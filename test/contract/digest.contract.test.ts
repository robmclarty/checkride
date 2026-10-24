/**
 * Contract: `digest.md` presence semantics, and the digest a red run prints
 * (docs/contract.md §`.check/summary.json`).
 *
 * `.check/digest.md` is written only under `--digest` and only when a check
 * failed; a green `--digest` run removes any stale digest. Its existence
 * always means "this run had failures" — a consumer may branch on the file
 * without reading it. A red `--digest` run also prints that text on stderr,
 * last, below its `report:` and `digest:` lines and any notice beneath them,
 * and never on stdout.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { CliDeps } from '../../src/cli.js';
import { runCli } from '../../src/cli.js';

function sink(): { write: (text: string) => boolean } {
  return { write: () => true };
}

/** A sink that records what was written, for asserting on the stream. */
function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

/** The digest's first line, which only a printed digest puts on a stream. */
const DIGEST_HEADING = '# checkride failure digest';

describe('--digest', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-digest-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function deps(): CliDeps {
    return { cwd: dir, stdout: sink(), stderr: sink() };
  }

  function digestPath(): string {
    return join(dir, '.check', 'digest.md');
  }

  /** One custom check with the given exit; `links` off so it is the only check. */
  async function configWithExit(code: number): Promise<void> {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: {
        links: false,
        probe: { command: 'node', args: ['-e', `console.error('boom'); process.exit(${code})`] },
      },
    }));
  }

  test('a failing --digest run writes it', async () => {
    await configWithExit(1);
    expect(await runCli(['--digest'], deps())).toBe(1);
    expect(existsSync(digestPath())).toBe(true);
  });

  test('a failing run without --digest does not', async () => {
    await configWithExit(1);
    expect(await runCli([], deps())).toBe(1);
    expect(existsSync(digestPath())).toBe(false);
  });

  test('a green --digest run writes none — and removes a stale one', async () => {
    await configWithExit(1);
    await runCli(['--digest'], deps());
    expect(existsSync(digestPath())).toBe(true);

    await configWithExit(0);
    expect(await runCli(['--digest'], deps())).toBe(0);
    expect(existsSync(digestPath())).toBe(false);
  });

  test('a failing --digest run prints digest.md on stderr, last, below its report lines, and nothing on stdout', async () => {
    await configWithExit(1);
    const stdout = capture();
    const stderr = capture();
    expect(await runCli(['--digest'], { cwd: dir, stdout, stderr })).toBe(1);
    const digest = await readFile(digestPath(), 'utf8');
    const err = stderr.text();
    const pointers = err.indexOf('report: .check/summary.json\ndigest: .check/digest.md\n');
    expect(pointers).toBeGreaterThanOrEqual(0);
    expect(err.indexOf(digest)).toBeGreaterThan(pointers);
    expect(err.trimEnd().endsWith(digest.trimEnd())).toBe(true);
    expect(stdout.text()).toBe('');
  });

  /** A notice beneath the report changes how the red above it reads, so it comes before the digest. */
  test('a failing --digest run prints the notices beneath its report before the digest', async () => {
    await configWithExit(1);
    await writeFile(join(dir, 'checkride.baseline.json'), '<<<<<<< HEAD\n{\n');
    const stderr = capture();
    expect(await runCli(['--digest'], { cwd: dir, stdout: sink(), stderr })).toBe(1);
    const err = stderr.text();
    const warning = err.indexOf('baseline: checkride.baseline.json is present but unparseable');
    expect(warning).toBeGreaterThan(err.indexOf('digest: .check/digest.md\n'));
    expect(err.indexOf(DIGEST_HEADING)).toBeGreaterThan(warning);
  });

  test('a green --digest run prints none, and neither does a failing run without the flag', async () => {
    await configWithExit(0);
    const green = capture();
    expect(await runCli(['--digest'], { cwd: dir, stdout: sink(), stderr: green })).toBe(0);
    expect(green.text()).not.toContain(DIGEST_HEADING);

    await configWithExit(1);
    const unflagged = capture();
    expect(await runCli([], { cwd: dir, stdout: sink(), stderr: unflagged })).toBe(1);
    expect(unflagged.text()).not.toContain(DIGEST_HEADING);
  });

  test('a failing --json --digest run keeps the digest in the file: stdout is the summary alone', async () => {
    await configWithExit(1);
    const stdout = capture();
    const stderr = capture();
    expect(await runCli(['--json', '--digest'], { cwd: dir, stdout, stderr })).toBe(1);
    expect(existsSync(digestPath())).toBe(true);
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: false });
    expect(stderr.text()).not.toContain(DIGEST_HEADING);
  });
});

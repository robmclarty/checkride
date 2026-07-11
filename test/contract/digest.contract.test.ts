/**
 * Contract: `digest.md` presence semantics (docs/contract.md
 * §`.check/summary.json`).
 *
 * `.check/digest.md` is written only under `--digest` and only when a check
 * failed; a green `--digest` run removes any stale digest. Its existence
 * always means "this run had failures" — a consumer may branch on the file
 * without reading it.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { CliDeps } from '../../src/cli.js';
import { runCli } from '../../src/cli.js';

function sink(): { write: (text: string) => boolean } {
  return { write: () => true };
}

describe('digest.md presence', () => {
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
});

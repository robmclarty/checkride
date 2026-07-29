/**
 * Contract: the exit-code taxonomy (docs/contract.md §Exit codes).
 *
 *   0 — every executed check passed
 *   1 — at least one check failed (a verification failure)
 *   2 — the harness itself broke or was misused (config/usage error, --strict
 *       with zero checks run)
 *
 * Gate consumers (plumbbob's checkpoint) branch on the 1-vs-2 distinction.
 * A change that breaks one of these tests is a breaking change: it needs a
 * major-version decision and a "Contract" entry in CHANGELOG.md, not a fix
 * that quietly moves the test.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { CliDeps } from '../../src/cli.js';
import { runCli } from '../../src/cli.js';

function sink(): { write: (text: string) => boolean } {
  return { write: () => true };
}

describe('exit-code taxonomy', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-contract-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function deps(): CliDeps {
    return { cwd: dir, stdout: sink(), stderr: sink() };
  }

  /** One custom check with the given exit; `links` off so it is the only check. */
  async function configWithExit(code: number): Promise<void> {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: {
        links: false,
        probe: { command: 'node', args: ['-e', `process.exit(${code})`] },
      },
    }));
  }

  test('0: all executed checks pass', async () => {
    await configWithExit(0);
    expect(await runCli([], deps())).toBe(0);
  });

  test('1: a check fails', async () => {
    await configWithExit(1);
    expect(await runCli([], deps())).toBe(1);
  });

  test('2: a malformed config is a harness error, not a check failure', async () => {
    await writeFile(join(dir, 'checkride.config.json'), 'not json');
    expect(await runCli([], deps())).toBe(2);
  });

  test('2: an unknown command is a usage error', async () => {
    expect(await runCli(['no-such-command'], deps())).toBe(2);
  });

  test('2: an unknown flag is a usage error', async () => {
    expect(await runCli(['--no-such-flag'], deps())).toBe(2);
  });

  test('2: a selection flag that names nothing is a usage error, not a zero-check pass', async () => {
    await configWithExit(0);
    expect(await runCli(['--only', ','], deps())).toBe(2);
  });

  test('2: --strict with zero checks run refuses the vacuous green', async () => {
    // An empty repo: nothing detected, everything sits out, nothing verified.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ checks: { links: false } }));
    expect(await runCli(['--strict'], deps())).toBe(2);
    // ...while the default stays a warned exit 0, so exploration is not punished.
    expect(await runCli([], deps())).toBe(0);
  });
});

/**
 * Contract: the CLI command and run-flag set (docs/contract.md §CLI).
 *
 * The promised run flags parse today and keep parsing; new flags are additive.
 * Removing or repurposing one is a breaking change (major-version decision +
 * a "Contract" CHANGELOG entry).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { CliDeps } from '../../src/cli.js';
import { parseCliArgs, runCli } from '../../src/cli.js';

const BOOLEAN_FLAGS = ['bail', 'json', 'all', 'changed', 'digest', 'strict'] as const;
const LIST_FLAGS = ['only', 'skip', 'include'] as const;

/** A stderr sink that records what was written, for asserting on the message. */
function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

describe('CLI run flags', () => {
  test('every promised boolean flag parses', () => {
    for (const flag of BOOLEAN_FLAGS) {
      expect(parseCliArgs([`--${flag}`]).flags[flag]).toBe(true);
    }
  });

  test('every promised list flag parses to a string array', () => {
    for (const flag of LIST_FLAGS) {
      expect(parseCliArgs([`--${flag}`, 'a,b']).flags[flag]).toEqual(['a', 'b']);
    }
  });

  test('the promised commands are recognized', () => {
    for (const command of ['run', 'init', 'doctor', 'fix', 'baseline', 'agent-setup']) {
      expect(parseCliArgs([command]).command).toBe(command);
    }
  });

  test('an unknown run flag is rejected (usage error, exit 2 at the CLI)', () => {
    expect(() => parseCliArgs(['--no-such-flag'])).toThrow();
  });
});

/**
 * Contract: an unknown slot name in `--only`/`--skip`/`--include` is a usage
 * error (exit 2), never a silent no-op. A typo that disables the gate is the
 * worst vacuous green in a definition-of-done check. The error names the bad
 * slot and the valid set (catalogue slots + config custom-check names).
 */
describe('CLI slot-selection validation', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-flags-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function deps(stderr: CliDeps['stderr']): CliDeps {
    return { cwd: dir, stdout: { write: () => true }, stderr };
  }

  for (const flag of LIST_FLAGS) {
    test(`an unknown slot in --${flag} exits 2, naming it and the valid set`, async () => {
      const stderr = capture();
      expect(await runCli([`--${flag}`, 'lints'], deps(stderr))).toBe(2);
      expect(stderr.text()).toContain("'lints'"); // the unknown slot
      expect(stderr.text()).toContain('types'); // and the valid set
    });
  }

  test('a valid slot name is accepted (not rejected as unknown)', async () => {
    // No adapter is detected here, so `lint` sits out and the run is a warned
    // vacuous green (exit 0) — the point is the name is not a usage error.
    expect(await runCli(['--only', 'lint'], deps(capture()))).toBe(0);
  });

  test('the valid set includes config custom-check names', async () => {
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: { licenses: { command: 'node', args: ['-e', ''] } },
    }));
    const stderr = capture();
    expect(await runCli(['--only', 'nope'], deps(stderr))).toBe(2);
    expect(stderr.text()).toContain('licenses');
  });
});

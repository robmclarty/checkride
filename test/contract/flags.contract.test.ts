/**
 * Contract: the CLI command and run-flag set (docs/contract.md §CLI).
 *
 * The promised run flags parse today and keep parsing; new flags are additive.
 * Removing or repurposing one is a breaking change (major-version decision +
 * a "Contract" CHANGELOG entry).
 */

import { existsSync } from 'node:fs';
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
    for (const command of ['run', 'init', 'doctor', 'fix', 'baseline', 'agent-setup', 'gate', 'triage', 'qa']) {
      expect(parseCliArgs([command]).command).toBe(command);
    }
  });

  test('--concurrency <n> parses to a positive integer', () => {
    expect(parseCliArgs(['--concurrency', '3']).flags.concurrency).toBe(3);
    // Absent → left undefined so the orchestrator applies its auto default.
    expect(parseCliArgs([]).flags.concurrency).toBeUndefined();
  });

  test('--concurrency rejects a non-positive-integer value (usage error, exit 2 at the CLI)', () => {
    for (const bad of ['0', '-1', 'x', '2.5']) {
      expect(() => parseCliArgs(['--concurrency', bad])).toThrow();
    }
  });

  test('a list flag that names nothing is rejected at parse time', () => {
    for (const flag of LIST_FLAGS) {
      for (const empty of ['', ',', '  ', ' , ']) {
        expect(() => parseCliArgs([`--${flag}`, empty])).toThrow(`--${flag}`);
      }
    }
    // Absent is still `null` — the caller's default applies, not an error.
    expect(parseCliArgs([]).flags.only).toBeNull();
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

  /**
   * A list flag that names nothing is the same class of mistake as a typo, and
   * `--only` is the dangerous one: it used to parse to `[]`, which is truthy,
   * so every check was filtered out and the run exited 0 having verified
   * nothing. The two empty spellings also disagreed — `--only ''` ran the whole
   * pipeline, `--only ,` ran none of it. Both are exit 2 now.
   */
  for (const flag of LIST_FLAGS) {
    for (const empty of ['', ',', '  ', ' , ']) {
      test(`--${flag} ${JSON.stringify(empty)} names nothing and exits 2`, async () => {
        const stderr = capture();
        expect(await runCli([`--${flag}`, empty], deps(stderr))).toBe(2);
        expect(stderr.text()).toContain(`--${flag}`);
      });
    }
  }

  test('an empty selection is rejected before any .check/ side effect', async () => {
    expect(await runCli(['--only', ','], deps(capture()))).toBe(2);
    expect(existsSync(join(dir, '.check'))).toBe(false);
  });
});

/**
 * Contract: `init`/`agent-setup` take `--hook <a,b>` to select which agent
 * hooks to write (default: all), `--no-hook` as the write-none escape, and
 * `--remove-hook <a,b>` to tear installed ones back out. An unknown hook name is
 * a usage error (exit 2) naming the valid set, for either selecting flag.
 */
describe('CLI hook selection (--hook / --no-hook / --remove-hook)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-hook-flag-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function deps(stderr: CliDeps['stderr']): CliDeps {
    return { cwd: dir, stdout: { write: () => true }, stderr };
  }

  test('--hook gate is accepted on agent-setup and init', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(await runCli(['agent-setup', '--hook', 'gate', '--dry-run'], deps(capture()))).toBe(0);
    expect(await runCli(['init', '--hook', 'gate', '--dry-run'], deps(capture()))).toBe(0);
  });

  test('an unknown hook name exits 2, naming it and the valid set', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    const stderr = capture();
    expect(await runCli(['agent-setup', '--hook', 'bogus', '--dry-run'], deps(stderr))).toBe(2);
    expect(stderr.text()).toContain("'bogus'");
    expect(stderr.text()).toContain('gate');
  });

  test('--no-hook still parses (the escape hatch is unchanged)', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(await runCli(['agent-setup', '--no-hook', '--dry-run'], deps(capture()))).toBe(0);
  });

  test('--remove-hook is accepted on agent-setup and init, alone and with --no-hook', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(await runCli(['agent-setup', '--remove-hook', 'gate', '--dry-run'], deps(capture()))).toBe(0);
    expect(await runCli(['init', '--remove-hook', 'gate', '--dry-run'], deps(capture()))).toBe(0);
    expect(
      await runCli(['agent-setup', '--no-hook', '--remove-hook', 'gate', '--dry-run'], deps(capture())),
    ).toBe(0);
  });

  test('an unknown --remove-hook name exits 2, naming it and the valid set', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    const stderr = capture();
    expect(await runCli(['agent-setup', '--remove-hook', 'bogus', '--dry-run'], deps(stderr))).toBe(2);
    expect(stderr.text()).toContain("'bogus'");
    expect(stderr.text()).toContain('gate');
  });

  /** Writing and removing the same hook has no coherent reading; say so rather than pick one. */
  test('naming one hook in both flags is a usage error', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    const stderr = capture();
    expect(
      await runCli(['agent-setup', '--hook', 'gate', '--remove-hook', 'gate', '--dry-run'], deps(stderr)),
    ).toBe(2);
    expect(stderr.text()).toContain('--remove-hook');
  });
});

/**
 * Contract: `init`/`agent-setup` take `--harness <a,b>` to select which agent
 * harnesses to write hooks for (default: claude, plus any the repo shows
 * evidence of). An unknown name is a usage error (exit 2) naming the valid set,
 * the same rule `--hook` follows.
 */
describe('CLI harness selection (--harness)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-harness-flag-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function deps(stderr: CliDeps['stderr']): CliDeps {
    return { cwd: dir, stdout: { write: () => true }, stderr };
  }

  test('every promised harness is accepted, alone and together', async () => {
    // Each case gets its own repo: `init` probes by running the checks, so two
    // sharing a cwd would race in `.check/`.
    const cases = ['claude', 'cursor', 'claude,cursor'].flatMap((value) =>
      ['agent-setup', 'init'].map((command) => [command, '--harness', value, '--dry-run']),
    );
    const codes = await Promise.all(
      cases.map(async (argv) => {
        const cwd = await mkdtemp(join(tmpdir(), 'checkride-harness-case-'));
        await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'x' }));
        try {
          return await runCli(argv, { cwd, stdout: { write: () => true }, stderr: capture() });
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      }),
    );
    expect(codes).toEqual(cases.map(() => 0));
  }, 30000);

  test('an unknown harness name exits 2, naming it and the valid set', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    const stderr = capture();
    expect(await runCli(['agent-setup', '--harness', 'windsurf', '--dry-run'], deps(stderr))).toBe(2);
    expect(stderr.text()).toContain("'windsurf'");
    expect(stderr.text()).toContain('claude');
    expect(stderr.text()).toContain('cursor');
  });

  test('gate answers one harness at a time; a list is a usage error', async () => {
    expect(await runCli(['gate', '--harness', 'claude,cursor'], deps(capture()))).toBe(2);
  });
});

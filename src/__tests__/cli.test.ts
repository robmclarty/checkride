import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { CliDeps } from '../cli.js';
import { parseCliArgs, parseInitArgs, runCli } from '../cli.js';

function sink(): { write: (text: string) => boolean; text: () => string } {
  const lines: string[] = [];
  return { write: (text: string) => { lines.push(text); return true; }, text: () => lines.join('') };
}

describe('parseCliArgs', () => {
  test('defaults to the run command with empty flags', () => {
    const { command, flags } = parseCliArgs([]);
    expect(command).toBe('run');
    expect(flags).toMatchObject({ bail: false, json: false, all: false, only: null });
  });

  test('parses lists and boolean flags', () => {
    const { flags } = parseCliArgs(['--only', 'types,lint', '--bail']);
    expect(flags.only).toEqual(['types', 'lint']);
    expect(flags.bail).toBe(true);
  });

  test('trims whitespace and drops empties in list flags', () => {
    expect(parseCliArgs(['--skip', ' docs , , spell ']).flags.skip).toEqual(['docs', 'spell']);
  });

  test('parses --strict (off by default)', () => {
    expect(parseCliArgs(['--strict']).flags.strict).toBe(true);
    expect(parseCliArgs([]).flags.strict).toBe(false);
  });

  test('reads a leading subcommand positional', () => {
    expect(parseCliArgs(['init']).command).toBe('init');
    expect(parseCliArgs(['run', '--json']).command).toBe('run');
  });
});

describe('parseInitArgs', () => {
  test('parses every init flag', () => {
    const opts = parseInitArgs([
      'init', '--shape', 'monorepo', '--name', 'demo', '--scope', '@s',
      '--license', 'MIT', '--author', 'Me', '--dry-run', '--add', 'lint,spell',
    ]);
    expect(opts).toMatchObject({
      shape: 'monorepo', name: 'demo', scope: '@s', license: 'MIT', author: 'Me',
      dryRun: true, add: ['lint', 'spell'],
    });
  });

  test('omits unset flags (so defaults apply)', () => {
    const opts = parseInitArgs(['init']);
    expect(opts.shape).toBeUndefined();
    expect(opts.name).toBeUndefined();
    expect(opts.dryRun).toBeUndefined();
    expect(opts.add).toBeUndefined();
  });

  test('rejects an invalid shape', () => {
    expect(() => parseInitArgs(['init', '--shape', 'nope'])).toThrow('invalid --shape');
  });
});

describe('runCli help and version', () => {
  test('--help prints usage to stdout and exits 0', async () => {
    const out = sink();
    const code = await runCli(['--help'], { cwd: process.cwd(), stdout: out, stderr: sink() });
    expect(code).toBe(0);
    expect(out.text()).toContain('Usage: checkride');
    expect(out.text()).toContain('doctor');
  });

  test('-h is an alias for --help', async () => {
    const out = sink();
    expect(await runCli(['-h'], { cwd: process.cwd(), stdout: out, stderr: sink() })).toBe(0);
    expect(out.text()).toContain('Usage: checkride');
  });

  test('--version prints a semver and exits 0', async () => {
    const out = sink();
    const code = await runCli(['--version'], { cwd: process.cwd(), stdout: out, stderr: sink() });
    expect(code).toBe(0);
    expect(out.text().trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('-V is an alias for --version', async () => {
    const out = sink();
    expect(await runCli(['-V'], { cwd: process.cwd(), stdout: out, stderr: sink() })).toBe(0);
    expect(out.text().trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('runCli dispatch', () => {
  test('rejects an unknown command with a usage pointer', async () => {
    const err = sink();
    const code = await runCli(['bogus'], { cwd: process.cwd(), stdout: sink(), stderr: err });
    expect(code).toBe(2);
    expect(err.text()).toContain("unknown command 'bogus'");
    expect(err.text()).toContain('checkride --help');
  });

  test('returns 2 on a parse error with a clean message and usage pointer', async () => {
    const err = sink();
    const code = await runCli(['--definitely-not-a-flag'], { cwd: process.cwd(), stdout: sink(), stderr: err });
    expect(code).toBe(2);
    expect(err.text()).toContain('checkride:');
    expect(err.text()).toContain('checkride --help');
    // The verbose Node "To specify a positional…" tail is trimmed.
    expect(err.text()).not.toContain('To specify a positional');
  });

  // Probes real tool versions (pnpm, git, …); Node-CLI startup alone can
  // exceed the 5s default on slow-spawn machines.
  test('doctor exits 0 on this healthy, installed project', async () => {
    const code = await runCli(['doctor', '--json'], { cwd: process.cwd(), stdout: sink(), stderr: sink() });
    expect(code).toBe(0);
  }, 30_000);
});

describe('runCli run (built-in links path)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-cli-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function deps(): CliDeps {
    return { cwd: dir, stdout: sink(), stderr: sink() };
  }

  test('exits 0 when the only check passes', async () => {
    await writeFile(join(dir, 'README.md'), '# clean, no links\n');
    expect(await runCli(['--only', 'links'], deps())).toBe(0);
  });

  test('exits 1 when a check fails', async () => {
    await writeFile(join(dir, 'README.md'), 'broken [x](./missing.md)\n');
    expect(await runCli(['--only', 'links'], deps())).toBe(1);
  });
});

describe('runCli baseline', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-cli-baseline-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('writes checkride.baseline.json at repo root and exits 0', async () => {
    await writeFile(join(dir, 'README.md'), '# clean, no links\n');
    const code = await runCli(['baseline'], { cwd: dir, stdout: sink(), stderr: sink() });
    expect(code).toBe(0);
    const path = join(dir, 'checkride.baseline.json');
    expect(existsSync(path)).toBe(true);
    // A bare dir detects no fingerprintable tool, so the baseline is empty but valid.
    const written = JSON.parse(readFileSync(path, 'utf8')) as { schema_version: number; slots: unknown };
    expect(written.schema_version).toBe(1);
    expect(written.slots).toEqual({});
  });

  test('baseline appears in --help', async () => {
    const out = sink();
    await runCli(['--help'], { cwd: dir, stdout: out, stderr: sink() });
    expect(out.text()).toContain('baseline');
  });
});

describe('runCli init', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-cli-init-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('generates a new flat project', async () => {
    const code = await runCli(['init', '--shape', 'flat', '--name', 'demo'], { cwd: dir, stdout: sink(), stderr: sink() });
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'package.json'))).toBe(true);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
  });

  test('rejects an invalid shape with exit 2', async () => {
    const err = sink();
    const code = await runCli(['init', '--shape', 'nope', '--name', 'demo'], { cwd: dir, stdout: sink(), stderr: err });
    expect(code).toBe(2);
    expect(err.text()).toContain('invalid --shape');
  });

  test('refuses to overwrite an existing file with exit 2, writing nothing', async () => {
    await writeFile(join(dir, 'README.md'), '# keep me\n');
    const err = sink();
    const code = await runCli(['init', '--shape', 'flat', '--name', 'demo'], { cwd: dir, stdout: sink(), stderr: err });
    expect(code).toBe(2);
    expect(err.text()).toContain('README.md');
    expect(existsSync(join(dir, 'package.json'))).toBe(false);
  });

  test('--force overwrites and exits 0', async () => {
    await writeFile(join(dir, 'README.md'), '# stale\n');
    const code = await runCli(['init', '--shape', 'flat', '--name', 'demo', '--force'], { cwd: dir, stdout: sink(), stderr: sink() });
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'package.json'))).toBe(true);
  });
});

describe('runCli agent-setup', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-cli-agent-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('appears in --help', async () => {
    const out = sink();
    await runCli(['--help'], { cwd: dir, stdout: out, stderr: sink() });
    expect(out.text()).toContain('agent-setup');
  });

  test('writes the AGENTS stanza and the Stop hook, exit 0', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    const code = await runCli(['agent-setup'], { cwd: dir, stdout: sink(), stderr: sink() });
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(true);
  });

  test('--no-hook skips the Stop hook', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    const code = await runCli(['agent-setup', '--no-hook'], { cwd: dir, stdout: sink(), stderr: sink() });
    expect(code).toBe(0);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(false);
  });
});

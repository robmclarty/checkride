import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { CliDeps } from './index.js';
import { parseCliArgs, runCli } from './index.js';

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

  test('reads a leading subcommand positional', () => {
    expect(parseCliArgs(['init']).command).toBe('init');
    expect(parseCliArgs(['run', '--json']).command).toBe('run');
  });
});

describe('runCli dispatch', () => {
  test('stubs init/doctor/fix with exit 2', async () => {
    const err = sink();
    const code = await runCli(['doctor'], { cwd: process.cwd(), stdout: sink(), stderr: err });
    expect(code).toBe(2);
    expect(err.text()).toContain('not implemented');
  });

  test('rejects an unknown command', async () => {
    const err = sink();
    const code = await runCli(['bogus'], { cwd: process.cwd(), stdout: sink(), stderr: err });
    expect(code).toBe(2);
    expect(err.text()).toContain("unknown command 'bogus'");
  });

  test('returns 2 on a parse error', async () => {
    const err = sink();
    const code = await runCli(['--definitely-not-a-flag'], { cwd: process.cwd(), stdout: sink(), stderr: err });
    expect(code).toBe(2);
    expect(err.text()).toContain('checkride:');
  });
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

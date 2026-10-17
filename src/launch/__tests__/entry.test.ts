/**
 * R6.6: a repo runs checkride through its `check` script when it has a
 * `package.json`, through the checkride its root `mise.toml` pins when it has
 * none, and through the one on `PATH` otherwise; and each entry command
 * renders the full check, a subcommand and the gate's argv its own way.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { EntryCommand } from '../index.js';
import { asEntry, entryArgv, entryCheckride, entryText, resolveEntry } from '../index.js';

const mise: EntryCommand = { kind: 'mise' };
const path: EntryCommand = { kind: 'path' };

describe('resolveEntry', () => {
  let repo: string;
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'checkride-entry-')); });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  test('a package.json with a check script runs it, a mise pin beside it notwithstanding', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { check: 'checkride' } }));
    await writeFile(join(repo, 'mise.toml'), '[tools]\n"npm:checkride" = "0.14.0"\n');
    expect(resolveEntry(repo, 'npm')).toEqual({ kind: 'script', pm: 'npm' });
  });

  test('a package.json without one keeps the check script, which init wires', async () => {
    await writeFile(join(repo, 'package.json'), '{"name":"x"}');
    expect(resolveEntry(repo, 'pnpm')).toEqual({ kind: 'script', pm: 'pnpm' });
  });

  test.each([
    ['mise.toml', '[tools]\n"npm:checkride" = "0.14.0"\nnode = "22"\n'],
    ['mise.toml', '[tools]\n"github:robmclarty/checkride" = "latest"\n'],
    ['.mise.toml', '[tools]\n"npm:checkride" = { version = "0.14.0" }\n'],
  ])('with no package.json, a root %s that pins checkride runs mise’s copy', async (file, text) => {
    await writeFile(join(repo, file), text);
    expect(resolveEntry(repo, 'pnpm')).toEqual(mise);
  });

  test('with no package.json and no pin, the checkride on PATH runs, unpinned', async () => {
    await writeFile(join(repo, 'mise.toml'), '[tools]\ngo = "1.27"\ncheckride-ish = "1"\n');
    expect(resolveEntry(repo, 'pnpm')).toEqual(path);
  });

  test('reads files through the reader it is given', () => {
    expect(resolveEntry('/nowhere', 'yarn', () => '{"scripts":{"check":"x"}}')).toEqual({ kind: 'script', pm: 'yarn' });
    expect(resolveEntry('/nowhere', 'yarn', () => null)).toEqual(path);
  });
});

describe('rendering an entry command', () => {
  test('the full check, as a person types it', () => {
    expect(entryText('pnpm')).toBe('pnpm check');
    expect(entryText({ kind: 'script', pm: 'npm' })).toBe('npm run check');
    expect(entryText(mise)).toBe('mise exec -- checkride');
    expect(entryText(path)).toBe('checkride');
  });

  test('a subcommand, through the package manager’s launcher, mise or PATH', () => {
    expect(entryCheckride('npm', ['triage'])).toBe('npx --no-install checkride triage');
    expect(entryCheckride(mise, ['gate', '--harness', 'claude'], { quiet: true })).toBe('mise exec -- checkride gate --harness claude');
    expect(entryCheckride(path, ['triage'])).toBe('checkride triage');
  });

  test('the argv that runs the check, npm alone putting -- before its flags', () => {
    expect(entryArgv('npm', ['--strict'])).toEqual(['npm', 'run', 'check', '--', '--strict']);
    expect(entryArgv('npm', [])).toEqual(['npm', 'run', 'check']);
    expect(entryArgv('pnpm', ['--strict'])).toEqual(['pnpm', 'run', 'check', '--strict']);
    expect(entryArgv(mise, ['--strict', '--digest'])).toEqual(['mise', 'exec', '--', 'checkride', '--strict', '--digest']);
    expect(entryArgv(path, [])).toEqual(['checkride']);
  });

  test('a bare package manager reads as its check script', () => {
    expect(asEntry('bun')).toEqual({ kind: 'script', pm: 'bun' });
    expect(asEntry(mise)).toBe(mise);
  });
});

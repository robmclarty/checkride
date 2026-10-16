/**
 * A bash target's checks run over its file list (R11.2): `{files}` expands to
 * the target's files before anything spawns, so the runner, the summary's
 * argv and `fix` all see them; a target whose list matches nothing skips its
 * checks with `no files matched` (F10); and a list too long for one argv is a
 * usage error, exit 2, raised before the run writes anything.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../../cli.js';
import type { CheckrideConfig } from '../../config.js';
import type { LaunchContext } from '../../launch/index.js';
import type { CheckRunner, Out } from '../index.js';
import { runChecks, runFix } from '../index.js';

function sink(): { out: Out; text: () => string } {
  let text = '';
  return { out: { write: (chunk: string) => { text += chunk; return true; } }, text: () => text };
}

/** One bash target over `scripts/`, its lint and format named so no pin is needed. */
const config = (target: Record<string, unknown> = {}): CheckrideConfig => ({
  targets: { scripts: { lang: 'bash', root: 'scripts', checks: { lint: 'shellcheck', format: 'shfmt' }, ...target } },
});

/** A runner that records the args each target's check was handed, by check name, and passes. */
function recorder(): { runner: CheckRunner; args: Record<string, readonly string[]> } {
  const args: Record<string, readonly string[]> = {};
  const runner: CheckRunner = (r) => {
    if (r.target !== undefined) args[`${r.target}:${r.slot}`] = r.adapter?.args ?? [];
    return Promise.resolve({ ok: true, exit_code: 0, stdout: '{"comments":[]}', stderr: '' });
  };
  return { runner, args };
}

describe('a bash target runs over its files', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-file-lists-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const put = async (path: string, content = ''): Promise<void> => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  };

  test('shellcheck lints and shfmt checks the format of every script, one argument each', async () => {
    await put('scripts/b.sh');
    await put('scripts/a.sh');
    await put('scripts/bin/run', '#!/usr/bin/env bash\n');
    await put('scripts/README.md');
    const { runner, args } = recorder();
    const result = await runChecks({ cwd: dir, config: config(), runner, baseline: null, stderr: sink().out });
    expect(args['scripts:lint']).toEqual(['exec', 'shellcheck', '-f', 'json1', 'a.sh', 'b.sh', 'bin/run']);
    expect(args['scripts:format']).toEqual(['exec', 'shfmt', '-d', 'a.sh', 'b.sh', 'bin/run']);
    const lint = result.summary.checks.find((c) => c.name === 'scripts:lint');
    expect(lint).toMatchObject({ adapter: 'shellcheck', ok: true, output_file: 'scripts/lint.json', pack: 'bash', cwd: 'scripts' });
  });

  test("format is opt-in: detection alone doesn't run shfmt in the default pass", async () => {
    await put('scripts/a.sh');
    await put('scripts/mise.toml', '[tools]\nshfmt = "3.14.1"\nshellcheck = "0.11.0"\n');
    const { runner, args } = recorder();
    const result = await runChecks({ cwd: dir, config: config({ checks: {} }), runner, baseline: null, stderr: sink().out });
    expect(Object.keys(args)).toEqual(['scripts:lint']);
    expect(result.summary.checks.find((c) => c.name === 'scripts:lint')).toMatchObject({
      origin: 'detected',
      detected_by: 'scripts/mise.toml: shellcheck',
    });
    await runChecks({ cwd: dir, config: config({ checks: {} }), runner, baseline: null, include: ['format'], stderr: sink().out });
    expect(args['scripts:format']).toEqual(['exec', 'shfmt', '-d', 'a.sh']);
  });

  test('a target whose files match nothing skips its checks rather than fail them (F10)', async () => {
    await put('scripts/notes.txt');
    const { runner, args } = recorder();
    const err = sink();
    const result = await runChecks({ cwd: dir, config: config(), runner, baseline: null, only: ['scripts'], stderr: err.out });
    expect(args).toEqual({});
    expect(result.exitCode).toBe(0);
    expect(result.summary.checks.find((c) => c.name === 'scripts:lint')).toMatchObject({
      ok: true,
      skipped: true,
      reason: 'no files matched',
      exit_code: null,
      duration_ms: 0,
      output_file: null,
    });
    expect(result.summary.checks_run).toBe(0);
    expect(err.text()).toMatch(/scripts:lint\s+skip {2}no files matched/);
  });

  test("an include that matches nothing skips too, and the target's own exclude is honored", async () => {
    await put('scripts/a.sh');
    await put('scripts/vendor/b.sh');
    const { runner, args } = recorder();
    await runChecks({ cwd: dir, config: config({ exclude: ['vendor'] }), runner, baseline: null, only: ['scripts:lint'], stderr: sink().out });
    expect(args['scripts:lint']?.slice(4)).toEqual(['a.sh']);
    const result = await runChecks({ cwd: dir, config: config({ include: ['bin/*'] }), runner, baseline: null, only: ['scripts:lint'], stderr: sink().out });
    expect(result.summary.checks[0]).toMatchObject({ skipped: true, reason: 'no files matched' });
  });

  test('a target --changed skips keeps its own reason, and its list is never read', async () => {
    // A file list this long would throw if it were read.
    await Promise.all(Array.from({ length: 1100 }, (_, i) => put(`scripts/${'z'.repeat(200)}-${i}.sh`)));
    await put('README.md');
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' });
    };
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'init');
    await put('README.md', 'changed\n');
    const { runner, args } = recorder();
    const result = await runChecks({ cwd: dir, config: config(), runner, baseline: null, changed: true, only: ['scripts:lint'], stderr: sink().out });
    expect(args).toEqual({});
    expect(result.summary.checks[0]).toMatchObject({ name: 'scripts:lint', skipped: true, reason: 'no changes under scripts' });
  });

  test('a file list too long for one argv stops the run before it writes anything', async () => {
    const long = 'x'.repeat(200);
    await Promise.all(Array.from({ length: 1100 }, (_, i) => put(`scripts/${long}-${String(i).padStart(4, '0')}.sh`)));
    const { runner, args } = recorder();
    await expect(runChecks({ cwd: dir, config: config(), runner, baseline: null, only: ['scripts:lint'], stderr: sink().out })).rejects.toThrow(
      /scripts:lint would run over 1100 files, an argv of \d+ bytes, past the limit of 200000 bytes: narrow targets\.scripts\.include, or leave files out with targets\.scripts\.exclude/,
    );
    expect(args).toEqual({});
    expect(existsSync(join(dir, '.check'))).toBe(false);
  });

  test('the CLI exits 2 on a file list too long for one argv', async () => {
    const long = 'y'.repeat(200);
    await Promise.all(Array.from({ length: 1100 }, (_, i) => put(`scripts/${long}-${i}.sh`)));
    await put('checkride.config.json', JSON.stringify(config()));
    const err = sink();
    const code = await runCli(['--only', 'scripts:lint'], { cwd: dir, stdout: sink().out, stderr: err.out, env: {} });
    expect(code).toBe(2);
    expect(err.text()).toMatch(/^checkride: scripts:lint would run over 1100 files/);
  });

  test('fix runs shfmt -w over the same files, and says when a target has none', async () => {
    await put('scripts/a.sh');
    const seen: { args: readonly string[]; ctx: LaunchContext }[] = [];
    const fixRunner = (adapter: { fixArgs?: string[] }, ctx: LaunchContext) => {
      seen.push({ args: adapter.fixArgs ?? [], ctx });
      return Promise.resolve({ ok: true, exit_code: 0 });
    };
    const fixed = await runFix({ cwd: dir, config: config(), fixRunner, stderr: sink().out });
    expect(fixed.ran).toEqual(['shfmt']);
    expect(seen[0]?.args).toEqual(['exec', 'shfmt', '-w', 'a.sh']);
    expect(seen[0]?.ctx.cwd).toBe(join(dir, 'scripts'));

    await rm(join(dir, 'scripts/a.sh'));
    const err = sink();
    const none = await runFix({ cwd: dir, config: config(), fixRunner, stderr: err.out });
    expect(none).toEqual({ ok: true, exitCode: 0, ran: [] });
    expect(err.text()).toContain('○ scripts:format skipped (no files matched)');
  });

  test('a ts target leaves a literal {files} alone: only a file-list pack expands it', async () => {
    await mkdir(join(dir, 'web'));
    const { runner, args } = recorder();
    const tsConfig: CheckrideConfig = { targets: { web: { lang: 'ts', root: 'web', checks: { gen: { command: 'node', args: ['gen.js', '{files}'] } } } } };
    await runChecks({ cwd: dir, config: tsConfig, runner, baseline: null, only: ['web:gen'], stderr: sink().out });
    expect(args['web:gen']).toEqual(['gen.js', '{files}']);
  });
});

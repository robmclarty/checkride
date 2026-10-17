/**
 * `checkride target add` (R7.4, S11): it declares a target, adopting the tools
 * its root configures, converts a repo without targets, rewrites its baseline
 * so the next full run masks exactly what the last one did (F22), prints each
 * change, and under `--dry-run` writes nothing. A change that would break the
 * config exits 2 having written nothing.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../cli.js';
import { loadConfig } from '../config.js';
import type { CheckRunner, Out } from '../orchestrator/index.js';
import { runChecks } from '../orchestrator/index.js';
import { runTargetAdd } from '../target-command.js';

function sink(): { out: Out; text: () => string } {
  let text = '';
  return { out: { write: (chunk: string) => { text += chunk; return true; } }, text: () => text };
}

/** An oxlint `--format=json` payload with one error per `[file, code, message]`. */
function oxlint(findings: [string, string, string][]): string {
  return JSON.stringify({ diagnostics: findings.map(([filename, code, message]) => ({ filename, code, message, severity: 'error' })) });
}

/** A runner whose lint reports one grandfathered finding, and whose every other check passes. */
const lintRunner: CheckRunner = (r) =>
  Promise.resolve(
    r.slot === 'lint' && r.target !== 'scripts'
      ? { ok: false, exit_code: 1, stdout: oxlint([['src/a.ts', 'no-x', 'bad'], ['src/b.ts', 'no-y', 'worse']]), stderr: '' }
      : { ok: true, exit_code: 0, stdout: '', stderr: '' },
  );

describe('runTargetAdd', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-target-add-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const put = async (path: string, content = ''): Promise<void> => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  };
  const read = (path: string): Promise<string> => readFile(join(dir, path), 'utf8');
  const add = (opts: Partial<Parameters<typeof runTargetAdd>[0]> = {}, out = sink()) =>
    runTargetAdd({ cwd: dir, name: 'scripts', lang: 'bash', root: 'scripts', stdout: out.out, ...opts });

  test('converting a repo with a baseline keeps every grandfathered finding masked on the next full run (F22)', async () => {
    await put('package.json', '{"name":"x"}');
    await put('scripts/run.sh', '#!/bin/sh\n');
    await put('checkride.config.json', JSON.stringify({ checks: { lint: 'oxlint', links: false } }));
    await put('checkride.baseline.json', JSON.stringify({ schema_version: 1, slots: { lint: ['src/a.ts:no-x:bad', 'src/b.ts:no-y:worse'], spell: ['README.md:teh'] } }));
    const before = await runChecks({ cwd: dir, config: loadConfig(dir), runner: lintRunner, stderr: sink().out });
    expect(before.summary.checks.find((c) => c.name === 'lint')).toMatchObject({ ok: true, baselined: 2 });

    const out = sink();
    const result = await add({}, out);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await read('checkride.baseline.json'))).toEqual({
      schema_version: 1,
      slots: { 'app:lint': ['src/a.ts:no-x:bad', 'src/b.ts:no-y:worse'], spell: ['README.md:teh'] },
    });
    expect(out.text()).toContain('checkride.baseline.json: lint renamed app:lint (2 keys)');
    expect(out.text()).toContain('checks.lint moved to targets.app.checks.lint');
    expect(out.text()).toContain('wrote checkride.config.json, checkride.baseline.json');

    const after = await runChecks({ cwd: dir, config: loadConfig(dir), runner: lintRunner, stderr: sink().out });
    expect(after.summary.checks.find((c) => c.name === 'app:lint')).toMatchObject({ ok: true, baselined: 2 });
    expect(after.exitCode).toBe(before.exitCode);
    // A full run observed both findings, so the ratchet pruned nothing.
    expect(JSON.parse(await read('checkride.baseline.json')).slots['app:lint']).toHaveLength(2);
  });

  test('--dry-run prints every change and writes nothing', async () => {
    await put('package.json', '{"name":"x"}');
    await put('scripts/.shellcheckrc');
    await put('checkride.config.json', '{"checks":{"lint":"oxlint"}}');
    await put('checkride.baseline.json', '{"schema_version":1,"slots":{"lint":["a:b:c"]}}');
    const out = sink();
    const result = await add({ dryRun: true }, out);
    expect(result).toMatchObject({ exitCode: 0, written: [] });
    expect(await read('checkride.config.json')).toBe('{"checks":{"lint":"oxlint"}}');
    expect(await read('checkride.baseline.json')).toBe('{"schema_version":1,"slots":{"lint":["a:b:c"]}}');
    expect(out.text()).toContain('targets.scripts.checks.lint: "shellcheck"');
    expect(out.text()).toContain('dry run: nothing written');
  });

  test('creates the config when there is none, naming the schema', async () => {
    await put('scripts/a.sh');
    await add();
    const config = JSON.parse(await read('checkride.config.json')) as Record<string, unknown>;
    expect(config['$schema']).toMatch(/schema\/checkride\.config\.schema\.json$/);
    expect(config['targets']).toEqual({ app: { lang: 'ts', root: '.' }, scripts: { lang: 'bash', root: 'scripts' } });
  });

  test('converting a go.mod root names its implicit target a go one, and a go target at . takes it over (R2.1)', async () => {
    await put('go.mod', 'module example.com/m\n');
    await put('scripts/a.sh');
    await add();
    expect(JSON.parse(await read('checkride.config.json')).targets).toEqual({ app: { lang: 'go', root: '.' }, scripts: { lang: 'bash', root: 'scripts' } });

    await rm(join(dir, 'checkride.config.json'));
    await add({ name: 'svc', lang: 'go', root: '.' });
    expect(JSON.parse(await read('checkride.config.json')).targets).toEqual({ svc: { lang: 'go', root: '.', checks: { types: 'go-build', test: 'go-test' } } });
  });

  test('adopts the tools the root configures, and --add names the blessed one and scaffolds a ts target’s config', async () => {
    await put('checkride.config.json', JSON.stringify({ targets: { scripts: { lang: 'bash', root: 'scripts' } } }));
    await put('scripts/a.sh');
    await put('apps/web/vitest.config.ts');
    const out = sink();
    await add({ name: 'web', lang: 'ts', root: './apps/web/', add: ['lint'] }, out);
    expect(JSON.parse(await read('checkride.config.json')).targets.web).toEqual({
      lang: 'ts', root: 'apps/web', checks: { test: 'vitest', lint: 'oxlint' },
    });
    expect(existsSync(join(dir, 'apps/web/.oxlintrc.json'))).toBe(true);
    expect(out.text()).toContain('apps/web/.oxlintrc.json written (--add)');
  });

  test('a bash target’s --add names its tool and scaffolds nothing', async () => {
    await put('checkride.config.json', JSON.stringify({ targets: { web: { lang: 'ts', root: 'web' } } }));
    await put('web/package.json');
    await put('scripts/a.sh');
    await add({ add: ['lint', 'format'] });
    expect(JSON.parse(await read('checkride.config.json')).targets.scripts.checks).toEqual({ lint: 'shellcheck', format: 'shfmt' });
    expect(existsSync(join(dir, 'scripts/.oxlintrc.json'))).toBe(false);
  });

  test('a change that breaks the config, a ts target nesting under the converted root, writes nothing', async () => {
    await put('package.json', '{"name":"x"}');
    await put('apps/web/package.json');
    await put('checkride.config.json', '{"checks":{}}');
    await expect(add({ name: 'web', lang: 'ts', root: 'apps/web' })).rejects.toThrow(
      "invalid checkride.config.json: ts target 'web' sits inside 'app' ('apps/web' is under '.'), and two targets of one pack can't nest",
    );
    expect(await read('checkride.config.json')).toBe('{"checks":{}}');
  });

  test('refuses an unknown pack, a slot its pack fills nowhere, and a baseline it can’t follow', async () => {
    await put('scripts/a.sh');
    await expect(add({ lang: 'cobol' })).rejects.toThrow('target add: --lang "cobol" isn\'t a pack (packs: ts, bash, go, rust)');
    await expect(add({ lang: 'repo' })).rejects.toThrow('isn\'t a pack');
    await expect(add({ add: ['types'] })).rejects.toThrow('target add: --add types: bash fills no types slot');
    await expect(add({ add: ['struct'] })).rejects.toThrow('struct is a repo-scope slot; scaffold it with checkride init --add struct');
    await put('checkride.baseline.json', '{not json');
    await expect(add()).rejects.toThrow('checkride.baseline.json can\'t be parsed');
    expect(existsSync(join(dir, 'checkride.config.json'))).toBe(false);
  });

  test('the CLI runs it, and a malformed invocation exits 2', async () => {
    await put('scripts/a.sh');
    const run = (argv: string[]) => runCli(argv, { cwd: dir, stdout: sink().out, stderr: sink().out, env: {} });
    expect(await run(['target'])).toBe(2);
    expect(await run(['target', 'remove', 'scripts'])).toBe(2);
    expect(await run(['target', 'add', 'scripts', '--lang', 'bash'])).toBe(2);
    expect(await run(['target', 'add', '--lang', 'bash', '--root', 'scripts'])).toBe(2);
    expect(await run(['target', 'add', 'doc-snippets', '--lang', 'bash', '--root', 'scripts'])).toBe(2);
    expect(existsSync(join(dir, 'checkride.config.json'))).toBe(false);
    expect(await run(['target', 'add', 'scripts', '--lang', 'bash', '--root', 'scripts', '--root-name', 'web'])).toBe(0);
    expect(Object.keys(JSON.parse(await read('checkride.config.json')).targets)).toEqual(['web', 'scripts']);
  });
});

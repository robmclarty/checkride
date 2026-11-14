/**
 * The orchestrator in multi-target mode, through an injected runner: each
 * target's check runs from its root with `{out}` its own directory, masks
 * against its `<target>:<slot>` baseline entry with its paths joined onto the
 * root (D50), and feeds the ratchet under that name; `fix` runs a target's
 * fixer from its root; and under `--changed` a target nothing changed under
 * sits out (R10.3). A Go module root without targets runs as one go target
 * whose checks keep their bare names (D66). A local target's findings mask
 * against the baseline file at its own root (D10).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Baseline } from '../../baseline/index.js';
import { runBaseline } from '../../baseline-command.js';
import type { CheckrideConfig, ResolvedCheck } from '../../config.js';
import { PACKS } from '../../packs/index.js';
import type { CheckRunner, Out, RunResult } from '../index.js';
import { runChecks, runFix } from '../index.js';
import { suiteNamed } from '../../suite.js';
import { skipUnchanged } from '../select.js';

function sink(): { out: Out; text: () => string } {
  let text = '';
  return { out: { write: (chunk: string) => { text += chunk; return true; } }, text: () => text };
}

/** An oxlint `--format=json` payload with one error per `[file, code, message]`. */
function oxlint(findings: [string, string, string][]): string {
  return JSON.stringify({ diagnostics: findings.map(([filename, code, message]) => ({ filename, code, message, severity: 'error' })) });
}

/** Two ts targets whose `lint` names oxlint, so no detection is needed; nothing else runs. */
const config: CheckrideConfig = {
  targets: {
    web: { lang: 'ts', root: 'apps/web', checks: { lint: 'oxlint' } },
    api: { lang: 'ts', root: 'apps/api', checks: { lint: 'oxlint' } },
  },
};

/** A runner that reports `findings` for each target's lint, as oxlint prints them from that target's root. */
function lintRunner(findings: Record<string, [string, string, string][]>): CheckRunner {
  return (r) => {
    const found = findings[r.target ?? ''] ?? [];
    return Promise.resolve({ ok: found.length === 0, exit_code: found.length === 0 ? 0 : 1, stdout: oxlint(found), stderr: '' });
  };
}

describe('runChecks with targets', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-orch-targets-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const run = (runner: CheckRunner, baseline: Baseline | null = null, extra: CheckrideConfig = {}) =>
    runChecks({ cwd: dir, config: { ...config, ...extra }, runner, baseline, only: ['lint'], stderr: sink().out });

  test("each target's check runs from its root, with {out} its own absolute directory", async () => {
    const seen: Record<string, { cwd: string; out?: string }> = {};
    const runner: CheckRunner = (r, ctx) => {
      seen[r.target ?? r.slot] = { cwd: ctx.cwd, ...(ctx.out !== undefined ? { out: ctx.out } : {}) };
      return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });
    };
    await runChecks({ cwd: dir, config: { ...config, checks: { tally: { command: 'node' } } }, runner, baseline: null, stderr: sink().out });
    expect(seen['web']).toEqual({ cwd: join(dir, 'apps/web'), out: join(dir, '.check', 'web') });
    expect(seen['api']).toEqual({ cwd: join(dir, 'apps/api'), out: join(dir, '.check', 'api') });
    expect(seen['tally']).toEqual({ cwd: dir, out: join(dir, '.check') });
  });

  test("each target runs under the package manager declared nearest its root, and with its pack's pin chain", async () => {
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
    await mkdir(join(dir, 'apps', 'api'), { recursive: true });
    await mkdir(join(dir, 'apps', 'web'), { recursive: true });
    await writeFile(join(dir, 'apps', 'api', 'package-lock.json'), '{}');
    const seen: Record<string, { pm: string; repo?: string; pins?: readonly string[] }> = {};
    const runner: CheckRunner = (r, ctx) => {
      seen[r.target ?? r.slot] = { pm: ctx.pm, ...(ctx.repo !== undefined ? { repo: ctx.repo } : {}), ...(ctx.pins !== undefined ? { pins: ctx.pins } : {}) };
      return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });
    };
    await runChecks({ cwd: dir, config: { ...config, checks: { tally: { command: 'node' } } }, runner, baseline: null, stderr: sink().out });
    expect(seen['web']).toEqual({ pm: 'pnpm', repo: dir, pins: ['js-lockfile'] });
    expect(seen['api']).toEqual({ pm: 'npm', repo: dir, pins: ['js-lockfile'] });
    expect(seen['tally']).toEqual({ pm: 'pnpm', repo: dir, pins: ['js-lockfile', 'mise', 'path'] });
    // Each chain is its pack's own row, not the implicit chain that happens to match it today.
    expect(seen['web']?.pins).toBe(PACKS.ts.pins);
    expect(seen['tally']?.pins).toBe(PACKS.repo.pins);
  });

  test("a target's findings mask against its <target>:<slot> entry, keyed from the repo root", async () => {
    const baseline: Baseline = { schema_version: 1, slots: { 'web:lint': ['apps/web/src/a.ts:no-x:bad'] } };
    const result = await run(lintRunner({ web: [['src/a.ts', 'no-x', 'bad']], api: [['src/a.ts', 'no-x', 'bad']] }), baseline);
    const byName = new Map(result.summary.checks.map((c) => [c.name, c]));
    expect(byName.get('web:lint')).toMatchObject({ ok: true, baselined: 1 });
    // The same file name under another target is another file, and its own entry is empty.
    expect(byName.get('api:lint')).toMatchObject({ ok: false });
    expect(result.exitCode).toBe(1);
  });

  test('a full run ratchets each target entry by its own findings, and leaves the repo-root keys alone', async () => {
    await writeFile(join(dir, 'checkride.baseline.json'), JSON.stringify({
      schema_version: 1,
      slots: { 'web:lint': ['apps/web/src/a.ts:no-x:bad', 'apps/web/src/b.ts:no-y:worse'], 'api:lint': ['apps/api/src/c.ts:no-z:gone'] },
    }));
    const result = await runChecks({ cwd: dir, config, runner: lintRunner({ web: [['src/a.ts', 'no-x', 'bad']] }), stderr: sink().out });
    expect(result.exitCode).toBe(0);
    const written = JSON.parse(await readFile(join(dir, 'checkride.baseline.json'), 'utf8')) as Baseline;
    expect(written.slots).toEqual({ 'api:lint': [], 'web:lint': ['apps/web/src/a.ts:no-x:bad'] });
  });

  test('checkride baseline writes each target entry under its name, with repo-root-relative paths', async () => {
    const result = await runBaseline({
      cwd: dir,
      config,
      runner: lintRunner({ web: [['src/a.ts', 'no-x', 'bad']], api: [['./lib/d.ts', 'no-w', 'odd']] }),
      stderr: sink().out,
    });
    expect(result.baseline.slots['web:lint']).toEqual(['apps/web/src/a.ts:no-x:bad']);
    expect(result.baseline.slots['api:lint']).toEqual(['apps/api/lib/d.ts:no-w:odd']);
    expect(result.baseline.slots).not.toHaveProperty('lint');
  });

  test('status lines name each check <target>:<slot>, and its JSON lands under <target>/', async () => {
    const err = sink();
    const result = await runChecks({ cwd: dir, config, runner: lintRunner({}), baseline: null, stderr: err.out });
    expect(err.text()).toMatch(/✔ web:lint\s/);
    expect(err.text()).toMatch(/✔ api:lint\s/);
    expect(result.summary.checks.find((c) => c.name === 'web:lint')).toMatchObject({ output_file: 'web/lint.json' });
    expect(JSON.parse(await readFile(join(dir, '.check', 'web', 'lint.json'), 'utf8'))).toEqual({ diagnostics: [] });
  });

  test("a red target check's excerpt names its findings from the repo root, and its file under <target>/", async () => {
    const err = sink();
    await runChecks({ cwd: dir, config, runner: lintRunner({ api: [['src/a.ts', 'no-x', 'bad']] }), baseline: null, stderr: err.out });
    expect(err.text()).toContain('           apps/api/src/a.ts  bad  [no-x]\n           full output: .check/api/lint.json\n');
    expect(err.text()).not.toContain('.check/web/');
  });
});

/** The checks a run ran, in summary order. */
function checksRan(result: RunResult): RunResult['summary']['checks'] {
  return result.summary.checks.filter((c) => c.skipped !== true);
}

/** A cspell line for one unknown word, and the key it takes. */
const CSPELL_LINE = 'docs/old.md:3:7 - teh\n';
const SPELL_KEY = 'docs/old.md::teh';

/** Every check red: one lint finding in each target, and one unknown word in the repo. */
const red: CheckRunner = (r) => {
  if (r.slot === 'spell') return Promise.resolve({ ok: false, exit_code: 1, stdout: CSPELL_LINE, stderr: '' });
  return Promise.resolve({ ok: false, exit_code: 1, stdout: oxlint([['src/a.ts', 'no-x', 'bad']]), stderr: '' });
};

/** A baseline file's text holding `entries`. */
const slots = (entries: Record<string, string[]>): string => JSON.stringify({ schema_version: 1, slots: entries });

describe('runChecks over local targets, each with its own baseline file (D10)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-orch-shards-'));
    await writeFiles(dir, {
      'web/checkride.config.json': JSON.stringify({ lang: 'ts', checks: { lint: 'oxlint' } }),
      'services/api/checkride.config.json': JSON.stringify({ lang: 'ts', checks: { lint: 'oxlint' } }),
    });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** `web` and `api` local, with the repo-scope `spell` beside them. */
  const local: CheckrideConfig = {
    targets: { web: { root: 'web', local: true }, api: { root: 'services/api', local: true } },
    checks: { spell: 'cspell' },
  };

  const WEB_KEY = 'web/src/a.ts:no-x:bad';
  const API_KEY = 'services/api/src/a.ts:no-x:bad';

  /** A partial run of the three checks over the files on disk, with each check's verdict by name. */
  async function verdicts(declared: CheckrideConfig = local): Promise<Record<string, string>> {
    const result = await runChecks({ cwd: dir, config: declared, runner: red, only: ['lint', 'spell'], stderr: sink().out });
    return Object.fromEntries(checksRan(result).map((c) => [c.name, c.ok ? `masked ${c.baselined ?? 0}` : 'red']));
  }

  test("each target's findings mask from the file at its root, and the repo-scope check's from the root file", async () => {
    await writeFiles(dir, {
      'checkride.baseline.json': slots({ spell: [SPELL_KEY] }),
      'web/checkride.baseline.json': slots({ 'web:lint': [WEB_KEY] }),
      'services/api/checkride.baseline.json': slots({ 'api:lint': [API_KEY] }),
    });
    expect(await verdicts()).toEqual({ 'web:lint': 'masked 1', 'api:lint': 'masked 1', spell: 'masked 1' });
  });

  test("a key in another target's file, or a repo-scope key in a target's, masks nothing", async () => {
    await writeFiles(dir, {
      'web/checkride.baseline.json': slots({ 'web:lint': [WEB_KEY], 'api:lint': [API_KEY], spell: [SPELL_KEY] }),
    });
    expect(await verdicts()).toEqual({ 'web:lint': 'masked 1', 'api:lint': 'red', spell: 'red' });
  });

  test("a local target's keys still in the root file mask, so making a target local turns nothing red (D28)", async () => {
    await writeFiles(dir, { 'checkride.baseline.json': slots({ spell: [SPELL_KEY], 'web:lint': [WEB_KEY], 'api:lint': [API_KEY] }) });
    expect(await verdicts()).toEqual({ 'web:lint': 'masked 1', 'api:lint': 'masked 1', spell: 'masked 1' });
  });

  test('a file left at the root of a target that is no longer local is still read (D37)', async () => {
    await writeFiles(dir, {
      'web/checkride.baseline.json': slots({ 'web:lint': [WEB_KEY] }),
      'services/api/checkride.baseline.json': slots({ 'api:lint': [API_KEY] }),
    });
    const turnedBack: CheckrideConfig = {
      targets: { web: { root: 'web', local: true }, api: { lang: 'ts', root: 'services/api', checks: { lint: 'oxlint' } } },
      checks: { spell: 'cspell' },
    };
    expect(await verdicts(turnedBack)).toEqual({ 'web:lint': 'masked 1', 'api:lint': 'masked 1', spell: 'red' });
  });

  test("a file that can't be parsed turns only its own target's grandfathered findings red (D47)", async () => {
    await writeFiles(dir, {
      'checkride.baseline.json': slots({ spell: [SPELL_KEY] }),
      'web/checkride.baseline.json': '<<<<<<< HEAD\n{ mangled\n',
      'services/api/checkride.baseline.json': slots({ 'api:lint': [API_KEY] }),
    });
    expect(await verdicts()).toEqual({ 'web:lint': 'red', 'api:lint': 'masked 1', spell: 'masked 1' });
  });

  test("a named suite reads <root>/checkride.<suite>.baseline.json, and never the default suite's file (D12)", async () => {
    await writeFiles(dir, {
      'web/checkride.evals.config.json': JSON.stringify({ lang: 'ts', checks: { lint: 'oxlint' } }),
      'web/checkride.evals.baseline.json': slots({ 'web:lint': [WEB_KEY] }),
      'services/api/checkride.evals.config.json': JSON.stringify({ lang: 'ts', checks: { lint: 'oxlint' } }),
      'services/api/checkride.baseline.json': slots({ 'api:lint': [API_KEY] }),
    });
    const result = await runChecks({ cwd: dir, config: local, suite: suiteNamed('evals'), runner: red, only: ['lint'], stderr: sink().out });
    expect(Object.fromEntries(checksRan(result).map((c) => [c.name, c.ok]))).toEqual({ 'web:lint': true, 'api:lint': false });
  });

  test('an injected baseline stands in for every file', async () => {
    await writeFiles(dir, { 'web/checkride.baseline.json': slots({ 'web:lint': [WEB_KEY] }) });
    const result = await runChecks({ cwd: dir, config: local, runner: red, baseline: null, only: ['lint'], stderr: sink().out });
    expect(checksRan(result).map((c) => c.ok)).toEqual([false, false]);
  });
});

/** A runner where each target's lint reports `found[<target>]`, `spell` its one unknown word when `found.spell` is set, and every other check passes. */
function shardRunner(found: { web?: [string, string, string][]; api?: [string, string, string][]; spell?: boolean }): CheckRunner {
  return (r) => {
    if (r.slot === 'spell') return Promise.resolve({ ok: found.spell !== true, exit_code: found.spell === true ? 1 : 0, stdout: found.spell === true ? CSPELL_LINE : '', stderr: '' });
    if (r.slot !== 'lint') return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });
    const findings = (r.target === 'web' ? found.web : found.api) ?? [];
    return Promise.resolve({ ok: findings.length === 0, exit_code: findings.length === 0 ? 0 : 1, stdout: oxlint(findings), stderr: '' });
  };
}

describe('the ratchet over local targets, each file on its own (D10)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-orch-shard-ratchet-'));
    await writeFiles(dir, {
      'web/checkride.config.json': JSON.stringify({ lang: 'ts', checks: { lint: 'oxlint' } }),
      'services/api/checkride.config.json': JSON.stringify({ lang: 'ts', checks: { lint: 'oxlint' } }),
    });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const local: CheckrideConfig = {
    targets: { web: { root: 'web', local: true }, api: { root: 'services/api', local: true } },
    checks: { spell: 'cspell' },
  };

  const ROOT = 'checkride.baseline.json';
  const WEB = 'web/checkride.baseline.json';
  const API = 'services/api/checkride.baseline.json';
  const WEB_A = 'web/src/a.ts:no-x:bad';
  const WEB_B = 'web/src/b.ts:no-y:worse';
  const API_A = 'services/api/src/a.ts:no-x:bad';

  const text = (file: string): Promise<string> => readFile(join(dir, file), 'utf8');
  const held = async (file: string): Promise<Record<string, string[]>> => (JSON.parse(await text(file)) as Baseline).slots;

  /** Everything the three files grandfather still found: nothing to prune. */
  const allFound = { web: [['src/a.ts', 'no-x', 'bad'], ['src/b.ts', 'no-y', 'worse']], api: [['src/a.ts', 'no-x', 'bad']], spell: true } satisfies Parameters<typeof shardRunner>[0];

  /** The three files, each holding its own checks, written compact so a rewrite shows in the bytes. */
  async function eachItsOwn(): Promise<void> {
    await writeFiles(dir, {
      [ROOT]: slots({ spell: [SPELL_KEY] }),
      [WEB]: slots({ 'web:lint': [WEB_A, WEB_B] }),
      [API]: slots({ 'api:lint': [API_A] }),
    });
  }

  test("a key fixed in web rewrites web's file, and leaves api's and the root file byte-identical", async () => {
    await eachItsOwn();
    const err = sink();
    const result = await runChecks({ cwd: dir, config: local, runner: shardRunner({ ...allFound, web: [['src/a.ts', 'no-x', 'bad']] }), stderr: err.out });
    expect(result.exitCode).toBe(0);
    expect(await text(WEB)).toBe(`${JSON.stringify({ schema_version: 1, slots: { 'web:lint': [WEB_A] } }, null, 2)}\n`);
    expect(await text(API)).toBe(slots({ 'api:lint': [API_A] }));
    expect(await text(ROOT)).toBe(slots({ spell: [SPELL_KEY] }));
    expect(err.text()).toContain('\nbaseline: ratcheted web/checkride.baseline.json to 1 grandfathered finding(s)\n');
    expect(err.text()).not.toContain(`ratcheted ${ROOT}`);
  });

  test('a full run with nothing fixed and every key at home writes no file', async () => {
    await eachItsOwn();
    const err = sink();
    await runChecks({ cwd: dir, config: local, runner: shardRunner(allFound), stderr: err.out });
    expect([await text(ROOT), await text(WEB), await text(API)]).toEqual([slots({ spell: [SPELL_KEY] }), slots({ 'web:lint': [WEB_A, WEB_B] }), slots({ 'api:lint': [API_A] })]);
    expect(err.text()).not.toContain('ratcheted');
  });

  test("a local target's keys still in the root file move to its own, which the run makes (D28)", async () => {
    await writeFiles(dir, { [ROOT]: slots({ spell: [SPELL_KEY], 'web:lint': [WEB_A, WEB_B], 'api:lint': [API_A] }), [API]: slots({ 'api:lint': [] }) });
    const err = sink();
    const result = await runChecks({ cwd: dir, config: local, runner: shardRunner(allFound), stderr: err.out });
    expect(result.exitCode).toBe(0);
    expect(await held(ROOT)).toEqual({ spell: [SPELL_KEY] });
    expect(await held(WEB)).toEqual({ 'web:lint': [WEB_A, WEB_B] });
    expect(await held(API)).toEqual({ 'api:lint': [API_A] });
    expect(err.text()).toContain(
      '\nbaseline: ratcheted checkride.baseline.json to 1 grandfathered finding(s)\n' +
      'baseline: ratcheted web/checkride.baseline.json to 2 grandfathered finding(s)\n' +
      'baseline: ratcheted services/api/checkride.baseline.json to 1 grandfathered finding(s)\n',
    );
  });

  test('a file left by a target that is no longer local gives its keys to the root file and is removed (D37)', async () => {
    await writeFiles(dir, { [ROOT]: slots({ spell: [SPELL_KEY] }), [WEB]: slots({ 'web:lint': [WEB_A, WEB_B] }), [API]: slots({ 'api:lint': [API_A] }) });
    const turnedBack: CheckrideConfig = {
      targets: { web: { root: 'web', local: true }, api: { lang: 'ts', root: 'services/api', checks: { lint: 'oxlint' } } },
      checks: { spell: 'cspell' },
    };
    const err = sink();
    const result = await runChecks({ cwd: dir, config: turnedBack, runner: shardRunner(allFound), stderr: err.out });
    expect(result.exitCode).toBe(0);
    expect(await held(ROOT)).toEqual({ 'api:lint': [API_A], spell: [SPELL_KEY] });
    expect(existsSync(join(dir, API))).toBe(false);
    expect(await text(WEB)).toBe(slots({ 'web:lint': [WEB_A, WEB_B] }));
    expect(err.text()).toContain('baseline: removed services/api/checkride.baseline.json, whose target is no longer local: the root file holds its keys now\n');
  });

  test("a baseline file at a target's root that holds none of its checks is nobody's shard, and is left alone", async () => {
    const nested = slots({ lint: ['src/a.ts:no-x:bad'] });
    await writeFiles(dir, { [ROOT]: slots({ spell: [SPELL_KEY, 'docs/gone.md::fixd'] }), [API]: nested });
    const plain: CheckrideConfig = { targets: { api: { lang: 'ts', root: 'services/api', checks: { lint: 'oxlint' } } }, checks: { spell: 'cspell' } };
    await runChecks({ cwd: dir, config: plain, runner: shardRunner({ spell: true }), stderr: sink().out });
    expect(await held(ROOT)).toEqual({ spell: [SPELL_KEY] });
    expect(await text(API)).toBe(nested);
  });

  test('a partial run writes none of them', async () => {
    await writeFiles(dir, { [ROOT]: slots({ spell: [SPELL_KEY], 'web:lint': [WEB_A] }), [WEB]: slots({ 'web:lint': [WEB_B] }), [API]: slots({ 'api:lint': [API_A] }) });
    const before = [await text(ROOT), await text(WEB), await text(API)];
    await runChecks({ cwd: dir, config: local, runner: shardRunner({}), only: ['lint', 'spell'], stderr: sink().out });
    await runChecks({ cwd: dir, config: local, runner: shardRunner({}), skip: ['links'], stderr: sink().out });
    expect([await text(ROOT), await text(WEB), await text(API)]).toEqual(before);
  });

  test("a file that can't be parsed is never written, and its target's keys in the root file stay where they are (D47)", async () => {
    const mangled = '<<<<<<< HEAD\n{ mangled\n';
    await writeFiles(dir, { [ROOT]: slots({ spell: [SPELL_KEY], 'web:lint': [WEB_A, WEB_B], 'api:lint': [API_A] }), [WEB]: mangled });
    const err = sink();
    await runChecks({ cwd: dir, config: local, runner: shardRunner({ api: [['src/a.ts', 'no-x', 'bad']] }), stderr: err.out });
    expect(await text(WEB)).toBe(mangled);
    // spell's key is pruned and api's moves home, while web's two stay, unpruned, until its file is repaired.
    expect(await held(ROOT)).toEqual({ spell: [], 'web:lint': [WEB_A, WEB_B] });
    expect(await held(API)).toEqual({ 'api:lint': [API_A] });
    expect(err.text()).toContain("baseline: web/checkride.baseline.json is present but unparseable — possibly a botched merge; its target's grandfathered findings report red. See `checkride recover`.\n");
    expect(err.text()).not.toContain('baseline: checkride.baseline.json is present');
  });

  test("an entry in a target's file that isn't its target's is nobody's to move, and stays through a rewrite", async () => {
    await writeFiles(dir, { [WEB]: slots({ 'web:lint': [WEB_A, WEB_B], 'api:lint': ['not-webs'], spell: ['nor-this'] }) });
    await runChecks({ cwd: dir, config: local, runner: shardRunner({ web: [['src/a.ts', 'no-x', 'bad']] }), stderr: sink().out });
    expect(await held(WEB)).toEqual({ 'api:lint': ['not-webs'], spell: ['nor-this'], 'web:lint': [WEB_A] });
    expect(existsSync(join(dir, ROOT))).toBe(false);
  });

  test('a consumer run writes none of them, and names the files it would have', async () => {
    await eachItsOwn();
    await writeFile(join(dir, 'defaults.json'), '{}');
    const err = sink();
    await runChecks({ cwd: dir, config: local, runner: shardRunner({}), defaults: { path: 'defaults.json', config: {} }, stderr: err.out });
    expect([await text(ROOT), await text(WEB), await text(API)]).toEqual([slots({ spell: [SPELL_KEY] }), slots({ 'web:lint': [WEB_A, WEB_B] }), slots({ 'api:lint': [API_A] })]);
    expect(err.text()).toContain('baseline: not ratcheted, because a run with --defaults never writes checkride.baseline.json, web/checkride.baseline.json, services/api/checkride.baseline.json\n');
  });
});

describe('runFix with targets', () => {
  test("a target's fixer runs under the package manager declared nearest its root", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkride-fix-targets-'));
    try {
      await mkdir(join(dir, 'apps', 'web'), { recursive: true });
      await mkdir(join(dir, 'apps', 'api'), { recursive: true });
      await writeFile(join(dir, 'apps', 'api', 'yarn.lock'), '');
      const seen: string[] = [];
      await runFix({
        cwd: dir,
        config,
        stderr: sink().out,
        fixRunner: (_adapter, ctx) => {
          seen.push(`${ctx.cwd.slice(dir.length)}:${ctx.pm}`);
          return Promise.resolve({ ok: true, exit_code: 0 });
        },
      });
      expect(seen).toEqual(['/apps/web:pnpm', '/apps/api:yarn']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a target's fixer runs from its root, named <target>:<slot>", async () => {
    const ran: string[] = [];
    const err = sink();
    const result = await runFix({
      cwd: '/repo',
      config,
      stderr: err.out,
      pm: 'pnpm',
      fixRunner: (adapter, ctx) => {
        ran.push(`${adapter.name}@${ctx.cwd}`);
        return Promise.resolve({ ok: true, exit_code: 0 });
      },
    });
    expect(result.exitCode).toBe(0);
    expect(ran).toEqual(['oxlint@/repo/apps/web', 'oxlint@/repo/apps/api']);
    expect(err.text()).toContain('✔ web:lint');
    expect(err.text()).toContain('✔ api:lint');
  });
});

/** A selected check of `slot`, in `target` when given, skipped with `skip` when given. */
function check(slot: string, target?: { name: string; root: string }, skip: string | null = null): ResolvedCheck {
  return { slot, optIn: false, adapter: null, skip, ...(target ? { target: target.name, root: target.root } : {}) };
}

describe('skipUnchanged', () => {
  const web = { name: 'web', root: 'apps/web' };
  const api = { name: 'api', root: 'apps/api' };

  test("a target with nothing changed under its root sits out, naming the root, and keeps its place", () => {
    const selected = [check('lint', web), check('lint', api), check('links')];
    expect(skipUnchanged(selected, ['apps/web/src/a.ts']).map((r) => r.skip)).toEqual([null, 'no changes under apps/api', null]);
  });

  test('a repo-scope or top-level check runs with nothing changed at all', () => {
    expect(skipUnchanged([check('links'), check('licenses')], []).map((r) => r.skip)).toEqual([null, null]);
  });

  test('a check resolution already skipped keeps its own reason', () => {
    expect(skipUnchanged([check('test', api, 'no adapter detected')], [])[0]?.skip).toBe('no adapter detected');
  });

  test('null skips nothing', () => {
    const selected = [check('lint', web), check('lint', api)];
    expect(skipUnchanged(selected, null)).toEqual(selected);
  });
});

/** Is a real git usable here? The `--changed` suites skip without it. */
const gitAvailable = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const gitIn = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, stdio: 'pipe' });
};

/** Write `files` under `dir`, making their directories. */
async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of fixture files; sequential keeps each directory made before its file.
    await mkdir(join(dir, path, '..'), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop -- as above.
    await writeFile(join(dir, path), text);
  }
}

/** A runner whose every check passes with nothing to say. */
const passing: CheckRunner = () => Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });

/** The checks a run ran, sorted by name, since a pool finishes them in any order. */
function ranNames(result: RunResult): string[] {
  return result.summary.checks.filter((c) => c.skipped !== true).map((c) => c.name).toSorted();
}

/**
 * A frontend and an api target, each with a lint, plus a top-level custom
 * check of the whole repo; `unclaimed`, which every multi-target run has,
 * runs as a repo-scope check too.
 */
const changedConfig: CheckrideConfig = {
  targets: {
    web: { lang: 'ts', root: 'frontend', checks: { lint: 'oxlint' } },
    api: { lang: 'ts', root: 'api', checks: { lint: 'oxlint' } },
  },
  checks: { tally: { command: 'node' } },
};

describe.skipIf(!gitAvailable)('runChecks --changed with targets (S10)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-changed-'));
    gitIn(dir, 'init', '-q', '-b', 'main');
    await writeFiles(dir, { '.gitignore': '.check/\n', 'frontend/a.ts': 'a\n', 'api/main.go': 'm\n', 'README.md': 'r\n' });
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-q', '-m', 'one');
    gitIn(dir, 'checkout', '-q', '-b', 'feature');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const runChanged = (stderr: Out = sink().out): Promise<RunResult> =>
    runChecks({ cwd: dir, config: changedConfig, runner: passing, baseline: null, changed: true, base: { ref: 'main', from: '--base' }, stderr });

  test("a change only under frontend/ skips api's checks with their reason, and runs web's and the repo's", async () => {
    await writeFile(join(dir, 'frontend/a.ts'), 'a2\n');
    gitIn(dir, 'commit', '-q', '-am', 'web change');
    const err = sink();
    const result = await runChanged(err.out);
    expect(ranNames(result)).toEqual(['links', 'tally', 'unclaimed', 'web:lint']);
    expect(result.summary.checks.find((c) => c.name === 'api:lint')).toMatchObject({
      skipped: true, ok: true, exit_code: null, reason: 'no changes under api', target: 'api',
    });
    expect(result.summary.checks_run).toBe(4);
    expect(err.text()).toMatch(/○ api:lint\s+skip {2}no changes under api/);
    expect(result.exitCode).toBe(0);
  });

  test('changes are measured from the merge base, so what main changed since is not this change (R10.2)', async () => {
    gitIn(dir, 'checkout', '-q', 'main');
    await writeFile(join(dir, 'api/main.go'), 'm2\n');
    gitIn(dir, 'commit', '-q', '-am', 'api change on main');
    gitIn(dir, 'checkout', '-q', 'feature');
    await writeFile(join(dir, 'frontend/a.ts'), 'a2\n');
    expect(ranNames(await runChanged())).toEqual(['links', 'tally', 'unclaimed', 'web:lint']);
  });

  test('an untracked file affects its target, and an unstaged edit does too', async () => {
    await writeFile(join(dir, 'api/new.go'), 'n\n');
    expect(ranNames(await runChanged())).toEqual(['api:lint', 'links', 'tally', 'unclaimed']);
    await rm(join(dir, 'api/new.go'));
    await writeFile(join(dir, 'frontend/a.ts'), 'a2\n');
    expect(ranNames(await runChanged())).toEqual(['links', 'tally', 'unclaimed', 'web:lint']);
  });

  test('a file moved between targets affects both', async () => {
    gitIn(dir, 'mv', 'api/main.go', 'frontend/main.go');
    expect(ranNames(await runChanged())).toEqual(['api:lint', 'links', 'tally', 'unclaimed', 'web:lint']);
  });

  test('with nothing changed, every target sits out and the repo-scope checks still run', async () => {
    const result = await runChanged();
    expect(ranNames(result)).toEqual(['links', 'tally', 'unclaimed']);
    expect(result.summary.checks.filter((c) => c.reason?.startsWith('no changes') === true).map((c) => `${c.name}: ${c.reason}`)).toEqual([
      'web:lint: no changes under frontend',
      'api:lint: no changes under api',
    ]);
  });
});

describe.skipIf(!gitAvailable)('the red-run hint over local targets', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-shard-hint-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test("names the target's file whose history grandfathered the new findings", async () => {
    gitIn(dir, 'init', '-q', '-b', 'main');
    await writeFiles(dir, {
      '.gitignore': '.check/\n',
      'checkride.baseline.json': slots({ spell: [SPELL_KEY] }),
      'web/checkride.config.json': JSON.stringify({ lang: 'ts', checks: { lint: 'oxlint' } }),
      'web/checkride.baseline.json': slots({ 'web:lint': ['web/src/a.ts:no-x:bad'] }),
    });
    gitIn(dir, 'add', '.');
    gitIn(dir, 'commit', '-q', '-m', 'baseline');
    // A merge that dropped web's entry: the finding it grandfathered reads as new.
    await writeFile(join(dir, 'web/checkride.baseline.json'), slots({ 'web:lint': [] }));
    const err = sink();
    const webLocal: CheckrideConfig = { targets: { web: { root: 'web', local: true } }, checks: { spell: 'cspell' } };
    const result = await runChecks({ cwd: dir, config: webLocal, runner: shardRunner({ web: [['src/a.ts', 'no-x', 'bad']], spell: true }), only: ['lint', 'spell'], stderr: err.out });
    expect(result.exitCode).toBe(1);
    expect(err.text()).toMatch(/hint: 1 of 1 new finding\(s\) were grandfathered in web\/checkride\.baseline\.json until [0-9a-f]{7,} — a merge may have dropped baseline entries; see `checkride recover`\n/);
    expect(err.text()).not.toContain('grandfathered in checkride.baseline.json');
  });
});

describe('runChecks --changed outside a git repository (F19)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-nogit-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('no target is skipped, and stderr says so', async () => {
    const err = sink();
    const result = await runChecks({ cwd: dir, config: changedConfig, runner: passing, baseline: null, changed: true, json: true, stdout: sink().out, stderr: err.out });
    expect(ranNames(result)).toEqual(['api:lint', 'links', 'tally', 'unclaimed', 'web:lint']);
    expect(result.summary.checks.filter((c) => c.reason?.startsWith('no changes') === true)).toEqual([]);
    expect(err.text()).toContain("--changed: can't list the changed paths (HEAD names no commit), so no target is skipped");
  });

  test('a repo without targets has nothing to skip, and says nothing more', async () => {
    const err = sink();
    await runChecks({ cwd: dir, config: { checks: { tally: { command: 'node' } } }, runner: passing, baseline: null, changed: true, json: true, stdout: sink().out, stderr: err.out });
    expect(err.text()).not.toContain('no target is skipped');
  });
});

describe('runChecks at a Go module root without targets (D66)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-orch-implicit-go-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test("each go check runs from the root as its bare slot, with the go pack's chain, variables and packages", async () => {
    await writeFile(join(dir, 'go.mod'), 'module example.com/m\n\ngo 1.24\n');
    const seen: Record<string, { cwd: string; out?: string; pins?: readonly string[]; env?: Readonly<Record<string, string>>; args: readonly string[] }> = {};
    const runner: CheckRunner = (r, ctx) => {
      seen[r.slot] = {
        cwd: ctx.cwd,
        args: r.adapter?.args ?? [],
        ...(ctx.out !== undefined ? { out: ctx.out } : {}),
        ...(ctx.pins !== undefined ? { pins: ctx.pins } : {}),
        ...(ctx.packEnv !== undefined ? { env: ctx.packEnv } : {}),
      };
      return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });
    };
    const status = sink();
    const result: RunResult = await runChecks({ cwd: dir, runner, baseline: null, only: ['types', 'test'], stdout: status.out, stderr: sink().out });
    expect(seen['types']).toMatchObject({ cwd: dir, out: '.check', pins: PACKS.go.pins, env: PACKS.go.env });
    expect(seen['types']?.args.at(-1)).toBe('./...');
    expect(seen['test']).toMatchObject({ cwd: dir, pins: PACKS.go.pins });
    expect(result.summary.checks.find((c) => c.name === 'types')).toMatchObject({ pack: 'go', adapter: 'go-build' });
    expect(result.summary).not.toHaveProperty('targets');
    expect(status.text()).not.toContain(':types');
  });
});

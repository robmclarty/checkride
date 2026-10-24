/**
 * Contract: the programmatic surface (docs/contract.md §Programmatic surface).
 *
 * Everything exported from the package root, and from the `checkride/findings`
 * subpath, is public and semver-bound; everything else is internal by
 * definition. This test locks each export list exactly: removing or renaming
 * one is a breaking change (major-version decision + a "Contract" CHANGELOG
 * entry), and adding one means adding it here and to the contract doc in the
 * same commit.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import * as findings from '../../src/findings/api.js';
import * as api from '../../src/index.js';

/** The frozen value-export list (types are checked by the compiler, not here). */
const PUBLIC_EXPORTS = [
  'ADAPTERS',
  'DEFAULT_TIMEOUT_SECONDS',
  'PACKS',
  'SCHEMA_VERSION',
  'SLOTS',
  'TOOLS',
  'loadConfig',
  'resolveChecks',
  'runChecks',
  'runDoctor',
  'runFix',
  'runInit',
  'selectChecks',
];

/** The catalogue position of the slot an adapter fills. */
const slotIndex = (a: api.Adapter): number => api.SLOTS.findIndex((s) => s.name === a.slot);

describe('programmatic surface', () => {
  test('the package root exports exactly the promised names', () => {
    expect(Object.keys(api).toSorted()).toEqual(PUBLIC_EXPORTS);
  });

  test('contract constants hold their promised values', () => {
    expect(api.SCHEMA_VERSION).toBe(1);
    expect(api.DEFAULT_TIMEOUT_SECONDS).toBe(600);
  });
});

describe('the registry exports', () => {
  test('are plain data: each survives a JSON round trip unchanged', () => {
    for (const value of [api.SLOTS, api.ADAPTERS, api.PACKS, api.TOOLS]) {
      expect(JSON.parse(JSON.stringify(value))).toStrictEqual(value);
    }
  });

  test('PACKS keys each pack by its own name', () => {
    expect(Object.keys(api.PACKS).length).toBeGreaterThan(0);
    for (const [key, pack] of Object.entries(api.PACKS)) {
      expect(pack.name).toBe(key);
    }
  });

  test('ADAPTERS is the ts and repo packs\' rows, grouped by slot in SLOTS order', () => {
    const rows = [...api.PACKS.ts.adapters, ...api.PACKS.repo.adapters];
    // Every row exactly once, and nothing else.
    expect(api.ADAPTERS).toHaveLength(rows.length);
    for (const row of rows) {
      expect(api.ADAPTERS.filter((a) => a === row)).toHaveLength(1);
    }
    // Slot by slot in catalogue order, each slot's rows in their pack's order.
    for (const slot of api.SLOTS) {
      const inRegistry = api.ADAPTERS.filter((a) => a.slot === slot.name);
      expect(inRegistry).toEqual(rows.filter((a) => a.slot === slot.name));
    }
    const positions = api.ADAPTERS.map(slotIndex);
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
  });

  test('every slot declares its scope, and the repo pack fills exactly the repo-scope slots', () => {
    const repoSlots = new Set(api.PACKS.repo.adapters.map((a) => a.slot));
    for (const slot of api.SLOTS) {
      expect(slot.scope, `${slot.name} declares no scope`).toBe(repoSlots.has(slot.name) ? 'repo' : 'target');
    }
  });
});

/** `oxlint --format=json` with one error and one warning on `src/a.ts`. */
const OXLINT = JSON.stringify({
  diagnostics: [
    { filename: 'src/a.ts', code: 'eslint(eqeqeq)', message: 'Expected ===', severity: 'error', labels: [{ span: { line: 3, column: 5 } }] },
    { filename: 'src/a.ts', code: 'eslint(no-debugger)', message: 'No debugger', severity: 'warning', labels: [{ span: { line: 7, column: 1 } }] },
  ],
});

/** A runner that prints `OXLINT` for every `lint` and one unknown word for `spell`, as the tools would. */
const replay: api.RunOptions['runner'] = (r) =>
  Promise.resolve({ ok: false, exit_code: 1, stdout: r.slot === 'spell' ? 'docs/a.md:2:4 - Unknown word (teh)\n' : OXLINT, stderr: '' });

describe('the checkride/findings subpath', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-findings-contract-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('exports exactly parseFindings, findingsFor and isParseable', () => {
    expect(Object.keys(findings).toSorted()).toEqual(['findingsFor', 'isParseable', 'parseFindings']);
  });

  test('package.json maps checkride/findings to its built entry and types', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { exports: Record<string, unknown> };
    expect(manifest.exports['./findings']).toEqual({ types: './dist/findings/api.d.ts', default: './dist/findings/api.js' });
  });

  test('the go, rust and bash packs\' lint and cargo check output is parseable', () => {
    for (const adapter of ['golangci-lint', 'staticcheck', 'clippy', 'cargo-check', 'shellcheck']) expect(findings.isParseable(adapter), adapter).toBe(true);
  });

  test('the docs, spell and type-checker output is parseable', () => {
    for (const adapter of ['markdownlint-cli2', 'rumdl', 'typos', 'tsc', 'go-build']) expect(findings.isParseable(adapter), adapter).toBe(true);
  });

  test('a tsc run that stopped short of some errors, which the baseline neither masks nor prunes with, still parses into every finding', () => {
    const stopped = "lib/src/broken.ts(1,34): error TS1005: ',' expected.\napp/src/main.ts(3,7): error TS2322: Type 'number' is not assignable to type 'string'.\n";
    expect(findings.parseFindings('tsc', stopped)?.map((f) => [f.file, f.rule, f.message])).toEqual([
      ['lib/src/broken.ts', 'TS1005', "',' expected."],
      ['app/src/main.ts', 'TS2322', "Type 'number' is not assignable to type 'string'."],
    ]);
    expect(findings.parseFindings('tsc', "error TS6053: File '/repo/api/tsconfig.json' not found.\n")).toHaveLength(1);
  });

  test('the python pack\'s ruff, mypy and basedpyright output is parseable', () => {
    for (const adapter of ['ruff', 'mypy', 'basedpyright']) expect(findings.isParseable(adapter), adapter).toBe(true);
  });

  test('the terraform pack\'s tflint, terraform validate and trivy output is parseable', () => {
    for (const adapter of ['tflint', 'terraform-validate', 'trivy-config']) expect(findings.isParseable(adapter), adapter).toBe(true);
  });

  test('an adapter with no parser returns null (F45)', () => {
    expect(findings.isParseable('vitest')).toBe(false);
    expect(findings.parseFindings('vitest', 'FAIL src/a.test.ts')).toBeNull();
  });

  test("findingsFor reads each summary entry's own artifact out of the run's output directory", async () => {
    const config: api.CheckrideConfig = { checks: { lint: 'oxlint', spell: 'cspell' } };
    const run = await api.runChecks({ cwd: dir, config, runner: replay, baseline: null, only: ['lint', 'spell'], stderr: { write: () => true } });
    const read = (name: string): findings.Finding[] | null => {
      const check = run.summary.checks.find((c) => c.name === name);
      return check ? findings.findingsFor(check, join(dir, '.check'), { repoRoot: dir }) : null;
    };
    expect(read('lint')).toEqual([
      { adapter: 'oxlint', slot: 'lint', file: 'src/a.ts', line: 3, column: 5, rule: 'eslint(eqeqeq)', message: 'Expected ===', severity: 'error', gates: true },
      { adapter: 'oxlint', slot: 'lint', file: 'src/a.ts', line: 7, column: 1, rule: 'eslint(no-debugger)', message: 'No debugger', severity: 'warning', gates: false },
    ]);
    expect(read('spell')).toEqual([{ adapter: 'cspell', slot: 'spell', file: 'docs/a.md', line: 2, column: 4, rule: '', message: 'Unknown word (teh)', gates: true }]);
  });

  test("a target's findings name files from the repo root", async () => {
    const config: api.CheckrideConfig = { targets: { web: { lang: 'ts', root: 'apps/web', checks: { lint: 'oxlint' } } } };
    const run = await api.runChecks({ cwd: dir, config, runner: replay, baseline: null, only: ['lint'], stderr: { write: () => true } });
    const check = run.summary.checks.find((c) => c.name === 'web:lint');
    expect(check && findings.findingsFor(check, join(dir, '.check'), { repoRoot: dir })?.map((f) => [f.slot, f.file, f.line])).toEqual([
      ['lint', 'apps/web/src/a.ts', 3],
      ['lint', 'apps/web/src/a.ts', 7],
    ]);
  });
});

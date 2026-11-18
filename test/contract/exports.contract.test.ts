/**
 * Contract: the programmatic surface (docs/contract.md §Programmatic surface).
 *
 * Everything exported from the package root, and from the `checkride/findings`
 * subpath, is public and semver-bound; everything else is internal by
 * definition. The root carries only the names a surveyed consumer imports or
 * a doc's example shows. This test locks each export list exactly: removing or
 * renaming one is a breaking change (major-version decision + a "Contract"
 * CHANGELOG entry), and adding one means adding it here and to the contract
 * doc in the same commit.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { SCHEMA_VERSION } from '../../src/adapters.js';
import * as findings from '../../src/findings/api.js';
import * as api from '../../src/index.js';
import { DEFAULT_TIMEOUT_SECONDS } from '../../src/orchestrator/index.js';

/** The frozen value-export list: the names a surveyed consumer imports, or a doc's example shows. */
const PUBLIC_EXPORTS = ['runChecks', 'runDoctor'];

/** The frozen type-export list, read from the barrel's `export type` lines, since types leave no runtime trace. */
const PUBLIC_TYPES = ['DoctorCheck', 'RunOptions', 'RunResult', 'Summary', 'SummaryCheck'];

/** Every name the barrel's `export type { ... }` statements re-export. */
const typeExports = (source: string): string[] =>
  [...source.matchAll(/export\s+type\s*\{([^}]*)\}/g)].flatMap((m) => (m[1] ?? '').split(',').map((n) => n.trim()).filter((n) => n !== ''));

describe('programmatic surface', () => {
  test('the package root exports exactly the promised names', () => {
    expect(Object.keys(api).toSorted()).toEqual(PUBLIC_EXPORTS);
  });

  test('the package root exports exactly the promised types', () => {
    const barrel = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
    expect(typeExports(barrel).toSorted()).toEqual(PUBLIC_TYPES);
  });

  test('the promised constants hold their values, though neither is exported', () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(DEFAULT_TIMEOUT_SECONDS).toBe(600);
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

  test('the security slot\'s pnpm audit report is parseable, each advisory a finding with no file under its GHSA id', () => {
    expect(findings.isParseable('pnpm-audit')).toBe(true);
    const report = JSON.stringify({
      advisories: { 1: { module_name: 'zod', title: 'Zod can exhaust memory', severity: 'high', github_advisory_id: 'GHSA-mrhx-c7xc-m3w5', patched_versions: '>=4.6.6', findings: [{ version: '4.4.3' }] } },
      metadata: { vulnerabilities: { high: 1 } },
    });
    expect(findings.parseFindings('pnpm-audit', report)?.map((f) => [f.file, f.rule, f.message, f.severity, f.gates])).toEqual([
      ['', 'GHSA-mrhx-c7xc-m3w5', 'zod 4.4.3: Zod can exhaust memory (fixed in >=4.6.6)', 'high', true],
    ]);
    expect(findings.parseFindings('pnpm-audit', '{"error":{"message":"timeout"}}')).toBeNull();
  });

  test('the odin pack\'s compiler output is parseable under each row that runs odin check', () => {
    for (const adapter of ['odin-check', 'odin-vet', 'odin-unused']) expect(findings.isParseable(adapter), adapter).toBe(true);
  });

  test("the schema built-in's report is parseable, each error a finding with its keyword as the rule", () => {
    expect(findings.isParseable('schema')).toBe(true);
    const report = JSON.stringify({
      rules: [{ schema: 'checkride:agent-skill', files: 1 }],
      errors: [{ file: 'skills/pdf/SKILL.md', rule: 0, instancePath: '/name', keyword: 'pattern', message: 'must match pattern "^[a-z]+$"', line: 2 }],
    });
    expect(findings.parseFindings('schema', report)).toEqual([
      { adapter: 'schema', slot: 'schema', file: 'skills/pdf/SKILL.md', line: 2, rule: 'pattern', message: '/name must match pattern "^[a-z]+$"', gates: true },
    ]);
    expect(findings.parseFindings('schema', JSON.stringify({ rules: [], errors: [] }))).toEqual([]);
  });

  test('an adapter with no parser returns null (F45)', () => {
    expect(findings.isParseable('vitest')).toBe(false);
    expect(findings.parseFindings('vitest', 'FAIL src/a.test.ts')).toBeNull();
  });

  test("findingsFor reads each summary entry's own artifact out of the run's output directory", async () => {
    const config: api.RunOptions['config'] = { checks: { lint: 'oxlint', spell: 'cspell' } };
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
    const config: api.RunOptions['config'] = { targets: { web: { lang: 'ts', root: 'apps/web', checks: { lint: 'oxlint' } } } };
    const run = await api.runChecks({ cwd: dir, config, runner: replay, baseline: null, only: ['lint'], stderr: { write: () => true } });
    const check = run.summary.checks.find((c) => c.name === 'web:lint');
    expect(check && findings.findingsFor(check, join(dir, '.check'), { repoRoot: dir })?.map((f) => [f.slot, f.file, f.line])).toEqual([
      ['lint', 'apps/web/src/a.ts', 3],
      ['lint', 'apps/web/src/a.ts', 7],
    ]);
  });
});

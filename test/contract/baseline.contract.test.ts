/**
 * Contract: the committed baseline file (docs/contract.md §checkride.baseline.json).
 *
 * The file `checkride baseline` writes must validate against the published
 * schema (`schema/checkride.baseline.schema.json`) exactly, be byte-canonical,
 * carry keys that name a finding by what it is rather than where it sits, and
 * read tolerantly — never breaking a run, and failing closed on a newer
 * version. Several of these are also covered as unit tests in
 * `src/__tests__/baseline.test.ts`; this file re-asserts the promised subset
 * on purpose, because a break here is a version decision, not a test edit.
 * The last suite holds `baseline diff --json` (docs/contract.md §CLI).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv } from 'ajv';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter, Slot } from '../../src/adapters.js';
import type { Baseline } from '../../src/baseline/index.js';
import { BASELINE_FILE, BASELINE_SCHEMA_VERSION, fingerprint, observedTally, parseBaseline, shardMap, shardOf, writeBaseline } from '../../src/baseline/index.js';
import { runBaseline, runBaselineVersions } from '../../src/baseline-command.js';
import { runCli } from '../../src/cli.js';
import type { CheckRunner, Out } from '../../src/orchestrator/index.js';
import { runChecks } from '../../src/orchestrator/index.js';
import { suiteNamed } from '../../src/suite.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, '..', '..', 'schema');

const ajv = new Ajv({ allErrors: true });
const validateBaseline = ajv.compile(JSON.parse(readFileSync(join(schemaDir, 'checkride.baseline.schema.json'), 'utf8')) as object);
const validateSummary = ajv.compile(JSON.parse(readFileSync(join(schemaDir, 'checkride.summary.schema.json'), 'utf8')) as object);

function sink(): { out: Out; text: () => string } {
  const chunks: string[] = [];
  return { out: { write: (t: string) => { chunks.push(t); return true; } }, text: () => chunks.join('') };
}

// --- fixtures: the tools' own report shapes, inline so the contract stays self-contained ---

/** oxlint --format=json: the same finding at two positions, plus one whose message wraps. */
const OXLINT_REPORT = JSON.stringify({
  diagnostics: [
    { filename: 'src/a.ts', code: 'eslint(no-unused-vars)', message: "Variable 'x' is declared but never used.", labels: [{ span: { line: 3 } }] },
    { filename: 'src/a.ts', code: 'eslint(no-unused-vars)', message: "Variable 'x' is declared but never used.", labels: [{ span: { line: 40 } }] },
    { filename: 'src/b.ts', code: 'eslint(no-explicit-any)', message: 'Unexpected any.\n   Specify a different type.', labels: [{ span: { line: 7 } }] },
  ],
});
const OXLINT_KEYS = [
  "src/a.ts:eslint(no-unused-vars):Variable 'x' is declared but never used.",
  'src/b.ts:eslint(no-explicit-any):Unexpected any. Specify a different type.',
];

/** cspell's default reporter line. */
const CSPELL_REPORT = 'docs/old.md:3:7 - teh\n';

/** vale --output=JSON: an alert report with one error and one warning, and a runtime-error report. */
const VALE_ALERTS = JSON.stringify({
  'docs/a.md': [
    { Check: 'Repo.Latin', Message: "Use 'for example' instead of 'e.g.'.", Severity: 'error' },
    { Check: 'Repo.Weasel', Message: "Consider removing 'very'.", Severity: 'warning' },
  ],
});
const VALE_RUNTIME_ERROR = JSON.stringify({ Code: 'E100', Text: 'no config file found', Path: '', Line: 0, Span: [0, 0] });

function adapter(name: string, slot: string, outputFile: string | null): Adapter {
  return { name, slot, description: name, detect: [], command: 'node', args: [], outputFile, devDeps: {} };
}

// Real adapter *names* on fake commands: the extractor dispatch is by name, and
// nothing here spawns — the runner supplies each slot's report. go build's
// `types` is the slot with no extractor.
const ADAPTERS: Adapter[] = [adapter('cspell', 'spell', null), adapter('oxlint', 'lint', 'lint.json'), adapter('go-build', 'types', null)];
// Listed out of alphabetical order on purpose: the file must not care.
const SLOTS: Slot[] = [{ name: 'spell' }, { name: 'lint' }, { name: 'types' }];

const REPORTS: Record<string, string> = { lint: OXLINT_REPORT, spell: CSPELL_REPORT, types: '' };

/** Every slot with findings is red (as the real tools would be); `types` is clean. */
const redRunner: CheckRunner = (r) => {
  const stdout = REPORTS[r.slot] ?? '';
  const ok = stdout === '';
  return Promise.resolve({ ok, exit_code: ok ? 0 : 1, stdout, stderr: '' });
};

/** A `tsc --build` that failed printing `stdout`, as tsc does with any error. */
function tscPrinting(stdout: string): CheckRunner {
  return () => Promise.resolve({ ok: false, exit_code: 2, stdout, stderr: '' });
}

/** {@link redRunner}, recording the pin each tool resolved through as a real runner does: lint's lockfile copy, the rest from PATH. */
const pinnedRed: CheckRunner = async (r, ctx) => ({
  ...(await redRunner(r, ctx)),
  ...(r.slot === 'lint' ? { pin_source: 'js-lockfile' as const, tool_version: '1.87.0' } : { pin_source: 'path' as const }),
});

/** Every key a baseline grandfathers, across its checks. */
function keysOf(b: Baseline): string[] {
  return Object.values(b.slots).flat();
}

describe('checkride.baseline.json', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-baseline-contract-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const baselinePath = (): string => join(dir, BASELINE_FILE);

  async function capture(): Promise<{ raw: string; parsed: Baseline }> {
    await runBaseline({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: null, runner: redRunner, stdout: sink().out, stderr: sink().out });
    const raw = await readFile(baselinePath(), 'utf8');
    return { raw, parsed: JSON.parse(raw) as Baseline };
  }

  test('the file name and schema version constants are the contract', () => {
    // The generated `protect` hook denies edits to the file by this name.
    expect(BASELINE_FILE).toBe('checkride.baseline.json');
    expect(BASELINE_SCHEMA_VERSION).toBe(1);
  });

  test('a captured baseline validates against the published schema and is byte-canonical', async () => {
    const { raw, parsed } = await capture();
    const valid = validateBaseline(parsed);
    expect(validateBaseline.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
    expect(parsed.schema_version).toBe(BASELINE_SCHEMA_VERSION);
    // Sorted slots, sorted keys within each, two-space indent, trailing newline —
    // JSON.parse keeps on-disk key order, so one comparison pins all four.
    expect(Object.keys(parsed.slots)).toEqual(Object.keys(parsed.slots).toSorted());
    for (const keys of Object.values(parsed.slots)) expect(keys).toEqual(keys.toSorted());
    expect(raw).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    // A slot with no extractor is absent; a fingerprintable one is present.
    expect(parsed.slots['types']).toBeUndefined();
    expect(parsed.slots['lint']).toEqual(OXLINT_KEYS);
    expect(parsed.slots['spell']).toEqual(['docs/old.md::teh']);
    // Every check it observed is counted; a key found twice records it, and one found once records nothing.
    expect(parsed.counts).toEqual({ lint: { [OXLINT_KEYS[0] ?? '']: 2 }, spell: {} });
  });

  /**
   * Contract: `captured_with` records how `checkride baseline` captured each
   * check's keys, as the run's summary recorded the pin: written after the
   * slots, checks sorted, `pin_source` before `tool_version`, and valid
   * against the published schema.
   */
  test('a capture records how each check was captured, in the canonical shape the schema describes', async () => {
    await runBaseline({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: null, runner: pinnedRed, stdout: sink().out, stderr: sink().out });
    const raw = await readFile(baselinePath(), 'utf8');
    const parsed = JSON.parse(raw) as Baseline;
    expect(validateBaseline(parsed), JSON.stringify(validateBaseline.errors)).toBe(true);
    expect(Object.keys(parsed)).toEqual(['schema_version', 'slots', 'captured_with', 'counts']);
    expect(Object.keys(parsed.captured_with ?? {})).toEqual(Object.keys(parsed.slots));
    expect(parsed.captured_with?.['lint']).toEqual({ pin_source: 'js-lockfile', tool_version: '1.87.0' });
    expect(raw).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  });

  /**
   * Contract: a check of a pack that names a toolchain records the release
   * its tool ran on as `toolchain_version`, written after `tool_version`
   * whatever order it was built in, and valid against the published schema.
   */
  test("a check's toolchain release is written last in its record, and validates", async () => {
    await writeBaseline(dir, {
      schema_version: 1,
      slots: { 'api:lint': [], lint: [] },
      captured_with: {
        'api:lint': { toolchain_version: '1.25.3', tool_version: '2.11.4', pin_source: 'nix' },
        lint: { toolchain_version: '1.26.1', pin_source: 'path' },
      },
    });
    const raw = await readFile(baselinePath(), 'utf8');
    const parsed = JSON.parse(raw) as Baseline;
    expect(validateBaseline(parsed), JSON.stringify(validateBaseline.errors)).toBe(true);
    expect(Object.keys(parsed.captured_with?.['api:lint'] ?? {})).toEqual(['pin_source', 'tool_version', 'toolchain_version']);
    expect(Object.keys(parsed.captured_with?.['lint'] ?? {})).toEqual(['pin_source', 'toolchain_version']);
    expect(raw).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  });

  /**
   * Contract: `checkride baseline --versions` adds no key (§Who writes to
   * it). Where a check reported only keys its entry holds, under a copy a pin
   * of the repo's chose, it records that copy and prunes the keys the copy no
   * longer reports; a check that reported a key its entry lacks leaves the
   * file as it was.
   */
  test('baseline --versions moves a record to the copy that ran and prunes, and never adds a key', async () => {
    await runBaseline({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: null, runner: pinnedRed, stdout: sink().out, stderr: sink().out });
    const captured = await readFile(baselinePath(), 'utf8');
    const upgraded = (lint: string): CheckRunner => async (r, ctx) => ({
      ...(await pinnedRed(r, ctx)),
      ...(r.slot === 'lint' ? { stdout: lint, tool_version: '1.88.0' } : {}),
    });

    const withNew = JSON.stringify({ diagnostics: [...(JSON.parse(OXLINT_REPORT) as { diagnostics: unknown[] }).diagnostics, { filename: 'src/c.ts', code: 'eslint(no-debugger)', message: 'Unexpected debugger statement.' }] });
    await runBaselineVersions({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: null, runner: upgraded(withNew), stdout: sink().out, stderr: sink().out });
    expect(await readFile(baselinePath(), 'utf8')).toBe(captured);

    const subset = JSON.stringify({ diagnostics: (JSON.parse(OXLINT_REPORT) as { diagnostics: unknown[] }).diagnostics.slice(0, 1) });
    const result = await runBaselineVersions({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: null, runner: upgraded(subset), stdout: sink().out, stderr: sink().out });
    const raw = await readFile(baselinePath(), 'utf8');
    const parsed = JSON.parse(raw) as Baseline;
    expect(validateBaseline(parsed), JSON.stringify(validateBaseline.errors)).toBe(true);
    expect(raw).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    expect(parsed.slots['lint']).toEqual(OXLINT_KEYS.slice(0, 1));
    expect(parsed.captured_with?.['lint']).toEqual({ pin_source: 'js-lockfile', tool_version: '1.88.0' });
    expect(result.written).toBe(true);
    const before = new Set(keysOf(JSON.parse(captured) as Baseline));
    for (const key of keysOf(parsed)) expect(before.has(key), key).toBe(true);
  });

  test('construction order and duplicate keys never reach the disk', async () => {
    await writeBaseline(dir, { schema_version: 1, slots: { spell: ['z', 'a', 'a'], lint: ['b'] } });
    const first = await readFile(baselinePath(), 'utf8');
    await writeBaseline(dir, { schema_version: 1, slots: { lint: ['b'], spell: ['a', 'z'] } });
    expect(await readFile(baselinePath(), 'utf8')).toBe(first);
    expect((JSON.parse(first) as Baseline).slots).toEqual({ lint: ['b'], spell: ['a', 'z'] });
  });

  test('keys carry no line or column, collapse whitespace, and are absent for a slot with no extractor', () => {
    const lint = fingerprint('oxlint', OXLINT_REPORT);
    expect(lint).not.toBeNull();
    // Two positions of one finding collapse to one key; the wrapped message is one line.
    expect([...(lint ?? [])].toSorted()).toEqual(OXLINT_KEYS);
    for (const k of lint ?? []) expect(k).not.toMatch(/:\d+:\d+/);
    expect(fingerprint('cspell', CSPELL_REPORT)).toEqual(new Set(['docs/old.md::teh']));
    expect(fingerprint('go-build', 'anything')).toBeNull();
  });

  test('oxlint and ast-grep key a warning only when argv lets it fail', () => {
    const oxlint = JSON.stringify({
      diagnostics: [
        { filename: 'src/a.ts', code: 'eslint(no-debugger)', severity: 'error', message: 'No debugger.' },
        { filename: 'src/a.ts', code: 'eslint(eqeqeq)', severity: 'warning', message: 'Use ===.' },
      ],
    });
    const oxlintArgv = ['pnpm', 'exec', 'oxlint', '--format=json'];
    expect(fingerprint('oxlint', oxlint, oxlintArgv)).toEqual(new Set(['src/a.ts:eslint(no-debugger):No debugger.']));
    expect(fingerprint('oxlint', oxlint, [...oxlintArgv, '--deny-warnings'])?.size).toBe(2);
    expect(fingerprint('oxlint', oxlint, [...oxlintArgv, '--max-warnings=0'])?.size).toBe(2);
    // A wrapper hides the tool's flags, so every finding is keyed.
    expect(fingerprint('oxlint', oxlint, ['pnpm', 'run', 'lint'])?.size).toBe(2);

    const astGrep = JSON.stringify([
      { file: 'src/a.ts', ruleId: 'no-class', severity: 'error', message: 'no classes' },
      { file: 'src/a.ts', ruleId: 'no-var', severity: 'warning', message: 'prefer const' },
    ]);
    const astGrepArgv = ['pnpm', 'exec', 'ast-grep', 'scan', '--json=compact'];
    expect(fingerprint('ast-grep', astGrep, astGrepArgv)).toEqual(new Set(['src/a.ts:no-class:no classes']));
    expect(fingerprint('ast-grep', astGrep, [...astGrepArgv, '--error'])?.size).toBe(2);
    expect(fingerprint('ast-grep', astGrep, [...astGrepArgv, '--error=no-var'])?.size).toBe(2);
  });

  test('vale keys only error-severity alerts and refuses a runtime-error report', () => {
    expect(fingerprint('vale', VALE_ALERTS)).toEqual(new Set(["docs/a.md:Repo.Latin:Use 'for example' instead of 'e.g.'."]));
    // A report that is not an alert report is "not observed" (null), never "clean" (empty).
    expect(fingerprint('vale', VALE_RUNTIME_ERROR)).toBeNull();
    expect(fingerprint('vale', '{}')).toEqual(new Set());
  });

  test('the go, rust and bash lint tools key as <file>:<rule>:<message>, and cargo check never keys', () => {
    const golangci = JSON.stringify({
      Issues: [{ FromLinter: 'errcheck', Text: 'Error return value is not checked', Severity: '', Pos: { Filename: 'store/store.go', Line: 11, Column: 11 } }],
    });
    expect(fingerprint('golangci-lint', golangci, undefined, 'svc')).toEqual(new Set(['svc/store/store.go:errcheck:Error return value is not checked']));
    // staticcheck prints absolute paths, and a key names them from the repo root.
    const staticcheck = '{"code":"S1003","severity":"error","location":{"file":"/repo/svc/store.go","line":16,"column":5},"message":"use strings.Contains"}\n';
    expect(fingerprint('staticcheck', staticcheck, undefined, 'svc', '/repo')).toEqual(new Set(['svc/store.go:S1003:use strings.Contains']));
    const cargo = [
      JSON.stringify({
        reason: 'compiler-message',
        message: { level: 'error', code: { code: 'clippy::ptr_arg' }, message: 'writing `&Vec`', spans: [{ file_name: 'src/lib.rs', line_start: 13, column_start: 24, is_primary: true }] },
      }),
      JSON.stringify({ reason: 'build-finished', success: false }),
    ].join('\n');
    expect(fingerprint('clippy', cargo)).toEqual(new Set(['src/lib.rs:clippy::ptr_arg:writing `&Vec`']));
    expect(fingerprint('cargo-check', cargo)).toBeNull();
    const shellcheck = JSON.stringify({ comments: [{ file: 'deploy.sh', line: 9, column: 19, level: 'style', code: 2006, message: 'Use $(...).' }] });
    expect(fingerprint('shellcheck', shellcheck, ['shellcheck', '-f', 'json1'])).toEqual(new Set(['deploy.sh:SC2006:Use $(...).']));
    expect(fingerprint('shellcheck', shellcheck, ['shellcheck', '-f', 'json1', '--severity=warning'])).toEqual(new Set());
  });

  test('the docs and spell tools key as <file>:<rule>:<message>, and go build never keys', () => {
    // markdownlint-cli2 prints on stderr; a rule set to "warning" can't fail the slot.
    const markdownlint = 'docs/a.md:1:1 error MD018/no-missing-space-atx No space after hash\nREADME.md:8:1 warning MD033/no-inline-html Inline HTML\n';
    expect(fingerprint('markdownlint-cli2', markdownlint)).toEqual(new Set(['docs/a.md:MD018:No space after hash']));
    const rumdl = JSON.stringify([{ file: 'docs/a.md', line: 6, column: 1, rule: 'MD040', message: 'Code block missing language', severity: 'warning' }]);
    expect(fingerprint('rumdl', rumdl, ['rumdl', 'check', '--output-format', 'json', '.'])).toEqual(new Set(['docs/a.md:MD040:Code block missing language']));
    expect(fingerprint('rumdl', rumdl, ['rumdl', 'check', '--fail-on', 'error', '--output-format', 'json', '.'])).toEqual(new Set());
    expect(fingerprint('typos', './docs/a.md:3:9: error: `teh` should be `the`\n')).toEqual(new Set(['docs/a.md::`teh` should be `the`']));
    expect(fingerprint('go-build', '{"ImportPath":"x","Action":"build-output","Output":"a.go:1:1: undefined: y\\n"}\n')).toBeNull();
  });

  test("tsc keys as <file>:<code>:<its message's first line>, what tsc filled in '…', and a run that stopped short keys nothing", () => {
    const report = [
      "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/a.ts(9,7): error TS2322: Type '{ id: string; }' is not assignable to type 'number'.",
      "src/b.ts(4,3): error TS2345: Argument of type '{ retry: string; }' is not assignable to parameter of type 'Options'.",
      "  Types of property 'retry' are incompatible.",
      '',
    ].join('\n');
    const argv = ['pnpm', 'exec', 'tsc', '--build'];
    expect(fingerprint('tsc', report, argv, 'web')).toEqual(
      new Set(["web/src/a.ts:TS2322:Type '…' is not assignable to type '…'.", "web/src/b.ts:TS2345:Argument of type '…' is not assignable to parameter of type '…'."]),
    );
    // Past the single-quoted spans: a double-quoted or backtick span, the list a "following …:" message ends on, and every number.
    const filled = [
      "src/c.ts(4,1): error TS2554: Expected 2 arguments, but got 3.",
      "src/c.ts(9,14): error TS2740: Type '{}' is missing the following properties from type 'Wide': a, b, c, d, and 2 more.",
      'src/c.ts(12,1): error TS4023: Exported variable \'x\' has or is using name \'Y\' from external module "/home/ci/repo/node_modules/y" but cannot be named.',
      'src/c.ts(15,9): error TS2208: This type parameter might need an `extends string` constraint.',
      '',
    ].join('\n');
    expect([...(fingerprint('tsc', filled, argv) ?? [])]).toEqual([
      'src/c.ts:TS2554:Expected … arguments, but got ….',
      "src/c.ts:TS2740:Type '…' is missing the following properties from type '…': …",
      'src/c.ts:TS4023:Exported variable \'…\' has or is using name \'…\' from external module "…" but cannot be named.',
      'src/c.ts:TS2208:This type parameter might need an `…` constraint.',
    ]);
    // A syntax error, a diagnostic on a tsconfig or with no file, an unbuilt reference, or any error under --stopBuildOnErrors.
    expect(fingerprint('tsc', `${report}src/c.ts(2,1): error TS1005: ';' expected.\n`, argv)).toBeNull();
    expect(fingerprint('tsc', `${report}tsconfig.json(3,5): error TS5096: Option 'x' can only be used when 'y' is set.\n`, argv)).toBeNull();
    expect(fingerprint('tsc', "error TS6053: File '/repo/api/tsconfig.json' not found.\n", argv)).toBeNull();
    expect(fingerprint('tsc', `${report}src/d.ts(1,20): error TS6305: Output file '/repo/lib/dist/index.d.ts' has not been built from source file '/repo/lib/src/index.ts'.\n`, argv)).toBeNull();
    expect(fingerprint('tsc', report, [...argv, '--stopBuildOnErrors'])).toBeNull();
    expect(fingerprint('tsc', report, [...argv, '-stopBuildOnErrors'])).toBeNull();
    expect(fingerprint('tsc', report, [...argv, '--stopBuildOnErrors', 'false'])?.size).toBe(2);
    expect(fingerprint('tsc', '', [...argv, '--stopBuildOnErrors'])).toEqual(new Set());
    // What a run shows beyond the text tsc's parser reads: a TypeScript before 5.6 under --build, or a tsc that died.
    const failed = { ok: false, exit_code: 2, stdout: report, stderr: '' };
    expect(observedTally('tsc', failed, argv)?.size).toBe(2);
    expect(observedTally('tsc', { ...failed, tool_version: '5.5.4' }, argv)).toBeNull();
    expect(observedTally('tsc', { ...failed, exit_code: 1, stdout: `${report}[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command was killed with SIGKILL (Forced termination): tsc --build\n` }, argv)).toBeNull();
    expect(observedTally('tsc', { ...failed, stderr: 'panic: runtime error: invalid memory address or nil pointer dereference\n' }, argv)).toBeNull();
  });

  test("a tsc run that stopped short, a baseline present, is unmasked, prunes none of the check's keys, and its reason says why", async () => {
    const tscSlots: Slot[] = [{ name: 'types' }];
    const tscAdapters: Adapter[] = [adapter('tsc', 'types', null)];
    const errors = "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n";
    await runBaseline({ cwd: dir, slots: tscSlots, adapters: tscAdapters, config: null, runner: tscPrinting(errors), stdout: sink().out, stderr: sink().out });
    const before = await readFile(baselinePath(), 'utf8');
    const stopped = `src/b.ts(2,1): error TS1005: ';' expected.\n`;
    const result = await runChecks({ cwd: dir, slots: tscSlots, adapters: tscAdapters, config: null, runner: tscPrinting(stopped), json: true, stdout: sink().out, stderr: sink().out });
    const types = result.summary.checks.find((c) => c.name === 'types');
    expect(types?.ok).toBe(false);
    expect(types?.baselined).toBeUndefined();
    expect(types?.reason).toBe("tsc stopped short at `src/b.ts(2,1): error TS1005: ';' expected.`, so the baseline neither masked its findings nor pruned its keys");
    expect(validateSummary(result.summary), JSON.stringify(validateSummary.errors)).toBe(true);
    expect(await readFile(baselinePath(), 'utf8')).toBe(before);
  });

  test('ruff keys as <file>:<rule>:<message>, every violation of it, and neither python type checker keys', () => {
    const ruff = JSON.stringify([{ code: 'F401', message: '`os` imported but unused', filename: 'src/a.py', location: { row: 1, column: 8 }, severity: 'error' }]);
    expect(fingerprint('ruff', ruff)).toEqual(new Set(['src/a.py:F401:`os` imported but unused']));
    const mypy = '{"file": "src/a.py", "line": 7, "column": 11, "message": "Incompatible return value type", "hint": null, "code": "return-value", "severity": "error"}\n';
    expect(fingerprint('mypy', mypy)).toBeNull();
    expect(fingerprint('basedpyright', JSON.stringify({ generalDiagnostics: [], summary: {} }))).toBeNull();
  });

  test('tflint keys as <file>:<rule>:<message>, every issue at its default severity, and neither validate nor trivy keys', () => {
    const tflint = JSON.stringify({
      issues: [{ rule: { name: 'terraform_unused_declarations', severity: 'warning' }, message: 'variable "x" is declared but not used', range: { filename: 'main.tf', start: { line: 1, column: 1 } } }],
      errors: [],
    });
    expect(fingerprint('tflint', tflint)).toEqual(new Set(['main.tf:terraform_unused_declarations:variable "x" is declared but not used']));
    expect(fingerprint('terraform-validate', JSON.stringify({ valid: false, diagnostics: [{ severity: 'error', summary: 'x' }] }))).toBeNull();
    expect(fingerprint('trivy-config', JSON.stringify({ SchemaVersion: 2, Results: [] }))).toBeNull();
  });

  test('the schema built-in adds what a keyword names as at fault to its key, so two errors of one keyword at one pointer differ', () => {
    for (const param of ['name', 'description']) {
      const report = JSON.stringify({ rules: [], errors: [{ file: 'skills/pdf/SKILL.md', rule: 0, instancePath: '', keyword: 'required', message: `must have required property '${param}'`, param }] });
      expect(fingerprint('schema', report)).toEqual(new Set([`skills/pdf/SKILL.md:required::${param}`]));
    }
  });

  test('the schema built-in keys as <file>:<keyword>:<instancePath>, every error, and never on the message', () => {
    const keys = new Set(['skills/pdf/SKILL.md:pattern:/name', 'config/app.json:parse:']);
    for (const message of ['must match pattern "^[a-z0-9]+(-[a-z0-9]+)*$"', 'must match pattern "^[a-z]+$"']) {
      const report = JSON.stringify({
        rules: [{ schema: 'checkride:agent-skill', files: 2 }],
        errors: [
          { file: 'skills/pdf/SKILL.md', rule: 0, instancePath: '/name', keyword: 'pattern', message, line: 2 },
          { file: 'config/app.json', rule: 1, instancePath: '', keyword: 'parse', message: 'Unexpected end of JSON input' },
        ],
      });
      expect(fingerprint('schema', report)).toEqual(keys);
    }
    expect(fingerprint('schema', JSON.stringify({ rules: [], errors: [] }))).toEqual(new Set());
    // A payload that isn't the report is not observed, so it prunes nothing.
    expect(fingerprint('schema', JSON.stringify({ ok: true }))).toBeNull();
  });

  test('odin check keys as <file>::<first message line>, every error, a warning only under -warnings-as-errors, and a run stopped at a syntax error keys nothing', () => {
    // The compiler prints absolute paths, and a key names them from the repo root.
    const vet = JSON.stringify({
      error_count: 1,
      errors: [{ type: 'error', pos: { file: '/repo/game/a.odin', offset: 20, line: 3, column: 2, end_column: 2 }, msgs: ["'x' declared but not used"] }],
    });
    const odinArgv = ['odin', 'check', '.', '-json-errors'];
    expect(fingerprint('odin-vet', vet, odinArgv, 'game', '/repo')).toEqual(new Set(["game/a.odin::'x' declared but not used"]));
    const warned = JSON.stringify({ error_count: 1, errors: [{ type: 'warning', pos: null, msgs: ['Warning: given -define:X is unused in the project', '\tSuggestion: see -show-defineables'] }] });
    expect(fingerprint('odin-check', warned, odinArgv, 'game', '/repo')).toEqual(new Set());
    expect(fingerprint('odin-check', warned, [...odinArgv, '-warnings-as-errors'], 'game', '/repo')).toEqual(new Set(['::Warning: given -define:X is unused in the project']));
    const syntax = JSON.stringify({ error_count: 1, errors: [{ type: 'warning', pos: { file: '/repo/game/b.odin', line: 3, column: 17 }, msgs: ["Syntax Error: Expected a type, got '{'"] }] });
    expect(fingerprint('odin-vet', syntax, odinArgv, 'game', '/repo')).toBeNull();
  });

  test('eslint and biome key as <file>:<rule>:<message>, a warning only when argv lets it fail', () => {
    // eslint prints absolute paths, and a key names them from the repo root.
    const eslint = JSON.stringify([
      {
        filePath: '/repo/web/src/a.js',
        messages: [
          { ruleId: 'eqeqeq', severity: 2, message: "Expected '===' and instead saw '=='.", line: 3, column: 9 },
          { ruleId: 'prefer-const', severity: 1, message: "'x' is never reassigned. Use 'const' instead.", line: 2, column: 7 },
        ],
      },
    ]);
    const eslintArgv = ['eslint', '.', '--format', 'json'];
    expect(fingerprint('eslint', eslint, eslintArgv, 'web', '/repo')).toEqual(new Set(["web/src/a.js:eqeqeq:Expected '===' and instead saw '=='."]));
    expect(fingerprint('eslint', eslint, [...eslintArgv, '--max-warnings', '0'], 'web', '/repo')?.size).toBe(2);
    const biome = JSON.stringify({
      summary: { errors: 1, warnings: 1, infos: 0, diagnosticsNotPrinted: 0 },
      diagnostics: [
        { severity: 'error', message: 'Using == may be unsafe.', category: 'lint/suspicious/noDoubleEquals', location: { path: 'src/a.js', start: { line: 3, column: 9 } } },
        { severity: 'warning', message: 'This let declares a variable that is only assigned once.', category: 'lint/style/useConst', location: { path: 'src/a.js', start: { line: 2, column: 3 } } },
      ],
    });
    const biomeArgv = ['biome', 'check', '--reporter=json'];
    expect(fingerprint('biome', biome, biomeArgv, 'web')).toEqual(new Set(['web/src/a.js:lint/suspicious/noDoubleEquals:Using == may be unsafe.']));
    expect(fingerprint('biome', biome, [...biomeArgv, '--error-on-warnings'], 'web')?.size).toBe(2);
  });

  test("fallow's named units key without a position, and a key in their old positional form reads as the new one", () => {
    const health = JSON.stringify({
      schema_version: 11,
      kind: 'health',
      findings: [
        { path: 'src/foo.component.ts', name: '<component>', line: 11, col: 6 },
        { path: 'src/foo.component.html', name: '<template>', line: 2, col: 7 },
        { path: 'src/bar.component.ts', name: '<template>', line: 3, col: 0 },
      ],
    });
    expect([...(fingerprint('fallow', health) ?? [])].toSorted()).toEqual([
      'health:src/bar.component.ts:<template>:3:0',
      'health:src/foo.component.html:<template>',
      'health:src/foo.component.ts:<component>',
    ]);
    const old = JSON.stringify({ schema_version: 1, slots: { health: ['health:src/foo.component.ts:<component>:11:6', 'health:src/bar.component.ts:<template>:3:0'] } });
    expect(parseBaseline(old)?.slots['health']).toEqual(['health:src/foo.component.ts:<component>', 'health:src/bar.component.ts:<template>:3:0']);
  });

  test.each<{ label: string; raw: string; expected: Baseline | null }>([
    { label: 'an unknown top-level field is ignored', raw: JSON.stringify({ schema_version: 1, slots: { lint: ['a'] }, extra: true }), expected: { schema_version: 1, slots: { lint: ['a'] } } },
    { label: 'a missing schema_version reads as 1', raw: JSON.stringify({ slots: { lint: ['a'] } }), expected: { schema_version: 1, slots: { lint: ['a'] } } },
    { label: 'a newer schema_version is dropped whole', raw: JSON.stringify({ schema_version: 2, slots: { lint: ['a'] } }), expected: null },
    { label: 'slots as an array is rejected', raw: JSON.stringify({ schema_version: 1, slots: [['a']] }), expected: null },
    { label: 'non-string keys and non-array slots are dropped', raw: JSON.stringify({ schema_version: 1, slots: { lint: ['a', 5, null], types: 'nope' } }), expected: { schema_version: 1, slots: { lint: ['a'] } } },
    { label: 'a captured_with entry naming no pin source, or no check in slots, is dropped', raw: JSON.stringify({ schema_version: 1, slots: { lint: ['a'] }, captured_with: { lint: { tool_version: '1.0.0' }, spell: { pin_source: 'path' } } }), expected: { schema_version: 1, slots: { lint: ['a'] } } },
    { label: 'a captured_with that is not an object is ignored', raw: JSON.stringify({ schema_version: 1, slots: { lint: ['a'] }, captured_with: 'path' }), expected: { schema_version: 1, slots: { lint: ['a'] } } },
    {
      label: 'a count for a check or key slots does not hold, or below two, or not whole, is dropped',
      raw: JSON.stringify({ schema_version: 1, slots: { lint: ['a', 'b', 'c'] }, counts: { lint: { a: 3, b: 1, c: 2.5, z: 4 }, spell: { x: 2 } } }),
      expected: { schema_version: 1, slots: { lint: ['a', 'b', 'c'] }, counts: { lint: { a: 3 } } },
    },
    {
      label: 'a check entry in counts that is not an object still counts its check, every key once',
      raw: JSON.stringify({ schema_version: 1, slots: { lint: ['a'] }, counts: { lint: 'many' } }),
      expected: { schema_version: 1, slots: { lint: ['a'] }, counts: { lint: {} } },
    },
    {
      label: 'a counts that is not an object counts every check, each key once, failing closed',
      raw: JSON.stringify({ schema_version: 1, slots: { lint: ['a'], spell: [] }, counts: [] }),
      expected: { schema_version: 1, slots: { lint: ['a'], spell: [] }, counts: { lint: {}, spell: {} } },
    },
    { label: 'malformed JSON is null', raw: '{ not json', expected: null },
    { label: 'empty text is null', raw: '', expected: null },
    { label: 'a JSON array is null', raw: '[]', expected: null },
    { label: 'JSON null is null', raw: 'null', expected: null },
  ])('read is tolerant: $label', ({ raw, expected }) => {
    expect(parseBaseline(raw)).toEqual(expected);
  });

  test('a capture masks the next run, and summary.json says so', async () => {
    const { parsed } = await capture();
    const result = await runChecks({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: null, runner: redRunner, json: true, stdout: sink().out, stderr: sink().out });
    expect(result.ok).toBe(true);
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as {
      checks: { name: string; ok: boolean; baselined?: number }[];
    };
    expect(validateSummary(summary)).toBe(true);
    const lint = summary.checks.find((c) => c.name === 'lint');
    const spell = summary.checks.find((c) => c.name === 'spell');
    // `baselined` counts findings, not keys: lint's three findings share two keys.
    expect(lint).toMatchObject({ ok: true, baselined: 3 });
    expect(spell).toMatchObject({ ok: true, baselined: parsed.slots['spell']?.length });
  });

  /**
   * Contract: a key grandfathers as many findings as its count, one when a
   * counted check records none, and a third `x` in a file that grandfathered
   * two is red, listed with both counts (§A key names a finding).
   */
  test('a counted key grandfathers as many findings as it was captured with, and no more', async () => {
    await capture();
    const thirdX = JSON.stringify({
      diagnostics: [...(JSON.parse(OXLINT_REPORT) as { diagnostics: unknown[] }).diagnostics, { filename: 'src/a.ts', code: 'eslint(no-unused-vars)', message: "Variable 'x' is declared but never used." }],
    });
    const stderr = sink();
    const result = await runChecks({
      cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: null, json: false, stdout: sink().out, stderr: stderr.out,
      runner: (r, ctx) => (r.slot === 'lint' ? Promise.resolve({ ok: false, exit_code: 1, stdout: thirdX, stderr: '' }) : redRunner(r, ctx)),
    });
    expect(result.summary.checks.find((c) => c.name === 'lint')).toMatchObject({ ok: false, baselined: 3, new_count: 1, new: [OXLINT_KEYS[0]] });
    expect(stderr.text()).toContain(`1 new, not in baseline:\n             ${OXLINT_KEYS[0] ?? ''} (3 found, 2 grandfathered)`);
    // The summary on disk names the new finding, apart from the grandfathered ones, and validates (§summary.json).
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as unknown;
    expect(validateSummary(summary), JSON.stringify(validateSummary.errors)).toBe(true);
  });

  /**
   * Contract: a file captured before counts masks as it always did, any
   * number of findings under a key, so an upgrade changes no verdict, and
   * the ratchet never counts its checks; only `checkride baseline` does.
   */
  test('a baseline captured before counts masks any number of findings under a key, and the ratchet leaves it uncounted', async () => {
    await writeBaseline(dir, { schema_version: 1, slots: { lint: OXLINT_KEYS.slice(0, 1), spell: ['docs/old.md::teh'] } });
    const onlyX = JSON.stringify({ diagnostics: (JSON.parse(OXLINT_REPORT) as { diagnostics: unknown[] }).diagnostics.slice(0, 2) });
    const result = await runChecks({
      cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: null, json: true, stdout: sink().out, stderr: sink().out,
      runner: (r, ctx) => (r.slot === 'lint' ? Promise.resolve({ ok: false, exit_code: 1, stdout: onlyX, stderr: '' }) : redRunner(r, ctx)),
    });
    expect(result.summary.checks.find((c) => c.name === 'lint')).toMatchObject({ ok: true, baselined: 2 });
    expect(JSON.parse(await readFile(baselinePath(), 'utf8'))).not.toHaveProperty('counts');
  });

  /** Contract: a full run lowers a count to what it found, written canonical, and never raises one (§Who writes to it). */
  test('the ratchet lowers a count to what a full run found, and never raises one', async () => {
    await capture();
    const oneX = JSON.stringify({ diagnostics: (JSON.parse(OXLINT_REPORT) as { diagnostics: unknown[] }).diagnostics.slice(1) });
    await runChecks({
      cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: null, json: true, stdout: sink().out, stderr: sink().out,
      runner: (r, ctx) => (r.slot === 'lint' ? Promise.resolve({ ok: false, exit_code: 1, stdout: oneX, stderr: '' }) : redRunner(r, ctx)),
    });
    const raw = await readFile(baselinePath(), 'utf8');
    const parsed = JSON.parse(raw) as Baseline;
    expect(validateBaseline(parsed), JSON.stringify(validateBaseline.errors)).toBe(true);
    expect(parsed.slots['lint']).toEqual(OXLINT_KEYS);
    expect(parsed.counts).toEqual({ lint: {}, spell: {} });
    expect(raw).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  });

  test.each<{ label: string; raw: string }>([
    { label: 'an unparseable file (a botched merge)', raw: '<<<<<<< HEAD\n{\n' },
    { label: 'a file from a newer schema version', raw: JSON.stringify({ schema_version: 2, slots: { lint: OXLINT_KEYS, spell: ['docs/old.md::teh'] } }) },
  ])('$label masks nothing, and the run says so', async ({ raw }) => {
    await writeFile(baselinePath(), raw);
    const stderr = sink();
    const result = await runChecks({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: null, runner: redRunner, json: false, stdout: sink().out, stderr: stderr.out });
    expect(result.ok).toBe(false);
    const lint = result.summary.checks.find((c) => c.name === 'lint');
    expect(lint?.ok).toBe(false);
    expect(lint?.baselined).toBeUndefined();
    expect(stderr.text()).toMatch(/unparseable/);
  });
});

/** One lint finding in each target, as oxlint prints it from the target's root, and one unknown word in the repo. */
const shardsRed: CheckRunner = (r) => Promise.resolve({
  ok: false,
  exit_code: 1,
  stdout: r.slot === 'spell' ? CSPELL_REPORT : JSON.stringify({ diagnostics: [{ filename: 'src/a.ts', code: 'no-x', message: 'bad', severity: 'error' }] }),
  stderr: '',
});

/** {@link shardsRed} with each lint resolved through the lockfile at `version`, and web's reporting `web`. */
const shardsPinned = (version: string, web?: string[]): CheckRunner => async (r, ctx) => ({
  ...(await shardsRed(r, ctx)),
  ...(r.slot === 'lint' ? { pin_source: 'js-lockfile' as const, tool_version: version } : { pin_source: 'path' as const }),
  ...(r.slot === 'lint' && r.target === 'web' && web !== undefined
    ? { stdout: JSON.stringify({ diagnostics: web.map((filename) => ({ filename, code: 'no-x', message: 'bad', severity: 'error' })) }) }
    : {}),
});

/**
 * Contract: a local target keeps its keys in a baseline file at its own root
 * (§`checkride.baseline.json`, A local target's file): its name, the read,
 * and the writers, the ratchet, `baseline` and `baseline --versions`, each
 * of which writes every file on its own.
 */
describe("a local target's baseline file", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-shard-contract-'));
    await put('web/checkride.config.json', { lang: 'ts', checks: { lint: 'oxlint' } });
    await put('services/api/checkride.config.json', { lang: 'ts', checks: { lint: 'oxlint' } });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** Write `content` as the file `file`, relative to the repo, making its directory. */
  async function put(file: string, content: object | string): Promise<void> {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));
  }

  const config = {
    targets: { web: { root: 'web', local: true as const }, api: { root: 'services/api', local: true as const } },
    checks: { spell: 'cspell' },
  };

  const WEB = { schema_version: 1, slots: { 'web:lint': ['web/src/a.ts:no-x:bad'] } };
  const API = { schema_version: 1, slots: { 'api:lint': ['services/api/src/a.ts:no-x:bad'] } };
  const ROOT = { schema_version: 1, slots: { spell: ['docs/old.md::teh'] } };

  /** A partial run of the three checks, with whether each passed, by name. */
  async function passed(over: object = {}): Promise<Record<string, boolean>> {
    const result = await runChecks({ cwd: dir, config, runner: shardsRed, only: ['lint', 'spell'], stdout: sink().out, stderr: sink().out, ...over });
    return Object.fromEntries(result.summary.checks.filter((c) => c.skipped !== true).map((c) => [c.name, c.ok]));
  }

  test('the file is <root>/checkride.baseline.json, a named suite\'s <root>/checkride.<suite>.baseline.json, and it owns its target\'s checks alone', () => {
    const map = shardMap(BASELINE_FILE, config.targets);
    expect(map.shards.map((s) => s.file)).toEqual(['web/checkride.baseline.json', 'services/api/checkride.baseline.json']);
    expect(shardOf(map, 'web:lint')).toBe('web/checkride.baseline.json');
    expect(shardOf(map, 'api:lint')).toBe('services/api/checkride.baseline.json');
    expect(shardOf(map, 'spell')).toBe(BASELINE_FILE);
    const evals = suiteNamed('evals');
    expect(shardMap(evals.baselineFile, config.targets).shards.map((s) => s.file)).toEqual([
      'web/checkride.evals.baseline.json',
      'services/api/checkride.evals.baseline.json',
    ]);
  });

  test("a run masks each target's findings from its own file and the repo-scope checks from the root file, and each file is schema version 1", async () => {
    await put(BASELINE_FILE, ROOT);
    await put('web/checkride.baseline.json', WEB);
    await put('services/api/checkride.baseline.json', API);
    for (const file of [ROOT, WEB, API]) expect(validateBaseline(file)).toBe(true);
    expect(await passed()).toEqual({ 'web:lint': true, 'api:lint': true, spell: true });
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as { checks: { name: string; baselined?: number }[] };
    expect(validateSummary(summary)).toBe(true);
    expect(summary.checks.filter((c) => c.baselined !== undefined).map((c) => `${c.name} ${c.baselined}`).toSorted()).toEqual(['api:lint 1', 'spell 1', 'web:lint 1']);
  });

  test("a target's file is read for its own checks and no others", async () => {
    await put('web/checkride.baseline.json', { schema_version: 1, slots: { ...WEB.slots, ...API.slots, ...ROOT.slots } });
    expect(await passed()).toEqual({ 'web:lint': true, 'api:lint': false, spell: false });
  });

  test("a local target's keys still in the root file are read, and so is a file left at the root of a target that is no longer local", async () => {
    await put(BASELINE_FILE, { schema_version: 1, slots: { ...ROOT.slots, ...WEB.slots } });
    await put('services/api/checkride.baseline.json', API);
    const turnedBack = { ...config, targets: { ...config.targets, api: { lang: 'ts' as const, root: 'services/api', checks: { lint: 'oxlint' } } } };
    expect(await passed({ config: turnedBack })).toEqual({ 'web:lint': true, 'api:lint': true, spell: true });
  });

  test("a file that can't be parsed turns only its own target's grandfathered findings red", async () => {
    await put(BASELINE_FILE, ROOT);
    await put('web/checkride.baseline.json', '<<<<<<< HEAD\n{\n');
    await put('services/api/checkride.baseline.json', API);
    expect(await passed()).toEqual({ 'web:lint': false, 'api:lint': true, spell: true });
  });

  /** A full run: each target's lint finds what `web` and `api` say, `spell` its word, and every other check passes. */
  const full = (found: { web: boolean; api: boolean }, over: object = {}): ReturnType<typeof runChecks> =>
    runChecks({
      cwd: dir,
      config,
      runner: (r, ctx) => {
        const quiet = r.slot !== 'spell' && r.slot !== 'lint';
        const fixed = r.slot === 'lint' && !(r.target === 'web' ? found.web : found.api);
        return quiet || fixed ? Promise.resolve({ ok: true, exit_code: 0, stdout: r.slot === 'lint' ? '{"diagnostics":[]}' : '', stderr: '' }) : shardsRed(r, ctx);
      },
      stdout: sink().out,
      stderr: sink().out,
      ...over,
    });

  const text = (file: string): Promise<string> => readFile(join(dir, file), 'utf8');

  /** The three files as written by hand, compact, so a rewrite shows in the bytes. */
  async function eachItsOwn(): Promise<string[]> {
    await put(BASELINE_FILE, ROOT);
    await put('web/checkride.baseline.json', WEB);
    await put('services/api/checkride.baseline.json', API);
    return [JSON.stringify(ROOT), JSON.stringify(WEB), JSON.stringify(API)];
  }

  test("a full run that prunes a key in web rewrites web's file, canonical, and leaves api's and the root file byte-identical", async () => {
    const [root, , api] = await eachItsOwn();
    const result = await full({ web: false, api: true });
    expect(result.ok).toBe(true);
    const web = await text('web/checkride.baseline.json');
    expect(web).toBe(`${JSON.stringify({ schema_version: 1, slots: { 'web:lint': [] } }, null, 2)}\n`);
    expect(validateBaseline(JSON.parse(web))).toBe(true);
    expect(await text('services/api/checkride.baseline.json')).toBe(api);
    expect(await text(BASELINE_FILE)).toBe(root);
  });

  test('a full run moves a stray key to the file that owns it, and removes a file its target no longer owns', async () => {
    await put(BASELINE_FILE, { schema_version: 1, slots: { ...ROOT.slots, ...WEB.slots } });
    await put('services/api/checkride.baseline.json', API);
    const turnedBack = { ...config, targets: { ...config.targets, api: { lang: 'ts' as const, root: 'services/api', checks: { lint: 'oxlint' } } } };
    const result = await full({ web: true, api: true }, { config: turnedBack });
    expect(result.ok).toBe(true);
    expect((JSON.parse(await text(BASELINE_FILE)) as Baseline).slots).toEqual({ ...API.slots, ...ROOT.slots });
    expect((JSON.parse(await text('web/checkride.baseline.json')) as Baseline).slots).toEqual(WEB.slots);
    expect(existsSync(join(dir, 'services/api/checkride.baseline.json'))).toBe(false);
  });

  test('a partial run writes none of them', async () => {
    await put(BASELINE_FILE, { schema_version: 1, slots: { ...ROOT.slots, ...WEB.slots } });
    await put('services/api/checkride.baseline.json', API);
    const before = [await text(BASELINE_FILE), await text('services/api/checkride.baseline.json')];
    await full({ web: false, api: false }, { only: ['lint', 'spell'] });
    await full({ web: false, api: false }, { skip: ['links'] });
    expect([await text(BASELINE_FILE), await text('services/api/checkride.baseline.json')]).toEqual(before);
    expect(existsSync(join(dir, 'web/checkride.baseline.json'))).toBe(false);
  });

  test("a file that can't be parsed is never written", async () => {
    await put(BASELINE_FILE, { schema_version: 1, slots: { ...ROOT.slots, ...WEB.slots } });
    await put('web/checkride.baseline.json', '<<<<<<< HEAD\n{\n');
    await full({ web: true, api: true });
    expect(await text('web/checkride.baseline.json')).toBe('<<<<<<< HEAD\n{\n');
    expect((JSON.parse(await text(BASELINE_FILE)) as Baseline).slots).toEqual({ ...ROOT.slots, ...WEB.slots });
  });

  const slotsOf = async (file: string): Promise<Record<string, string[]>> => (JSON.parse(await text(file)) as Baseline).slots;
  const WEB_FILE = 'web/checkride.baseline.json';
  const API_FILE = 'services/api/checkride.baseline.json';
  const turnedBack = { ...config, targets: { ...config.targets, api: { lang: 'ts' as const, root: 'services/api', checks: { lint: 'oxlint' } } } };

  test("baseline writes each target's keys to its own file, canonical, and the repo-scope checks' to the root file", async () => {
    const err = sink();
    const result = await runBaseline({ cwd: dir, config, runner: shardsRed, stdout: sink().out, stderr: err.out });
    expect(result.exitCode).toBe(0);
    expect(await slotsOf(BASELINE_FILE)).toEqual(ROOT.slots);
    expect(await slotsOf(WEB_FILE)).toEqual(WEB.slots);
    expect(await slotsOf(API_FILE)).toEqual(API.slots);
    for (const file of [BASELINE_FILE, WEB_FILE, API_FILE]) {
      // oxlint-disable-next-line no-await-in-loop -- three small files, read in turn.
      const raw = await text(file);
      expect(validateBaseline(JSON.parse(raw)), file).toBe(true);
      expect(raw, file).toBe(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
    }
    expect(err.text()).toContain(
      '\nbaseline: wrote checkride.baseline.json — 1 finding(s) across spell\n' +
      'baseline: wrote web/checkride.baseline.json — 1 finding(s) across web:lint\n' +
      'baseline: wrote services/api/checkride.baseline.json — 1 finding(s) across api:lint\n',
    );
    // What the capture returns is the whole baseline, and the next run masks with all three files.
    expect(result.baseline.slots).toEqual({ ...ROOT.slots, ...WEB.slots, ...API.slots });
    expect(await passed()).toEqual({ 'web:lint': true, 'api:lint': true, spell: true });
  });

  test('baseline moves stray keys both ways at once', async () => {
    // web's keys still in the root file, and a file left where api was local.
    await put(BASELINE_FILE, { schema_version: 1, slots: { ...ROOT.slots, ...WEB.slots } });
    await put(API_FILE, API);
    const err = sink();
    await runBaseline({ cwd: dir, config: turnedBack, runner: shardsRed, stdout: sink().out, stderr: err.out });
    expect(await slotsOf(BASELINE_FILE)).toEqual({ ...API.slots, ...ROOT.slots });
    expect(await slotsOf(WEB_FILE)).toEqual(WEB.slots);
    expect(existsSync(join(dir, API_FILE))).toBe(false);
    expect(err.text()).toContain('baseline: removed services/api/checkride.baseline.json, whose target is no longer local: the root file holds its keys now\n');
  });

  test("a narrowed baseline writes the checks it recorded to the file that owns them, and leaves every other file byte-identical", async () => {
    const [root, web] = await eachItsOwn();
    await put(API_FILE, { schema_version: 1, slots: { 'api:lint': ['services/api/src/old.ts:no-x:gone'] } });
    const err = sink();
    await runBaseline({ cwd: dir, config, runner: shardsRed, only: ['api'], stdout: sink().out, stderr: err.out });
    expect(await slotsOf(API_FILE)).toEqual(API.slots);
    expect(await text(BASELINE_FILE)).toBe(root);
    expect(await text(WEB_FILE)).toBe(web);
    expect(err.text()).toContain('\nbaseline: wrote services/api/checkride.baseline.json — 1 finding(s) across api:lint\n');
    expect(err.text()).not.toContain('wrote checkride.baseline.json');
  });

  test("a narrowed baseline takes a recorded check's stray keys out of the file that doesn't own it", async () => {
    await put(BASELINE_FILE, { schema_version: 1, slots: { ...ROOT.slots, 'web:lint': ['web/src/old.ts:no-x:gone'] } });
    await runBaseline({ cwd: dir, config, runner: shardsRed, only: ['web'], stdout: sink().out, stderr: sink().out });
    expect(await slotsOf(BASELINE_FILE)).toEqual(ROOT.slots);
    expect(await slotsOf(WEB_FILE)).toEqual(WEB.slots);
    expect(existsSync(join(dir, API_FILE))).toBe(false);
  });

  test("baseline --versions re-records each file's copies in place: no key moves, and a file with nothing re-recorded stays byte-identical", async () => {
    const was = { pin_source: 'js-lockfile', tool_version: '1.87.0' };
    const now = { pin_source: 'js-lockfile', tool_version: '1.88.0' };
    // web's check sits in two files: a key still in the root file, and two in its own, one of them fixed since.
    await put(BASELINE_FILE, { schema_version: 1, slots: { ...ROOT.slots, 'web:lint': ['web/src/b.ts:no-x:bad'] }, captured_with: { 'web:lint': was } });
    await put(WEB_FILE, { schema_version: 1, slots: { 'web:lint': ['web/src/a.ts:no-x:bad', 'web/src/gone.ts:no-x:bad'] }, captured_with: { 'web:lint': was } });
    await put(API_FILE, { ...API, captured_with: { 'api:lint': now } });
    const api = await text(API_FILE);
    const err = sink();
    const result = await runBaselineVersions({ cwd: dir, config, runner: shardsPinned('1.88.0', ['src/a.ts', 'src/b.ts']), stdout: sink().out, stderr: err.out });
    expect(result.written).toBe(true);
    const root = JSON.parse(await text(BASELINE_FILE)) as Baseline;
    const web = JSON.parse(await text(WEB_FILE)) as Baseline;
    expect(root.slots).toEqual({ ...ROOT.slots, 'web:lint': ['web/src/b.ts:no-x:bad'] });
    expect(root.captured_with).toEqual({ 'web:lint': now });
    expect(web.slots).toEqual({ 'web:lint': ['web/src/a.ts:no-x:bad'] });
    expect(web.captured_with).toEqual({ 'web:lint': now });
    expect(await text(API_FILE)).toBe(api);
    expect(err.text()).toContain('baseline --versions: wrote checkride.baseline.json, web/checkride.baseline.json: 1 re-recorded, 1 left, 1 unchanged; review them with `git diff checkride.baseline.json web/checkride.baseline.json`\n');
  });

  test.each<{ label: string; run: (over: object) => Promise<unknown>; says: string }>([
    { label: 'baseline', run: (over) => runBaseline({ ...over }), says: "baseline: web/checkride.baseline.json can't be parsed, or comes from a newer checkride, and nothing writes over a baseline file it couldn't read; restore it with `checkride recover`, or remove the file and run this again" },
    { label: 'baseline --only', run: (over) => runBaseline({ ...over, only: ['api'] }), says: "baseline --only: web/checkride.baseline.json can't be parsed" },
    { label: 'baseline --versions', run: (over) => runBaselineVersions({ ...over }), says: "baseline --versions: web/checkride.baseline.json can't be parsed" },
  ])("$label stops before anything runs on a target's file it couldn't parse, and writes nothing", async ({ run, says }) => {
    await put(BASELINE_FILE, ROOT);
    await put(WEB_FILE, '<<<<<<< HEAD\n{\n');
    let ran = false;
    const runner: CheckRunner = (r, ctx) => {
      ran = true;
      return shardsRed(r, ctx);
    };
    await expect(run({ cwd: dir, config, runner, stdout: sink().out, stderr: sink().out })).rejects.toThrow(says);
    expect(ran).toBe(false);
    expect(await text(WEB_FILE)).toBe('<<<<<<< HEAD\n{\n');
    expect(await text(BASELINE_FILE)).toBe(JSON.stringify(ROOT));
    expect(existsSync(join(dir, API_FILE))).toBe(false);
  });

  test('a repo with no target below its root reads the root file alone', async () => {
    await writeBaseline(dir, { schema_version: 1, slots: { spell: ['docs/old.md::teh'] } });
    await put('web/checkride.baseline.json', { schema_version: 1, slots: { lint: OXLINT_KEYS } });
    const result = await runChecks({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: null, runner: redRunner, only: ['lint', 'spell'], stdout: sink().out, stderr: sink().out });
    expect(Object.fromEntries(result.summary.checks.filter((c) => c.skipped !== true).map((c) => [c.name, c.ok]))).toEqual({ spell: true, lint: false });
  });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

/**
 * `baseline diff --json` (docs/contract.md §CLI). A review agent counts what a
 * PR grandfathers from this object, so its six fields, their types, and the
 * exit codes are the promise. Real git, because the ref is resolved through it.
 */
describe('checkride baseline diff --json', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-baseline-diff-contract-'));
    git(dir, 'init', '-q');
    await writeBaseline(dir, { schema_version: 1, slots: { lint: ['src/a.ts:rule:kept', 'src/a.ts:rule:fixed'], struct: ['src/b.ts:no-class:no classes'] } });
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'adopt a baseline');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function diffJson(argv: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
    const out = sink();
    const code = await runCli(['baseline', 'diff', ...argv, '--json'], { cwd: dir, stdout: out.out, stderr: sink().out });
    return { code, json: JSON.parse(out.text()) as Record<string, unknown> };
  }

  test('prints exactly ref, sha, added, removed, added_count, removed_count, recounted and recounted_count', async () => {
    await writeBaseline(dir, {
      schema_version: 1,
      slots: { lint: ['src/a.ts:rule:kept', "src/c.ts:no-unused-vars:'x' is never used"] },
      counts: { lint: { 'src/a.ts:rule:kept': 2 } },
    });
    const { code, json } = await diffJson(['HEAD']);
    expect(code).toBe(0);
    expect(Object.keys(json)).toEqual(['ref', 'sha', 'added', 'removed', 'added_count', 'removed_count', 'recounted', 'recounted_count']);
    expect(json).toEqual({
      ref: 'HEAD',
      sha: git(dir, 'rev-parse', 'HEAD').trim(),
      added: { lint: ["src/c.ts:no-unused-vars:'x' is never used"] },
      removed: { lint: ['src/a.ts:rule:fixed'], struct: ['src/b.ts:no-class:no classes'] },
      added_count: 1,
      removed_count: 2,
      // Committed before counts, its key grandfathered any number; the working tree counts two.
      recounted: { lint: { 'src/a.ts:rule:kept': { from: null, to: 2 } } },
      recounted_count: 1,
    });
    expect(json['sha']).toMatch(/^[0-9a-f]{40}$/);
  });

  test('an unchanged file is exit 0 with empty sides, and the ref defaults to HEAD', async () => {
    const { code, json } = await diffJson([]);
    expect(code).toBe(0);
    expect(json).toMatchObject({ ref: 'HEAD', added: {}, removed: {}, added_count: 0, removed_count: 0, recounted: {}, recounted_count: 0 });
  });

  async function guard(argv: string[]): Promise<number> {
    return runCli(['baseline', 'diff', ...argv], { cwd: dir, stdout: sink().out, stderr: sink().out });
  }
  const recommit = async (baseline: Baseline): Promise<void> => {
    await writeBaseline(dir, baseline);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'recount');
  };

  /**
   * `--fail-on-added` (docs/contract.md §CLI) is the guard a CI job runs: a
   * grown baseline is a verification failure, exit 1 and never 2. A `from` of
   * null grandfathered any number, so nothing grows from it.
   */
  describe('--fail-on-added', () => {

    test('an added key is exit 1', async () => {
      await writeBaseline(dir, { schema_version: 1, slots: { lint: ['src/a.ts:rule:kept', 'src/a.ts:rule:fixed', 'src/a.ts:rule:new'], struct: ['src/b.ts:no-class:no classes'] } });
      expect(await guard(['HEAD', '--fail-on-added'])).toBe(1);
    });

    test('a grown count is exit 1, a fallen one exit 0', async () => {
      const slots = { lint: ['src/a.ts:rule:kept'] };
      await recommit({ schema_version: 1, slots, counts: { lint: { 'src/a.ts:rule:kept': 2 } } });
      await writeBaseline(dir, { schema_version: 1, slots, counts: { lint: { 'src/a.ts:rule:kept': 3 } } });
      expect(await guard(['HEAD', '--fail-on-added'])).toBe(1);
      await writeBaseline(dir, { schema_version: 1, slots, counts: { lint: { 'src/a.ts:rule:kept': 1 } } });
      expect(await guard(['HEAD', '--fail-on-added'])).toBe(0);
    });

    test('a count from a check captured before counts never grows', async () => {
      await writeBaseline(dir, { schema_version: 1, slots: { lint: ['src/a.ts:rule:kept', 'src/a.ts:rule:fixed'], struct: ['src/b.ts:no-class:no classes'] }, counts: { lint: { 'src/a.ts:rule:kept': 9 } } });
      expect(await guard(['HEAD', '--fail-on-added'])).toBe(0);
    });

    test('removals alone are exit 0', async () => {
      await writeBaseline(dir, { schema_version: 1, slots: { lint: ['src/a.ts:rule:kept'] } });
      expect(await guard(['HEAD', '--fail-on-added'])).toBe(0);
    });

    test('without the flag an added key is exit 0', async () => {
      await writeBaseline(dir, { schema_version: 1, slots: { lint: ['src/a.ts:rule:new'] } });
      expect(await guard(['HEAD'])).toBe(0);
    });

    test('a ref that holds no baseline file is exit 1 on any key', async () => {
      git(dir, 'rm', '-q', 'checkride.baseline.json');
      git(dir, 'commit', '-q', '-m', 'drop the baseline');
      await writeBaseline(dir, { schema_version: 1, slots: { lint: ['src/a.ts:rule:kept'] } });
      expect(await guard(['HEAD', '--fail-on-added'])).toBe(1);
    });

    test('the --json object is the same shape, and the exit carries the verdict', async () => {
      await writeBaseline(dir, { schema_version: 1, slots: { lint: ['src/a.ts:rule:new'] } });
      const { code, json } = await diffJson(['HEAD', '--fail-on-added']);
      expect(code).toBe(1);
      expect(Object.keys(json)).toEqual(['ref', 'sha', 'added', 'removed', 'added_count', 'removed_count', 'recounted', 'recounted_count']);
    });
  });

  test('a ref that names no commit is exit 2 with nothing on stdout', async () => {
    const out = sink();
    expect(await runCli(['baseline', 'diff', 'no-such-ref', '--json'], { cwd: dir, stdout: out.out, stderr: sink().out })).toBe(2);
    expect(out.text()).toBe('');
  });
});

/** A baseline holding `entries`. */
const slots = (entries: Record<string, string[]>): Baseline => ({ schema_version: 1, slots: entries });

/**
 * Contract: `baseline diff` walks every file a baseline is spread over
 * (§CLI, `baseline diff`): the working tree's as a run reads them, and the
 * ref's for the files its own config or the working tree's declares.
 */
describe("checkride baseline diff over a local target's files", () => {
  let dir: string;

  /** Write `content` as the file `file`, relative to the repo, making its directory. */
  async function put(file: string, content: object | string): Promise<void> {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }

  const CONFIG = { targets: { web: { root: 'web', local: true }, api: { root: 'services/api', local: true } } };
  const WEB_FILE = 'web/checkride.baseline.json';
  const API_FILE = 'services/api/checkride.baseline.json';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-shard-diff-contract-'));
    git(dir, 'init', '-q');
    await put('checkride.config.json', CONFIG);
    await put('web/checkride.config.json', { lang: 'ts' });
    await put('services/api/checkride.config.json', { lang: 'ts' });
    await put(BASELINE_FILE, slots({ spell: ['s1'] }));
    await put(WEB_FILE, slots({ 'web:lint': ['w1'] }));
    await put(API_FILE, slots({ 'api:lint': ['a1'] }));
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'adopt a baseline, a file to each target');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function diff(argv: string[] = []): Promise<{ code: number; json: Record<string, unknown>; err: string }> {
    const out = sink();
    const err = sink();
    const code = await runCli(['baseline', 'diff', ...argv, '--json'], { cwd: dir, stdout: out.out, stderr: err.out, env: {} });
    return { code, json: out.text() === '' ? {} : (JSON.parse(out.text()) as Record<string, unknown>), err: err.text() };
  }

  test.each<{ file: string; entries: Record<string, string[]>; added: Record<string, string[]> }>([
    { file: WEB_FILE, entries: { 'web:lint': ['w1', 'w2'] }, added: { 'web:lint': ['w2'] } },
    { file: API_FILE, entries: { 'api:lint': ['a1', 'a2'] }, added: { 'api:lint': ['a2'] } },
  ])('a key added in $file is reported under the same eight fields, and --fail-on-added exits 1 on it', async ({ file, entries, added }) => {
    await put(file, slots(entries));
    const plain = await diff();
    expect(plain.code).toBe(0);
    expect(Object.keys(plain.json)).toEqual(['ref', 'sha', 'added', 'removed', 'added_count', 'removed_count', 'recounted', 'recounted_count']);
    expect(plain.json).toMatchObject({ ref: 'HEAD', added, removed: {}, added_count: 1, removed_count: 0, recounted: {}, recounted_count: 0 });
    const guarded = await diff(['--fail-on-added']);
    expect(guarded.code).toBe(1);
    expect(guarded.json).toEqual(plain.json);
    expect(guarded.err).toContain('baseline diff --fail-on-added: the working tree grandfathers more than HEAD: 1 key(s) added, 0 counted more often\n');
  });

  test('nothing changed is exit 0 with empty sides, and a key that moved between files is no change', async () => {
    expect((await diff(['--fail-on-added'])).json).toMatchObject({ added_count: 0, removed_count: 0 });
    // web's key back in the root file, and its own file gone: the same key, held elsewhere.
    await put(BASELINE_FILE, slots({ spell: ['s1'], 'web:lint': ['w1'] }));
    await rm(join(dir, WEB_FILE));
    const moved = await diff(['--fail-on-added']);
    expect(moved.code).toBe(0);
    expect(moved.json).toMatchObject({ added: {}, removed: {}, added_count: 0, removed_count: 0 });
  });

  test('a file only the config at the ref declares is read there, so its keys read as removed', async () => {
    await put('checkride.config.json', { targets: { web: CONFIG.targets.web } });
    const now = await diff(['--fail-on-added']);
    expect(now.code).toBe(0);
    expect(now.json).toMatchObject({ added: {}, removed: { 'api:lint': ['a1'] }, removed_count: 1 });
  });

  test('a file only the working tree\'s config declares is read at the ref too', async () => {
    // The ref's config declares no target, with web's keys already in a file at its root.
    await put('checkride.config.json', {});
    git(dir, 'commit', '-q', '-am', 'drop the targets');
    await put('checkride.config.json', CONFIG);
    expect((await diff(['--fail-on-added'])).json).toMatchObject({ added: {}, removed: {}, added_count: 0, removed_count: 0 });
  });

  test("a config that can't be read falls back to the root file alone, with a warning", async () => {
    await put('checkride.config.json', '{ "targets": ');
    await put(BASELINE_FILE, slots({ spell: ['s1', 's2'] }));
    await put(WEB_FILE, slots({ 'web:lint': ['w1', 'w2'] }));
    const fell = await diff(['--fail-on-added']);
    expect(fell.err).toMatch(/^baseline diff: can't read the config \(.+\), so it compares checkride\.baseline\.json alone\n/);
    expect(fell.json).toMatchObject({ added: { spell: ['s2'] }, removed: {}, added_count: 1 });
    expect(fell.code).toBe(1);
  });

  test("a config the ref can't give still reads the ref for the files the working tree's config declares, with a warning", async () => {
    await put('checkride.config.json', '{ "targets": ');
    git(dir, 'commit', '-q', '-am', 'a bad merge of the config');
    await put('checkride.config.json', CONFIG);
    await put(WEB_FILE, slots({ 'web:lint': ['w1', 'w2'] }));
    const read = await diff();
    expect(read.err).toMatch(/^baseline diff: can't read the config at HEAD \(.+\), so HEAD is read for the files the working tree's config declares\n$/);
    expect(read.json).toMatchObject({ added: { 'web:lint': ['w2'] }, removed: {}, added_count: 1 });
  });

  test('--config names the config that stands for both sides', async () => {
    await put('only-web.json', { targets: { web: CONFIG.targets.web } });
    await put(WEB_FILE, slots({ 'web:lint': ['w1', 'w2'] }));
    await put(API_FILE, slots({ 'api:lint': ['a1', 'a2'] }));
    expect((await diff(['--config', 'only-web.json'])).json).toMatchObject({ added: { 'web:lint': ['w2'] }, removed: {}, added_count: 1 });
    const env = await runCli(['baseline', 'diff', '--json'], { cwd: dir, stdout: sink().out, stderr: sink().out, env: { CHECKRIDE_CONFIG: 'only-web.json' } });
    expect(env).toBe(0);
  });

  test.each<{ label: string; mangle: () => Promise<void>; says: string }>([
    { label: 'in the working tree', mangle: () => put(WEB_FILE, '<<<<<<< HEAD\n{\n'), says: "web/checkride.baseline.json in the working tree can't be parsed, or comes from a newer checkride" },
    {
      label: 'at the ref',
      mangle: async () => {
        await put(WEB_FILE, '<<<<<<< HEAD\n{\n');
        git(dir, 'commit', '-q', '-am', 'a bad merge');
        await put(WEB_FILE, slots({ 'web:lint': ['w1'] }));
      },
      says: "web/checkride.baseline.json at HEAD can't be parsed, or comes from a newer checkride",
    },
  ])("a target's file that can't be parsed $label is exit 2 naming it, with nothing on stdout", async ({ mangle, says }) => {
    await mangle();
    const out = sink();
    const err = sink();
    expect(await runCli(['baseline', 'diff', '--json'], { cwd: dir, stdout: out.out, stderr: err.out, env: {} })).toBe(2);
    expect(out.text()).toBe('');
    expect(err.text()).toContain(says);
  });
});

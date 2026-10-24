/**
 * The parsers for the go, rust and bash packs' tools, each read against
 * output its tool printed (C9): golangci-lint, staticcheck, clippy, cargo
 * check and shellcheck, captured from a scratch repo whose Go module sits in
 * `svc/`, whose Rust workspace sits in `rs/` and whose scripts sit in
 * `scripts/`, at `/tmp/fixture-repo`. Each finding's path names its file from
 * that repo's root (R12.4), and `gates` follows R12.3.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import type { KeyedFinding } from '../index.js';
import { baselineParserFor, parserFor } from '../index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '__tests__', 'fixtures');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

/** The absolute root of the repo the fixtures were captured in. */
const REPO = '/tmp/fixture-repo';

type Context = { argv?: readonly string[]; root?: string; repoRoot?: string };

/** `adapter`'s findings over a fixture, failing loudly when it has no parser or can't trust the output. */
function parse(adapter: string, fixture: string, context: Context = {}): readonly KeyedFinding[] {
  const findings = parserFor(adapter)?.parse(read(fixture), { argv: context.argv, root: context.root, repoRoot: context.repoRoot });
  if (!findings) throw new Error(`${adapter} returned no findings`);
  return findings;
}

/** What `adapter`'s parser makes of `raw`: its findings, or `null`. */
function attempt(adapter: string, raw: string): readonly KeyedFinding[] | null | undefined {
  return parserFor(adapter)?.parse(raw, { argv: undefined, root: undefined });
}

describe('the registry', () => {
  test.each(['golangci-lint', 'staticcheck', 'clippy', 'cargo-check', 'shellcheck'])('%s reads its JSON artifact', (adapter) => {
    expect(parserFor(adapter)?.stream).toBe('artifact');
  });

  test("the linters' parsers key the baseline, and cargo check's, which stops at a crate with errors, serves findings alone", () => {
    for (const adapter of ['golangci-lint', 'staticcheck', 'clippy', 'shellcheck']) {
      expect(baselineParserFor(adapter), adapter).toBe(parserFor(adapter));
    }
    expect(parserFor('cargo-check')).toBeDefined();
    expect(baselineParserFor('cargo-check')).toBeUndefined();
  });
});

describe('golangci-lint', () => {
  test('every issue gates, keyed on the linter that reported it, its path joined onto the root', () => {
    const findings = parse('golangci-lint', 'findings-golangci-lint.json', { root: 'svc' });
    expect(findings.map((f) => [f.rule, f.line, f.column, f.gates])).toEqual([
      ['errcheck', 11, 11, true],
      ['ineffassign', 11, 2, true],
      ['staticcheck', 16, 5, true],
      ['staticcheck', 17, 10, true],
    ]);
    expect(findings[0]).toEqual({
      file: 'svc/internal/store/store.go',
      line: 11,
      column: 11,
      rule: 'errcheck',
      message: 'Error return value of `os.Remove` is not checked',
      gates: true,
      key: 'svc/internal/store/store.go:errcheck:Error return value of `os.Remove` is not checked',
    });
  });

  test("a typecheck issue's column 0 is no column, and its wrapped compiler error keys on one line", () => {
    const [issue] = parse('golangci-lint', 'findings-golangci-lint-typecheck.json', { root: 'svc' });
    expect(issue).toMatchObject({ file: 'svc/cmd/app/main.go', line: 1, rule: 'typecheck', gates: true });
    expect(issue).not.toHaveProperty('column');
    expect(issue?.key).toBe('svc/cmd/app/main.go:typecheck:: # example.com/svc/cmd/app cmd/app/main.go:11:2: declared and not used: x');
  });

  test('output with no Issues array, as a config it can not load leaves, is untrustworthy', () => {
    expect(attempt('golangci-lint', '')).toBeNull();
    expect(attempt('golangci-lint', '{"Report":{}}')).toBeNull();
    expect(attempt('golangci-lint', '{"Issues":[],"Report":{}}')).toEqual([]);
  });
});

describe('staticcheck', () => {
  test('its absolute paths name files from the repo root when the caller names it', () => {
    const findings = parse('staticcheck', 'findings-staticcheck.jsonl', { root: 'svc', repoRoot: REPO });
    expect(findings).toEqual([
      {
        file: 'svc/internal/store/store.go',
        line: 16,
        column: 5,
        rule: 'S1003',
        message: 'should use strings.Contains(parts[0], "x") instead',
        severity: 'error',
        gates: true,
        key: 'svc/internal/store/store.go:S1003:should use strings.Contains(parts[0], "x") instead',
      },
      expect.objectContaining({ file: 'svc/internal/store/store.go', line: 17, column: 10, rule: 'S1025', gates: true }),
    ]);
  });

  test('without a repo root, an absolute path stays as printed', () => {
    const [first] = parse('staticcheck', 'findings-staticcheck.jsonl', { root: 'svc' });
    expect(first?.file).toBe(`${REPO}/svc/internal/store/store.go`);
  });

  test('a package that does not compile stays a gating finding with no file', () => {
    const findings = parse('staticcheck', 'findings-staticcheck-compile.jsonl', { root: 'svc', repoRoot: REPO });
    expect(findings).toHaveLength(3);
    expect(findings[0]).toEqual({
      file: '',
      rule: 'compile',
      message: '# example.com/svc/cmd/app\ncmd/app/main.go:11:2: declared and not used: x',
      severity: 'error',
      gates: true,
      key: ':compile:# example.com/svc/cmd/app cmd/app/main.go:11:2: declared and not used: x',
    });
  });

  test('an ignored problem does not gate', () => {
    const raw = read('findings-staticcheck.jsonl').replaceAll('"severity":"error"', '"severity":"ignored"');
    expect(attempt('staticcheck', raw)?.map((f) => [f.severity, f.gates])).toEqual([
      ['ignored', false],
      ['ignored', false],
    ]);
  });

  test('a clean run prints nothing, and a stray line hides none of the rest', () => {
    expect(attempt('staticcheck', '')).toEqual([]);
    expect(attempt('staticcheck', `launcher noise\n${read('findings-staticcheck.jsonl')}`)).toHaveLength(2);
  });
});

describe('clippy and cargo check', () => {
  test('under -D warnings every diagnostic is an error and gates, reported once though cargo prints it per target', () => {
    const findings = parse('clippy', 'findings-clippy.jsonl', { root: 'rs' });
    expect(findings).toEqual([
      {
        file: 'rs/crates/core/src/lib.rs',
        line: 9,
        column: 5,
        rule: 'clippy::needless_return',
        message: 'unneeded `return` statement',
        severity: 'error',
        gates: true,
        key: 'rs/crates/core/src/lib.rs:clippy::needless_return:unneeded `return` statement',
      },
      expect.objectContaining({ file: 'rs/crates/core/src/lib.rs', line: 13, column: 24, rule: 'clippy::ptr_arg', gates: true }),
    ]);
  });

  test('without -D warnings its warnings, rustc lints included, do not gate', () => {
    const findings = parse('clippy', 'findings-clippy-warnings.jsonl', { root: 'rs' });
    expect(findings.map((f) => [f.file, f.rule, f.severity, f.gates])).toEqual([
      ['rs/crates/core/src/lib.rs', 'clippy::needless_return', 'warning', false],
      ['rs/crates/core/src/lib.rs', 'clippy::ptr_arg', 'warning', false],
      ['rs/crates/cli/src/main.rs', 'unused_variables', 'warning', false],
    ]);
  });

  test("cargo check's type error is a finding, and its spanless failure-notes are none", () => {
    expect(parse('cargo-check', 'findings-cargo-check.jsonl', { root: 'rs' })).toEqual([
      {
        file: 'rs/crates/cli/src/main.rs',
        line: 3,
        column: 22,
        rule: 'E0308',
        message: 'mismatched types',
        severity: 'error',
        gates: true,
        key: 'rs/crates/cli/src/main.rs:E0308:mismatched types',
      },
    ]);
  });

  test('a spanless error stays a gating finding with no file', () => {
    const raw = JSON.stringify({ reason: 'compiler-message', message: { level: 'error', message: 'linking failed', code: null, spans: [] } });
    expect(attempt('clippy', `${raw}\n{"reason":"build-finished","success":false}\n`)).toEqual([
      { file: '', rule: '', message: 'linking failed', severity: 'error', gates: true, key: '::linking failed' },
    ]);
  });

  test('a build that never finished is untrustworthy', () => {
    const unfinished = read('findings-clippy.jsonl').split('\n').filter((line) => !line.includes('"build-finished"')).join('\n');
    expect(attempt('clippy', unfinished)).toBeNull();
    expect(attempt('cargo-check', '')).toBeNull();
  });
});

describe('shellcheck', () => {
  const ARGV = ['pnpm', 'exec', 'shellcheck', '-f', 'json1', 'deploy.sh', 'release', 'broken.sh'];

  test('every comment gates at the default severity, keyed on its SC code, its path joined onto the root', () => {
    const findings = parse('shellcheck', 'findings-shellcheck.json', { argv: ARGV, root: 'scripts' });
    expect(findings).toHaveLength(12);
    expect(findings.every((f) => f.gates)).toBe(true);
    expect(new Set(findings.map((f) => f.severity))).toEqual(new Set(['error', 'warning', 'info', 'style']));
    expect(findings.find((f) => f.severity === 'style')).toEqual({
      file: 'scripts/deploy.sh',
      line: 9,
      column: 19,
      rule: 'SC2006',
      message: 'Use $(...) notation instead of legacy backticks `...`.',
      severity: 'style',
      gates: true,
      key: 'scripts/deploy.sh:SC2006:Use $(...) notation instead of legacy backticks `...`.',
    });
  });

  test.each([['--severity=warning'], ['--severity', 'warning'], ['-S', 'warning'], ['-Swarning']])(
    'under %s the comments that gate are exactly those a real --severity=warning run prints',
    (...flag) => {
      const gating = parse('shellcheck', 'findings-shellcheck.json', { argv: [...ARGV, ...flag] }).filter((f) => f.gates);
      const real = parse('shellcheck', 'findings-shellcheck-severity-warning.json');
      expect(gating.map((f) => f.key)).toEqual(real.map((f) => f.key));
    },
  );

  test('an argv that hides shellcheck, or none at all, reads as the default', () => {
    expect(parse('shellcheck', 'findings-shellcheck.json', { argv: ['sh', '-c', 'lint.sh --severity=error'] }).every((f) => f.gates)).toBe(true);
    expect(parse('shellcheck', 'findings-shellcheck.json').every((f) => f.gates)).toBe(true);
  });

  test('output with no comments array is untrustworthy', () => {
    expect(attempt('shellcheck', '')).toBeNull();
    expect(attempt('shellcheck', '{"comments":[]}')).toEqual([]);
  });
});

/**
 * The python pack's tools, captured at ruff 0.17.1, mypy 2.4.0 and
 * basedpyright 1.40.2 from a target in `py/` of the same scratch repo. ruff
 * and basedpyright print the real path, which on macOS runs through
 * `/private/tmp`, so that's the repo root they're rebased from.
 */
const REAL_REPO = '/private/tmp/fixture-repo';

describe('the python pack’s parsers', () => {
  test('ruff reads its JSON artifact and keys the baseline; mypy and basedpyright, which a syntax error can stop short, serve findings alone', () => {
    for (const adapter of ['ruff', 'mypy', 'basedpyright']) expect(parserFor(adapter)?.stream, adapter).toBe('artifact');
    expect(baselineParserFor('ruff')).toBe(parserFor('ruff'));
    expect(baselineParserFor('mypy')).toBeUndefined();
    expect(baselineParserFor('basedpyright')).toBeUndefined();
  });
});

describe('ruff', () => {
  test('every violation gates, keyed on its code, its absolute path named from the repo root', () => {
    const findings = parse('ruff', 'findings-ruff.json', { root: 'py', repoRoot: REAL_REPO });
    expect(findings).toEqual([
      {
        file: 'py/src/kit/__init__.py',
        line: 1,
        column: 8,
        rule: 'F401',
        message: '`os` imported but unused',
        severity: 'error',
        gates: true,
        key: 'py/src/kit/__init__.py:F401:`os` imported but unused',
      },
      expect.objectContaining({ file: 'py/src/kit/__init__.py', line: 5, column: 40, rule: 'B006', gates: true }),
    ]);
  });

  test('without a repo root an absolute path stays as printed, and a syntax error is a finding like any other', () => {
    const [first] = parse('ruff', 'findings-ruff.json', { root: 'py' });
    expect(first?.file).toBe(`${REAL_REPO}/py/src/kit/__init__.py`);
    const syntax = parse('ruff', 'findings-ruff-syntax.json', { root: 'py', repoRoot: REAL_REPO });
    expect(syntax.map((f) => [f.rule, f.line, f.column, f.gates])).toEqual([
      ['invalid-syntax', 1, 12, true],
      ['invalid-syntax', 1, 13, true],
    ]);
  });

  test('a clean run is no findings, and output that is not an array, as a config ruff can not load leaves, is untrustworthy', () => {
    expect(attempt('ruff', '[]')).toEqual([]);
    expect(attempt('ruff', '')).toBeNull();
    expect(attempt('ruff', '{"error":"x"}')).toBeNull();
  });
});

describe('mypy', () => {
  test('an error gates and a note does not, its 0-based column counted from 1, its path joined onto the root', () => {
    const findings = parse('mypy', 'findings-mypy.jsonl', { root: 'py' });
    expect(findings.map((f) => [f.rule, f.line, f.column, f.severity, f.gates])).toEqual([
      ['return-value', 7, 12, 'error', true],
      ['arg-type', 15, 7, 'error', true],
      ['misc', 16, 13, 'note', false],
    ]);
    expect(findings[1]).toEqual({
      file: 'py/src/kit/__init__.py',
      line: 15,
      column: 7,
      rule: 'arg-type',
      message: 'Argument 1 to "total" has incompatible type "list[int]"; expected "list[float]"',
      severity: 'error',
      gates: true,
      key: 'py/src/kit/__init__.py:arg-type:Argument 1 to "total" has incompatible type "list[int]"; expected "list[float]"',
    });
  });

  test('a syntax error is a gating finding, an unknown place is none, and a clean run or a stray line hides nothing', () => {
    expect(parse('mypy', 'findings-mypy-syntax.jsonl', { root: 'py' }).map((f) => [f.rule, f.line, f.column])).toEqual([
      ['syntax', 1, 13],
      ['syntax', 1, 14],
    ]);
    const unplaced = attempt('mypy', '{"file": "a.py", "line": -1, "column": -1, "message": "m", "code": null, "severity": "error"}\n');
    expect(unplaced).toEqual([{ file: 'a.py', rule: '', message: 'm', severity: 'error', gates: true, key: 'a.py::m' }]);
    expect(attempt('mypy', '\n')).toEqual([]);
    expect(attempt('mypy', `Warning: a stray print\n${read('findings-mypy-syntax.jsonl')}`)).toHaveLength(2);
  });
});

describe('basedpyright', () => {
  const registry = ['basedpyright', '--outputjson'];

  test('an error gates and an information does not; a warning gates under --warnings, and otherwise its config decides', () => {
    const findings = parse('basedpyright', 'findings-basedpyright.json', { root: 'py', repoRoot: REAL_REPO, argv: registry });
    expect(findings.map((f) => [f.rule, f.severity, f.line, f.column, f.gates])).toEqual([
      ['reportUnusedImport', 'warning', 1, 8, undefined],
      ['reportCallInDefaultInitializer', 'warning', 5, 40, undefined],
      ['reportReturnType', 'error', 7, 12, true],
      ['reportUnusedCallResult', 'warning', 15, 1, undefined],
      ['reportArgumentType', 'error', 15, 7, true],
      ['', 'information', 16, 13, false],
    ]);
    expect(findings[0]).not.toHaveProperty('gates');
    expect(findings[0]?.file).toBe('py/src/kit/__init__.py');
    const warned = parse('basedpyright', 'findings-basedpyright.json', { root: 'py', repoRoot: REAL_REPO, argv: [...registry, '--warnings'] });
    expect(warned.filter((f) => f.severity === 'warning').map((f) => f.gates)).toEqual([true, true, true]);
  });

  test('a message over several lines is kept whole, and output with no diagnostics array is untrustworthy', () => {
    const returnType = parse('basedpyright', 'findings-basedpyright.json', { root: 'py', repoRoot: REAL_REPO }).find((f) => f.rule === 'reportReturnType');
    expect(returnType?.message).toContain('\n');
    expect(returnType?.key).toBe(`py/src/kit/__init__.py:reportReturnType:${(returnType?.message ?? '').replace(/\s+/g, ' ').trim()}`);
    expect(attempt('basedpyright', '{"generalDiagnostics": [], "summary": {}}')).toEqual([]);
    expect(attempt('basedpyright', '')).toBeNull();
    expect(attempt('basedpyright', 'No configuration file found.')).toBeNull();
  });
});

/**
 * The terraform pack's tools, captured at `/tmp/fixture-tf` (real path
 * `/private/tmp/fixture-tf`) from a run of this checkride against OpenTofu
 * 1.13.1, tflint 0.64.0 and trivy 0.76.0: a root module at `infra/` with two
 * child modules, and a second root at `noinit/` whose provider was never
 * installed.
 */
const TF_REPO = '/private/tmp/fixture-tf';

/** How many of tflint's findings over its fixture gate under `argv`. */
const tflintGating = (argv: readonly string[]): number => parse('tflint', 'findings-tflint.json', { root: 'infra', argv }).filter((f) => f.gates).length;

/** Findings' keys, sorted, so two parses compare whatever order they came in. */
const sortedKeys = (findings: readonly KeyedFinding[]): string[] => findings.map((f) => f.key).toSorted();

describe('the terraform pack’s parsers', () => {
  test('each reads its JSON artifact, and only tflint keys the baseline (R12.2)', () => {
    for (const adapter of ['tflint', 'terraform-validate', 'trivy-config']) expect(parserFor(adapter)?.stream, adapter).toBe('artifact');
    expect(baselineParserFor('tflint')).toBe(parserFor('tflint'));
    expect(baselineParserFor('terraform-validate')).toBeUndefined();
    expect(baselineParserFor('trivy-config')).toBeUndefined();
  });
});

describe('tflint', () => {
  const registry = ['pnpm', 'exec', 'tflint', '--recursive', '--format=json'];

  test('every issue gates by default, a notice included, keyed on its rule, a nested module’s path joined onto the root', () => {
    const findings = parse('tflint', 'findings-tflint.json', { root: 'infra', argv: registry });
    expect(findings).toHaveLength(9);
    expect(findings.every((f) => f.gates)).toBe(true);
    expect(findings[0]).toEqual({
      file: 'infra/main.tf',
      line: 5,
      column: 1,
      rule: 'terraform_unused_declarations',
      message: 'variable "unused" is declared but not used',
      severity: 'warning',
      gates: true,
      key: 'infra/main.tf:terraform_unused_declarations:variable "unused" is declared but not used',
    });
    expect(findings.map((f) => f.file)).toContain('infra/modules/greet/main.tf');
    expect(findings.filter((f) => f.severity === 'info').map((f) => f.rule)).toEqual(['terraform_documented_outputs', 'terraform_documented_outputs']);
  });

  test('--minimum-failure-severity lets the issues below it through, in either spelling, and --force lets every one through', () => {
    expect(tflintGating([...registry, '--minimum-failure-severity=warning'])).toBe(7);
    expect(tflintGating([...registry, '--minimum-failure-severity', 'error'])).toBe(0);
    expect(tflintGating([...registry, '--minimum-failure-severity=notice'])).toBe(9);
    expect(tflintGating([...registry, '--force'])).toBe(0);
    // A wrapper hides the flags, so every issue counts, as tflint's default does.
    expect(tflintGating(['sh', '-c', 'tflint --force'])).toBe(9);
  });

  test('a nested module named through a symlinked PWD is its real path, named from the repo root', () => {
    const climbed = parse('tflint', 'findings-tflint-symlinked.json', { root: 'infra', repoRoot: TF_REPO });
    expect(read('findings-tflint-symlinked.json')).toContain('"../../../private/tmp/fixture-tf/infra/modules/greet/main.tf"');
    expect(sortedKeys(climbed)).toEqual(sortedKeys(parse('tflint', 'findings-tflint.json', { root: 'infra' })));
    expect(climbed.map((f) => f.file)).toContain('infra/modules/greet/main.tf');
    // A name that climbs out of the repo, or no repo root to measure from, keeps tflint's own path.
    const [outside] = attempt('tflint', '{"issues":[{"rule":{"name":"r","severity":"warning"},"message":"m","range":{"filename":"../shared/a.tf","start":{"line":1,"column":1}}}],"errors":[]}') ?? [];
    expect(outside?.file).toBe('../shared/a.tf');
  });

  test('a run that stopped short, as on a plugin tflint --init never installed, is untrustworthy; a clean one is no findings', () => {
    expect(attempt('tflint', read('findings-tflint-plugin-error.json'))).toBeNull();
    expect(attempt('tflint', '')).toBeNull();
    expect(attempt('tflint', '{"errors":[]}')).toBeNull();
    expect(attempt('tflint', '{"issues":[],"errors":[]}')).toEqual([]);
  });
});

describe('terraform validate', () => {
  test('an error gates and a warning does not, each message its summary and detail, a child module’s path joined onto the root', () => {
    const findings = parse('terraform-validate', 'findings-terraform-validate.json', { root: 'infra' });
    expect(findings.map((f) => [f.file, f.line, f.column, f.severity, f.gates])).toEqual([
      ['infra/main.tf', 18, 23, 'warning', false],
      ['infra/modules/greet/main.tf', 4, 21, 'error', true],
      ['infra/main.tf', 40, 11, 'error', true],
    ]);
    expect(findings[2]).toEqual({
      file: 'infra/main.tf',
      line: 40,
      column: 11,
      rule: '',
      message: 'Reference to undeclared resource: There is no managed resource "terraform_data" "nothing" definition in the root module.',
      severity: 'error',
      gates: true,
      key: 'infra/main.tf::Reference to undeclared resource: There is no managed resource "terraform_data" "nothing" definition in the root module.',
    });
  });

  test('a diagnostic about the whole configuration stays a gating finding with no file', () => {
    const [missing] = parse('terraform-validate', 'findings-terraform-validate-noinit.json', { root: 'noinit' });
    expect(missing).toMatchObject({ file: '', rule: '', severity: 'error', gates: true });
    expect(missing).not.toHaveProperty('line');
    expect(missing?.message).toMatch(/^Missing required provider: This configuration requires provider registry\.opentofu\.org\/hashicorp\/null/);
  });

  test('a valid configuration is no findings, and output with no diagnostics list is untrustworthy', () => {
    expect(attempt('terraform-validate', '{"format_version":"1.0","valid":true,"error_count":0,"warning_count":0,"diagnostics":[]}')).toEqual([]);
    expect(attempt('terraform-validate', '')).toBeNull();
    expect(attempt('terraform-validate', '{"valid":false}')).toBeNull();
  });
});

describe('trivy config', () => {
  const registry = ['pnpm', 'exec', 'trivy', 'config', '--format', 'json', '--exit-code', '1', '--skip-check-update', '--cache-dir', '{out}/trivy-cache', '.'];

  test('every failed check gates under the registry args, keyed on its ID at the line its cause starts on', () => {
    const findings = parse('trivy-config', 'findings-trivy-config.json', { root: 'infra', argv: registry });
    expect(findings).toHaveLength(9);
    expect(findings.every((f) => f.gates)).toBe(true);
    expect(findings[0]).toEqual({
      file: 'infra/main.tf',
      line: 31,
      rule: 'AWS-0107',
      message: 'Security group rule allows unrestricted ingress from any IP address.',
      severity: 'HIGH',
      gates: true,
      key: 'infra/main.tf:AWS-0107:Security group rule allows unrestricted ingress from any IP address.',
    });
    expect(new Set(findings.slice(1).map((f) => f.file))).toEqual(new Set(['infra/modules/bucket/main.tf']));
    expect(findings.map((f) => f.severity)).toEqual(['HIGH', 'HIGH', 'HIGH', 'LOW', 'MEDIUM', 'HIGH', 'HIGH', 'LOW', 'HIGH']);
  });

  test('--severity gates only the levels it lists, without a nonzero --exit-code nothing gates, and a wrapper leaves gates out', () => {
    const gating = (argv: readonly string[]) => parse('trivy-config', 'findings-trivy-config.json', { root: 'infra', argv }).map((f) => f.gates);
    expect(gating([...registry, '--severity', 'HIGH,CRITICAL']).filter(Boolean)).toHaveLength(6);
    expect(gating([...registry, '-s=low']).filter(Boolean)).toHaveLength(2);
    expect(gating(registry.filter((arg) => arg !== '--exit-code' && arg !== '1')).every((g) => g === false)).toBe(true);
    expect(gating(['sh', '-c', 'trivy config .']).every((g) => g === undefined)).toBe(true);
    expect(parse('trivy-config', 'findings-trivy-config.json', { root: 'infra' })[0]?.gates).toBe(true);
  });

  test('a clean scan, or one with nothing to scan, is no findings; a passed check is none; output that is not its report is untrustworthy', () => {
    expect(parse('trivy-config', 'findings-trivy-config-clean.json')).toEqual([]);
    expect(attempt('trivy-config', '{"SchemaVersion":2,"ArtifactName":".","ArtifactType":"filesystem"}')).toEqual([]);
    const passed = read('findings-trivy-config.json').replaceAll('"Status": "FAIL"', '"Status": "PASS"');
    expect(attempt('trivy-config', passed)).toEqual([]);
    expect(attempt('trivy-config', '')).toBeNull();
    expect(attempt('trivy-config', '[]')).toBeNull();
  });
});

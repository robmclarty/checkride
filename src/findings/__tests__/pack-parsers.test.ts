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

  test("the linters' parsers key the baseline, and cargo check's serves findings alone (D31)", () => {
    for (const adapter of ['golangci-lint', 'staticcheck', 'clippy', 'shellcheck']) {
      expect(baselineParserFor(adapter), adapter).toBe(parserFor(adapter));
    }
    expect(parserFor('cargo-check')).toBeDefined();
    expect(baselineParserFor('cargo-check')).toBeUndefined();
    expect(baselineParserFor('tsc')).toBeUndefined();
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

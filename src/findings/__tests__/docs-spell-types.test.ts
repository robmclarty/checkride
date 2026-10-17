/**
 * The docs, spell and type-checker parsers, each read against output its
 * tool printed at the pinned version (C9): markdownlint-cli2 0.23.3 and rumdl
 * 0.2.79 over the same two Markdown files, typos 1.51.1 in `--format brief`,
 * tsc 7.0.2 over a project at `web/`, and `go build -json` from Go 1.27.2
 * over a module at `svc/`. The docs and spell parsers key the baseline; the
 * type checkers' serve `checkride/findings` alone (D31, D32).
 */

// cspell:ignore seperate

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import type { KeyedFinding } from '../index.js';
import { baselineParserFor, parserFor } from '../index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '__tests__', 'fixtures');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

type Context = { argv?: readonly string[]; root?: string };

/** What `adapter`'s parser makes of `raw`: its findings, or `null`. */
function attempt(adapter: string, raw: string, context: Context = {}): readonly KeyedFinding[] | null | undefined {
  return parserFor(adapter)?.parse(raw, { argv: context.argv, root: context.root });
}

/** `adapter`'s findings over a fixture, failing loudly when it has no parser or can't trust the output. */
function parse(adapter: string, fixture: string, context: Context = {}): readonly KeyedFinding[] {
  const findings = attempt(adapter, read(fixture), context);
  if (!findings) throw new Error(`${adapter} returned no findings`);
  return findings;
}

describe('the registry', () => {
  test.each([
    ['markdownlint-cli2', 'stderr'],
    ['rumdl', 'artifact'],
    ['typos', 'stdout'],
    ['tsc', 'stdout'],
    ['go-build', 'artifact'],
  ])('%s reads its %s (D49)', (adapter, stream) => {
    expect(parserFor(adapter)?.stream).toBe(stream);
  });

  test('the docs and spell parsers key the baseline, and the type checkers serve findings alone (D31, D32)', () => {
    for (const adapter of ['markdownlint-cli2', 'rumdl', 'typos']) expect(baselineParserFor(adapter), adapter).toBe(parserFor(adapter));
    for (const adapter of ['tsc', 'go-build']) {
      expect(parserFor(adapter), adapter).toBeDefined();
      expect(baselineParserFor(adapter), adapter).toBeUndefined();
    }
  });
});

describe('markdownlint-cli2', () => {
  test('each stderr line is a finding keyed on its first rule name, and only an error gates', () => {
    const findings = parse('markdownlint-cli2', 'findings-markdownlint-cli2.stderr.txt');
    expect(findings).toHaveLength(10);
    expect(findings[0]).toEqual({
      file: 'docs/install.md',
      line: 1,
      column: 1,
      rule: 'MD018',
      message: 'No space after hash on atx style heading [Context: "#Install"]',
      severity: 'error',
      gates: true,
      key: 'docs/install.md:MD018:No space after hash on atx style heading [Context: "#Install"]',
    });
    expect(findings.filter((f) => !f.gates)).toEqual([expect.objectContaining({ file: 'README.md', rule: 'MD033', severity: 'warning' })]);
  });

  test('a rule that names a whole line has no column', () => {
    expect(parse('markdownlint-cli2', 'findings-markdownlint-cli2.stderr.txt')[1]).not.toHaveProperty('column');
  });

  test("a config it can't load is untrustworthy, and a clean run's empty stderr is clean", () => {
    expect(attempt('markdownlint-cli2', read('findings-markdownlint-cli2-config-error.stderr.txt'))).toBeNull();
    expect(attempt('markdownlint-cli2', '')).toEqual([]);
  });

  test("a target's paths join its root", () => {
    expect(parse('markdownlint-cli2', 'findings-markdownlint-cli2.stderr.txt', { root: 'site' })[0]?.file).toBe('site/docs/install.md');
  });
});

describe('rumdl', () => {
  const ARGV = ['pnpm', 'exec', 'rumdl', 'check', '--no-cache', '--output-format', 'json', '.'];

  test('every finding gates under the default --fail-on any, whatever its severity', () => {
    const findings = parse('rumdl', 'findings-rumdl.json', { argv: ARGV });
    expect(findings).toHaveLength(8);
    expect(new Set(findings.map((f) => f.severity))).toEqual(new Set(['info', 'warning', 'error']));
    expect(findings.every((f) => f.gates)).toBe(true);
    expect(findings[3]).toEqual({
      file: 'README.md',
      line: 8,
      column: 1,
      rule: 'MD033',
      message: 'Inline HTML found: <b>',
      severity: 'error',
      gates: true,
      key: 'README.md:MD033:Inline HTML found: <b>',
    });
  });

  test.each([
    [['--fail-on', 'warning'], ['warning', 'error']],
    [['--fail-on=error'], ['error']],
    [['--fail-on', 'never'], []],
  ])('under %j only %j gate, as the exit codes rumdl 0.2.79 returns say', (flag, gating) => {
    const findings = parse('rumdl', 'findings-rumdl.json', { argv: [...ARGV, ...flag] });
    expect(new Set(findings.filter((f) => f.gates).map((f) => f.severity))).toEqual(new Set(gating));
  });

  test('an argv that hides rumdl reads as the default', () => {
    expect(parse('rumdl', 'findings-rumdl.json', { argv: ['sh', '-c', 'rumdl check --fail-on error'] }).every((f) => f.gates)).toBe(true);
  });

  test('output that is not an array is untrustworthy, and [] is clean', () => {
    expect(attempt('rumdl', '')).toBeNull();
    expect(attempt('rumdl', '{"error":"bad config"}')).toBeNull();
    expect(attempt('rumdl', '[]')).toEqual([]);
  });
});

describe('typos', () => {
  test('each misspelling gates with no rule, its ./ dropped and its root joined', () => {
    const findings = parse('typos', 'findings-typos.txt', { root: 'site' });
    expect(findings).toHaveLength(5);
    expect(findings.every((f) => f.gates && f.rule === '' && f.severity === 'error')).toBe(true);
    expect(findings[0]).toEqual({
      file: 'site/docs/notes.md',
      line: 3,
      column: 9,
      rule: '',
      message: '`teh` should be `the`',
      severity: 'error',
      gates: true,
      key: 'site/docs/notes.md::`teh` should be `the`',
    });
  });

  test('at the repo root a path keys as every other tool names it', () => {
    expect(parse('typos', 'findings-typos.txt')[0]?.key).toBe('docs/notes.md::`teh` should be `the`');
  });

  test('a misspelled file name, which brief prints with no path, stays a gating finding with no file', () => {
    expect(parse('typos', 'findings-typos.txt')[3]).toEqual({
      file: '',
      rule: '',
      message: '`seperate` should be `separate`',
      severity: 'error',
      gates: true,
      key: '::`seperate` should be `separate`',
    });
  });
});

describe('tsc', () => {
  test('each diagnostic is keyed on its TS code, its path joined onto the root', () => {
    const findings = parse('tsc', 'findings-tsc.txt', { root: 'web' });
    expect(findings.map((f) => [f.file, f.line, f.column, f.rule])).toEqual([
      ['web/src/app.ts', 1, 17, 'TS2305'],
      ['web/src/app.ts', 8, 7, 'TS2741'],
      ['web/src/app.ts', 9, 7, 'TS2345'],
      ['web/src/app.ts', 15, 11, 'TS2345'],
      ['web/src/greet.ts', 5, 14, 'TS2322'],
    ]);
    expect(findings.every((f) => f.gates && f.severity === 'error')).toBe(true);
  });

  test('a chained message keeps its indented lines', () => {
    expect(parse('tsc', 'findings-tsc.txt')[3]?.message).toBe(
      "Argument of type '{ retry: { count: string; }; }' is not assignable to parameter of type '{ retry: { count: number; }; }'.\n" +
        "  The types of 'retry.count' are incompatible between these types.\n" +
        "    Type 'string' is not assignable to type 'number'.",
    );
  });

  test('a diagnostic with no file, such as a missing project, is a finding with no file', () => {
    expect(parse('tsc', 'findings-tsc-missing-project.txt')).toEqual([
      {
        file: '',
        rule: 'TS6053',
        severity: 'error',
        message: "File '/tmp/fixture-repo/api/tsconfig.json' not found.",
        gates: true,
        key: ":TS6053:File '/tmp/fixture-repo/api/tsconfig.json' not found.",
      },
    ]);
  });

  test('an indented line after anything but a diagnostic joins none', () => {
    const verbose = '[12:00:00 AM] Projects in this build:\n    * tsconfig.json\n';
    expect(attempt('tsc', verbose)).toEqual([]);
  });
});

describe('go build -json', () => {
  test("each package's errors are findings, its header dropped and its paths joined onto the root", () => {
    expect(parse('go-build', 'findings-go-build.jsonl', { root: 'svc' })).toEqual([
      {
        file: 'svc/internal/extra/extra.go',
        line: 5,
        column: 9,
        rule: '',
        message: 'cannot use "big" (untyped string constant) as int value in return statement',
        gates: true,
        key: 'svc/internal/extra/extra.go::cannot use "big" (untyped string constant) as int value in return statement',
      },
      expect.objectContaining({ file: 'svc/cmd/app/main.go', line: 11, column: 2, message: 'declared and not used: x' }),
    ]);
  });

  test("an error's indented line, printed as the package's next event, joins it", () => {
    const [missing] = parse('go-build', 'findings-go-build-missing-module.jsonl', { root: 'svc' });
    expect(missing).toMatchObject({ file: 'svc/internal/remote/remote.go', line: 3, column: 8 });
    expect(missing?.message).toBe('no required module provides package github.com/nope/missing; to add it:\n\tgo get github.com/nope/missing');
  });

  test('a clean build prints nothing, and an error with no place is one with no file', () => {
    expect(attempt('go-build', '')).toEqual([]);
    const event = JSON.stringify({ ImportPath: 'example.com/x', Action: 'build-output', Output: 'package example.com/x: cannot find package\n' });
    expect(attempt('go-build', event)?.map((f) => [f.file, f.message])).toEqual([['', 'package example.com/x: cannot find package']]);
  });
});

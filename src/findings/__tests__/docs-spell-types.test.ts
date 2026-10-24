/**
 * The docs, spell and type-checker parsers, each read against output its
 * tool printed at the pinned version (C9): markdownlint-cli2 0.23.3 and rumdl
 * 0.2.79 over the same two Markdown files, typos 1.51.1 in `--format brief`,
 * tsc 7.0.2 over a project at `web/` and over a solution build there (`lib`,
 * and `app` referencing it), and `go build -json` from Go 1.27.2 over a
 * module at `svc/`. The docs and spell parsers and tsc's key the baseline;
 * go build's serves `checkride/findings` alone (D32).
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

  test("the docs and spell parsers and tsc's key the baseline, and go build's serves findings alone (D32)", () => {
    for (const adapter of ['markdownlint-cli2', 'rumdl', 'typos', 'tsc']) expect(baselineParserFor(adapter), adapter).toBe(parserFor(adapter));
    expect(parserFor('go-build')).toBeDefined();
    expect(baselineParserFor('go-build')).toBeUndefined();
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

/** What a run hands `stoppedShort` beside the parse context: both streams, its tool's version, and a reader of the check's files. */
type Run = { output?: { stdout: string; stderr: string }; toolVersion?: string; read?: (path: string) => string | null };

/** A reader of the check's files that holds only `files`. */
const holding = (files: Record<string, string>) => (path: string): string | null => files[path] ?? null;

/** A solution tsconfig, whose build spans its references, and a single project's, whose build doesn't. */
const SOLUTION = '{ "files": [], "references": [{ "path": "./lib" }, { "path": "./app" }] }';
const SINGLE = '{\n  // one project\n  "compilerOptions": { "strict": true },\n  "references": []\n}';

/** Why tsc's parser reads `fixture` as a run that stopped short of some errors, or `null` when it reached them all. */
function stoppedShort(fixture: string, context: Context = {}, run: Run = {}): string | null | undefined {
  return parserFor('tsc')?.stoppedShort?.(parse('tsc', fixture, context), { argv: context.argv, root: context.root, ...run });
}

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
    expect(findings[0]?.key).toBe("web/src/app.ts:TS2305:Module '…' has no exported member '…'.");
  });

  test('a chained message keeps its indented lines, and its key only its first', () => {
    const chained = parse('tsc', 'findings-tsc.txt')[3];
    expect(chained?.message).toBe(
      "Argument of type '{ retry: { count: string; }; }' is not assignable to parameter of type '{ retry: { count: number; }; }'.\n" +
        "  The types of 'retry.count' are incompatible between these types.\n" +
        "    Type 'string' is not assignable to type 'number'.",
    );
    expect(chained?.key).toBe("src/app.ts:TS2345:Argument of type '…' is not assignable to parameter of type '…'.");
  });

  test('a key makes each quoted span `…`, so the errors one file has of a code and wording share it', () => {
    const findings = parse('tsc', 'findings-tsc-build.txt', { root: 'web' });
    expect(findings.map((f) => f.key)).toEqual([
      "web/lib/src/index.ts:TS2322:Type '…' is not assignable to type '…'.",
      "web/lib/src/index.ts:TS2322:Type '…' is not assignable to type '…'.",
      "web/lib/src/index.ts:TS7053:Element implicitly has an '…' type because expression of type '…' can't be used to index type '…'.",
      "web/lib/src/index.ts:TS1308:'…' expressions are only allowed within async functions and at the top levels of modules.",
      "web/app/src/main.ts:TS6133:'…' is declared but its value is never read.",
      "web/app/src/main.ts:TS2741:Property '…' is missing in type '…' but required in type '…'.",
      "web/app/src/main.ts:TS2322:Type '…' is not assignable to type '…'.",
      "web/app/src/main.ts:TS2322:Type '…' is not assignable to type '…'.",
    ]);
    // The finding keeps the types the key leaves out.
    expect(findings[1]?.message).toBe("Type 'boolean' is not assignable to type 'number'.");
  });

  test("a key makes the rest of what tsc filled in `…` too: a count, the list a type lacks, a module's name", () => {
    expect(parse('tsc', 'findings-tsc-variable-text.txt').slice(0, 5).map((f) => f.key)).toEqual([
      "lib/src/both.ts:TS2308:Module '…' has already exported a member named '…'. Consider explicitly re-exporting to resolve the ambiguity.",
      'lib/src/counts.ts:TS2554:Expected … arguments, but got ….',
      'lib/src/counts.ts:TS2554:Expected … arguments, but got ….',
      "lib/src/counts.ts:TS2740:Type '…' is missing the following properties from type '…': …",
      "lib/src/counts.ts:TS2739:Type '…' is missing the following properties from type '…': …",
    ]);
    // An older tsc's module name in double quotes, an absolute path that differs by machine, and a type in backticks.
    const older = [
      'src/a.ts(1,14): error TS4023: Exported variable \'x\' has or is using name \'Y\' from external module "/home/ci/repo/node_modules/y/index" but cannot be named.',
      'src/b.ts(3,9): error TS2208: This type parameter might need an `extends string` constraint.',
      '',
    ].join('\n');
    expect(attempt('tsc', older)?.map((f) => f.key)).toEqual([
      'src/a.ts:TS4023:Exported variable \'…\' has or is using name \'…\' from external module "…" but cannot be named.',
      'src/b.ts:TS2208:This type parameter might need an `…` constraint.',
    ]);
  });

  test('a build whose errors are all ordinary ones, a checker TS1xxx and an unused declaration among them, reached every error', () => {
    expect(stoppedShort('findings-tsc-build.txt', { root: 'web' })).toBeNull();
    expect(stoppedShort('findings-tsc.txt')).toBeNull();
  });

  test("a syntax error, a config tsc rejected or a reference it didn't build stopped tsc short, and the reason names it", () => {
    // lib's four errors are gone behind its syntax error, app's behind its options error,
    // and the two of app's that need lib's types behind TS6305.
    expect(parse('tsc', 'findings-tsc-syntax.txt').map((f) => [f.file, f.rule])[0]).toEqual(['lib/src/broken.ts', 'TS1005']);
    expect(stoppedShort('findings-tsc-syntax.txt')).toBe("tsc stopped short at `lib/src/broken.ts(1,34): error TS1005: ',' expected.`");
    expect(parse('tsc', 'findings-tsc-config.txt', { root: 'web' }).at(-1)).toMatchObject({ file: 'web/app/tsconfig.json', rule: 'TS5096' });
    expect(stoppedShort('findings-tsc-config.txt', { root: 'web' })).toMatch(/^tsc stopped short at `web\/app\/tsconfig\.json\(2,73\): error TS5096: /);
    expect(stoppedShort('findings-tsc-unbuilt-reference.txt')).toMatch(/^tsc stopped short at `app\/src\/main\.ts\(1,34\): error TS6305: /);
    // A reference that isn't composite is reported on the referencing tsconfig.
    const ts6306 = 'app/tsconfig.json(4,18): error TS6306: Referenced project \'/repo/lib\' must have setting "composite": true.\n';
    expect(parserFor('tsc')?.stoppedShort?.(attempt('tsc', ts6306) ?? [], { argv: undefined, root: undefined })).toMatch(/TS6306/);
  });

  test('a diagnostic with no file, such as a missing project, is a finding with no file, and stopped tsc short', () => {
    expect(parse('tsc', 'findings-tsc-missing-project.txt')).toEqual([
      {
        file: '',
        rule: 'TS6053',
        severity: 'error',
        message: "File '/tmp/fixture-repo/api/tsconfig.json' not found.",
        gates: true,
        key: ":TS6053:File '…' not found.",
      },
    ]);
    expect(stoppedShort('findings-tsc-missing-project.txt')).toBe("tsc stopped short at `error TS6053: File '/tmp/fixture-repo/api/tsconfig.json' not found.`");
  });

  test('under --stopBuildOnErrors, with one dash or two and in any case, any error stopped the build short, and a clean one did not', () => {
    const argv = ['pnpm', 'exec', 'tsc', '--build', '--stopBuildOnErrors'];
    expect(stoppedShort('findings-tsc-build.txt', { argv })).toBe('tsc stopped short: `--stopBuildOnErrors` skips each project that depends on one with errors');
    expect(stoppedShort('findings-tsc-build.txt', { argv: ['tsc', '-b', '--STOPBUILDONERRORS'] })).not.toBeNull();
    expect(stoppedShort('findings-tsc-build.txt', { argv: ['tsc', '-b', '-stopBuildOnErrors', 'true'] })).not.toBeNull();
    expect(stoppedShort('findings-tsc-build.txt', { argv: ['pnpm', 'exec', 'tsc', '--build'] })).toBeNull();
    expect(parserFor('tsc')?.stoppedShort?.([], { argv, root: undefined })).toBeNull();
  });

  test('a following `false` turns --stopBuildOnErrors off, as tsc reads it', () => {
    expect(stoppedShort('findings-tsc-build.txt', { argv: ['tsc', '--build', '--stopBuildOnErrors', 'false'] })).toBeNull();
    expect(stoppedShort('findings-tsc-build.txt', { argv: ['tsc', '--build', '--stopBuildOnErrors', 'false', '--stopBuildOnErrors'] })).not.toBeNull();
  });

  test('a TypeScript before 5.6, whose --build stopped at a project with errors, stopped a build spanning references short', () => {
    const argv = ['pnpm', 'exec', 'tsc', '--build'];
    const solution = { toolVersion: '5.5.4', read: holding({ 'tsconfig.json': SOLUTION }) };
    expect(stoppedShort('findings-tsc-build.txt', { argv }, solution)).toBe(
      "tsc stopped short: TypeScript 5.5.4's `--build` skips each project that depends on one with errors, which 5.6 and later check",
    );
    // Projects named after the flag are read instead, and two of them are a build of several.
    expect(stoppedShort('findings-tsc-build.txt', { argv: ['tsc', '-b', 'packages'] }, { toolVersion: '4.9.5', read: holding({ 'packages/tsconfig.json': SOLUTION }) })).not.toBeNull();
    expect(stoppedShort('findings-tsc-build.txt', { argv: ['tsc', '-b', 'a.json', 'b.json'] }, { toolVersion: '5.5.4', read: holding({}) })).not.toBeNull();
    // A tsconfig that can't be read, or no reader at all, vouches for nothing.
    expect(stoppedShort('findings-tsc-build.txt', { argv }, { toolVersion: '5.5.4', read: holding({}) })).not.toBeNull();
    expect(stoppedShort('findings-tsc-build.txt', { argv }, { toolVersion: '5.5.4' })).not.toBeNull();
  });

  test('a single project, 5.6 and later, a check that builds nothing, and a pin naming no version reached every error', () => {
    const argv = ['pnpm', 'exec', 'tsc', '--build'];
    expect(stoppedShort('findings-tsc-build.txt', { argv }, { toolVersion: '5.5.4', read: holding({ 'tsconfig.json': SINGLE }) })).toBeNull();
    expect(stoppedShort('findings-tsc-build.txt', { argv: ['tsc', '-b', '--verbose', 'web/tsconfig.json'] }, { toolVersion: '5.5.4', read: holding({ 'web/tsconfig.json': SINGLE }) })).toBeNull();
    const solution = holding({ 'tsconfig.json': SOLUTION });
    expect(stoppedShort('findings-tsc-build.txt', { argv }, { toolVersion: '5.6.3', read: solution })).toBeNull();
    expect(stoppedShort('findings-tsc-build.txt', { argv }, { toolVersion: '7.0.2', read: solution })).toBeNull();
    expect(stoppedShort('findings-tsc-build.txt', { argv: ['tsc', '--noEmit'] }, { toolVersion: '5.5.4', read: solution })).toBeNull();
    expect(stoppedShort('findings-tsc-build.txt', { argv }, { read: solution })).toBeNull();
    expect(parserFor('tsc')?.stoppedShort?.([], { argv, root: undefined, toolVersion: '5.5.4', read: solution })).toBeNull();
  });

  test('a tsc that died part way, killed under pnpm or yarn or its own launcher, or crashed, stopped short whatever it printed first', () => {
    const partial = read('findings-tsc-build.txt');
    // pnpm 11.28.5 reports a killed command on stdout, after what the tool printed.
    const killed = `${partial}undefined\n[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command was killed with SIGKILL (Forced termination): tsc --build\n`;
    expect(stoppedShort('findings-tsc-build.txt', {}, { output: { stdout: killed, stderr: '' } })).toBe(
      'tsc stopped short: `[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command was killed with SIGKILL (Forced termination): tsc --build`',
    );
    const stderrs = [
      'error Command failed with signal "SIGKILL".\n', // yarn 1.22.22
      "Error: Command failed: /x/tsc --build\n    at checkExecSyncError (node:child_process:891:11) {\n  status: null,\n  signal: 'SIGKILL',\n", // typescript 7's launcher without process.execve
      "TypeError: Cannot read properties of undefined (reading 'flags')\n    at getTypeOfSymbol (tsc.js:1:2)\n\nNode.js v20.11.1\n", // an uncaught exception
      'panic: runtime error: index out of range [3] with length 3\n\ngoroutine 1 [running]:\n',
      'fatal error: runtime: out of memory\n',
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n',
      'Error: Debug Failure. False expression.\n    at Object.assert\n',
    ];
    for (const stderr of stderrs) expect(stoppedShort('findings-tsc-build.txt', {}, { output: { stdout: partial, stderr } }), stderr).not.toBeNull();
    // yarn's own line for a tool that failed on its own isn't one.
    expect(stoppedShort('findings-tsc-build.txt', {}, { output: { stdout: partial, stderr: 'error Command failed with exit code 2.\n' } })).toBeNull();
    expect(stoppedShort('findings-tsc-build.txt', {}, { output: { stdout: partial, stderr: '' } })).toBeNull();
  });

  test('a type a diagnostic prints, whatever text it holds, never reads as tsc dying', () => {
    const stdout = [
      "src/a.ts(2,14): error TS2322: Type '\"Command was killed with SIGTERM\"' is not assignable to type '`exit ${number}`'.",
      "src/a.ts(3,14): error TS2345: Argument of type '\"x\"' is not assignable to parameter of type 'Fail'.",
      "  Type '\"Maximum call stack size exceeded\"' is not assignable to type '\"Debug Failure.\"'.",
      '',
    ].join('\n');
    const findings = attempt('tsc', stdout) ?? [];
    expect(findings).toHaveLength(2);
    expect(parserFor('tsc')?.stoppedShort?.(findings, { argv: undefined, root: undefined, output: { stdout, stderr: '' } })).toBeNull();
  });

  test('a stopping line holding a backtick is quoted in two', () => {
    const stdout = "src/a.ts(1,1): error TS1005: '`' expected.\n";
    expect(parserFor('tsc')?.stoppedShort?.(attempt('tsc', stdout) ?? [], { argv: undefined, root: undefined })).toBe(
      "tsc stopped short at `` src/a.ts(1,1): error TS1005: '`' expected. ``",
    );
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

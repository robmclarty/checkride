import { describe, expect, test } from 'vitest';

import { parseToolJson, parseToolJsonLines } from '../tool-json.js';

/**
 * The preamble pnpm's `verifyDepsBeforeRun` prints on stdout ahead of every
 * `pnpm exec` when no outer pnpm process has already verified. Verbatim from a
 * pnpm 11.1.2 run of `fallow dead-code --format json`.
 */
const PNPM_PREAMBLE = 'Already up to date\nDone in 210ms using pnpm v11.1.2\n';

/**
 * Verbatim from a go 1.27.2 run of `go build -json ./...` over a module with a
 * type error: one JSON event per line, and exit 1.
 */
const GO_BUILD_JSONL = [
  String.raw`{"ImportPath":"example.com/demo","Action":"build-output","Output":"# example.com/demo\n"}`,
  String.raw`{"ImportPath":"example.com/demo","Action":"build-output","Output":"./main.go:4:14: cannot use \"nope\" (untyped string constant) as int value in variable declaration\n"}`,
  '{"ImportPath":"example.com/demo","Action":"build-fail"}',
  '',
].join('\n');

describe('parseToolJson', () => {
  test('returns clean JSON byte for byte', () => {
    const raw = '{\n  "kind": "dead-code",\n  "total_issues": 0\n}\n';
    const parsed = parseToolJson(raw);
    expect(parsed?.value).toEqual({ kind: 'dead-code', total_issues: 0 });
    // The fast path must not reformat: the artifact keeps the tool's own bytes.
    expect(parsed?.text).toBe(raw);
  });

  test('skips a pnpm dependency-check preamble', () => {
    const json = '{\n  "kind": "dead-code",\n  "schema_version": 7\n}\n';
    const parsed = parseToolJson(`${PNPM_PREAMBLE}${json}`);
    expect(parsed?.value).toEqual({ kind: 'dead-code', schema_version: 7 });
    // What lands in `.check/<slot>.json` must parse on its own.
    expect(parsed?.text).toBe(json);
    expect(JSON.parse(parsed?.text ?? '')).toEqual({ kind: 'dead-code', schema_version: 7 });
  });

  test('skips a preamble ahead of a top-level array', () => {
    const parsed = parseToolJson(`${PNPM_PREAMBLE}[{"file":"a.ts"}]`);
    expect(parsed?.value).toEqual([{ file: 'a.ts' }]);
  });

  test('preserves JSON that is itself a scalar', () => {
    expect(parseToolJson('42')?.value).toBe(42);
    expect(parseToolJson('null')?.value).toBeNull();
  });

  test('returns null for empty and whitespace-only output', () => {
    expect(parseToolJson('')).toBeNull();
    expect(parseToolJson('   \n  ')).toBeNull();
  });

  test('returns null when nothing on any line parses', () => {
    expect(parseToolJson('error: fallow crashed\nstack trace here\n')).toBeNull();
  });

  test('gives up past the preamble cap rather than scanning a whole log', () => {
    const buried = `${'noise\n'.repeat(11)}{"ok":true}`;
    expect(parseToolJson(buried)).toBeNull();
    const reachable = `${'noise\n'.repeat(10)}{"ok":true}`;
    expect(parseToolJson(reachable)?.value).toEqual({ ok: true });
  });

  test('does not treat a truncated payload as parseable', () => {
    expect(parseToolJson(`${PNPM_PREAMBLE}{"kind":"dead-code"`)).toBeNull();
  });
});

describe('parseToolJsonLines', () => {
  test('returns clean JSON lines byte for byte, one value per line', () => {
    const parsed = parseToolJsonLines(GO_BUILD_JSONL);
    expect(parsed?.text).toBe(GO_BUILD_JSONL);
    expect(parsed?.values).toHaveLength(3);
    expect(parsed?.values[2]).toEqual({ ImportPath: 'example.com/demo', Action: 'build-fail' });
  });

  test('skips a pnpm dependency-check preamble', () => {
    const parsed = parseToolJsonLines(`${PNPM_PREAMBLE}${GO_BUILD_JSONL}`);
    expect(parsed?.text).toBe(GO_BUILD_JSONL);
    expect(parsed?.values).toHaveLength(3);
  });

  test('skips blank lines without counting them as values', () => {
    const parsed = parseToolJsonLines('\n{"a":1}\n\n{"b":2}\r\n');
    expect(parsed?.values).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parsed?.text).toBe('{"a":1}\n\n{"b":2}\r\n');
  });

  test('returns null when a text line sits between JSON lines (F13)', () => {
    expect(parseToolJsonLines('{"a":1}\nwarning: something odd\n{"b":2}\n')).toBeNull();
  });

  test('returns null when a text line follows the JSON lines', () => {
    expect(parseToolJsonLines(`${GO_BUILD_JSONL}FAIL\n`)).toBeNull();
  });

  test('returns null for empty and whitespace-only output', () => {
    expect(parseToolJsonLines('')).toBeNull();
    expect(parseToolJsonLines('  \n\t\n')).toBeNull();
  });

  test('returns null when nothing on any line parses', () => {
    expect(parseToolJsonLines('error: go crashed\nstack trace here\n')).toBeNull();
  });

  test('returns null for one JSON value spread across lines', () => {
    expect(parseToolJsonLines('{\n  "kind": "dead-code"\n}\n')).toBeNull();
  });

  test('gives up past the preamble cap rather than scanning a whole log', () => {
    expect(parseToolJsonLines(`${'noise\n'.repeat(11)}{"ok":true}`)).toBeNull();
    expect(parseToolJsonLines(`${'noise\n'.repeat(10)}{"ok":true}`)?.text).toBe('{"ok":true}');
  });
});

import { describe, expect, test } from 'vitest';

import { parseToolJson } from '../tool-json.js';

/**
 * The preamble pnpm's `verifyDepsBeforeRun` prints on stdout ahead of every
 * `pnpm exec` when no outer pnpm process has already verified. Verbatim from a
 * pnpm 11.1.2 run of `fallow dead-code --format json`.
 */
const PNPM_PREAMBLE = 'Already up to date\nDone in 210ms using pnpm v11.1.2\n';

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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { fingerprint } from '../baseline/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const OXLINT = read('baseline-oxlint.json');
const AST_GREP = read('baseline-ast-grep.json');
const CSPELL = read('baseline-cspell.txt');

/** Reverse a JSON array, or a named array field of a JSON object, in place. */
function reversedJson(raw: string, field?: string): string {
  const parsed: unknown = JSON.parse(raw);
  if (field && parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    obj[field] = (obj[field] as unknown[]).toReversed();
    return JSON.stringify(obj);
  }
  return JSON.stringify((parsed as unknown[]).toReversed());
}

describe('fingerprint — extraction', () => {
  test('oxlint keys on file + rule (code) + message', () => {
    expect(fingerprint('oxlint', OXLINT)).toEqual(
      new Set([
        'src/doctor.ts:eslint(no-await-in-loop):Unexpected `await` inside a loop.',
        'src/init.ts:eslint(no-await-in-loop):Unexpected `await` inside a loop.',
        'src/config.ts:typescript(no-unused-vars):Variable is assigned a value but never used.',
      ]),
    );
  });

  test('ast-grep keys on file + ruleId + message', () => {
    expect(fingerprint('ast-grep', AST_GREP)).toEqual(
      new Set([
        'src/cli.ts:no-default-export:avoid default exports',
        'src/config.ts:no-class:no classes',
      ]),
    );
  });

  test('cspell keys on file + message with an empty rule slot', () => {
    expect(fingerprint('cspell', CSPELL)).toEqual(
      new Set([
        'src/cli.ts::Unknown word (oxlint)',
        'src/config.ts::Unknown word (vitest)',
        'src/init.ts::Unknown word (cspell)',
      ]),
    );
  });
});

describe('fingerprint — stability', () => {
  test('duplicate findings collapse to one key (order-independent set)', () => {
    // Each fixture repeats one finding across lines: 4 oxlint → 3 keys,
    // 3 ast-grep → 2 keys, 4 cspell → 3 keys.
    expect(fingerprint('oxlint', OXLINT)?.size).toBe(3);
    expect(fingerprint('ast-grep', AST_GREP)?.size).toBe(2);
    expect(fingerprint('cspell', CSPELL)?.size).toBe(3);
  });

  test('reordering the diagnostics does not change the key set', () => {
    expect(fingerprint('oxlint', reversedJson(OXLINT, 'diagnostics'))).toEqual(fingerprint('oxlint', OXLINT));
    expect(fingerprint('ast-grep', reversedJson(AST_GREP))).toEqual(fingerprint('ast-grep', AST_GREP));
    const cspellReversed = CSPELL.trimEnd().split('\n').toReversed().join('\n');
    expect(fingerprint('cspell', cspellReversed)).toEqual(fingerprint('cspell', CSPELL));
  });

  test('shifting line and column does not change the key', () => {
    // Move every oxlint finding down 100 lines; keys must be identical.
    const shifted = JSON.parse(OXLINT) as {
      diagnostics: { labels: { span: { line: number; column: number; offset: number } }[] }[];
    };
    for (const d of shifted.diagnostics) {
      for (const label of d.labels) {
        label.span.line += 100;
        label.span.column += 7;
        label.span.offset += 4096;
      }
    }
    expect(fingerprint('oxlint', JSON.stringify(shifted))).toEqual(fingerprint('oxlint', OXLINT));
  });
});

describe('fingerprint — support boundary', () => {
  test('a supported adapter with zero findings returns an empty set, not null', () => {
    expect(fingerprint('oxlint', '{"diagnostics":[]}')).toEqual(new Set());
    expect(fingerprint('ast-grep', '[]')).toEqual(new Set());
    expect(fingerprint('cspell', '')).toEqual(new Set());
  });

  test('an adapter with no extractor returns null (baseline unsupported)', () => {
    // fallow sits out for now (a4); alternates and non-diagnostic slots too.
    for (const adapter of ['fallow', 'knip', 'biome', 'eslint', 'tsc', 'links', 'stryker', 'pnpm-audit']) {
      expect(fingerprint(adapter, '[]')).toBeNull();
    }
  });

  test('malformed output fingerprints to an empty set, never throws', () => {
    expect(fingerprint('oxlint', 'not json at all')).toEqual(new Set());
    expect(fingerprint('oxlint', '{"diagnostics":"nope"}')).toEqual(new Set());
    expect(fingerprint('ast-grep', '{"not":"an array"}')).toEqual(new Set());
  });
});

import { describe, expect, test } from 'vitest';

import {
  CHECK_MARKER_RE,
  FENCE_CLOSE_RE,
  FENCE_OPEN_RE,
  extractSnippets,
  generateSnippetTsconfig,
  planSnippets,
  selectDocFiles,
  slugForDoc,
  snippetFileName,
  vacuousOptInError,
} from '../snippets.js';
import type { DocInput } from '../snippets.js';

/** Join fixture lines into one markdown document. */
function md(...lines: string[]): string {
  return lines.join('\n');
}

describe('the marker/fence regexes match fascicle byte-for-byte (D11)', () => {
  test('exact patterns', () => {
    expect(CHECK_MARKER_RE.source).toBe('<!--\\s*snippet:\\s*check\\s*-->');
    expect(FENCE_OPEN_RE.source).toBe('^```(ts|typescript)\\s*$');
    expect(FENCE_CLOSE_RE.source).toBe('^```\\s*$');
  });
});

describe('selectDocFiles', () => {
  test('always includes README.md first, then each docs/*.md in listing order', () => {
    expect(selectDocFiles(['guide.md', 'api.md'])).toEqual(['README.md', 'docs/guide.md', 'docs/api.md']);
  });

  test('an empty docs/ listing still checks README.md', () => {
    expect(selectDocFiles([])).toEqual(['README.md']);
  });

  test('non-.md entries (and subdirectory names) are skipped — discovery is non-recursive', () => {
    expect(selectDocFiles(['guide.md', 'assets', 'notes.txt', 'sub'])).toEqual(['README.md', 'docs/guide.md']);
  });
});

describe('extractSnippets', () => {
  test('a marker on the immediately-preceding line marks the block checked', () => {
    const blocks = extractSnippets(md('<!-- snippet: check -->', '```ts', 'const a = 1;', '```'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ code: 'const a = 1;', startLine: 2, checked: true });
  });

  test('tag-on-previous-line ONLY — a blank line between marker and fence does not count', () => {
    const blocks = extractSnippets(md('<!-- snippet: check -->', '', '```ts', 'const a = 1;', '```'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.checked).toBe(false);
  });

  test('a marker two lines above (prose in between) does not count', () => {
    const blocks = extractSnippets(md('<!-- snippet: check -->', 'Some prose.', '```ts', 'const a = 1;', '```'));
    expect(blocks[0]?.checked).toBe(false);
  });

  test('a fence on the very first line cannot be tagged (no preceding line)', () => {
    const blocks = extractSnippets(md('```ts', 'const a = 1;', '```'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.checked).toBe(false);
  });

  test('only ts/typescript fences are extracted — a js fence is ignored even when tagged', () => {
    const blocks = extractSnippets(md('<!-- snippet: check -->', '```js', 'const a = 1;', '```'));
    expect(blocks).toEqual([]);
  });

  test('`typescript` is accepted alongside `ts`', () => {
    const blocks = extractSnippets(md('<!-- snippet: check -->', '```typescript', 'const a = 1;', '```'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.checked).toBe(true);
  });

  test('a `tsx` fence is not a ts fence (the language must be exactly ts/typescript)', () => {
    expect(extractSnippets(md('```tsx', 'const a = 1;', '```'))).toEqual([]);
  });

  test('startLine is the 1-based line of the opening fence, and the body is verbatim (no trailing newline)', () => {
    const blocks = extractSnippets(
      md('# Title', '', '<!-- snippet: check -->', '```ts', 'const a: number = 1;', 'const b = a + 1;', '```'),
    );
    expect(blocks[0]?.startLine).toBe(4);
    expect(blocks[0]?.code).toBe('const a: number = 1;\nconst b = a + 1;');
  });

  test('multiple fences in one doc are all returned, tagged independently', () => {
    const blocks = extractSnippets(
      md('```ts', 'skipped', '```', '', '<!-- snippet: check -->', '```ts', 'checked', '```'),
    );
    expect(blocks.map((b) => b.checked)).toEqual([false, true]);
  });
});

describe('slugForDoc / snippetFileName', () => {
  test('collapses every non-alphanumeric run to `_` and trims the ends (fascicle algorithm)', () => {
    expect(slugForDoc('README.md')).toBe('README_md');
    expect(slugForDoc('docs/guide.md')).toBe('docs_guide_md');
    expect(slugForDoc('docs/contract.md')).toBe('docs_contract_md');
  });

  test('distinct docs in the discovered namespace get distinct slugs (no emitted-file collision)', () => {
    const docs = ['README.md', 'docs/guide.md', 'docs/api.md', 'docs/contract.md', 'docs/reliability.md'];
    const slugs = docs.map(slugForDoc);
    expect(new Set(slugs).size).toBe(docs.length);
  });

  test('snippetFileName composes the slug with the 1-based block index', () => {
    expect(snippetFileName('docs/guide.md', 3)).toBe('docs_guide_md__3.ts');
    expect(snippetFileName('README.md', 1)).toBe('README_md__1.ts');
  });
});

describe('planSnippets', () => {
  test('checked blocks become plan entries mapped back to <doc>:<line>; untagged ones only bump skipped', () => {
    const docs: DocInput[] = [
      {
        relPath: 'README.md',
        text: md('<!-- snippet: check -->', '```ts', 'export const x = 1;', '```', '', '```ts', 'partial', '```'),
      },
    ];
    const plan = planSnippets(docs);
    expect(plan.checked).toBe(1);
    expect(plan.skipped).toBe(1);
    expect(plan.entries).toEqual([
      { name: 'README_md__1.ts', file: 'README.md', line: 2, code: 'export const x = 1;' },
    ]);
  });

  test('a skipped fence still advances the block number — the tagged block after it is __2.ts', () => {
    const docs: DocInput[] = [
      { relPath: 'README.md', text: md('```ts', 'skipped', '```', '', '<!-- snippet: check -->', '```ts', 'checked', '```') },
    ];
    const plan = planSnippets(docs);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.name).toBe('README_md__2.ts');
    expect(plan.entries[0]?.line).toBe(6);
  });

  test('entries preserve doc order then block order across multiple docs', () => {
    const docs: DocInput[] = [
      { relPath: 'README.md', text: md('<!-- snippet: check -->', '```ts', 'a', '```') },
      { relPath: 'docs/guide.md', text: md('<!-- snippet: check -->', '```ts', 'b', '```') },
    ];
    const plan = planSnippets(docs);
    expect(plan.entries.map((e) => e.name)).toEqual(['README_md__1.ts', 'docs_guide_md__1.ts']);
    expect(plan.checked).toBe(2);
    expect(plan.skipped).toBe(0);
  });

  test('an empty doc set is an empty plan', () => {
    expect(planSnippets([])).toEqual({ entries: [], checked: 0, skipped: 0 });
  });
});

describe('vacuousOptInError (D11 — zero tagged snippets is a hard error)', () => {
  test('a plan with no checked snippets returns the hard-error message', () => {
    const plan = planSnippets([{ relPath: 'README.md', text: md('```ts', 'partial', '```') }]);
    expect(plan.checked).toBe(0);
    expect(vacuousOptInError(plan)).toContain('refusing to pass vacuously');
  });

  test('a plan with at least one checked snippet passes the guard (null)', () => {
    const plan = planSnippets([{ relPath: 'README.md', text: md('<!-- snippet: check -->', '```ts', 'ok', '```') }]);
    expect(vacuousOptInError(plan)).toBeNull();
  });
});

describe('generateSnippetTsconfig', () => {
  test('extends the repo config, relaxes exactly the three flags, and embeds the given paths', () => {
    const paths = { pkg: ['../../src/index.ts'] };
    expect(generateSnippetTsconfig({ extendsPath: '../../tsconfig.json', paths })).toEqual({
      extends: '../../tsconfig.json',
      compilerOptions: {
        paths,
        noEmit: true,
        verbatimModuleSyntax: false,
        isolatedModules: false,
        noPropertyAccessFromIndexSignature: false,
      },
      include: ['./*.ts'],
      exclude: [],
    });
  });

  test('clears the parent exclude so emitted snippet files are seen (include ./*.ts, exclude [])', () => {
    const cfg = generateSnippetTsconfig({ extendsPath: '../../tsconfig.json', paths: {} });
    expect(cfg.include).toEqual(['./*.ts']);
    expect(cfg.exclude).toEqual([]);
  });
});

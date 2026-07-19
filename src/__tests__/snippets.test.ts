import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  CHECK_MARKER_RE,
  FENCE_CLOSE_RE,
  FENCE_OPEN_RE,
  checkSnippets,
  deriveSrcPaths,
  extractSnippets,
  generateSnippetTsconfig,
  planSnippets,
  selectDocFiles,
  slugForDoc,
  snippetFileName,
  vacuousOptInError,
} from '../snippets.js';
import type { DocInput, SnippetSpawn } from '../snippets.js';

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
  test('extends the repo config, relaxes the style flags plus the composite-build fields, and embeds the given paths', () => {
    const paths = { pkg: ['../../src/index.ts'] };
    expect(generateSnippetTsconfig({ extendsPath: '../../tsconfig.json', paths })).toEqual({
      extends: '../../tsconfig.json',
      compilerOptions: {
        paths,
        noEmit: true,
        verbatimModuleSyntax: false,
        isolatedModules: false,
        noPropertyAccessFromIndexSignature: false,
        rootDir: '../..',
        composite: false,
        declaration: false,
        declarationMap: false,
        incremental: false,
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

describe('deriveSrcPaths (Q1 — src-mode path mapping)', () => {
  test('prefers the repo tsconfig paths when present, remapped two directories deeper', () => {
    const mapped = deriveSrcPaths({
      manifestName: 'fascicle',
      tsconfigPaths: { fascicle: ['./src/index.ts'], '#core': ['src/core/index.ts'] },
      hasSrcIndex: true,
    });
    expect(mapped).toEqual({ fascicle: ['../../src/index.ts'], '#core': ['../../src/core/index.ts'] });
  });

  test('falls back to the src/index.ts convention when tsconfig has no paths', () => {
    const mapped = deriveSrcPaths({ manifestName: 'checkride', tsconfigPaths: null, hasSrcIndex: true });
    expect(mapped).toEqual({ checkride: ['../../src/index.ts'] });
  });

  test('an empty tsconfig paths object also falls back to the convention', () => {
    const mapped = deriveSrcPaths({ manifestName: 'checkride', tsconfigPaths: {}, hasSrcIndex: true });
    expect(mapped).toEqual({ checkride: ['../../src/index.ts'] });
  });

  test('returns null (recommend snippets-dist) when there is no manifest name', () => {
    expect(deriveSrcPaths({ manifestName: null, tsconfigPaths: null, hasSrcIndex: true })).toBeNull();
  });

  test('returns null when there is no src/index.ts and no tsconfig paths', () => {
    expect(deriveSrcPaths({ manifestName: 'checkride', tsconfigPaths: null, hasSrcIndex: false })).toBeNull();
  });
});

/** A real spawner, mirroring the orchestrator's `spawnCheck` capture. */
const realSpawn: SnippetSpawn = (command, args, cwd) =>
  new Promise((resolve) => {
    const proc = nodeSpawn(command, args, { cwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('error', (err) => resolve({ ok: false, exit_code: -1, stdout, stderr: err.message }));
    proc.on('close', (code) => resolve({ ok: code === 0, exit_code: code ?? -1, stdout, stderr }));
  });

describe('checkSnippets (fixture repo, real subprocess)', () => {
  // Nested under this repo's own `.check/` (gitignored) rather than the OS
  // tmpdir: `pnpm exec tsc` requires a package.json to resolve at all, and
  // resolves the `tsc` binary by walking up from `cwd` through ancestor
  // `node_modules/.bin` — nesting here lets it find this repo's own pinned
  // typescript install instead of hitting the network.
  let dir: string;
  beforeEach(async () => {
    await mkdir(join(process.cwd(), '.check'), { recursive: true });
    dir = await mkdtemp(join(process.cwd(), '.check', 'checkride-snippets-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const TSCONFIG = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      types: [],
    },
  };

  test('a passing snippet typechecks against source (src mode, src/index.ts convention)', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-pkg', version: '1.0.0' }));
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(TSCONFIG));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'index.ts'), 'export const answer = 42;\n');
    await writeFile(
      join(dir, 'README.md'),
      [
        '# fixture-pkg',
        '',
        '<!-- snippet: check -->',
        '```ts',
        "import { answer } from 'fixture-pkg';",
        'const x: number = answer;',
        'console.log(x);',
        '```',
        '',
      ].join('\n'),
    );

    const outcome = await checkSnippets({ cwd: dir, mode: 'src', pm: 'pnpm', spawn: realSpawn });

    expect(outcome.ok).toBe(true);
    expect(outcome.exit_code).toBe(0);
    const parsed = JSON.parse(outcome.stdout) as { ok: boolean; checked: number; skipped: number; mode: string };
    expect(parsed).toEqual({ ok: true, checked: 1, skipped: 0, mode: 'src' });
  }, 15000);

  test('a passing snippet typechecks against the built .d.ts (dist mode, package self-reference)', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture-pkg',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      }),
    );
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(TSCONFIG));
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(join(dir, 'dist', 'index.js'), 'export const answer = 42;\n');
    await writeFile(join(dir, 'dist', 'index.d.ts'), 'export declare const answer: number;\n');
    await writeFile(
      join(dir, 'README.md'),
      [
        '<!-- snippet: check -->',
        '```ts',
        "import { answer } from 'fixture-pkg';",
        'const x: number = answer;',
        '```',
        '',
      ].join('\n'),
    );

    const outcome = await checkSnippets({ cwd: dir, mode: 'dist', pm: 'pnpm', spawn: realSpawn });

    expect(outcome.ok).toBe(true);
    const parsed = JSON.parse(outcome.stdout) as { ok: boolean; mode: string };
    expect(parsed).toEqual({ ok: true, checked: 1, skipped: 0, mode: 'dist' });
  }, 15000);

  test('a failing snippet reports tsc output plus a legend mapping back to <doc>:<line>', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-pkg', version: '1.0.0' }));
    await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(TSCONFIG));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'index.ts'), 'export const answer = 42;\n');
    await writeFile(
      join(dir, 'README.md'),
      [
        '# fixture-pkg',
        '',
        '<!-- snippet: check -->',
        '```ts',
        "const broken: number = 'not a number';",
        '```',
        '',
      ].join('\n'),
    );

    const outcome = await checkSnippets({ cwd: dir, mode: 'src', pm: 'pnpm', spawn: realSpawn });

    expect(outcome.ok).toBe(false);
    expect(outcome.exit_code).toBe(1);
    expect(outcome.stderr).toContain('snippet(s) failed to compile');
    expect(outcome.stderr).toContain('README_md__1.ts');
    expect(outcome.stderr).toContain('snippet -> source map:');
    expect(outcome.stderr).toContain('README_md__1.ts  <-  README.md:4');
  }, 15000);

  test('zero tagged snippets is a hard error and never spawns tsc', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-pkg', version: '1.0.0' }));
    await writeFile(join(dir, 'README.md'), ['# fixture-pkg', '', '```ts', 'untagged', '```', ''].join('\n'));

    let spawned = false;
    const spy: SnippetSpawn = (...args) => {
      spawned = true;
      return realSpawn(...args);
    };
    const outcome = await checkSnippets({ cwd: dir, mode: 'src', pm: 'pnpm', spawn: spy });

    expect(spawned).toBe(false);
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('refusing to pass vacuously');
  });

  test('src mode with no tsconfig paths and no src/index.ts fails with a snippets-dist recommendation, never spawning', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-pkg', version: '1.0.0' }));
    await writeFile(
      join(dir, 'README.md'),
      ['<!-- snippet: check -->', '```ts', 'const x = 1;', '```', ''].join('\n'),
    );

    let spawned = false;
    const spy: SnippetSpawn = (...args) => {
      spawned = true;
      return realSpawn(...args);
    };
    const outcome = await checkSnippets({ cwd: dir, mode: 'src', pm: 'pnpm', spawn: spy });

    expect(spawned).toBe(false);
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('snippets-dist');
  });
});

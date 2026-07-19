/**
 * Built-in `snippets` check.
 *
 * A doc snippet typecheck ported to match fascicle's `check-doc-snippets.mjs`
 * byte-for-byte so the origin repo can adopt the slot verbatim (D11). It pulls
 * fenced ```ts / ```typescript blocks out of `README.md` and the non-recursive
 * `docs/*.md`, and typechecks only the ones explicitly opted in with an HTML
 * comment on the line immediately above the fence:
 *
 *     <!-- snippet: check -->
 *
 * Opt-in (rather than checking every fence) keeps the check honest: many doc
 * fences are deliberately partial fragments that assert nothing about the API.
 * A tagged snippet that fails to compile is documentation that lies — this
 * turns that into a build failure. Opting the slot in but tagging *nothing* is
 * a misconfiguration, not a vacuous pass, so zero tagged snippets is a hard
 * error ({@link vacuousOptInError}; fascicle exits 2).
 *
 * The pure machinery — no filesystem, no spawning:
 *
 *   - {@link extractSnippets} parses one doc's markdown into its ts/typescript
 *     fenced blocks, recording each block's start line and whether it is tagged;
 *   - {@link slugForDoc} / {@link snippetFileName} name the emitted scratch file
 *     for a block (`<slug>__<n>.ts`);
 *   - {@link planSnippets} folds a set of docs into the emission plan (the
 *     checked blocks to write, each mapped back to `<doc>:<line>`) plus the
 *     checked/skipped counts;
 *   - {@link generateSnippetTsconfig} builds the generated tsconfig (extends the
 *     repo's own, relaxes the three emit/style flags plus the composite-build
 *     fields a `tsc --build` project carries, embeds the caller's mode-specific
 *     `paths`).
 *
 * Execution (D12/Q1), consuming the primitives above:
 *
 *   - {@link deriveSrcPaths} resolves **src mode**'s `paths` mapping: the repo's
 *     own tsconfig `paths` when present, else the `src/index.ts` convention,
 *     else null (the caller fails, recommending `snippets-dist`);
 *   - {@link checkSnippets} discovers the doc set, plans it, derives the mode's
 *     `paths`, emits the scratch files + generated tsconfig under
 *     `.check/doc-snippets/`, and typechecks them via a spawned
 *     `<pm> exec tsc --noEmit -p`, returning a {@link CheckOutcome} whose
 *     failure `stderr` carries tsc's raw output plus the `snippet -> source
 *     map:` legend.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CheckOutcome } from './links.js';
import type { PackageManager } from './pm/index.js';
import { translateExec } from './pm/index.js';

/**
 * The opt-in marker: an HTML comment `<!-- snippet: check -->` that must sit on
 * the line immediately above a fence for its snippet to be typechecked. Exact
 * fascicle regex (D11).
 */
export const CHECK_MARKER_RE = /<!--\s*snippet:\s*check\s*-->/;

/** An opening fence — `ts` or `typescript` only, nothing else on the line (D11). */
export const FENCE_OPEN_RE = /^```(ts|typescript)\s*$/;

/** A closing fence: three backticks alone on the line. */
export const FENCE_CLOSE_RE = /^```\s*$/;

/**
 * One `ts`/`typescript` fenced block extracted from a doc. `code` is the fence
 * body verbatim (no trailing newline — step 8 appends one on write); `startLine`
 * is the 1-based line of the opening fence; `checked` is true when a
 * {@link CHECK_MARKER_RE} marker sits on the immediately-preceding line.
 */
export type Snippet = {
  code: string;
  startLine: number;
  checked: boolean;
};

/** A doc to plan over: its repo-relative path and full text. */
export type DocInput = {
  relPath: string;
  text: string;
};

/**
 * One checked snippet in the emission plan: the scratch file to write
 * (`<slug>__<n>.ts`), and the source doc + line it maps back to (the
 * `snippet -> source map:` legend step 8 renders on failure).
 */
export type SnippetPlanEntry = {
  name: string;
  file: string;
  line: number;
  code: string;
};

/** The emission plan for a doc set: checked blocks to write, plus the counts. */
export type SnippetsPlan = {
  entries: SnippetPlanEntry[];
  checked: number;
  skipped: number;
};

/** The two modes `snippets` runs in (D12): fast against `src`, or against built `dist/*.d.ts`. */
export type SnippetMode = 'src' | 'dist';

/** The generated tsconfig object (serialized to `.check/doc-snippets/tsconfig.json`). */
export type SnippetTsconfig = {
  extends: string;
  compilerOptions: {
    paths: Record<string, string[]>;
    noEmit: true;
    verbatimModuleSyntax: false;
    isolatedModules: false;
    noPropertyAccessFromIndexSignature: false;
    rootDir: '../..';
    composite: false;
    declaration: false;
    declarationMap: false;
    incremental: false;
  };
  include: string[];
  exclude: string[];
};

/**
 * Select the doc files to check from a `docs/` directory listing (D11): always
 * `README.md`, then every non-recursive `docs/*.md` entry, README first and the
 * `docs/` entries in the order given. Pure — the caller does the (non-recursive)
 * `readdir` and passes its entries; a plain entry list means a nested
 * `docs/sub/x.md` never appears (its listing entry `sub` fails `.md`), matching
 * fascicle's non-recursive `doc_files`.
 */
export function selectDocFiles(docsEntries: readonly string[]): string[] {
  const files = ['README.md'];
  for (const name of docsEntries) {
    if (name.endsWith('.md')) files.push(`docs/${name}`);
  }
  return files;
}

/**
 * Parse a doc's markdown into its `ts`/`typescript` fenced blocks (D11). A block
 * is `checked` when a {@link CHECK_MARKER_RE} marker sits on the line immediately
 * above its opening fence — a marker anywhere else does not count. Untagged
 * blocks are still returned (the caller counts them as skipped). Semantics match
 * fascicle's `extract_blocks` exactly.
 */
export function extractSnippets(text: string): Snippet[] {
  const lines = text.split('\n');
  const blocks: Snippet[] = [];
  let i = 0;
  while (i < lines.length) {
    if (FENCE_OPEN_RE.test(lines[i] ?? '')) {
      const startLine = i + 1;
      const checked = i > 0 && CHECK_MARKER_RE.test(lines[i - 1] ?? '');
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      blocks.push({ code: body.join('\n'), startLine, checked });
    }
    i += 1;
  }
  return blocks;
}

/**
 * The scratch-file slug for a doc's repo-relative path: every non-alphanumeric
 * run collapses to a single `_`, with leading/trailing `_` trimmed
 * (`README.md` → `README_md`, `docs/guide.md` → `docs_guide_md`). Exact fascicle
 * algorithm. Distinct docs in the discovered namespace (`README.md` plus the
 * flat `docs/*.md`) map to distinct slugs, so their emitted files never collide.
 */
export function slugForDoc(relPath: string): string {
  return relPath.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * The scratch-file name for a block: `<slug>__<n>.ts`, where `n` is the block's
 * 1-based position among *all* ts/typescript fences in its doc (checked or not) —
 * so a skipped fence still advances the number, matching fascicle.
 */
export function snippetFileName(relPath: string, blockIndex: number): string {
  return `${slugForDoc(relPath)}__${blockIndex}.ts`;
}

/**
 * Fold a set of docs into the emission plan: every checked block becomes a
 * {@link SnippetPlanEntry} (named, mapped back to `<doc>:<line>`), untagged
 * blocks bump `skipped`. The block index for naming counts all fences in a doc,
 * so a checked block keeps its position even after skipped ones (fascicle
 * parity). Pure — the caller reads the docs and writes the files.
 */
export function planSnippets(docs: readonly DocInput[]): SnippetsPlan {
  const entries: SnippetPlanEntry[] = [];
  let checked = 0;
  let skipped = 0;
  for (const doc of docs) {
    extractSnippets(doc.text).forEach((block, index) => {
      if (!block.checked) {
        skipped += 1;
        return;
      }
      entries.push({
        name: snippetFileName(doc.relPath, index + 1),
        file: doc.relPath,
        line: block.startLine,
        code: block.code,
      });
      checked += 1;
    });
  }
  return { entries, checked, skipped };
}

/**
 * The vacuous-opt-in guard (D11): a plan with no checked snippets is a hard
 * error, not a vacuous green — opting the slot in obligates at least one tagged
 * fence. Returns the error message for step 8 to surface (fascicle exits 2), or
 * null when the plan has something to check.
 */
export function vacuousOptInError(plan: SnippetsPlan): string | null {
  if (plan.checked > 0) return null;
  return 'no tagged snippets found — refusing to pass vacuously (add a `<!-- snippet: check -->` marker above a ts/typescript fence)';
}

/**
 * Build the generated tsconfig (D11): extend the repo's own config so the
 * snippets inherit its strictness, then relax exactly the three flags that
 * false-positive on illustrative snippets (`verbatimModuleSyntax`,
 * `isolatedModules`, `noPropertyAccessFromIndexSignature`) while keeping the
 * type-correctness flags that catch real API drift. `include` clears the parent's
 * `.check` exclusion so the emitted `./*.ts` are seen; `paths` is the caller's
 * mode-specific module resolution (src vs dist — Q1).
 *
 * A `tsc --build` project (composite, `rootDir`/`outDir` pinned to `src`/`dist`
 * for project-reference emit) fails TS6059 on any *source* file outside its
 * `rootDir` — and the generated snippets live under `.check/doc-snippets/`,
 * while src mode's `paths` mapping pulls in a real source file elsewhere in the
 * repo (dist mode's self-referenced `.d.ts` is exempt: a declaration file isn't
 * subject to the same check). `rootDir: '../..'` re-scopes to `cwd` — the
 * common ancestor of both — so either file satisfies it; `composite`/
 * `declaration`/`declarationMap`/`incremental` are turned off since this is a
 * one-shot typecheck, never a build. All four are no-ops on a plain
 * (non-composite) project's tsconfig, so the override is harmless there too.
 */
export function generateSnippetTsconfig(opts: {
  extendsPath: string;
  paths: Record<string, string[]>;
}): SnippetTsconfig {
  return {
    extends: opts.extendsPath,
    compilerOptions: {
      paths: opts.paths,
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
  };
}

// ---------------------------------------------------------------------------
// Execution (D12/Q1): doc discovery, tsconfig `paths` derivation, snippet +
// tsconfig emission, and compilation via a spawned `<pm> exec tsc`.
// ---------------------------------------------------------------------------

/** The compilation subprocess spawner — same signature as the orchestrator's `spawnCheck`. */
export type SnippetSpawn = (
  command: string,
  args: string[],
  cwd: string,
  timeoutSec?: number,
) => Promise<CheckOutcome>;

/** Where the generated snippet files + tsconfig land, relative to `cwd`. */
const OUT_DIR_REL = join('.check', 'doc-snippets');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the doc set (D11): `README.md` plus non-recursive `docs/*.md`, skipping
 * any that don't exist — a repo with no `docs/` directory (or no `README.md`)
 * still runs on what it has; an empty result is caught by
 * {@link vacuousOptInError}.
 */
async function discoverDocs(cwd: string): Promise<DocInput[]> {
  let docsEntries: string[] = [];
  try {
    docsEntries = await readdir(join(cwd, 'docs'));
  } catch {
    // No docs/ directory — README.md alone still gets checked.
  }
  const found = await Promise.all(
    selectDocFiles(docsEntries).map(async (relPath): Promise<DocInput | null> => {
      try {
        return { relPath, text: await readFile(join(cwd, relPath), 'utf8') };
      } catch {
        return null;
      }
    }),
  );
  return found.filter((d): d is DocInput => d !== null);
}

/** The package name from `package.json`, or null on any read/parse failure or a missing `name`. */
async function readManifestName(cwd: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    const name = isRecord(parsed) ? parsed['name'] : undefined;
    return typeof name === 'string' && name ? name : null;
  } catch {
    return null;
  }
}

/**
 * The repo's own `tsconfig.json`'s **own** `compilerOptions.paths` (not resolved
 * through its `extends` chain — a repo that hand-declares self-referencing
 * paths, as fascicle does, puts them directly on the root file), or null when
 * absent, unreadable, or empty.
 */
async function readOwnTsconfigPaths(cwd: string): Promise<Record<string, string[]> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(cwd, 'tsconfig.json'), 'utf8'));
    const compilerOptions = isRecord(parsed) ? parsed['compilerOptions'] : undefined;
    const paths = isRecord(compilerOptions) ? compilerOptions['paths'] : undefined;
    if (!isRecord(paths)) return null;
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(paths)) {
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Rewrite a tsconfig-root-relative target (`./src/x.ts` or `src/x.ts`) to resolve from `.check/doc-snippets/`. */
function remapRootRelative(target: string): string {
  const stripped = target.startsWith('./') ? target.slice(2) : target;
  return `../../${stripped}`;
}

/**
 * Derive the `paths` mapping **src mode** needs so `import { x } from
 * '<pkg-name>'` resolves against source (Q1): the repo's own tsconfig `paths`
 * when present (remapped two directories deeper, to where the generated
 * tsconfig lives), else the `src/index.ts` convention (`<pkg-name>` maps to its
 * root `src/index.ts`) when the manifest names the package and that file
 * exists, else null — the caller turns a null into a failing outcome that
 * recommends `snippets-dist` (whose dist-mode compilation needs no mapping at
 * all: package self-reference through `exports` resolves the built types).
 */
export function deriveSrcPaths(opts: {
  manifestName: string | null;
  tsconfigPaths: Record<string, readonly string[]> | null;
  hasSrcIndex: boolean;
}): Record<string, string[]> | null {
  if (opts.tsconfigPaths && Object.keys(opts.tsconfigPaths).length > 0) {
    const remapped: Record<string, string[]> = {};
    for (const [key, targets] of Object.entries(opts.tsconfigPaths)) {
      remapped[key] = targets.map(remapRootRelative);
    }
    return remapped;
  }
  if (opts.manifestName !== null && opts.hasSrcIndex) {
    return { [opts.manifestName]: ['../../src/index.ts'] };
  }
  return null;
}

function failOutcome(message: string): CheckOutcome {
  return {
    ok: false,
    exit_code: 1,
    stdout: `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`,
    stderr: `check-snippets: ${message}\n`,
  };
}

/** Compile the generated tsconfig via `<pm> exec tsc --noEmit -p <path>`, translated per PM. */
function runTsc(
  cwd: string,
  tsconfigRelPath: string,
  pm: PackageManager,
  spawn: SnippetSpawn,
  timeoutSec: number | undefined,
): Promise<CheckOutcome> {
  const { command, args } = translateExec('pnpm', ['exec', 'tsc', '--noEmit', '-p', tsconfigRelPath], pm);
  return spawn(command, args, cwd, timeoutSec);
}

/**
 * Run the `snippets` check against `cwd` in `mode` (D12: the `snippets` src
 * adapter passes `'src'`, `snippets-dist` passes `'dist'`). Discovers the doc
 * set, plans the checked snippets ({@link vacuousOptInError} applies first —
 * zero tagged snippets is a hard error before anything is written), derives
 * the mode's `paths` mapping, emits the scratch files plus a generated
 * tsconfig under `.check/doc-snippets/`, and typechecks them through the
 * injected `spawn`. A compile failure's `stderr` carries tsc's raw output plus
 * the `snippet -> source map:` legend mapping each generated file back to
 * `<doc>:<line>` (D11).
 */
export async function checkSnippets(opts: {
  cwd: string;
  mode: SnippetMode;
  pm: PackageManager;
  spawn: SnippetSpawn;
  timeoutSec?: number;
}): Promise<CheckOutcome> {
  const { cwd, mode, pm, spawn, timeoutSec } = opts;

  const plan = planSnippets(await discoverDocs(cwd));
  const vacuous = vacuousOptInError(plan);
  if (vacuous) return failOutcome(vacuous);

  let paths: Record<string, string[]> = {};
  if (mode === 'src') {
    const [manifestName, tsconfigPaths] = await Promise.all([readManifestName(cwd), readOwnTsconfigPaths(cwd)]);
    const derived = deriveSrcPaths({
      manifestName,
      tsconfigPaths,
      hasSrcIndex: existsSync(join(cwd, 'src', 'index.ts')),
    });
    if (derived === null) {
      return failOutcome(
        "cannot map snippet imports to source: tsconfig.json has no self-referencing 'paths' and there is no " +
          "src/index.ts — add a 'paths' entry for the package name, or opt into the 'snippets-dist' adapter " +
          'instead (dist mode needs no mapping)',
      );
    }
    paths = derived;
  }

  const outDir = join(cwd, OUT_DIR_REL);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await Promise.all(plan.entries.map((e) => writeFile(join(outDir, e.name), `${e.code}\n`, 'utf8')));

  const tsconfig = generateSnippetTsconfig({ extendsPath: '../../tsconfig.json', paths });
  await writeFile(join(outDir, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`, 'utf8');

  const outcome = await runTsc(cwd, join(OUT_DIR_REL, 'tsconfig.json'), pm, spawn, timeoutSec);
  const status = { checked: plan.checked, skipped: plan.skipped, mode };

  if (outcome.ok) {
    return {
      ok: true,
      exit_code: 0,
      stdout: `${JSON.stringify({ ok: true, ...status }, null, 2)}\n`,
      stderr: `check-snippets: ${plan.checked} snippet(s) compile against ${mode} (${plan.skipped} skipped)\n`,
    };
  }

  const legend = plan.entries.map((e) => `  ${e.name}  <-  ${e.file}:${e.line}`).join('\n');
  const tscOutput = `${outcome.stdout}${outcome.stderr}`.trim();
  return {
    ok: false,
    exit_code: 1,
    stdout: `${JSON.stringify({ ok: false, ...status }, null, 2)}\n`,
    stderr: `check-snippets: snippet(s) failed to compile:\n\n${tscOutput}\n\nsnippet -> source map:\n${legend}\n`,
  };
}

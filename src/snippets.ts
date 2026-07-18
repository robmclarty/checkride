/**
 * Built-in `snippets` check — **pure extraction core** (step 7 of the
 * publish-ready bundle; execution + adapters land in step 8).
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
 * This module is the pure machinery only — no filesystem, no spawning:
 *
 *   - {@link extractSnippets} parses one doc's markdown into its ts/typescript
 *     fenced blocks, recording each block's start line and whether it is tagged;
 *   - {@link slugForDoc} / {@link snippetFileName} name the emitted scratch file
 *     for a block (`<slug>__<n>.ts`);
 *   - {@link planSnippets} folds a set of docs into the emission plan (the
 *     checked blocks to write, each mapped back to `<doc>:<line>`) plus the
 *     checked/skipped counts;
 *   - {@link generateSnippetTsconfig} builds the generated tsconfig (extends the
 *     repo's own, relaxes the three emit/style flags, embeds the caller's
 *     mode-specific `paths`).
 *
 * Doc discovery, snippet/tsconfig emission, `<pm> exec tsc` execution, and the
 * src-vs-dist path mapping (Q1) all live in step 8's adapter, which consumes the
 * primitives here.
 */

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

/** The generated tsconfig object (serialized to `.check/doc-snippets/tsconfig.json` in step 8). */
export type SnippetTsconfig = {
  extends: string;
  compilerOptions: {
    paths: Record<string, string[]>;
    noEmit: true;
    verbatimModuleSyntax: false;
    isolatedModules: false;
    noPropertyAccessFromIndexSignature: false;
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
 * mode-specific module resolution (src vs dist — Q1, resolved in step 8).
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
    },
    include: ['./*.ts'],
    exclude: [],
  };
}

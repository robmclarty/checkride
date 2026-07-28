/**
 * Built-in relative-markdown-link check.
 *
 * Walks every `*.md` under `cwd` (minus the exclude set), parses inline
 * `[text](target)` links, and verifies that each relative target exists on
 * disk. External URLs and pure `#anchor` targets are skipped; a `#fragment`
 * on a relative target is stripped before the existence check. Links inside
 * fenced code blocks and inline code spans are examples, not links, and are
 * skipped too.
 *
 * Two config knobs (`checks.links.{exclude,allowlist}`) tune the walk: `exclude`
 * adds directory names to skip on top of the built-in set (repos with generated
 * or vendored markdown — `docs/`, `research/`, a `.ridgeline/` build store), and
 * `allowlist` is a set of regex sources; any link target one matches is treated
 * as valid (for deliberately illustrative `[x](target)` links that never resolve
 * on disk). Together they retire a project's bespoke link-checker script.
 *
 * Returns a result the orchestrator persists to `.check/links.json`:
 *   stdout `{ "ok": true }`                  on success (exit 0)
 *   stdout `[{ file, line, link, resolved }]` on miss   (exit 1)
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** The shape every check (spawned or built-in) produces. */
export type CheckOutcome = {
  ok: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
};

type LinkMiss = {
  file: string;
  line: number;
  link: string;
  resolved: string;
};

/**
 * Config-provided tuning for the links check, carried on the resolved adapter
 * (whose fields are optional, hence the explicit `| undefined`).
 */
export type LinksOptions = {
  /** Directory names to skip *in addition to* {@link DEFAULT_EXCLUDE_DIRS}. */
  exclude?: readonly string[] | undefined;
  /**
   * Regex sources; a link target matching any is treated as valid (never a
   * miss). For deliberately illustrative links that don't resolve on disk.
   */
  allowlist?: readonly string[] | undefined;
};

/** Directories never walked for markdown — build output, VCS, tool caches. */
const DEFAULT_EXCLUDE_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  '.check',
  '.stryker-tmp',
  '.git',
  '.fallow',
  'coverage',
  '.pnpm-store',
];

const LINK_RE = /\[([^\]\n]*)\]\(([^)\n]+)\)/g;

/** An opening or closing code fence: up to 3 leading spaces, then 3+ backticks or tildes. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

async function walkMarkdown(dir: string, acc: string[], exclude: ReadonlySet<string>): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  const directories: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!exclude.has(entry.name)) directories.push(full);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      acc.push(full);
    }
  }
  // Descend into subdirectories concurrently; each accumulates into `acc`.
  await Promise.all(directories.map((full) => walkMarkdown(full, acc, exclude)));
  return acc;
}

function isExternal(target: string): boolean {
  return (
    target.startsWith('http://') ||
    target.startsWith('https://') ||
    target.startsWith('mailto:')
  );
}

function stripFragment(target: string): string {
  const hash = target.indexOf('#');
  return hash === -1 ? target : target.slice(0, hash);
}

/** A target with nothing to verify on disk: external URL, bare `#anchor`, or allowlisted. */
function isIgnorableTarget(target: string, allowlist: readonly RegExp[]): boolean {
  return isExternal(target) || target.startsWith('#') || allowlist.some((re) => re.test(target));
}

/** Resolve a relative link target to an on-disk path, or `null` when it has no file half. */
function resolveTarget(target: string, mdPath: string, repoRoot: string): string | null {
  const fileHalf = stripFragment(target).trim();
  if (!fileHalf) return null;
  return isAbsolute(fileHalf) ? join(repoRoot, fileHalf) : resolve(dirname(mdPath), fileHalf);
}

/** The fence a line opens, or `null` when it opens none. */
function openingFence(line: string): { char: string; length: number } | null {
  const m = FENCE_RE.exec(line);
  if (m === null) return null;
  const marker = m[1] ?? '';
  // A backtick fence's info string may not itself contain a backtick, so
  // ``` `a` ``` stays an inline span rather than opening a block.
  if (marker.startsWith('`') && (m[2] ?? '').includes('`')) return null;
  return { char: marker[0] ?? '', length: marker.length };
}

/** Whether `line` closes `open`: same character, at least as long, nothing trailing. */
function closesFence(line: string, open: { char: string; length: number }): boolean {
  const m = FENCE_RE.exec(line);
  if (m === null) return false;
  const marker = m[1] ?? '';
  return marker[0] === open.char && marker.length >= open.length && (m[2] ?? '').trim() === '';
}

/** Index just past the run of backticks starting at `start`. */
function backtickRunEnd(line: string, start: number): number {
  let i = start;
  while (i < line.length && line[i] === '`') i += 1;
  return i;
}

/**
 * Index just past the next run of exactly `length` backticks at or after
 * `from` — the delimiter that would close a span — or `-1` when there is none.
 */
function closingRunEnd(line: string, from: number, length: number): number {
  let i = from;
  while (i < line.length) {
    if (line[i] !== '`') {
      i += 1;
      continue;
    }
    const end = backtickRunEnd(line, i);
    if (end - i === length) return end;
    i = end;
  }
  return -1;
}

/**
 * Blank out inline code spans, so an illustrative `[text](target)` inside
 * backticks is not read as a link. Spans are replaced with spaces rather than
 * removed to keep the rest of the line's offsets intact. A span opens on a run
 * of backticks and closes on the next run of exactly that length; an unclosed
 * run is literal text and left alone. Spans that straddle a newline are not
 * matched — this is a per-line pass.
 */
function maskCodeSpans(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i];
      i += 1;
      continue;
    }
    const openEnd = backtickRunEnd(line, i);
    const closeEnd = closingRunEnd(line, openEnd, openEnd - i);
    if (closeEnd === -1) {
      out += line.slice(i, openEnd);
      i = openEnd;
      continue;
    }
    out += ' '.repeat(closeEnd - i);
    i = closeEnd;
  }
  return out;
}

/**
 * Collect every inline link target with its 1-based line number, skipping
 * fenced code blocks and inline code spans — links shown as examples in code
 * are not links to verify.
 */
function parseLinks(text: string): { line: number; target: string }[] {
  const hits: { line: number; target: string }[] = [];
  const lines = text.split('\n');
  let fence: { char: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    fence = openingFence(line);
    if (fence !== null) continue;
    const scannable = maskCodeSpans(line);
    let m: RegExpExecArray | null;
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(scannable)) !== null) {
      hits.push({ line: i + 1, target: m[2] ?? '' });
    }
  }
  return hits;
}

async function checkFile(mdPath: string, repoRoot: string, allowlist: readonly RegExp[]): Promise<LinkMiss[]> {
  let text: string;
  try {
    text = await readFile(mdPath, 'utf8');
  } catch {
    return [];
  }
  const misses: LinkMiss[] = [];
  for (const { line, target } of parseLinks(text)) {
    if (!target || isIgnorableTarget(target, allowlist)) continue;
    const base = resolveTarget(target, mdPath, repoRoot);
    if (base === null || existsSync(base)) continue;
    misses.push({
      file: relative(repoRoot, mdPath),
      line,
      link: target,
      resolved: relative(repoRoot, base),
    });
  }
  return misses;
}

/**
 * Run the links check against `cwd`; never throws on a per-file read failure.
 * `options.allowlist` sources are compiled once here — they are validated at
 * config-resolution time (`invalidConfig`), so compilation is expected to
 * succeed.
 */
export async function checkLinks(cwd: string, options: LinksOptions = {}): Promise<CheckOutcome> {
  const exclude = new Set([...DEFAULT_EXCLUDE_DIRS, ...(options.exclude ?? [])]);
  const allowlist = (options.allowlist ?? []).map((src) => new RegExp(src));
  const files = await walkMarkdown(cwd, [], exclude);
  // Each file is read and checked independently — run them concurrently.
  const misses = (await Promise.all(files.map((f) => checkFile(f, cwd, allowlist)))).flat();

  if (misses.length === 0) {
    return { ok: true, exit_code: 0, stdout: `${JSON.stringify({ ok: true }, null, 2)}\n`, stderr: '' };
  }

  const stderr = misses
    .map((m) => `check-links: broken link in ${m.file}:${m.line} -> ${m.link} (resolved: ${m.resolved})`)
    .join('\n');
  return {
    ok: false,
    exit_code: 1,
    stdout: `${JSON.stringify(misses, null, 2)}\n`,
    stderr: `${stderr}\n`,
  };
}

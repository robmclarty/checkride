/**
 * Built-in relative-markdown-link check.
 *
 * Walks every `*.md` under `cwd` (minus the exclude set), parses inline
 * `[text](target)` links, and verifies that each relative target exists on
 * disk. External URLs and pure `#anchor` targets are skipped; a `#fragment`
 * on a relative target is stripped before the existence check.
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

function parseLinks(text: string): { line: number; target: string }[] {
  const hits: { line: number; target: string }[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    let m: RegExpExecArray | null;
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(line)) !== null) {
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
    if (!target) continue;
    if (isExternal(target)) continue;
    if (target.startsWith('#')) continue;
    if (allowlist.some((re) => re.test(target))) continue;

    const fileHalf = stripFragment(target).trim();
    if (!fileHalf) continue;

    const base = isAbsolute(fileHalf)
      ? join(repoRoot, fileHalf)
      : resolve(dirname(mdPath), fileHalf);

    if (!existsSync(base)) {
      misses.push({
        file: relative(repoRoot, mdPath),
        line,
        link: target,
        resolved: relative(repoRoot, base),
      });
    }
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

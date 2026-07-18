/**
 * Built-in relative-markdown-link check (ported from the interim
 * `scripts/check-links.mjs`).
 *
 * Walks every `*.md` under `cwd` (minus the exclude set), parses inline
 * `[text](target)` links, and verifies that each relative target exists on
 * disk. External URLs and pure `#anchor` targets are skipped; a `#fragment`
 * on a relative target is stripped before the existence check.
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

const EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  '.check',
  '.stryker-tmp',
  '.git',
  '.fallow',
  'coverage',
  '.pnpm-store',
]);

const LINK_RE = /\[([^\]\n]*)\]\(([^)\n]+)\)/g;

async function walkMarkdown(dir: string, acc: string[]): Promise<string[]> {
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
      if (!EXCLUDE_DIRS.has(entry.name)) directories.push(full);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      acc.push(full);
    }
  }
  // Descend into subdirectories concurrently; each accumulates into `acc`.
  await Promise.all(directories.map((full) => walkMarkdown(full, acc)));
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

async function checkFile(mdPath: string, repoRoot: string): Promise<LinkMiss[]> {
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

/** Run the links check against `cwd`; never throws on a per-file read failure. */
export async function checkLinks(cwd: string): Promise<CheckOutcome> {
  const files = await walkMarkdown(cwd, []);
  // Each file is read and checked independently — run them concurrently.
  const misses = (await Promise.all(files.map((f) => checkFile(f, cwd)))).flat();

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

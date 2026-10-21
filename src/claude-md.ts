/**
 * CLAUDE.md, and whether it loads the AGENTS.md that holds the checkride
 * stanza.
 *
 * Claude Code reads AGENTS.md on its own only while a repo has no CLAUDE.md,
 * `.claude/CLAUDE.md` or `CLAUDE.local.md`. Once one exists it reads those
 * instead, and AGENTS.md reaches the session only through an `@AGENTS.md`
 * import in one of them: a CLAUDE.md that links to AGENTS.md, or names it in
 * a sentence, leaves opening it to the model. So a repo's own CLAUDE.md hides
 * the stanza unless it imports AGENTS.md, is AGENTS.md through a symlink, or
 * carries the stanza itself. The pointer earlier releases of checkride wrote
 * was such a link.
 *
 * Text in, text out: `init.ts` writes what these return and `doctor.ts`
 * reads with them, and neither imports the other.
 */

import { posix } from 'node:path';

/** The marker a checkride stanza opens with; its stamp and the comment's close follow it. */
export const STANZA_BEGIN_PREFIX = '<!-- checkride:begin';

/** The files that stop Claude Code reading AGENTS.md on its own, from the repo root, CLAUDE.md first. */
export const CLAUDE_FILES: readonly string[] = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];

/** The line that loads AGENTS.md into a Claude Code session, as Claude Code's docs write it. */
export const AGENTS_IMPORT = '@AGENTS.md';

/** The CLAUDE.md checkride scaffolds: the import first, so Claude reads AGENTS.md before any note below it. */
export function claudeMd(): string {
  return [
    '# CLAUDE.md',
    '',
    AGENTS_IMPORT,
    '',
    'The line above imports [AGENTS.md](./AGENTS.md), the contract every agent in this repository follows. Claude Code-specific notes go below it.',
    '',
  ].join('\n');
}

/** The only pointer earlier releases wrote, normalized: a link Claude may never follow. */
const LEGACY_POINTER = '# CLAUDE.md\n\nClaude Code-specific notes. See [AGENTS.md](./AGENTS.md) for the full contract.';

/** Compare the way a reader would: line endings and trailing whitespace are not edits. */
function normalized(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

/** `content` without its fenced blocks and code spans, where Claude Code reads an `@path` as text. */
function outsideCode(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

/**
 * Whether `content`, read from `dir` (a path from the repo root, `.` for the
 * root itself), imports the repo's AGENTS.md: an `@` path outside code that
 * names it, as `@AGENTS.md`, `@./AGENTS.md` or, from `.claude/`,
 * `@../AGENTS.md`. An absolute or home path names some other file.
 */
export function importsAgents(content: string, dir = '.'): boolean {
  for (const [, path = ''] of outsideCode(content).matchAll(/(?:^|\s)@(\S+)/g)) {
    if (!/^[/~]/.test(path) && posix.join(dir, path) === 'AGENTS.md') return true;
  }
  return false;
}

/** Whether `content` carries a checkride stanza, as a CLAUDE.md that is AGENTS.md through a symlink does. */
export function hasStanza(content: string): boolean {
  return content.includes(STANZA_BEGIN_PREFIX);
}

/** Whether a CLAUDE file's `content`, read from `dir`, loads the stanza: it imports AGENTS.md, or carries the stanza itself. */
export function loadsStanza(content: string, dir = '.'): boolean {
  return importsAgents(content, dir) || hasStanza(content);
}

/** An edit to an existing CLAUDE.md: its new content, the change `init` records, and the line its report prints. */
export type ClaudeMdEdit = { content: string; change: string; note: string };

/**
 * The edit that makes an existing root CLAUDE.md load AGENTS.md, or `null`
 * when it already does. The pointer an earlier checkride wrote is replaced
 * whole, being checkride's own output. Any other file keeps every byte and
 * gains one `@AGENTS.md` line at its end, in its own line endings.
 */
export function claudeMdEdit(content: string): ClaudeMdEdit | null {
  if (loadsStanza(content)) return null;
  if (normalized(content) === LEGACY_POINTER) {
    return {
      content: claudeMd(),
      change: 'refreshed pointer',
      note: 'the pointer an earlier checkride wrote now imports AGENTS.md instead of linking to it',
    };
  }
  return {
    content: withAgentsImport(content),
    change: 'added @AGENTS.md import',
    note: 'added an @AGENTS.md import, since Claude Code reads CLAUDE.md instead of AGENTS.md when both exist',
  };
}

/** `content` with an `@AGENTS.md` line after its last, in its own line endings. */
function withAgentsImport(content: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const body = content.replace(/\s*$/, '');
  return body === '' ? `${AGENTS_IMPORT}${eol}` : `${body}${eol}${eol}${AGENTS_IMPORT}${eol}`;
}

/**
 * Skill delivery for harnesses that have no plugin system.
 *
 * Claude Code gets `check` and `qa` from the bundled plugin
 * (`.claude-plugin/plugin.json`), installed once and shared across every repo.
 * Cursor has no equivalent — it discovers skills from directories on disk — so
 * for Cursor the same two skills are written into the repo, from the same source
 * files the plugin ships. One authored copy, two delivery mechanisms.
 *
 * The only edit made on the way through is the frontmatter `name`: a bare
 * `check` would take the `/check` slash command in every repo it lands in, which
 * is not a name checkride should be squatting. The plugin gets namespacing for
 * free (`/checkride:check`); here it has to be spelled out.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { HookFile } from './files.js';
import { putFile, readIfExists } from './files.js';

/** Where Cursor discovers project skills, relative to the repo root. */
export const CURSOR_SKILLS_DIR = '.cursor/skills';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The package's own `skills/` directory, which ships in the published tarball. */
const SKILLS_DIR = join(HERE, '..', '..', 'skills');

/** Source skill → the name it takes once it is a repo-local Cursor skill. */
const SKILLS: readonly { source: string; name: string }[] = [
  { source: 'check', name: 'checkride-check' },
  { source: 'qa', name: 'checkride-qa' },
];

/**
 * Rewrite the `name:` field inside the leading frontmatter block, and only
 * there — a `name:` further down is prose in the skill body, not metadata.
 */
export function renameSkill(body: string, name: string): string {
  const frontmatter = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(body);
  if (!frontmatter) return body;
  const [, open, fields, close] = frontmatter;
  const renamed = (fields ?? '').replace(/^name:.*$/m, `name: ${name}`);
  return `${open}${renamed}${close}${body.slice(frontmatter[0].length)}`;
}

/**
 * Write the bundled skills into `cwd`'s Cursor skills directory. A source skill
 * that cannot be read is skipped rather than fatal: a broken or trimmed install
 * should cost the skills, not the whole `agent-setup`.
 */
export async function writeCursorSkills(cwd: string, opts: { dryRun?: boolean } = {}): Promise<HookFile[]> {
  const dryRun = opts.dryRun ?? false;
  const written = await Promise.all(
    SKILLS.map(async (skill) => {
      const body = await readIfExists(join(SKILLS_DIR, skill.source, 'SKILL.md'));
      if (body === null) return null;
      const rel = `${CURSOR_SKILLS_DIR}/${skill.name}/SKILL.md`;
      return putFile(cwd, rel, renameSkill(body, skill.name), { dryRun });
    }),
  );
  return written.filter((f) => f !== null);
}

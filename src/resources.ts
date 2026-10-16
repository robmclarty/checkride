/**
 * The package's own files: the scaffold templates, the JSON Schemas and the
 * plugin skills that ship beside `dist/`.
 *
 * Every read of `templates/`, `schema/` or `skills/` comes through here, and
 * the `read-bundled-through-resources` rule (A3) holds that. One reader is what
 * lets the standalone binary serve the same paths from its embedded assets
 * (R14.1) by changing this module and no caller.
 *
 * Paths are relative to the package root and use `/`, the form an asset key
 * takes: `templates/ts/shared/oxlintrc.json`, `skills/check/SKILL.md`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package root: one level above this module, whether it runs from `src/` or `dist/`. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Read a bundled file as UTF-8. Throws when the package doesn't carry it. */
export function readResource(relPath: string): string {
  return readFileSync(join(PACKAGE_ROOT, relPath), 'utf8');
}

/**
 * The package's own files: the scaffold templates, the JSON Schemas and the
 * plugin skills that ship beside `dist/`, and the `package.json` that names
 * the version.
 *
 * Every read of `templates/`, `schema/` or `skills/` comes through here, and
 * the `read-bundled-through-resources` rule (A3) holds that. One reader is what
 * lets the standalone binary serve the same paths from its embedded assets
 * (R14.1) by changing this module and no caller: `build/sea/build.mjs` embeds
 * each file under its relative path, and in the binary that path is the key
 * `./channel.ts` asks `node:sea` for it by.
 *
 * Paths are relative to the package root and use `/`, the form an asset key
 * takes: `templates/ts/shared/oxlintrc.json`, `skills/check/SKILL.md`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { channel, embeddedAsset } from './channel.js';

/**
 * The package root: one level above this module, whether it runs from `src/`
 * or `dist/`. Asked on each read and never at load, since the binary has no
 * package directory and must not go looking for one.
 */
function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Read a bundled file as UTF-8: from the package directory, or from the
 * binary's embedded assets. Throws when the package doesn't carry it.
 */
export function readResource(relPath: string): string {
  if (channel() === 'binary') return embeddedAsset(relPath);
  return readFileSync(join(packageRoot(), relPath), 'utf8');
}

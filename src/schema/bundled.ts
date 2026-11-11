/**
 * The schemas checkride ships, which a rule names as `checkride:<id>`:
 *
 * - `checkride:agent-skill`: a skill's `SKILL.md` frontmatter, with one check
 *   JSON Schema can't express, that `name` equals the parent directory's name.
 * - `checkride:checkride-config`: checkride's own config schema.
 *
 * Each is read through `../resources.ts`, so the standalone binary serves it
 * from its embedded assets.
 */

import { basename, dirname } from 'node:path';

import { isRecord } from '../json.js';
import { readResource } from '../resources.js';

/** What a rule's `schema` starts with when it names a bundled schema. */
const BUNDLED_PREFIX = 'checkride:';

/** One finding a bundled schema's own check adds, beside what its JSON Schema reports. */
export type ExtraError = { instancePath: string; keyword: string; message: string };

/** A check a bundled schema runs on each file beside its JSON Schema: the file's absolute path, and its parsed value. */
export type ExtraCheck = (path: string, value: unknown) => ExtraError[];

/**
 * The Agent Skills rule no JSON Schema can state: a skill's `name` is its
 * directory's name, so `skills/pdf/SKILL.md` is named `pdf`. A file whose
 * `name` isn't a string is left to the schema.
 */
const nameMatchesDirectory: ExtraCheck = (path, value) => {
  const name = isRecord(value) ? value['name'] : undefined;
  const directory = basename(dirname(path));
  if (typeof name !== 'string' || name === directory) return [];
  return [{ instancePath: '/name', keyword: 'directory-name', message: `must equal the parent directory's name, '${directory}'` }];
};

/** Each bundled schema: the file it ships as, and the check it adds. */
const BUNDLED: Readonly<Record<string, { resource: string; extra?: ExtraCheck }>> = {
  'agent-skill': { resource: 'schema/agent-skill.schema.json', extra: nameMatchesDirectory },
  'checkride-config': { resource: 'schema/checkride.config.schema.json' },
};

/** Every bundled schema, as a rule names it. */
export function bundledSchemas(): string[] {
  return Object.keys(BUNDLED).map((id) => `${BUNDLED_PREFIX}${id}`);
}

/** True for a `schema` value that names a bundled schema, one checkride ships or not. */
export function namesBundled(ref: string): boolean {
  return ref.startsWith(BUNDLED_PREFIX);
}

/** The entry of the bundled schema `ref` names, or `undefined` for a path, or an id checkride doesn't ship. */
function entryOf(ref: string): { resource: string; extra?: ExtraCheck } | undefined {
  const id = ref.slice(BUNDLED_PREFIX.length);
  return namesBundled(ref) && Object.hasOwn(BUNDLED, id) ? BUNDLED[id] : undefined;
}

/** True for a `schema` value that names a schema checkride ships. */
export function isBundled(ref: string): boolean {
  return entryOf(ref) !== undefined;
}

/** The bundled schema `ref` names: its text, and the check it adds; `null` for a path, or an id checkride doesn't ship. */
export function bundledSchema(ref: string): { text: string; extra?: ExtraCheck } | null {
  const entry = entryOf(ref);
  if (entry === undefined) return null;
  return { text: readResource(entry.resource), ...(entry.extra === undefined ? {} : { extra: entry.extra }) };
}

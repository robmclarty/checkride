/**
 * A run of the `schema` slot, from its rules to its outcome: load the
 * libraries the rules' formats need, from the repo's install or the binary's
 * bundle, then check. A library the repo hasn't installed stops it before
 * any file is read, and nothing it throws escapes: the orchestrator awaits a
 * check's runner bare, so a rejection here would end the whole run.
 */

import type { GitRunner } from '../git.js';
import type { CheckOutcome } from '../links.js';
import { checkSchemas } from './check.js';
import type { LibrariesAt, LibrarySource } from './libraries.js';
import { librariesFor, loadLibraries } from './libraries.js';
import type { LibraryName } from './library-types.js';
import type { SchemaRule } from './rules.js';
import { ruleFormats } from './rules.js';

/** What the slot's adapter carries from the config: its rules, and the config file that holds them. */
export type SchemaOptions = { rules: readonly SchemaRule[]; configFile: string };

/**
 * What a run came to: the check's outcome; `install`, the refusal for a
 * library the repo never installed; or `refusal`, for a schema that can't be
 * used.
 */
export type SchemaRun = { outcome: CheckOutcome } | { install: string } | { refusal: string };

/** The libraries `rules` need: `ajv`, and the parser of each format they read. */
export function neededLibraries(rules: readonly SchemaRule[]): LibraryName[] {
  return librariesFor(rules.flatMap(ruleFormats));
}

/** Run the slot's `options` against the repo at `at.repo`, with the libraries `at.source` holds. */
export async function runSchemaCheck(options: SchemaOptions, at: LibrariesAt & { source: LibrarySource; git?: GitRunner }): Promise<SchemaRun> {
  try {
    const loaded = loadLibraries(neededLibraries(options.rules), at, at.source);
    if ('refusal' in loaded) return { install: loaded.refusal };
    return await checkSchemas(at.repo, { ...options, libraries: loaded.libraries, ...(at.git === undefined ? {} : { git: at.git }) });
  } catch (error) {
    // Nothing the check does may end the run: whatever it didn't foresee fails this check, with what was thrown.
    return { refusal: `checkride: the schema check stopped on an error it didn't expect: ${error instanceof Error ? error.message : String(error)}.\n` };
  }
}

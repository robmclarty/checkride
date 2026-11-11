/**
 * What `doctor` says of the `schema` slot's libraries: ready, with the
 * version of each one a run would load, or which one is missing, with the
 * command that installs it. In the standalone binary they're the bundled
 * copies, so the slot is always ready there.
 */

import { channel } from '../channel.js';
import type { LibrariesAt, LibraryState } from './libraries.js';
import { libraryRefusal, SUPPORTED_MAJORS } from './libraries.js';
import type { SchemaRule } from './rules.js';
import { schemaLibraryStates } from './run.js';

/** The slot's row, in the fields a `doctor` probe carries. */
export type SchemaProbe = { status: 'ok' | 'missing'; found: string | null; expected: string; hint: string | null };

/** How the libraries of `rules` are found for a probe; a test hands its own. */
export type LibraryLookup = (rules: readonly SchemaRule[], repo: string) => LibraryState[];

/** The first line of a refusal, without its `checkride: ` prefix: the cause and the install command. */
function firstLine(refusal: string): string {
  return (refusal.split('\n')[0] ?? refusal).replace(/^checkride:\s*/, '');
}

/** Probe the libraries the slot's `rules` need, for a run in the repo at `at.repo`. */
export function probeSchemaLibraries(rules: readonly SchemaRule[], at: LibrariesAt, lookup: LibraryLookup = schemaLibraryStates): SchemaProbe {
  const states = lookup(rules, at.repo);
  const expected = states.map(({ name }) => `${name} ${SUPPORTED_MAJORS[name]}.x`).join(', ');
  const refusal = libraryRefusal(states, at);
  if (refusal !== null) return { status: 'missing', found: null, expected, hint: firstLine(refusal) };
  const versions = states.map(({ name, version }) => `${name} ${version ?? ''}`.trim()).join(', ');
  return { status: 'ok', found: channel() === 'binary' ? `bundled: ${versions}` : versions, expected, hint: null };
}

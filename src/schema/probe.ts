/**
 * What `doctor` says of the `schema` slot's libraries: ready, with the
 * version of each one a run would load, or which one is missing, with the
 * refusal a run would fail on. From the standalone binary's bundle they're
 * always there, so the slot is always ready.
 */

import type { LibrariesAt, LibrarySource } from './libraries.js';
import { libraryRefusal, SUPPORTED_MAJORS } from './libraries.js';
import type { SchemaRule } from './rules.js';
import { neededLibraries } from './run.js';

/**
 * The slot's row: what was found, what a run expects, and `refusal`, the
 * whole message a run would fail with, `null` when the libraries are ready.
 */
export type SchemaProbe = { status: 'ok' | 'missing'; found: string | null; expected: string; refusal: string | null };

/** Probe the libraries the slot's `rules` need in `source`, for a run in the repo at `at.repo`. */
export function probeSchemaLibraries(rules: readonly SchemaRule[], at: LibrariesAt, source: LibrarySource): SchemaProbe {
  const states = source.states(neededLibraries(rules));
  const expected = states.map(({ name }) => `${name} ${SUPPORTED_MAJORS[name]}.x`).join(', ');
  const refusal = libraryRefusal(states, at);
  if (refusal !== null) return { status: 'missing', found: null, expected, refusal };
  const versions = states.map(({ name, version }) => `${name} ${version ?? ''}`.trim()).join(', ');
  return { status: 'ok', found: source.label === 'bundled' ? `bundled: ${versions}` : versions, expected, refusal: null };
}

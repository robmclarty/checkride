/**
 * Defensive JSON narrowing for artifact reads.
 *
 * Both readers parse files a *different* checkride version may have written, so
 * every field access goes through a guard rather than a cast: a reader that
 * crashes on an unexpected shape is worse than one that says what it could not
 * read. These are the smallest primitives that make a `JSON.parse` result
 * usable without `any` and without asserting a type onto unvalidated bytes.
 *
 * The `../artifacts` barrel is this module's only public surface.
 */

import { isRecord } from '../json.js';
import type { JsonRecord } from '../json.js';

// `isRecord`/`JsonRecord` are the package-wide primitives (`../json.ts`);
// re-exported here so the artifacts barrel keeps its existing surface and the
// readers' import sites are unchanged.
export { isRecord };
export type { JsonRecord };

/** A string field, or `null` for every other type — including a missing key. */
export function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A number field, or `null` for every other type — including a missing key. */
export function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * A nested object, or an empty one when the key is missing or holds something
 * else. Reading a handful of fields off a block that may not exist is the
 * common shape in these artifacts, and `{}` makes every such read a `null`
 * rather than a branch at each call site.
 */
export function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

/** The object entries of an array field; `[]` when it is not an array at all. */
export function asRecordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Parse JSON without throwing: the parsed value, or `null` when it is not JSON. */
export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

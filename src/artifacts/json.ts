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

/** A parsed JSON object — the only `JSON.parse` result either reader can index. */
export type JsonRecord = Record<string, unknown>;

/** Whether a parsed value is an indexable JSON object (arrays and `null` are not). */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string field, or `null` for every other type — including a missing key. */
export function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Parse JSON without throwing: the parsed value, or `null` when it is not JSON. */
export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

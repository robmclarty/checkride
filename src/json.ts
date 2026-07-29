/**
 * The one narrowing primitive for parsed JSON.
 *
 * Every module that reads bytes it did not write — a consumer's config, a
 * committed baseline, a tool's report — needs to ask "is this an object I can
 * index?" before touching a field, and each had grown its own answer. Two of
 * the four disagreed: the config and audit copies excluded arrays, the two
 * baseline copies did not, so `loadBaseline` accepted an array as its `slots`
 * map and iterated the indices. Small enough that duplication analysis never
 * saw it (`fallow.toml` sets `minTokens = 50`), which is exactly how four
 * copies of a five-line predicate drift apart unnoticed.
 *
 * Arrays and `null` are not records. `typeof null === 'object'` and
 * `typeof [] === 'object'` are the two JavaScript traps this exists to close,
 * and a caller that wants an array should say so.
 */

/** A parsed JSON object — the only `JSON.parse` result that can be indexed by key. */
export type JsonRecord = Record<string, unknown>;

/** Whether a parsed value is an indexable JSON object (arrays and `null` are not). */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

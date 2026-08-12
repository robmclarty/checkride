/**
 * Per-team request quotas.
 *
 * The window slides: a team that bursts at the top of the hour is not locked
 * out for the rest of it. Vale lints these doc comments through the scaffolded
 * `ts = js` format mapping, and leaves the code and string literals alone.
 */
export type Quota = {
  /** Requests allowed per sliding window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
};

/**
 * Whether one more request fits the quota right now. Callers treat a refusal
 * as back-pressure, not an error.
 */
export function admits(quota: Quota, used: number): boolean {
  return used < quota.limit;
}

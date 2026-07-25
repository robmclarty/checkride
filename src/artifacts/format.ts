/**
 * Human-scale rendering of the quantities both readers report: file sizes,
 * elapsed time, and a bounded tail of captured output.
 *
 * Sizes and ages carry the judgment in a reader's table — "2.3 MB" and "4d" are
 * the whole reason an agent knows not to open a file — so they get one
 * implementation rather than one per reader.
 *
 * {@link tail} is truncation, never normalization: it drops whole lines from
 * the front and says how many, leaving the bytes it keeps exactly as the tool
 * emitted them.
 *
 * The `../artifacts` barrel is this module's only public surface.
 */

const UNITS: readonly { limit: number; suffix: string }[] = [
  { limit: 1024 ** 3, suffix: 'GB' },
  { limit: 1024 ** 2, suffix: 'MB' },
  { limit: 1024, suffix: 'KB' },
];

/** `483 B`, `5.1 KB`, `2.3 MB` — one decimal above a kilobyte, none below. */
export function formatBytes(bytes: number): string {
  for (const { limit, suffix } of UNITS) {
    if (bytes >= limit) return `${(bytes / limit).toFixed(1)} ${suffix}`;
  }
  return `${bytes} B`;
}

const DURATIONS: readonly { limit: number; suffix: string }[] = [
  { limit: 86_400_000, suffix: 'd' },
  { limit: 3_600_000, suffix: 'h' },
  { limit: 60_000, suffix: 'm' },
  { limit: 1000, suffix: 's' },
];

/** `340ms`, `1.4s`, `12m`, `4.1d` — the coarsest unit that keeps a whole part. */
export function formatDuration(ms: number): string {
  for (const { limit, suffix } of DURATIONS) {
    if (ms >= limit) return `${(ms / limit).toFixed(1)}${suffix}`;
  }
  return `${Math.round(ms)}ms`;
}

/** A bounded excerpt of captured output, with what it left out stated. */
export type Excerpt = {
  text: string;
  /** Lines dropped from the front, so the caller can say so rather than imply completeness. */
  omittedLines: number;
  /** Size of the full input, so "1.2 KB of 40 KB" is sayable. */
  totalBytes: number;
};

/**
 * The last `maxLines` non-blank lines of `text`, further trimmed from the front
 * until the excerpt fits `maxBytes`. A compiler, a test runner and a crashing
 * harness all put the thing worth reading at the end.
 */
export function tail(text: string, maxLines: number, maxBytes: number): Excerpt {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const totalBytes = Buffer.byteLength(text, 'utf8');
  let kept = lines.slice(-maxLines);
  while (kept.length > 1 && Buffer.byteLength(kept.join('\n'), 'utf8') > maxBytes) {
    kept = kept.slice(1);
  }
  return { text: kept.join('\n'), omittedLines: lines.length - kept.length, totalBytes };
}

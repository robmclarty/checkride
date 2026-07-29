/**
 * Tolerant parsing of a tool's stdout as JSON.
 *
 * A tool that emits JSON does not always get stdout to itself: any launcher,
 * wrapper or shell profile can print before it does. checkride suppresses the
 * one case it controls at the invocation (pnpm's dependency-check narration —
 * see `translateExec` and `docs/tools.md` §Launcher quirks), but a consumer's
 * launcher is not checkride's to pin, so the read tolerates a preamble too.
 *
 * **Skipping a preamble is not normalizing.** The tool's own bytes are returned
 * verbatim from the first character of the JSON onward — nothing inside them is
 * rewritten, reordered or reformatted, and what gets dropped was never the
 * tool's output to begin with. That is what keeps this compatible with "the raw
 * file is the truth" (`docs/contract.md`), which is a promise, not a detail.
 */

/**
 * How many leading lines may precede the JSON before parsing gives up. Real
 * preambles are one or two lines; the cap keeps a large non-JSON payload (a 650
 * kB test log, say) from costing one parse attempt per line.
 */
const MAX_PREAMBLE_LINES = 10;

/** A tool's stdout parsed as JSON: the value, and the exact text it came from. */
export type ToolJson = {
  /** The parsed value. */
  value: unknown;
  /**
   * The JSON text with any preamble removed — what belongs in
   * `.check/<slot>.json`, so the artifact a consumer opens actually parses.
   */
  text: string;
};

/** Parse `text` as JSON, or `undefined` when it is not JSON at all. */
function tryParse(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Parse `raw` as JSON, tolerating up to {@link MAX_PREAMBLE_LINES} lines of
 * non-JSON ahead of it. Clean output takes the fast path and is returned byte
 * for byte. Returns `null` when nothing parses — every caller treats that as a
 * loud failure, never as "clean".
 */
export function parseToolJson(raw: string): ToolJson | null {
  const whole = tryParse(raw);
  if (whole !== undefined) return { value: whole, text: raw };

  // Retry from each subsequent line start. The tool's JSON begins at a line
  // boundary because the preamble that precedes it ended with a newline.
  let offset = 0;
  for (let line = 0; line < MAX_PREAMBLE_LINES; line++) {
    const newline = raw.indexOf('\n', offset);
    if (newline === -1) break;
    offset = newline + 1;
    const rest = raw.slice(offset);
    const value = tryParse(rest);
    if (value !== undefined) return { value, text: rest };
  }
  return null;
}

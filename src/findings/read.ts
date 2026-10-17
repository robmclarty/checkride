/**
 * The defensive readers the diagnostic parsers share: tolerant JSON, string
 * and array coercion, and whether an argv shows a tool's own flags.
 */

import { parseToolJson } from '../tool-json.js';

/**
 * Parse JSON output defensively; malformed input yields `null`, never a throw.
 * Tolerant of a launcher preamble ahead of the JSON — see `parseToolJson` —
 * because a parser that silently finds no findings would quietly stop
 * masking the baseline rather than fail loudly.
 */
export function parseJson(raw: string): unknown {
  return parseToolJson(raw)?.value ?? null;
}

/** Read a field as a string, or `''` when it is missing or not a string. */
export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Coerce an unknown to an array of unknowns (non-arrays become empty). */
export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Whether `argv` runs one of `tools` itself: an element is the tool's name, or
 * a path ending in it. A wrapper (`sh -c "…"`, a package script, a shell
 * script) hides the tool's flags, so whether a warning gates can't be read
 * off its argv.
 */
export function runsTool(argv: readonly string[], tools: readonly string[]): boolean {
  return argv.some((arg) => tools.some((tool) => arg === tool || arg.endsWith(`/${tool}`)));
}

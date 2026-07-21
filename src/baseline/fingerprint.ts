/**
 * Per-adapter diagnostic fingerprints.
 *
 * A *fingerprint* is a stable, order-independent set of key strings extracted
 * from one adapter's raw output. Each key names a single finding by what it is
 * (`<file>:<rule>:<message>`) rather than where it sits, so a finding keeps its
 * key when unrelated edits shift its line and column — that is what lets
 * the baseline subtract already-known findings without re-flagging
 * them every time surrounding code moves.
 *
 * This is deliberately NOT a normalized diagnostic schema: each adapter
 * owns its own key string, the raw `.check/<slot>.json` stays authoritative, and
 * an adapter whose output isn't a stable diagnostic set simply has no extractor
 * and returns `null` — baseline is unsupported for that slot, decided
 * per-adapter against real fixtures, not from an up-front list. Extractors
 * ship for the blessed lint/struct/spell adapters (oxlint, ast-grep, cspell) and
 * for fallow's three analyses (dead-code, dupes, health — see `./fallow.ts`,
 * which also owns fallow's gating verdict).
 */

import { fallowFindings } from './fallow.js';

/** A stable, order-independent set of diagnostic keys for one adapter's output. */
export type Fingerprint = ReadonlySet<string>;

/** Turns one adapter's raw output (JSON or text) into a fingerprint. */
type Extractor = (raw: string) => Fingerprint;

/**
 * Build a finding's key from its identity. Line and column are intentionally
 * excluded so the key survives edits that only move the code; the message is
 * whitespace-collapsed so cosmetic wrapping differences don't split one finding
 * into two. `rule` is empty for tools (cspell) that don't name a rule.
 */
function key(file: string, rule: string, message: string): string {
  return `${file}:${rule}:${message.replace(/\s+/g, ' ').trim()}`;
}

/** Parse JSON output defensively; malformed input yields `null`, never a throw. */
function parseJson(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    return null;
  }
}

/** Narrow to a plain object so string fields can be read without assertions. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Read a field as a string, or `''` when it is missing or not a string. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Coerce an unknown to an array of unknowns (non-arrays become empty). */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** oxlint `--format=json`: `{ diagnostics: [{ filename, code, message }] }`. */
const extractOxlint: Extractor = (raw) => {
  const keys = new Set<string>();
  const payload = parseJson(raw);
  const diagnostics = isRecord(payload) ? asArray(payload['diagnostics']) : [];
  for (const d of diagnostics) {
    if (!isRecord(d)) continue;
    const file = str(d['filename']);
    const message = str(d['message']);
    if (file && message) keys.add(key(file, str(d['code']), message));
  }
  return keys;
};

/** ast-grep `--json=compact`: an array of `{ file, ruleId, message }`. */
const extractAstGrep: Extractor = (raw) => {
  const keys = new Set<string>();
  for (const m of asArray(parseJson(raw))) {
    if (!isRecord(m)) continue;
    const file = str(m['file']);
    const message = str(m['message']);
    if (file && message) keys.add(key(file, str(m['ruleId']), message));
  }
  return keys;
};

/** cspell default reporter line: `<file>:<line>:<col> - <message>`. */
const CSPELL_LINE = /^(.+?):\d+:\d+ - (.+)$/;

/** cspell has no rule id, so its key is `<file>::<message>` (empty rule slot). */
const extractCspell: Extractor = (raw) => {
  const keys = new Set<string>();
  for (const line of raw.split('\n')) {
    const m = CSPELL_LINE.exec(line.trim());
    if (m) keys.add(key(m[1] ?? '', '', m[2] ?? ''));
  }
  return keys;
};

/** Extractors keyed by adapter name (not slot); everything else sits out. */
const EXTRACTORS: Readonly<Record<string, Extractor>> = {
  oxlint: extractOxlint,
  'ast-grep': extractAstGrep,
  cspell: extractCspell,
  // One `fallow` adapter fills all three fallow slots (dead/dupes/health); its
  // extractor dispatches on the report's `kind`, so a single registration serves
  // every slot. See `./fallow.ts`.
  fallow: fallowFindings,
};

/**
 * Fingerprint one adapter's raw output, or `null` when the adapter has no
 * extractor (baseline unsupported for that slot). Keyed on adapter name, so an
 * alternate tool that shares a slot with a supported default (biome/eslint for
 * `lint`, knip for `dead`) opts out until it grows its own extractor. A
 * supported adapter with zero findings returns an empty set, never `null` —
 * "supported but clean" and "unsupported" are distinct, and masking and the
 * ratchet depend on the difference.
 */
export function fingerprint(adapter: string, raw: string): Fingerprint | null {
  const extractor = EXTRACTORS[adapter];
  return extractor ? extractor(raw) : null;
}

/**
 * Whether an adapter can be fingerprinted (has an extractor), decided by name
 * without needing its output. `init --baseline` uses this to tell which failing
 * slots the baseline can grandfather from those that must still fall back to a
 * `false` disable.
 */
export function isFingerprintable(adapter: string): boolean {
  return EXTRACTORS[adapter] !== undefined;
}

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
 * ship for the blessed lint/struct/spell/prose adapters (oxlint, ast-grep,
 * cspell, vale) and for fallow's three analyses (dead-code, dupes, health — see
 * `./fallow.ts`, which also owns fallow's gating verdict). Each keys only the
 * findings that can fail its check, so a finding that can only advise never
 * blocks masking.
 *
 * The same registry style keys the *report verdicts* — the adapters whose
 * pass/fail is read from the parsed report rather than the exit code — on
 * adapter name, for the same reason: it is per-tool knowledge of one output
 * format, and it belongs beside the parser, not on the registry row.
 */

import { isRecord } from '../json.js';
import { parseToolJson } from '../tool-json.js';
import type { FallowVerdict } from './fallow.js';
import { fallowFindings, fallowVerdict } from './fallow.js';

/** A stable, order-independent set of diagnostic keys for one adapter's output. */
export type Fingerprint = ReadonlySet<string>;

/**
 * The command a check spawned, then its args. Some tools take a flag that lets
 * a warning fail the run without changing the warning's reported severity, so
 * only the argv can say which findings gate. `undefined` means the caller
 * can't say, and an extractor that needs it keys every finding.
 */
type Argv = readonly string[] | undefined;

/**
 * Turns one adapter's raw output (JSON or text) into a fingerprint. Most
 * extractors always return a set — an unreadable payload is indistinguishable
 * from a clean one in their formats, so "nothing found" is the honest answer.
 * An extractor whose format *can* tell the two apart returns `null` for the
 * unreadable case instead, which propagates through {@link fingerprint} as "not
 * observed" and stands the ratchet down (see {@link extractVale}).
 */
type Extractor = (raw: string, argv: Argv) => Fingerprint | null;

/**
 * Build a finding's key from its identity. Line and column are intentionally
 * excluded so the key survives edits that only move the code; the message is
 * whitespace-collapsed so cosmetic wrapping differences don't split one finding
 * into two. `rule` is empty for tools (cspell) that don't name a rule.
 */
function key(file: string, rule: string, message: string): string {
  return `${file}:${rule}:${message.replace(/\s+/g, ' ').trim()}`;
}

/**
 * Parse JSON output defensively; malformed input yields `null`, never a throw.
 * Tolerant of a launcher preamble ahead of the JSON — see `parseToolJson` —
 * because an extractor that silently finds no findings would quietly stop
 * masking the baseline rather than fail loudly.
 */
function parseJson(raw: string): unknown {
  return parseToolJson(raw)?.value ?? null;
}

/** Read a field as a string, or `''` when it is missing or not a string. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Coerce an unknown to an array of unknowns (non-arrays become empty). */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Whether `argv` runs one of `tools` itself: an element is the tool's name, or
 * a path ending in it. A wrapper (`sh -c "…"`, a package script, a shell
 * script) hides the tool's flags, so whether a warning gates can't be read
 * off its argv.
 */
function runsTool(argv: readonly string[], tools: readonly string[]): boolean {
  return argv.some((arg) => tools.some((tool) => arg === tool || arg.endsWith(`/${tool}`)));
}

/** oxlint severities that never fail a run on their own; any other value keys. */
const OXLINT_ADVISORY: ReadonlySet<string> = new Set(['warning', 'advice']);

/**
 * Whether every oxlint diagnostic can fail the run, not only `error` ones.
 * `--deny-warnings` and `--max-warnings` make warnings gate while each still
 * reports `severity: "warning"`, so only the argv shows them. An argv that
 * hides oxlint's flags, or none at all, counts as gating everything: keying a
 * warning that can't fail costs a false red, while skipping one that can
 * would mask a red run green.
 */
function oxlintWarningsGate(argv: Argv): boolean {
  if (argv === undefined || !runsTool(argv, ['oxlint'])) return true;
  return argv.some((arg) => arg === '--deny-warnings' || arg === '--max-warnings' || arg.startsWith('--max-warnings='));
}

/**
 * oxlint `--format=json`: `{ diagnostics: [{ filename, code, message, severity }] }`.
 *
 * Only diagnostics that can fail the run are keyed, as with vale: an advisory
 * warning's key would block masking when it first appears on an otherwise
 * grandfathered red run, though it could never fail the check itself.
 */
const extractOxlint: Extractor = (raw, argv) => {
  const keys = new Set<string>();
  const all = oxlintWarningsGate(argv);
  const payload = parseJson(raw);
  const diagnostics = isRecord(payload) ? asArray(payload['diagnostics']) : [];
  for (const d of diagnostics) {
    if (!isRecord(d)) continue;
    if (!all && OXLINT_ADVISORY.has(str(d['severity']))) continue;
    const file = str(d['filename']);
    const message = str(d['message']);
    if (file && message) keys.add(key(file, str(d['code']), message));
  }
  return keys;
};

/** ast-grep severities that never fail a scan on their own; any other value keys. */
const AST_GREP_ADVISORY: ReadonlySet<string> = new Set(['warning', 'info', 'hint']);

/**
 * The rules an ast-grep argv raises to `error`: `'all'` for a bare `--error`,
 * else the ids each `--error=<id>[,<id>]` names. ast-grep already reports a
 * raised rule as `severity: "error"`, so this guards a version that doesn't.
 * An argv that hides ast-grep's flags, or none at all, raises every rule, for
 * the reason {@link oxlintWarningsGate} gives.
 */
function astGrepRaised(argv: Argv): ReadonlySet<string> | 'all' {
  if (argv === undefined || !runsTool(argv, ['ast-grep', 'sg'])) return 'all';
  const rules = new Set<string>();
  for (const arg of argv) {
    if (arg === '--error') return 'all';
    if (!arg.startsWith('--error=')) continue;
    const ids = arg.slice('--error='.length).split(',').filter(Boolean);
    if (ids.length === 0) return 'all';
    for (const id of ids) rules.add(id);
  }
  return rules;
}

/**
 * ast-grep `--json=compact`: an array of `{ file, ruleId, message, severity }`.
 * Only matches that can fail the scan are keyed, for the reason
 * {@link extractOxlint} gives.
 */
const extractAstGrep: Extractor = (raw, argv) => {
  const keys = new Set<string>();
  const raised = astGrepRaised(argv);
  for (const m of asArray(parseJson(raw))) {
    if (!isRecord(m)) continue;
    const rule = str(m['ruleId']);
    if (raised !== 'all' && !raised.has(rule) && AST_GREP_ADVISORY.has(str(m['severity']))) continue;
    const file = str(m['file']);
    const message = str(m['message']);
    if (file && message) keys.add(key(file, rule, message));
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

/**
 * Whether a parsed vale payload is an *alert report* — the `{ "<path>": [alert,
 * …] }` shape a lint run emits — rather than one of the flat runtime-error
 * objects (`{ Code: "E100" | "E201", Text, Path, Line, Span }`) it emits instead
 * when the config won't load. Every value of an alert report is an array of
 * alerts; an error report's are scalars, so the two never look alike. A clean
 * run's `{}` passes vacuously, which is the point: "clean" must stay
 * distinguishable from "broken".
 */
function isValeAlertReport(payload: unknown): payload is Record<string, Record<string, unknown>[]> {
  return (
    isRecord(payload) && Object.values(payload).every((alerts) => Array.isArray(alerts) && alerts.every(isRecord))
  );
}

/**
 * vale `--output=JSON`: `{ "<path>": [{ Check, Message, Severity }] }`.
 *
 * Only error-severity alerts are keyed. Vale's exit code — the `prose` slot's
 * whole verdict — is 1 iff an error-severity alert exists, so a warning can
 * never fail a check; fingerprinting one would hand an advisory alert gating
 * power in a baselined repo (a new warning key blocks masking on an otherwise
 * grandfathered red run) and churn the ratchet with keys no verdict can use.
 *
 * Returns `null` — never the empty set — for anything that is not an alert
 * report. A runtime error (`E100` no config, `E201` bad config) is a flat object
 * that an alert-shaped reader would happily see as zero findings, and one such
 * run would prune every grandfathered prose key out of the baseline on the next
 * ratchet. `null` means "not observed", which leaves the baseline standing.
 */
const extractVale: Extractor = (raw) => {
  const payload = parseJson(raw);
  if (!isValeAlertReport(payload)) return null;
  const keys = new Set<string>();
  for (const [file, alerts] of Object.entries(payload)) {
    for (const a of alerts) {
      if (str(a['Severity']) !== 'error') continue;
      const message = str(a['Message']);
      if (file && message) keys.add(key(file, str(a['Check']), message));
    }
  }
  return keys;
};

/** Extractors keyed by adapter name (not slot); everything else sits out. */
const EXTRACTORS: Readonly<Record<string, Extractor>> = {
  oxlint: extractOxlint,
  'ast-grep': extractAstGrep,
  cspell: extractCspell,
  vale: extractVale,
  // One `fallow` adapter fills all three fallow slots (dead/dupes/health); its
  // extractor dispatches on the report's `kind`, so a single registration serves
  // every slot. See `./fallow.ts`.
  fallow: fallowFindings,
};

/**
 * Derives one slot's pass/fail (and its baseline bookkeeping) from the tool's
 * raw report instead of its exit code. `baselineKeys === null` means no
 * baseline is active — the same contract as {@link fallowVerdict}.
 */
type ReportVerdict = (raw: string, baselineKeys: readonly string[] | null) => FallowVerdict;

/**
 * Report verdicts keyed by adapter name (not slot), like `EXTRACTORS`: only
 * fallow today, whose exit code does not reliably gate (combined mode and
 * `dupes` exit 0 even with findings — see `./fallow.ts`). One registration
 * serves dead/dupes/health; the verdict dispatches on the report's `kind`. A
 * custom check that names itself `fallow` is gated this way too, exactly as it
 * is fingerprinted this way. The exit code is still recorded in the summary.
 */
const REPORT_VERDICTS: Readonly<Record<string, ReportVerdict>> = {
  fallow: fallowVerdict,
};

/** The report verdict registered for `adapter`, or `null` when its exit code is the verdict. */
export function reportVerdict(adapter: string): ReportVerdict | null {
  return REPORT_VERDICTS[adapter] ?? null;
}

/**
 * Fingerprint one adapter's raw output, or `null` when the adapter has no
 * extractor (baseline unsupported for that slot). Keyed on adapter name, so an
 * alternate tool that shares a slot with a supported default (biome/eslint for
 * `lint`, knip for `dead`) opts out until it grows its own extractor. A
 * supported adapter with zero findings returns an empty set, never `null` —
 * "supported but clean" and "not observed" are distinct, and masking and the
 * ratchet depend on the difference.
 *
 * `null` therefore has two readings, and callers treat them the same way: no
 * extractor for this adapter (decided by name, before any output), or an
 * extractor that read its output and could not trust it — vale's runtime-error
 * report being the one case a format can say that about (see
 * {@link extractVale}). Either way the run contributes nothing to the baseline
 * and prunes nothing from it.
 *
 * `argv` is the check's command and then its args, as declared for the run
 * (`changedArgs` included under `--changed`). Only findings that can fail the
 * check under it are keyed; without it, oxlint and ast-grep key every finding.
 */
export function fingerprint(adapter: string, raw: string, argv?: readonly string[]): Fingerprint | null {
  const extractor = EXTRACTORS[adapter];
  return extractor ? extractor(raw, argv) : null;
}

/**
 * Whether an adapter can be fingerprinted (has an extractor), decided by name
 * without needing its output. `init --baseline` uses this to tell which failing
 * slots the baseline can grandfather from those that must still fall back to a
 * `false` disable. It answers for the adapter, not for a particular run: a
 * fingerprintable adapter can still yield `null` on output it can't trust, in
 * which case that run simply grandfathers nothing.
 */
export function isFingerprintable(adapter: string): boolean {
  return EXTRACTORS[adapter] !== undefined;
}

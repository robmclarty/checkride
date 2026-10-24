/**
 * Biome `check --reporter=json`: `{ summary: { errors, warnings, infos,
 * diagnosticsNotPrinted, … }, diagnostics: [{ severity, message, category,
 * location: { path, start: { line, column } } }], command }`, its line and
 * column 1-based, and both 0 for a diagnostic about a whole file, such as a
 * formatting one. The reporter prints every diagnostic, past
 * `--max-diagnostics` too. Biome calls the format unstable, so the parser
 * checks what it read against the summary's counts before it trusts it.
 * Checked against biome 2.5.6.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { asArray, located, oneBased, parseJson, runsTool, str } from '../read.js';
import type { Argv, KeyedFinding, ParseContext, Parser } from '../types.js';

/** The severities biome counts as errors, which fail a run whatever its flags. */
const BIOME_ERRORS: ReadonlySet<string> = new Set(['error', 'fatal']);

/**
 * Whether a warning can fail the run. `--error-on-warnings` makes biome exit
 * 1 on one while it still reports `severity: "warning"`, so only the argv
 * shows it, and an argv that hides biome's flags, or none at all, counts as
 * gating every warning. An info or a hint never fails a run.
 */
function biomeWarningsGate(argv: Argv): boolean {
  if (argv === undefined || !runsTool(argv, ['biome'])) return true;
  return argv.includes('--error-on-warnings');
}

/** One diagnostic as a finding, or `null` when it isn't one the format can print. */
function diagnosticFinding(d: unknown, context: ParseContext, warningsGate: boolean): KeyedFinding | null {
  if (!isRecord(d) || typeof d['message'] !== 'string' || d['message'].trim() === '' || typeof d['severity'] !== 'string') return null;
  const location = isRecord(d['location']) ? d['location'] : {};
  const start = isRecord(location['start']) ? location['start'] : {};
  const file = rebasePath(context, str(location['path']));
  const rule = str(d['category']);
  const severity = d['severity'];
  return {
    file,
    ...located(oneBased(start['line'], 1), oneBased(start['column'], 1)),
    rule,
    message: d['message'],
    severity,
    gates: BIOME_ERRORS.has(severity) || (severity === 'warning' && warningsGate),
    key: findingKey(file, rule, d['message']),
  };
}

/**
 * Whether the findings are every diagnostic the summary counts: none left
 * unprinted, and as many errors and warnings as it says. A summary that
 * leaves a count out isn't held to it.
 */
function matchesSummary(findings: readonly KeyedFinding[], summary: unknown): boolean {
  if (!isRecord(summary)) return true;
  const count = (wanted: (severity: string) => boolean): number => findings.filter((f) => wanted(f.severity ?? '')).length;
  const agrees = (field: string, n: number): boolean => typeof summary[field] !== 'number' || summary[field] === n;
  return agrees('diagnosticsNotPrinted', 0) && agrees('errors', count((s) => BIOME_ERRORS.has(s))) && agrees('warnings', count((s) => s === 'warning'));
}

/**
 * Every diagnostic biome printed, keyed on its category (`lint/suspicious/
 * noDoubleEquals`, `format`, `parse`): an error gates, a warning under
 * `--error-on-warnings`, and an info never does.
 *
 * Returns `null` unless the payload is a record holding a `diagnostics` array
 * whose every entry the parser can read, and whose counts are the summary's:
 * a config biome can't load prints its error on stderr and nothing here, and
 * reading that as clean would let the ratchet prune every grandfathered key,
 * while dropping a diagnostic the format moved could mask a red run green.
 */
export const biomeParser: Parser = {
  stream: 'artifact',
  parse: (raw, context) => {
    const payload = parseJson(raw);
    if (!isRecord(payload) || !Array.isArray(payload['diagnostics'])) return null;
    const warningsGate = biomeWarningsGate(context.argv);
    const findings: KeyedFinding[] = [];
    for (const d of asArray(payload['diagnostics'])) {
      const found = diagnosticFinding(d, context, warningsGate);
      if (found === null) return null;
      findings.push(found);
    }
    return matchesSummary(findings, payload['summary']) ? findings : null;
  },
};

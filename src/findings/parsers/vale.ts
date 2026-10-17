/**
 * vale `--output=JSON`: `{ "<path>": [{ Check, Message, Severity }] }`.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { parseJson, str } from '../read.js';
import type { KeyedFinding, Parser } from '../types.js';

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
 * Every alert that carries a message, and only error-severity ones gate.
 * Vale's exit code — the `prose` slot's whole verdict — is 1 iff an
 * error-severity alert exists, so a warning can never fail a check; keying one
 * would hand an advisory alert gating power in a baselined repo (a new warning
 * key blocks masking on an otherwise grandfathered red run) and churn the
 * ratchet with keys no verdict can use.
 *
 * Returns `null` — never the empty array — for anything that is not an alert
 * report. A runtime error (`E100` no config, `E201` bad config) is a flat object
 * that an alert-shaped reader would happily see as zero findings, and one such
 * run would prune every grandfathered prose key out of the baseline on the next
 * ratchet. `null` means "not observed", which leaves the baseline standing.
 */
export const valeParser: Parser = {
  stream: 'artifact',
  parse: (raw, { root }) => {
    const payload = parseJson(raw);
    if (!isValeAlertReport(payload)) return null;
    const findings: KeyedFinding[] = [];
    for (const [file, alerts] of Object.entries(payload)) {
      for (const a of alerts) {
        const message = str(a['Message']);
        if (!file || !message) continue;
        const severity = str(a['Severity']);
        const rule = str(a['Check']);
        const path = rebasePath(root, file);
        findings.push({
          file: path,
          rule,
          message,
          ...(severity ? { severity } : {}),
          gates: severity === 'error',
          key: findingKey(path, rule, message),
        });
      }
    }
    return findings;
  },
};

/**
 * rumdl `--output-format json`: an array of `{ file, line, column, rule,
 * message, severity }`, its line and column 1-based, its `file` relative to
 * the check's root, and `severity` one of `info`, `warning` or `error`.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { located, oneBased, parseJson, runsTool, str } from '../read.js';
import type { Argv, KeyedFinding, ParseContext, Parser } from '../types.js';

/** rumdl's severities, least severe first. */
const LEVELS = ['info', 'warning', 'error'] as const;

/** The rank of `severity` in {@link LEVELS}, or `-1` for one rumdl doesn't name. */
function rank(severity: string): number {
  return (LEVELS as readonly string[]).indexOf(severity);
}

/** The `--fail-on` value an argv names last, or `undefined` when it names none. */
function failOn(argv: readonly string[]): string | undefined {
  let named: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--fail-on') named = argv[i + 1];
    else if (arg.startsWith('--fail-on=')) named = arg.slice('--fail-on='.length);
  }
  return named;
}

/**
 * The least severe rank that fails the run, under `--fail-on`: `any`, the
 * default, fails on every finding (rank 0), `warning` and `error` on their
 * level and above, and `never` on none (`Infinity`). An argv that hides
 * rumdl's flags, or none at all, reads as the default: keying a finding that
 * can't fail costs a false red, while skipping one that can would mask a red
 * run green.
 */
function threshold(argv: Argv): number {
  if (argv === undefined || !runsTool(argv, ['rumdl'])) return 0;
  const named = failOn(argv);
  if (named === 'never') return Number.POSITIVE_INFINITY;
  return named === 'warning' || named === 'error' ? rank(named) : 0;
}

/**
 * Whether a finding at `severity` fails the run when findings from `floor`
 * up do. A severity rumdl doesn't name gates unless nothing can fail.
 */
function gatesAt(severity: string, floor: number): boolean {
  if (floor === Number.POSITIVE_INFINITY) return false;
  const level = rank(severity);
  return level < 0 || level >= floor;
}

/** The finding one warning carries, or `null` when it names no file or no message. */
function warningFinding(w: Record<string, unknown>, context: ParseContext, floor: number): KeyedFinding | null {
  const file = str(w['file']);
  const message = str(w['message']);
  if (!file || !message) return null;
  const rule = str(w['rule']);
  const severity = str(w['severity']);
  const path = rebasePath(context, file);
  return {
    file: path,
    ...located(oneBased(w['line'], 1), oneBased(w['column'], 1)),
    rule,
    message,
    ...(severity ? { severity } : {}),
    gates: gatesAt(severity, floor),
    key: findingKey(path, rule, message),
  };
}

/**
 * Every warning that names a file and a message, keyed on its rule. rumdl
 * 0.2.79 reports a rule at `warning` unless its config sets the rule's
 * `severity`, and fails the run on every finding unless `--fail-on` says
 * otherwise, so a finding gates when its severity is at or above that flag.
 *
 * Returns `null` for output that isn't an array: a run that finished prints
 * one, `[]` when clean, so anything else never read the files.
 */
export const rumdlParser: Parser = {
  stream: 'artifact',
  parse: (raw, context) => {
    const payload = parseJson(raw);
    if (!Array.isArray(payload)) return null;
    const floor = threshold(context.argv);
    const findings: KeyedFinding[] = [];
    for (const w of payload) {
      const finding = isRecord(w) ? warningFinding(w, context, floor) : null;
      if (finding !== null) findings.push(finding);
    }
    return findings;
  },
};

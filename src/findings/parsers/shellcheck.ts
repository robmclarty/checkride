/**
 * shellcheck `-f json1`: `{ comments: [{ file, line, column, level, code,
 * message }] }`, its line and column 1-based and its `file` as the command
 * line named it, relative to the check's root.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { asArray, located, oneBased, parseJson, runsTool, str } from '../read.js';
import type { Argv, KeyedFinding, ParseContext, Parser } from '../types.js';

/** shellcheck's levels, least severe first. */
const LEVELS = ['style', 'info', 'warning', 'error'] as const;

/** The rank of `level` in {@link LEVELS}, or `-1` for one shellcheck doesn't name. */
function rank(level: string): number {
  return (LEVELS as readonly string[]).indexOf(level);
}

/** The value a `-S` or `--severity` argument at `i` names, or `undefined` when `argv[i]` isn't one. */
function severityAt(argv: readonly string[], i: number): string | undefined {
  const arg = argv[i] ?? '';
  if (arg === '-S' || arg === '--severity') return argv[i + 1];
  if (arg.startsWith('--severity=')) return arg.slice('--severity='.length);
  if (arg.startsWith('-S')) return arg.slice(2);
  return undefined;
}

/**
 * The least severe level that fails the run: the last `--severity` or `-S`
 * the argv names, else `style`, shellcheck's default, under which every
 * comment fails it. An argv that hides shellcheck's flags, or none at all,
 * reads as the default: keying a comment that can't fail costs a false red,
 * while skipping one that can would mask a red run green.
 */
function threshold(argv: Argv): number {
  if (argv === undefined || !runsTool(argv, ['shellcheck'])) return 0;
  let floor = 0;
  for (let i = 0; i < argv.length; i++) {
    const named = severityAt(argv, i);
    if (named !== undefined && rank(named) >= 0) floor = rank(named);
  }
  return floor;
}

/**
 * The finding one comment carries, or `null` when it names no file or no
 * message. It gates when its level is at or above `floor`, the rank of the
 * argv's `--severity`, and a level shellcheck doesn't name gates too.
 */
function commentFinding(c: Record<string, unknown>, context: ParseContext, floor: number): KeyedFinding | null {
  const file = str(c['file']);
  const message = str(c['message']);
  if (!file || !message) return null;
  const level = str(c['level']);
  const rule = typeof c['code'] === 'number' ? `SC${c['code']}` : '';
  const path = rebasePath(context, file);
  return {
    file: path,
    ...located(oneBased(c['line'], 1), oneBased(c['column'], 1)),
    rule,
    message,
    ...(level ? { severity: level } : {}),
    gates: rank(level) < 0 || rank(level) >= floor,
    key: findingKey(path, rule, message),
  };
}

/**
 * Every comment that names a file and a message, keyed on its `SC` code.
 *
 * Returns `null` for output that holds no `comments` array: a run that
 * finished prints one, empty when clean, so anything else never read the
 * scripts.
 */
export const shellcheckParser: Parser = {
  stream: 'artifact',
  parse: (raw, context) => {
    const payload = parseJson(raw);
    if (!isRecord(payload) || !Array.isArray(payload['comments'])) return null;
    const floor = threshold(context.argv);
    const findings: KeyedFinding[] = [];
    for (const c of asArray(payload['comments'])) {
      const finding = isRecord(c) ? commentFinding(c, context, floor) : null;
      if (finding !== null) findings.push(finding);
    }
    return findings;
  },
};

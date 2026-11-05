/**
 * `odin check -json-errors`, on stderr: one object, `{ error_count, errors:
 * [{ type, pos, msgs }] }`, each error's `pos` its file as the compiler
 * resolved it (absolute), its 1-based line and column, or `null` for one
 * about the build as a whole (an unused `-define`), and its `msgs` the
 * message's lines, a suggestion indented under the first. The compiler names
 * no rule, and its `type` says nothing a reader can use: a syntax error is a
 * `warning` that exits 1. A clean run prints nothing at all. One parser
 * serves every row that runs `odin check`: `odin-check`, `odin-vet` and
 * `odin-unused`.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { asArray, located, oneBased, parseJson, str } from '../read.js';
import type { KeyedFinding, ParseContext, Parser } from '../types.js';

/** A line mise prints on stderr ahead of the tool's own (an update notice, say), which a launch through `mise exec` can leave there. */
const MISE_LINE = /^mise (?:WARN|INFO)\b/;

/** `raw` without mise's own lines. */
function toolText(raw: string): string {
  return raw.split('\n').filter((line) => !MISE_LINE.test(line)).join('\n');
}

/** A warning's first line, which the compiler prefixes; it fails the check only under `-warnings-as-errors`. */
const WARNING = /^Warning:/;

/** A syntax error's first line: the compiler stops at one before it checks anything. */
const SYNTAX_ERROR = /^Syntax Error:/;

/** The flag under which a warning exits 1. */
const WARNINGS_AS_ERRORS = '-warnings-as-errors';

/** The finding one `errors` entry carries, or `null` for one with no message. */
function entryFinding(entry: Record<string, unknown>, context: ParseContext): KeyedFinding | null {
  const msgs = asArray(entry['msgs']).map(str).map((m) => m.trimEnd());
  const [first = ''] = msgs;
  if (first === '') return null;
  const pos = isRecord(entry['pos']) ? entry['pos'] : {};
  const file = rebasePath(context, str(pos['file']));
  const warning = WARNING.test(first);
  return {
    file,
    ...located(oneBased(pos['line'], 1), oneBased(pos['column'], 1)),
    rule: '',
    message: msgs.join('\n'),
    severity: warning ? 'warning' : 'error',
    gates: !warning || (context.argv?.includes(WARNINGS_AS_ERRORS) ?? false),
    key: findingKey(file, '', first),
  };
}

/** `finding` as the compiler prints it: `<file>(<line>:<column>) <first line>`. */
function printedAt(finding: KeyedFinding): string {
  const where = finding.line === undefined ? finding.file : `${finding.file}(${finding.line}:${finding.column ?? 1})`;
  const [first = ''] = finding.message.split('\n');
  return `${where} ${first}`.trim();
}

/** `text` as a Markdown code span, a double-backtick one where it holds a backtick. */
function codeSpan(text: string): string {
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

/**
 * Every error, keyed on its file and its message's first line, since the
 * compiler names no rule, its message every line it printed. An error gates;
 * a warning (`Warning:` first) only under `-warnings-as-errors`, which the
 * vet row runs with. Empty stderr is a clean run, and stderr with text that
 * isn't the compiler's object, such as a crash or a launcher's refusal, is
 * untrustworthy. A run that hit a syntax error stopped short: the checker
 * never ran, so an error it would have found reads as fixed, and the
 * baseline neither masks nor prunes with that run.
 */
export const odinCheckParser: Parser = {
  stream: 'stderr',
  parse: (raw, context) => {
    const text = toolText(raw);
    if (text.trim() === '') return [];
    const payload = parseJson(text);
    if (!isRecord(payload) || !Array.isArray(payload['errors'])) return null;
    return asArray(payload['errors'])
      .filter(isRecord)
      .map((entry) => entryFinding(entry, context))
      .filter((finding) => finding !== null);
  },
  stoppedShort: (findings) => {
    const syntax = findings.find((f) => SYNTAX_ERROR.test(f.message));
    return syntax === undefined ? null : `odin stopped short at ${codeSpan(printedAt(syntax))}`;
  },
};

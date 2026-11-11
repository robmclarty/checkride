/**
 * `checkride protect` — the edit guard's verdict, for a harness whose config
 * has no deny list and a repo that has no Node to run a script with.
 *
 * Cursor's `protect` hook is a generated Node script wherever the repo runs
 * checkride through a package manager (`protectScript` in
 * `./agent-setup/scripts.ts`). A repo that runs the standalone binary may
 * have no Node, so there the hook calls this command, which reads the same
 * payload on stdin and answers the same way: a `permission: 'deny'` body for
 * a write to the baseline, a named suite's baseline or `.check/`, nothing at
 * all for anything else, and exit 0 either way.
 *
 * **The decision has two implementations, and a table binds them.** The
 * script is self-contained text that has to run on a bare `node`; this is
 * the same decision as typed functions, called directly. Neither is made
 * from the other, and nothing here evaluates the script. What holds them
 * together is the case table in `src/__tests__/protect.test.ts`, which puts
 * every payload to both and requires the same exit code and the same bytes
 * on stdout. A change to the decision here is a change to the script, and a
 * new case in that table. The lists of path keys and verbs are the script's
 * own, imported, so those can't differ at all.
 *
 * Two kinds of failure are kept apart. A payload this can't read, one that is
 * empty, not JSON or of no shape it knows, is allowed in silence, as the
 * script allows it: a guard that can't read its input must not become a repo
 * where nothing can be edited. A fault of this command's own is not an
 * allow: it is a line on stderr and exit 1, as a script that crashed would
 * give, so a guard that has stopped working never reads as one that passed
 * the edit.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { PROTECT_ALL_ARGS_VERBS, PROTECT_DEST_ONLY_VERBS, PROTECT_PATH_KEYS } from './agent-setup/index.js';
import type { HarnessName } from './gate.js';
import { isRecord } from './json.js';
import { SUITE_NAME_SOURCE } from './suite.js';

/** The harnesses whose edit guard is a hook and not configuration: Claude Code's is `permissions.deny`. */
export const PROTECT_HARNESSES: readonly HarnessName[] = ['cursor'];

/** A named suite's baseline, at the repo root: `checkride.<name>.baseline.json`. */
const SUITE_BASELINE = new RegExp(`^checkride\\.${SUITE_NAME_SOURCE}\\.baseline\\.json$`);

/** A leading `VAR=value`, which a shell reads as an assignment and not as the verb. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A token made of operator characters alone. */
const OPERATOR = /^[<>|&;]+$/;

/** An operator that starts a new command. */
const SEPARATOR = /^[|&;]+$/;

/** `sed` and `perl` edit in place under a flag cluster holding `i`. */
const IN_PLACE = /^-[a-zA-Z]*i/;

/**
 * `path` with its symlinks resolved, so a symlinked prefix can't make an
 * in-repo path look external. The path need not exist, since the hook runs
 * before the write: the first ancestor that does is resolved, and the rest
 * re-appended.
 */
function canon(path: string): string {
  let dir = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(dir), ...rest);
    } catch {
      const up = dirname(dir);
      if (up === dir) return resolve(path);
      rest.unshift(basename(dir));
      dir = up;
    }
  }
}

/** A command line being split: the tokens so far, the one under way, and the quote it is inside. */
type Lexer = { tokens: string[]; current: string; quote: string | null };

/** End the token under way, if there is one. */
function flush(lexer: Lexer): void {
  if (lexer.current !== '') lexer.tokens.push(lexer.current);
  lexer.current = '';
}

/** Read the run of one operator character that starts at `at` as a token of its own; returns where the next character is. */
function lexOperator(command: string, at: number, lexer: Lexer): number {
  flush(lexer);
  const char = command.charAt(at);
  let end = at + 1;
  while (command[end] === char) end += 1;
  lexer.tokens.push(command.slice(at, end));
  return end;
}

/** Read `char` inside a quote: the quote's own character closes it, and anything else is kept as it is. */
function lexQuoted(char: string, lexer: Lexer): void {
  if (char === lexer.quote) lexer.quote = null;
  else lexer.current += char;
}

/** Read `char` outside a quote, where it is neither a backslash nor an operator: a quote opens, a space ends the token, anything else joins it. */
function lexPlain(char: string, lexer: Lexer): void {
  if (/["']/.test(char)) lexer.quote = char;
  else if (/\s/.test(char)) flush(lexer);
  else lexer.current += char;
}

/** Read the character at `at`; returns where the next one to read is. */
function lexChar(command: string, at: number, lexer: Lexer): number {
  const char = command.charAt(at);
  if (lexer.quote !== null) {
    lexQuoted(char, lexer);
    return at + 1;
  }
  if (char === '\\') {
    lexer.current += command.charAt(at + 1);
    return at + 2;
  }
  if (/[<>|&;]/.test(char)) return lexOperator(command, at, lexer);
  lexPlain(char, lexer);
  return at + 1;
}

/**
 * A command line as tokens, quoted spans kept whole and each unquoted
 * operator a token of its own, so `echo x>f` and `echo x > f` split alike.
 */
function tokenize(command: string): string[] {
  const lexer: Lexer = { tokens: [], current: '', quote: null };
  let at = 0;
  while (at < command.length) at = lexChar(command, at, lexer);
  flush(lexer);
  return lexer.tokens;
}

/** A token stream cut at the operators that start a new command, so the verb of `cat x | tee .check/f` reads as `tee`. */
function segments(tokens: readonly string[]): string[][] {
  const out: string[][] = [[]];
  for (const token of tokens) {
    if (SEPARATOR.test(token)) out.push([]);
    else out.at(-1)?.push(token);
  }
  return out;
}

/** What one command's `>` and `>>` write to. */
function redirectTargets(segment: readonly string[]): string[] {
  return segment.flatMap((token, at) => {
    const next = segment[at + 1];
    return (token === '>' || token === '>>') && next !== undefined && !OPERATOR.test(next) ? [next] : [];
  });
}

/** What the verb `verb` writes to, given the words `rest` after it, for the verbs known to write: every argument, the last, or what a flag names. */
function writesOf(verb: string, rest: readonly string[]): string[] {
  const args = rest.filter((arg) => !arg.startsWith('-'));
  if (PROTECT_ALL_ARGS_VERBS.includes(verb)) return args;
  if (PROTECT_DEST_ONLY_VERBS.includes(verb)) return args.slice(-1);
  if (['sed', 'perl'].includes(verb)) return rest.some((arg) => IN_PLACE.test(arg)) ? args : [];
  if (verb === 'dd') return rest.filter((arg) => arg.startsWith('of=')).map((arg) => arg.slice(3));
  return [];
}

/** What one command's verb writes to. */
function verbTargets(segment: readonly string[]): string[] {
  const words = segment.filter((token) => !OPERATOR.test(token));
  // Step over any leading `VAR=value` assignments to reach the verb itself.
  const at = words.findIndex((word) => !ASSIGNMENT.test(word));
  const verb = at === -1 ? '' : (words[at]?.split('/').pop() ?? '');
  return writesOf(verb, words.slice(at + 1));
}

/** Every path a command line demonstrably writes to. What it can't read as a write yields nothing, and is allowed. */
function commandTargets(command: string): string[] {
  return segments(tokenize(command)).flatMap((segment) => [...redirectTargets(segment), ...verbTargets(segment)]);
}

/** `target`'s path from `root` when it is checkride's accounting, else `undefined`. A relative one is read from `base`. */
function accounting(target: string, root: string, base: string): string | undefined {
  const absolute = canon(isAbsolute(target) ? target : resolve(base, target));
  const below = relative(root, absolute).split(sep).join('/');
  if (below === 'checkride.baseline.json' || SUITE_BASELINE.test(below)) return below;
  if (below === '.check' || below.startsWith('.check/')) return below;
  return undefined;
}

/**
 * The payload as an object whose fields can be asked for, or `null` for
 * anything else: not JSON, `null`, a bare value, an array. The script reads
 * on past an array, and finds in it none of the fields the decision asks for,
 * so it allows one too.
 */
function parsed(payload: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(payload);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The paths a payload writes to: a shell event's command, read for writes, or a file tool's target under any key it may use. */
function payloadTargets(input: Record<string, unknown>): string[] {
  if (input['hook_event_name'] === 'beforeShellExecution') {
    return commandTargets(typeof input['command'] === 'string' ? input['command'] : '');
  }
  const tool = input['tool_input'];
  const fields = isRecord(tool) ? tool : {};
  return PROTECT_PATH_KEYS.map((key) => fields[key]).filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/**
 * The decision: the accounting path the hook payload `payload` writes to,
 * from the project root, or `null` for a call to allow. The project is the
 * one `CURSOR_PROJECT_DIR` names in `env`, then `CLAUDE_PROJECT_DIR`, then
 * `cwd`. A shell command's relative path is read from the `cwd` the payload
 * carries; a file tool's, from the project root.
 *
 * This is `protectScript`'s decision, written a second time: see the note at
 * the top of this file, and the table that holds the two to each other.
 */
export function protectDecision(payload: string, env: Record<string, string | undefined>, cwd: string): string | null {
  const input = parsed(payload);
  if (input === null) return null;
  // The first variable that names one: an empty one names none, as an unset one doesn't.
  const root = canon([env['CURSOR_PROJECT_DIR'], env['CLAUDE_PROJECT_DIR']].find((named) => named !== undefined && named !== '') ?? cwd);
  const from = input['cwd'];
  const base = typeof from === 'string' && from.length > 0 ? canon(from) : root;
  return payloadTargets(input).map((target) => accounting(target, root, base)).find((below) => below !== undefined) ?? null;
}

/** What Cursor reads as "deny this call": one JSON object on stdout, the message once for the user and once for the agent. */
export function denialBody(below: string): string {
  const message =
    `checkride: ${below} is checkride-owned accounting. Never edit the baseline or .check ` +
    'artifacts to make a check pass — fix the finding instead (the ratchet prunes the baseline on its own).';
  return JSON.stringify({ permission: 'deny', user_message: message, agent_message: message });
}

/** All of stdin as text; nothing when it is a terminal, where no hook is on the other end and a read would wait on a person. */
export async function readStdin(stdin: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stdin.isTTY) return '';
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  }
}

/** The harness `--harness` names, `cursor` when it names none; any other is a usage error naming the one accepted. */
function protectHarness(value: string | undefined): HarnessName {
  const harness = PROTECT_HARNESSES.find((name) => name === (value ?? 'cursor'));
  if (harness === undefined) throw new Error(`invalid --harness '${value}' (protect answers ${PROTECT_HARNESSES.join(' | ')})`);
  return harness;
}

export type ProtectOptions = {
  cwd: string;
  harness?: string;
  env?: Record<string, string | undefined>;
  stdout: { write: (text: string) => unknown };
  stderr: { write: (text: string) => unknown };
  /** Reads the hook payload; the process's stdin when omitted. */
  stdin?: () => Promise<string>;
  /** The decision to run; {@link protectDecision} when omitted. */
  decide?: typeof protectDecision;
};

/** What a fault of the command's own exits with, as a Node script that threw does. */
const FAULT_EXIT = 1;

/**
 * Run `checkride protect`: read the payload, write the denial's body if the
 * call is denied, and return the exit code. 0 for a call allowed and for one
 * denied. A fault that isn't about the payload is one line on stderr and exit
 * 1: never an allow, which a hook runner couldn't tell from a guard that ran.
 */
export async function runProtect(opts: ProtectOptions): Promise<{ exitCode: number }> {
  protectHarness(opts.harness);
  const payload = await (opts.stdin ?? readStdin)();
  try {
    const below = (opts.decide ?? protectDecision)(payload, opts.env ?? process.env, opts.cwd);
    if (below !== null) opts.stdout.write(denialBody(below));
    return { exitCode: 0 };
  } catch (error) {
    opts.stderr.write(`checkride protect: the edit guard failed, so this call was not checked: ${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: FAULT_EXIT };
  }
}

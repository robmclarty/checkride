/**
 * The hook scripts checkride generates into a consumer repo.
 *
 * checkride owns these files and overwrites them on every `agent-setup`/`init`,
 * so consumer customization belongs beside them, never in them. That is also why
 * the settings entry each harness gets is a stable one-liner invoking a script
 * rather than the behavior inline: a refresh rewrites the script freely without
 * ever clobbering an entry a human may have edited.
 *
 * **Every script here is one a harness's configuration could not express.** A
 * generated file in someone's repo is a standing cost — reviewed, kept in sync,
 * wondered about — so it is written only where config falls short. Claude Code
 * takes just the gate: its `protect` is a `permissions.deny` rule and its
 * `dirty` an inline command. Cursor, whose config is hooks and nothing else,
 * still takes all three. The gate is the one both need, because it alone has a
 * branch neither config can carry (see {@link gateTail}).
 */

import { DIRTY_MARKER, type HarnessName } from '../gate.js';
import { execCommand, type PackageManager } from '../pm/index.js';

/**
 * The repo root, however the calling harness spells it. Cursor sets
 * `CURSOR_PROJECT_DIR` (and `CLAUDE_PROJECT_DIR` as an alias); Claude Code sets
 * only the latter. The final `.` fallback keeps the script working under an
 * older harness that sets neither, where the cwd is already the project.
 */
const PROJECT_DIR = '"${CURSOR_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-.}}"';

/**
 * `<pm> exec checkride <args…>`, spelled for `pm`'s launcher. Quieted: the gate
 * parses this command's stdout, so pnpm's narration must not lead it.
 */
function checkrideCommand(pm: PackageManager, args: readonly string[]): string {
  return execCommand(pm, ['checkride', ...args], { quiet: true });
}

/**
 * What a harness is told when `checkride gate` itself could not run.
 *
 * Emitted through `printf '%s\n' '…'` — single-quoted, never double — because
 * the text carries backticks and `sh` runs a backtick span inside double quotes
 * as a command. The first draft of this message used `echo "…"` and the shell
 * silently ate the two quoted command names, substituting their output. Keep it
 * free of single quotes for the same reason.
 */
const UNRUNNABLE =
  'checkride: the gate could not run — `checkride gate` is not resolvable in this repo. ' +
  'Install checkride (or re-run `checkride agent-setup`) before finishing.';

/**
 * The one line that hands `harness` the {@link UNRUNNABLE} verdict, and the exit
 * status that goes with it.
 *
 * The statuses differ because the harnesses do: Claude Code blocks on 2, while
 * Cursor reads any non-zero stop hook as a *broken* hook and ends the turn —
 * there, blocking has to ride in the body with an exit of 0. Kept as a pair so
 * no branch can pick one without the other.
 */
function unrunnable(harness: HarnessName): { emit: string; exit: number } {
  return harness === 'cursor'
    ? { emit: `printf '%s\\n' '${JSON.stringify({ followup_message: UNRUNNABLE })}'`, exit: 0 }
    : { emit: `printf '%s\\n' '${UNRUNNABLE}' >&2`, exit: 2 };
}

/**
 * Translate the gate's exit status into `harness`'s protocol.
 *
 * The interesting branch is the last one. `checkride gate` exits 0 or 2 by
 * design; anything else means it never ran — an uninstalled checkride, a broken
 * launcher — and that must **block**, not pass. Claude Code reads a plain exit 1
 * as "hook failed, carry on", which would leave a repo whose gate had silently
 * stopped gating: precisely the vacuous green checkride exists to prevent. So
 * the gate alone fails closed. (`protect` fails open, deliberately: the cost of
 * a broken protect hook is a repo where nothing can be written at all.)
 */
function gateTail(harness: HarnessName): string[] {
  const { emit, exit } = unrunnable(harness);
  if (harness === 'cursor') {
    return [
      '# On success checkride has already written its JSON to stdout, which is what',
      '# Cursor reads. Only the never-ran case is left to answer for.',
      '[ "$status" -eq 0 ] && exit 0',
      emit,
      `exit ${exit}`,
    ];
  }
  return [
    '# Claude Code parses a hook body only on exit 0, and only a body can carry a',
    '# user-visible message alongside the block. So when checkride produced one,',
    '# forward it and exit 0: the verdict rides in `decision`, not in the status.',
    'if [ -n "$body" ]; then',
    "  printf '%s\\n' \"$body\"",
    '  case "$status" in',
    '    0|2) exit 0 ;;',
    '  esac',
    'fi',
    '',
    '# No body — an older checkride that reports only through the exit code.',
    '[ "$status" -eq 0 ] && exit 0',
    '[ "$status" -eq 2 ] && exit 2',
    '',
    "# Neither of checkride's two gate codes: it never ran. Block anyway.",
    emit,
    `exit ${exit}`,
  ];
}

/**
 * Enter the repo, or report the same "could not run" verdict as any other way
 * the gate can fail to start.
 *
 * Spelled as a block rather than `cd … || exit 2` for two reasons: a bare status
 * tells the agent nothing, and under Cursor a non-zero stop hook is a *broken*
 * hook, so the one branch that used to exit 2 there was the one branch that
 * silently let a turn end.
 */
function enterRepo(harness: HarnessName): string[] {
  const { emit, exit } = unrunnable(harness);
  return [`if ! cd ${PROJECT_DIR}; then`, `  ${emit}`, `  exit ${exit}`, 'fi'];
}

/**
 * How the gate's stdout is taken.
 *
 * Cursor's script lets it stream straight through: Cursor reads the hook's own
 * stdout, and there is nothing for the script to decide. Claude Code's captures
 * it, because the script has to *choose an exit code based on whether a body
 * came back* — see {@link gateTail}. Capturing costs nothing that is visible:
 * the pipeline's human-readable progress is on stderr and streams live either
 * way; stdout carries only the one-line JSON verdict, written at the very end.
 */
function invokeGate(pm: PackageManager, harness: HarnessName, args: readonly string[]): string[] {
  const command = checkrideCommand(pm, args);
  return harness === 'cursor'
    ? [command, 'status=$?']
    : [`body=$(${command})`, 'status=$?'];
}

/**
 * The gate script: `cd` to the repo, hand off to `checkride gate`, and translate
 * the result into the harness's protocol.
 *
 * `dirtyGuard` (on when the `dirty` hook is written alongside — the default)
 * makes the gate conditional on the edit marker, so pure-conversation turns
 * don't pay for a full pipeline run. Without the marker hook the guard would
 * disarm the gate entirely, so a `--hook gate` selection writes it unguarded.
 */
export function gateScript(
  pm: PackageManager,
  opts: { harness: HarnessName; dirtyGuard?: boolean },
): string {
  const args = ['gate', '--harness', opts.harness, ...((opts.dirtyGuard ?? true) ? ['--if-dirty'] : [])];
  return [
    '#!/bin/sh',
    `# checkride-gate.sh — the ${opts.harness} stop-hook gate.`,
    '#',
    '# checkride owns this file: `checkride agent-setup` (and `checkride init`)',
    '# overwrite it on every run. Customize via a sibling script or the',
    '# environment, not by editing here — edits are lost on the next refresh.',
    '#',
    "# Runs the repo's `check` script as a hard gate, and reports the verdict in",
    `# ${opts.harness}'s hook protocol. See \`checkride gate --help\`.`,
    '',
    ...enterRepo(opts.harness),
    '',
    ...invokeGate(pm, opts.harness, args),
    ...gateTail(opts.harness),
    '',
  ].join('\n');
}

/**
 * The dirty script: mark that this turn edited a file. A stop hook fires on
 * every turn, including pure-conversation ones; the marker is what lets the gate
 * skip those instead of taxing every reply with a full pipeline run.
 *
 * It exits 0 unconditionally. A failure to record an edit must never block the
 * edit itself — the cost of a missed marker is one skipped gate, and the cost of
 * a hard failure here is a repo where no file can be written.
 */
export function dirtyScript(): string {
  return [
    '#!/bin/sh',
    '# checkride-dirty.sh — record that this turn edited a file.',
    '#',
    '# checkride owns this file: `checkride agent-setup` (and `checkride init`)',
    '# overwrite it on every run.',
    '#',
    '# The gate reads this marker under `--if-dirty` and clears it on green.',
    '',
    `cd ${PROJECT_DIR} || exit 0`,
    `mkdir -p "$(dirname ${DIRTY_MARKER})" && touch ${DIRTY_MARKER}`,
    'exit 0',
    '',
  ].join('\n');
}

/**
 * Keys Cursor may use for the target path in a tool call's `tool_input`.
 *
 * Cursor documents the shape for `Shell` but not for `Write`/`Delete`, so the
 * list is deliberately broad and order-independent: the script takes the first
 * string it finds. It keeps Claude Code's documented `file_path` and
 * `notebook_path` too, since a harness that borrowed the schema would send
 * those. An unrecognized shape yields no target and the script fails open, which
 * is the correct failure — a protect hook that cannot read its input must not
 * become a repo where nothing can be written.
 *
 * **The Cursor half of this list is a guess, and a wrong guess is silent**: an
 * unmatched shape allows the write with no output, so `protect` would simply
 * stop protecting and nothing would say so. The tests here can only assert the
 * keys checkride *chose*, never the ones Cursor sends, so this is settled by one
 * live `preToolUse` payload and not by anything in this repo. Until it is,
 * `protect` is best-effort under Cursor — see docs/cursor.md. (Neither harness
 * matches its shell tool, so a redirect writes the baseline under both; that gap
 * is older and accepted.)
 */
const PATH_KEYS = ['file_path', 'notebook_path', 'path', 'target_file', 'filePath', 'relative_workspace_path'];

/**
 * Shell verbs that can destroy *any* path they are handed, so every positional
 * argument is a write target. `mv` belongs here rather than with the
 * destination-only verbs because moving an accounting file away removes it just
 * as effectively as overwriting it.
 */
const ALL_ARGS_VERBS = ['rm', 'unlink', 'shred', 'mv', 'truncate', 'tee', 'rmdir'];

/**
 * Shell verbs whose sources are *read* and whose last positional argument is the
 * only thing written. `cp .check/summary.json /tmp/x` has to stay allowed — it
 * is a backup, not an edit — and treating its source as a target would deny it.
 */
const DEST_ONLY_VERBS = ['cp', 'install', 'ln', 'rsync'];

/** The deny message, shared by both harnesses. */
const DENY_MESSAGE =
  "'checkride: ' + rel + ' is checkride-owned accounting. Never edit the baseline or .check ' +\n" +
  "    'artifacts to make a check pass — fix the finding instead (the ratchet prunes the baseline on its own).'";

/**
 * How Cursor spells "deny this tool call": a JSON body on stdout with exit 0. It
 * reads a non-zero hook as a *broken* hook and proceeds, so the denial has to
 * travel in the body, where `agent_message` is what the model sees.
 */
function denyTail(): string[] {
  return [
    '  const message = ' + DENY_MESSAGE + ';',
    '  process.stdout.write(JSON.stringify({',
    "    permission: 'deny',",
    '    user_message: message,',
    '    agent_message: message,',
    '  }));',
    '  process.exit(0);',
  ];
}

/**
 * The `protect` deny script: "never add to the baseline to make a check pass" as
 * enforcement, not README advice. A Node script (not sh) because the hook
 * protocol is JSON on stdin, and every checkride repo has node by construction;
 * `.cjs` so it runs regardless of the repo's module type. Only edit tools are
 * matched — reads are never denied, because triage depends on reading `.check/`
 * artifacts.
 *
 * Two Cursor events land here. `preToolUse` carries a file-tool call, whose
 * target is read from {@link PATH_KEYS}. `beforeShellExecution` carries a
 * command line, which is scanned for a write *to* an accounting path — the gap
 * a tool-name matcher cannot close, since `echo … > checkride.baseline.json` is
 * a shell call and not a `Write`.
 *
 * The command scan is deliberately timid, because a guard that fires on a wrong
 * parse is worse than a known hole. It denies only on demonstrated write intent
 * — a `>`/`>>` redirect target, or a positional argument of a known mutating
 * verb — and anything it cannot read that way is allowed. `cat`, `grep`, `jq`
 * and `cp … /tmp/x` over `.check/` all pass, which they must: triage reads those
 * artifacts. The hook's own `matcher` narrows the input further, so a command
 * that never names an accounting path is not parsed at all.
 *
 * **Cursor only.** Claude Code enforces the same paths through
 * `permissions.deny`, which is checked below the hook layer and costs nothing
 * per tool call, so it needs no script. Cursor has no documented equivalent —
 * its config is hooks — so the script survives for the harness that still
 * requires one. If Cursor grows a file-path deny list, this file goes away.
 * (Claude Code's deny rules have the same shell-redirect hole and no script to
 * close it with; that half of the gap is still open. See docs/cursor.md.)
 */
export function protectScript(): string {
  return [
    '#!/usr/bin/env node',
    "// checkride-protect.cjs — deny agent edits to checkride's accounting files.",
    '// checkride owns this file: `checkride agent-setup` (and `checkride init`)',
    '// overwrite it on every run.',
    '//',
    '// Guard hook for Cursor. Reads the hook payload as JSON on stdin and denies',
    '// the call when it *writes* to the baseline or .check/. Reads are never',
    '// denied — triage depends on reading .check artifacts.',
    "'use strict';",
    "const { realpathSync } = require('node:fs');",
    "const { basename, dirname, isAbsolute, relative, resolve, sep } = require('node:path');",
    '',
    `const PATH_KEYS = ${JSON.stringify(PATH_KEYS)};`,
    `const ALL_ARGS_VERBS = ${JSON.stringify(ALL_ARGS_VERBS)};`,
    `const DEST_ONLY_VERBS = ${JSON.stringify(DEST_ONLY_VERBS)};`,
    '',
    '// Resolve symlinks in `p`, so a symlinked prefix cannot make an in-repo path',
    '// look external. On macOS the repo root routinely arrives in two spellings —',
    '// the harness passes /var/…, the environment reports /private/var/… — and a',
    '// raw string comparison across the two rejects every path in the repo.',
    '//',
    '// `p` need not exist: this hook runs *before* the write, and the target is',
    '// often a file (or a whole directory) that is about to be created. So walk up',
    '// to the first ancestor that does exist, resolve that, and re-append the rest.',
    'function canon(p) {',
    '  let dir = resolve(p);',
    '  const rest = [];',
    '  for (;;) {',
    '    try {',
    '      return resolve(realpathSync(dir), ...rest);',
    '    } catch {',
    '      const up = dirname(dir);',
    '      if (up === dir) return resolve(p);',
    '      rest.unshift(basename(dir));',
    '      dir = up;',
    '    }',
    '  }',
    '}',
    '',
    '// Split a command line into tokens, keeping quoted spans whole and emitting',
    '// each unquoted operator as a token of its own — so `echo x>f` and `echo x > f`',
    '// tokenize alike, and a `>` inside quotes is never mistaken for a redirect.',
    'function tokenize(command) {',
    '  const tokens = [];',
    "  let cur = '';",
    '  let quote = null;',
    "  const flush = () => { if (cur !== '') { tokens.push(cur); cur = ''; } };",
    '  for (let i = 0; i < command.length; i += 1) {',
    '    const c = command[i];',
    '    if (quote !== null) {',
    '      if (c === quote) quote = null;',
    '      else cur += c;',
    '    } else if (/["\']/.test(c)) {',
    '      quote = c;',
    "    } else if (c === '\\\\') {",
    "      i += 1; cur += command[i] || '';",
    '    } else if (/\\s/.test(c)) {',
    '      flush();',
    '    } else if (/[<>|&;]/.test(c)) {',
    '      flush();',
    '      let op = c;',
    '      while (command[i + 1] === c) { op += c; i += 1; }',
    '      tokens.push(op);',
    '    } else {',
    '      cur += c;',
    '    }',
    '  }',
    '  flush();',
    '  return tokens;',
    '}',
    '',
    'const isOperator = (t) => /^[<>|&;]+$/.test(t);',
    '',
    '// Break a token stream at the operators that start a new command, so the verb',
    '// of `cat x | tee .check/f` is read as `tee` and not as `cat`.',
    'function segments(tokens) {',
    '  const out = [[]];',
    '  for (const t of tokens) {',
    '    if (/^[|&;]+$/.test(t)) out.push([]);',
    '    else out[out.length - 1].push(t);',
    '  }',
    '  return out;',
    '}',
    '',
    '// Every path a command line demonstrably writes to. Anything this cannot read',
    '// as a write yields nothing, and the caller then allows the command.',
    'function commandTargets(command) {',
    '  const targets = [];',
    '  for (const segment of segments(tokenize(command))) {',
    '    for (let i = 0; i < segment.length; i += 1) {',
    "      if (segment[i] !== '>' && segment[i] !== '>>') continue;",
    '      const next = segment[i + 1];',
    '      if (next !== undefined && !isOperator(next)) targets.push(next);',
    '    }',
    '    const words = segment.filter((t) => !isOperator(t));',
    '    // Step over any leading `VAR=value` assignments to reach the verb itself.',
    '    let i = 0;',
    '    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;',
    "    const verb = (words[i] || '').split('/').pop();",
    '    const rest = words.slice(i + 1);',
    "    const args = rest.filter((a) => !a.startsWith('-'));",
    '    if (ALL_ARGS_VERBS.indexOf(verb) >= 0) targets.push(...args);',
    '    else if (DEST_ONLY_VERBS.indexOf(verb) >= 0 && args.length > 0) targets.push(args[args.length - 1]);',
    "    else if ((verb === 'sed' || verb === 'perl') && rest.some((a) => /^-[a-zA-Z]*i/.test(a))) targets.push(...args);",
    "    else if (verb === 'dd') targets.push(...rest.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)));",
    '  }',
    '  return targets;',
    '}',
    '',
    "// `target`'s repo-relative path when it is checkride accounting, else undefined.",
    'function accounting(target, root, base) {',
    '  const abs = canon(isAbsolute(target) ? target : resolve(base, target));',
    "  const rel = relative(root, abs).split(sep).join('/');",
    "  if (rel === 'checkride.baseline.json' || rel === '.check' || rel.startsWith('.check/')) return rel;",
    '  return undefined;',
    '}',
    '',
    "let raw = '';",
    "process.stdin.on('data', (chunk) => { raw += chunk; });",
    "process.stdin.on('end', () => {",
    '  let input;',
    '  try {',
    '    input = JSON.parse(raw);',
    '  } catch {',
    '    process.exit(0); // fail open: a broken hook must not brick every edit',
    '  }',
    "  if (input === null || typeof input !== 'object') process.exit(0);",
    '  const root = canon(process.env.CURSOR_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd());',
    "  // A shell command resolves against the shell's own cwd, which Cursor sends;",
    '  // a file-tool path has always been resolved against the repo root.',
    "  const base = typeof input.cwd === 'string' && input.cwd.length > 0 ? canon(input.cwd) : root;",
    '  const tool = input.tool_input || {};',
    "  const targets = input.hook_event_name === 'beforeShellExecution'",
    "    ? commandTargets(typeof input.command === 'string' ? input.command : '')",
    "    : PATH_KEYS.map((k) => tool[k]).filter((v) => typeof v === 'string' && v.length > 0);",
    '  const rel = targets.map((t) => accounting(t, root, base)).find((r) => r !== undefined);',
    '  if (rel === undefined) process.exit(0);',
    ...denyTail(),
    '});',
    '',
  ].join('\n');
}

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
import { execCommand, type PackageManager, runScript } from '../pm/index.js';

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
 * Every message this script can emit is passed to `printf` as an *argument*,
 * never inlined into a double-quoted format string, so its backticks survive:
 * `sh` runs a backtick span inside double quotes as a command, but it does not
 * re-scan the result of a variable expansion. An early draft used `echo "…"`
 * with the text inline and the shell silently ate two quoted command names.
 *
 * Two characters are therefore banned from every message here, and a test
 * enforces both. A single quote would end the `'…'` the call site wraps it in. A
 * double quote (or a backslash) would break {@link standDown}, which builds its
 * JSON body with `printf '{"systemMessage":"%s"}'` rather than carrying a
 * second, pre-encoded copy of the same sentence out of step with the first.
 */
const NOTHING_RAN =
  'Nothing ran: no check executed and no artifact was written, so `.check/` holds nothing from this turn.';

/** `<pm> install`, which is how all four package managers spell it. */
const installFix = (pm: PackageManager): string =>
  `Run \`${pm} install\` (checkride is a devDependency of this repo), then run \`${runScript(pm, 'check')}\`.`;

/**
 * The repo has no checkride to run, because its dependencies were never
 * installed — someone pulled a branch that added checkride, or cloned fresh, and
 * started a session before installing.
 *
 * This stands the gate down instead of blocking, and it is the one case where
 * that is clearly right. Blocking exists to make an agent fix what it broke; an
 * absent toolchain is not something the turn broke, and the remedy is an install
 * rather than an edit. Blocking on it re-asks the same agent every turn, forever,
 * for a change that cannot clear it — the loop that ends with a contributor
 * removing the gate. See `../gate.ts` {@link reportStandDown} for the same
 * judgement one layer down.
 */
const notInstalled = (pm: PackageManager): string =>
  [
    'checkride: the gate could not run — checkride is not installed in this repo.',
    NOTHING_RAN,
    installFix(pm),
    'Not blocking: the fix is an install rather than an edit, so blocking would only repeat this ' +
      'message. Nothing was verified this turn.',
  ].join(' ');

/**
 * checkride *is* installed and still did not answer with one of its own two gate
 * codes — a broken launcher, a corrupt install, a crash. This one blocks: it is
 * rare, it is not self-explanatory, and unlike a missing install there is no
 * known remedy to name, so the honest move is to stop and be looked at. The
 * retry guard in {@link gatePreamble} still bounds it.
 */
const notAnswering = (pm: PackageManager, harness: HarnessName): string =>
  [
    'checkride: the gate could not run — checkride is installed here but `checkride gate` did not answer.',
    NOTHING_RAN,
    `Run \`${execCommand(pm, ['checkride', 'gate', '--harness', harness])}\` in a terminal to see the failure directly.`,
  ].join(' ');

/** The harness pointed the hook at a directory that is not there. */
const noRepo =
  'checkride: the gate could not run — the project directory the harness named does not exist or ' +
  'cannot be entered, so there is no repo to check.';

/**
 * The shell functions every branch below answers through: one for a verdict that
 * blocks, one for a verdict that gives up on blocking.
 *
 * `block` consults `retry` first, which is what bounds *every* could-not-run
 * cause rather than only the ones enumerated here. Claude Code sends
 * `stop_hook_active` on the Stop payload and Cursor sends `loop_count`; either
 * one says the previous turn already ended on this verdict, and a second
 * identical block has been demonstrated not to help. A red pipeline never
 * reaches this — that loop is the gate working, and is deliberately unbounded.
 */
function gatePreamble(harness: HarnessName): string[] {
  const cursor = harness === 'cursor';
  return [
    '# The Stop payload arrives as JSON on stdin and says whether the harness has',
    '# already been round this loop once. Read it before anything else can consume',
    '# it, and only from a pipe: `cat` on a terminal would hang a hand-run forever.',
    "payload=''",
    '[ -t 0 ] || payload=$(cat)',
    '',
    '# True once a previous turn already ended on a could-not-run verdict.',
    'retry() {',
    '  printf %s "$payload" |',
    `    grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true|"loop_count"[[:space:]]*:[[:space:]]*[1-9]'`,
    '}',
    '',
    '# Give up on blocking, and say so. Nothing here is silent: a turn that ended',
    '# unverified must never look like one that passed.',
    'stand_down() {',
    ...(cursor
      ? [
          '  # Cursor has one stop-hook output field, `followup_message`, and it submits',
          '  # a new turn — which is the loop being stood down from. So stderr is all',
          '  # there is.',
          '  printf \'%s\\n\' "$1" >&2',
        ]
      : [
          '  # `systemMessage` reaches the user — the one party who can fix an',
          '  # environment. With no `decision` in the body, Claude Code does not block.',
          '  printf \'{"systemMessage":"%s"}\\n\' "$1"',
          '  printf \'%s\\n\' "$1" >&2',
        ]),
    '  exit 0',
    '}',
    '',
    '# Block the turn — unless this is the second consecutive attempt, in which',
    '# case blocking is the thing already shown not to work.',
    'block() {',
    '  retry && stand_down "$1 Standing down rather than blocking a second time on the same verdict."',
    ...(cursor
      ? [
          '  # Cursor reads any non-zero stop hook as a *broken* hook and ends the turn,',
          '  # so the block has to ride in the body with an exit of 0.',
          '  printf \'{"followup_message":"%s"}\\n\' "$1"',
          '  exit 0',
        ]
      : ['  printf \'%s\\n\' "$1" >&2', '  exit 2']),
    '}',
  ];
}

/**
 * Translate the gate's exit status into `harness`'s protocol.
 *
 * `checkride gate` exits 0 or 2 by design, and only on those two is its stdout a
 * hook body worth forwarding. Anything else means checkride never ran, and
 * whatever is on stdout then is the *launcher's* error — pnpm writes
 * `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` there, ahead of a stray `undefined` on
 * pnpm 11. Forwarding that as a hook body puts unparseable text where Claude
 * Code expects JSON, so the status is checked first and the body is forwarded
 * only when checkride is the one that wrote it.
 */
function gateTail(harness: HarnessName, pm: PackageManager): string[] {
  const answered =
    harness === 'cursor'
      ? [
          '# On 0 checkride has already written its JSON to stdout, which is what Cursor',
          '# reads, and on 2 it has written the followup body. Either way it answered.',
          'case "$status" in',
          '  0|2) exit 0 ;;',
          'esac',
        ]
      : [
          '# Claude Code parses a hook body only on exit 0, and only a body can carry a',
          '# user-visible message alongside the block. So when checkride produced one,',
          '# forward it and exit 0: the verdict rides in `decision`, not in the status.',
          'case "$status" in',
          '  0|2)',
          '    if [ -n "$body" ]; then',
          "      printf '%s\\n' \"$body\"",
          '      exit 0',
          '    fi',
          '    # No body — an older checkride that reports only through the exit code.',
          '    exit "$status"',
          '    ;;',
          'esac',
        ];
  return [
    ...answered,
    '',
    "# Neither of checkride's two gate codes: checkride itself never ran. Which of",
    '# the two reasons it was decides whether blocking could accomplish anything.',
    'if [ -e node_modules/.bin/checkride ] || [ -e .pnp.cjs ] || [ -e .pnp.js ]; then',
    `  block '${notAnswering(pm, harness)}'`,
    'fi',
    `stand_down '${notInstalled(pm)}'`,
  ];
}

/**
 * Characters a `gate.preflight` path may not contain, because the generated
 * script embeds it inside `'…'` and inside a message that later becomes a JSON
 * string field.
 *
 * Rejected loudly rather than escaped or stripped. Every one of these in a
 * repo-relative script path is a mistake, and a mangled path would fail later as
 * "preflight not found", pointing at the wrong thing.
 */
const PREFLIGHT_HOSTILE = /['"\\`\n]/;

/**
 * The repo-owned preflight, run from the repo root before checkride is started.
 *
 * Its exit code is read in the gate's own vocabulary — 0 runs the gate, 2 blocks
 * the turn, anything else stands it down — so there is one meaning per code
 * across the whole system rather than a second convention to learn. Both
 * non-zero branches use the script's own output as the message and never start
 * checkride, which is what lets a preflight answer for a repo where checkride
 * *cannot* start.
 *
 * A configured path that is not there **blocks**, and deliberately: treating it
 * as a stand-down would mean a typo in one config key silently disarms the gate
 * forever. A missing file is repo-fixable, so blocking is the consistent answer.
 */
function preflight(path: string): string[] {
  if (PREFLIGHT_HOSTILE.test(path)) {
    throw new Error(
      `checkride.config.json: gate.preflight '${path}' contains a quote, backslash, backtick or newline. ` +
        'Use a plain repo-relative path.',
    );
  }
  // `sh` resolves a command with no `/` against PATH, which is never what a
  // repo-relative config value means.
  const target = path.includes('/') ? path : `./${path}`;
  return [
    '# The repo-owned preflight, from `gate.preflight` in checkride.config.json.',
    '# checkride owns this script and overwrites it; the preflight is where a repo',
    '# says something before the gate and keeps it across every refresh.',
    `if [ ! -e '${target}' ]; then`,
    `  block 'checkride: the gate could not run — checkride.config.json names a gate.preflight (${target}) that is not there. Add the script, or drop the key.'`,
    'fi',
    '',
    '# A preflight prints for humans; this has to survive a JSON string field. The',
    '# two characters that would break one are dropped and newlines folded.',
    'say() {',
    `  printf %s "$1" | tr -d '"\\\\' | tr '\\n' ' '`,
    '}',
    '',
    '# Honour the shebang when the file is executable, and fall back to `sh` when it',
    '# is not — a checked-in script routinely arrives without its exec bit.',
    `if [ -x '${target}' ]; then`,
    `  said=$('${target}' 2>&1)`,
    'else',
    `  said=$(sh '${target}' 2>&1)`,
    'fi',
    'code=$?',
    `[ "$code" -eq 0 ] || [ -n "$said" ] ||`,
    `  said='checkride: the gate could not run — the preflight ${target} exited non-zero and printed nothing.'`,
    '',
    '# 0 runs the gate; 2 blocks; anything else stands down. checkride is never',
    '# started on a non-zero branch.',
    'case "$code" in',
    '  0) ;;',
    '  2) block "$(say "$said")" ;;',
    '  *) stand_down "$(say "$said")" ;;',
    'esac',
  ];
}

/**
 * Enter the repo, or report a verdict rather than a bare status.
 *
 * Spelled as a block rather than `cd … || exit 2` for two reasons: a bare status
 * tells the agent nothing, and under Cursor a non-zero stop hook is a *broken*
 * hook, so the one branch that used to exit 2 there was the one branch that
 * silently let a turn end.
 */
function enterRepo(): string[] {
  return [`if ! cd ${PROJECT_DIR}; then`, `  block '${noRepo}'`, 'fi'];
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
 *
 * `preflight` is the repo's own script, from `gate.preflight` in
 * checkride.config.json, baked in here rather than looked up at run time — see
 * {@link preflight} and `../gate.ts` `gatePreflight`. It runs *before* the edit
 * marker is consulted, because a repo that cannot run the gate at all wants to
 * say so on every turn, not only on the ones that edited a file.
 */
export function gateScript(
  pm: PackageManager,
  opts: { harness: HarnessName; dirtyGuard?: boolean; preflight?: string },
): string {
  const args = ['gate', '--harness', opts.harness, ...((opts.dirtyGuard ?? true) ? ['--if-dirty'] : [])];
  return [
    '#!/bin/sh',
    `# checkride-gate.sh — the ${opts.harness} stop-hook gate.`,
    '#',
    '# checkride owns this file: `checkride agent-setup` (and `checkride init`)',
    '# overwrite it on every run. Customize through checkride.config.json (a `gate`',
    '# key narrows what runs) or the environment (CHECKRIDE_NODE_BIN), not by',
    '# editing here — edits are lost on the next refresh.',
    '#',
    "# Runs the repo's `check` script as a hard gate, and reports the verdict in",
    `# ${opts.harness}'s hook protocol. See \`checkride gate --help\`.`,
    '',
    ...gatePreamble(opts.harness),
    '',
    ...enterRepo(),
    '',
    ...(opts.preflight === undefined ? [] : [...preflight(opts.preflight), '']),
    ...invokeGate(pm, opts.harness, args),
    ...gateTail(opts.harness, pm),
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

/**
 * The hook scripts checkride generates into a consumer repo.
 *
 * checkride owns these files and overwrites them on every `agent-setup`/`init`,
 * so consumer customization belongs beside them, never in them. That is also why
 * the settings entry each harness gets is a stable one-liner invoking a script
 * rather than the behavior inline: a refresh rewrites the script freely without
 * ever clobbering an entry a human may have edited.
 *
 * The gate and dirty scripts are harness-independent but for one flag, because
 * the decision lives in `checkride gate` (see `../gate.ts`). Only `protect` still
 * differs in substance: Claude Code denies a tool call with exit 2 and a stderr
 * message, Cursor with a `{"permission":"deny"}` JSON body on stdout.
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
 * Keys a harness may use for the target path in a tool call's `tool_input`.
 *
 * Claude Code documents `file_path` and `notebook_path`. Cursor documents the
 * shape for `Shell` but not for `Write`/`Delete`, so the list is deliberately
 * broad and order-independent: the script takes the first string it finds. An
 * unrecognized shape yields no target and the script fails open, which is the
 * correct failure — a protect hook that cannot read its input must not become a
 * repo where nothing can be written.
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

/** The deny message, shared by both harnesses. */
const DENY_MESSAGE =
  "'checkride: ' + rel + ' is checkride-owned accounting. Never edit the baseline or .check ' +\n" +
  "    'artifacts to make a check pass — fix the finding instead (the ratchet prunes the baseline on its own).'";

/**
 * How each harness spells "deny this tool call".
 *
 * Claude Code: stderr plus exit 2 (exit 2 is the deny signal; stderr is what the
 * agent is shown). Cursor: a JSON body on stdout with exit 0 — it reads a
 * non-zero hook as a *broken* hook and proceeds, so the denial has to travel in
 * the body, where `agent_message` is what the model sees.
 */
function denyTail(harness: HarnessName): string[] {
  if (harness === 'cursor') {
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
  return ['  process.stderr.write(' + DENY_MESSAGE + " + '\\n');", '  process.exit(2);'];
}

/**
 * The `protect` deny script: "never add to the baseline to make a check pass" as
 * enforcement, not README advice. A Node script (not sh) because the hook
 * protocol is JSON on stdin, and every checkride repo has node by construction;
 * `.cjs` so it runs regardless of the repo's module type. Only edit tools are
 * matched — reads are never denied, because triage depends on reading `.check/`
 * artifacts.
 */
export function protectScript(harness: HarnessName): string {
  return [
    '#!/usr/bin/env node',
    "// checkride-protect.cjs — deny agent edits to checkride's accounting files.",
    '// checkride owns this file: `checkride agent-setup` (and `checkride init`)',
    '// overwrite it on every run.',
    '//',
    `// Pre-tool hook for ${harness}. Reads the tool call as JSON on stdin and`,
    '// denies the write when it targets the baseline or .check/. Reads are never',
    '// matched — triage depends on reading .check artifacts.',
    "'use strict';",
    "const { realpathSync } = require('node:fs');",
    "const { basename, dirname, isAbsolute, relative, resolve, sep } = require('node:path');",
    '',
    `const PATH_KEYS = ${JSON.stringify(PATH_KEYS)};`,
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
    "let raw = '';",
    "process.stdin.on('data', (chunk) => { raw += chunk; });",
    "process.stdin.on('end', () => {",
    '  let input;',
    '  try {',
    '    input = JSON.parse(raw);',
    '  } catch {',
    '    process.exit(0); // fail open: a broken hook must not brick every edit',
    '  }',
    '  const tool = (input && input.tool_input) || {};',
    "  const target = PATH_KEYS.map((k) => tool[k]).find((v) => typeof v === 'string' && v.length > 0);",
    '  if (target === undefined) process.exit(0);',
    '  const root = canon(process.env.CURSOR_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd());',
    '  const abs = canon(isAbsolute(target) ? target : resolve(root, target));',
    "  const rel = relative(root, abs).split(sep).join('/');",
    "  const denied = rel === 'checkride.baseline.json' || rel === '.check' || rel.startsWith('.check/');",
    '  if (!denied) process.exit(0);',
    ...denyTail(harness),
    '});',
    '',
  ].join('\n');
}

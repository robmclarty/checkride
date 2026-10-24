#!/usr/bin/env node
/**
 * CLI entry — arg parsing and command dispatch (the package `bin`).
 *
 * Commands: default `run`, plus `init`, `doctor`, `fix`, `baseline`, `recover`,
 * `agent-setup`, `gate`, `triage` and `qa`. The command is the first non-flag
 * token; everything after it is parsed against that command's options. The
 * module is import-safe: it only executes when invoked directly, so tests can
 * import {@link runCli} without triggering a process exit.
 *
 * Exit codes: 0 pass, 1 check/verification failure, 2 orchestrator/usage error.
 * `gate` is the documented exception — it speaks a harness's hook protocol
 * rather than checkride's own split (see `./gate.ts`).
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { HOOK_NAMES, type HookName, type HooksOptions, runHooks } from './agent-setup/index.js';
import { namedOut } from './artifacts/index.js';
import { runBaseline, runBaselineDiff, runBaselineVersions } from './baseline-command.js';
import type { CheckrideConfig } from './config.js';
import { CONFIG_ENV, DEFAULTS_ENV, loadConfig, loadConfigFile, loadDefaultsFile } from './config.js';
import { runDoctor } from './doctor.js';
import { HARNESS_NAMES, type HarnessName, runGate } from './gate.js';
import type { NamedBase } from './git.js';
import { BASE_ENV } from './git.js';
import type { AgentSetupOptions, InitOptions, Lang, Shape } from './init.js';
import { LANG_SHAPES, runAgentSetup, runInit } from './init.js';
import type { Out, RunFlags } from './orchestrator/index.js';
import { loadPinsFile, PINS_ENV } from './launch/index.js';
import { killLiveChecks, runChecks, runFix } from './orchestrator/index.js';
import { qaExtract, renderQa } from './qa/index.js';
import { runRecover } from './recover.js';
import { runTargetAdd } from './target-command.js';
import { declaredNote, discoverRun } from './targets/index.js';
import { realEnv, renderTriage, triage } from './triage/index.js';

/**
 * Injected process surface, so {@link runCli} is testable. `env` defaults to
 * `process.env`; a test passes its own so a variable exported in the shell
 * that started the suite can't reach the run.
 */
export type CliDeps = { cwd: string; stdout: Out; stderr: Out; env?: Record<string, string | undefined> };

const RUN_OPTIONS = {
  bail: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  only: { type: 'string' },
  skip: { type: 'string' },
  include: { type: 'string' },
  all: { type: 'boolean', default: false },
  changed: { type: 'boolean', default: false },
  discover: { type: 'boolean', default: false },
  'static-only': { type: 'boolean', default: false },
  digest: { type: 'boolean', default: false },
  strict: { type: 'boolean', default: false },
  concurrency: { type: 'string' },
  config: { type: 'string' },
  base: { type: 'string' },
  out: { type: 'string' },
  defaults: { type: 'string' },
  pins: { type: 'string' },
} as const;

/** `baseline` takes only `--versions`, `--only`, `--skip`, `--config` and `--out`; anything else is a usage error. */
const BASELINE_OPTIONS = {
  versions: { type: 'boolean', default: false },
  only: { type: 'string' },
  skip: { type: 'string' },
  config: { type: 'string' },
  out: { type: 'string' },
} as const;

/** `triage` and `qa` take an optional repo path and `--out`. */
const READER_OPTIONS = {
  out: { type: 'string' },
} as const;

/** `baseline diff` takes an optional ref and `--json`; anything else is a usage error. */
const BASELINE_DIFF_OPTIONS = {
  json: { type: 'boolean', default: false },
} as const;

const INIT_OPTIONS = {
  lang: { type: 'string' },
  shape: { type: 'string' },
  module: { type: 'string' },
  name: { type: 'string' },
  scope: { type: 'string' },
  license: { type: 'string' },
  author: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  add: { type: 'string' },
  baseline: { type: 'boolean', default: false },
  hook: { type: 'string' },
  'no-hook': { type: 'boolean', default: false },
  'remove-hook': { type: 'string' },
  harness: { type: 'string' },
  force: { type: 'boolean', default: false },
} as const;

const HOOKS_OPTIONS = {
  'dry-run': { type: 'boolean', default: false },
  harness: { type: 'string' },
} as const;

const GATE_OPTIONS = {
  'if-dirty': { type: 'boolean', default: false },
  harness: { type: 'string' },
} as const;

/** `target add <name>` takes these; anything else is a usage error. */
const TARGET_ADD_OPTIONS = {
  lang: { type: 'string' },
  root: { type: 'string' },
  add: { type: 'string' },
  'root-name': { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
} as const;

const RECOVER_OPTIONS = {
  pick: { type: 'string' },
  exact: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  depth: { type: 'string' },
  json: { type: 'boolean', default: false },
} as const;

const HELP_TEXT = `checkride — an agent harness for code repositories

Usage: checkride [command] [options]

Commands:
  (default)        Run the checks. Exit 0 pass / 1 fail / 2 error.
  init             Set up a project (new or existing — auto-detected). Writes the
                   agent stop-gate hooks (--no-hook to skip). New mode refuses to
                   overwrite existing files (--force to override). Existing mode:
                   --baseline grandfathers current debt.
  doctor           Verify the environment and every slot's status (read-only).
  fix              Run every active adapter's fix command. Takes --only, --skip,
                   --include, --all, --concurrency and --config; refuses
                   --static-only, --discover, --base, --out, --defaults and
                   --pins (exit 2).
  baseline         Record current diagnostics as a committed baseline.
                   --only/--skip <a,b> capture just the checks they select and
                   keep every other check's entry. \`baseline --versions\`
                   re-records the copy each check's tool ran, adding no key.
                   \`baseline diff [<ref>]\` lists the keys added and removed
                   since <ref> (default HEAD).
  recover          Rebuild checkride.baseline.json candidates from git history
                   and restore one (a merge that dropped entries fails closed).
  target           Declare a target: \`target add <name> --lang <pack> --root
                   <dir>\` (a repo with none yet becomes multi-target).
  agent-setup      Add the AGENTS.md stanza + agent hooks to an existing repo
                   (--hook <a,b> to select; --no-hook to skip them all;
                   --remove-hook <a,b> to tear installed ones back out;
                   --harness <a,b> to pick the harnesses; --force to refresh a
                   stanza carrying local edits).
  hooks            Install or remove agent hooks on their own, without touching
                   AGENTS.md: \`hooks add [a,b]\`, \`hooks remove <a,b>\`.
  gate             Run the check script as a stop gate and answer in a harness's
                   hook protocol. Invoked by the generated hook scripts.
  triage           Triage a red gate: run it, then read .check/ as a bounded
                   report. Takes an optional repo path, and --out.
  qa               Read the quality artifacts (mutation, dead, dupes, health)
                   a previous run left. Takes an optional repo path, and --out.

Run options:
  --only <a,b>     Run only these checks, each named by a slot, a custom check,
                   a target, or <target>:<slot>; an unknown name is exit 2
  --skip <a,b>     Skip these checks, named the same way
  --include <a,b>  Add opt-in slots (format, dupes, health, prose, mutation,
                   security, build, publint, attw, pack, smoke, snippets) to
                   the run
  --all            Include every opt-in slot
  --changed        Affected-only mode (incremental)
  --static-only    Keep only checks that read the repo as data, skipping any
                   that would run its code or need its install (also on
                   doctor). A selector for a run before the install, not a
                   sandbox; never ratchets.
  --discover       Check the targets the repo's files propose, as if the
                   config declared them (where it declares some, those run,
                   with a note; also on doctor). Writes nothing and never
                   ratchets the baseline.
  --base <ref>     The ref --changed measures from (or set CHECKRIDE_BASE, or
                   changedBase in the config; default origin/main, else HEAD).
                   A named ref that doesn't resolve is exit 2.
  --bail           Stop at the first failure (sequential; overrides --concurrency)
  --concurrency <n>  Max checks running at once within a wave (default auto; 1 = sequential)
  --json           Emit the summary as JSON on stdout
  --digest         Write a capped failure excerpt to digest.md beside the
                   summary, which carries it as digest, and print it below
                   the report (not under --json)
  --strict         Zero checks actually running is an error (exit 2), not a pass
  --config <path>  Read this config file instead of ./checkride.config.json
                   (also on doctor, fix and baseline; or set CHECKRIDE_CONFIG).
                   A file outside the repo never ratchets the baseline.
  --out <dir>      Write the summary, raw output and digest to <dir> instead of
                   ./.check (or set CHECKRIDE_OUT; also on baseline, triage and
                   qa, and doctor probes it). A directory outside the repo never
                   ratchets the baseline.
  --defaults <path>  Fill the slots the repo's config and detection leave empty
                   from this config file (or set CHECKRIDE_DEFAULTS; also on
                   doctor). A run with it never ratchets the baseline.
  --pins <mise.toml>  Run each tool this file's [tools] pins as that version,
                   through mise, ahead of the repo's own pins (or set
                   CHECKRIDE_PINS; also on doctor). Never installs; never
                   ratchets the baseline.
  -h, --help       Show this help
  -V, --version    Show the version

Every run writes a report to .check/summary.json, or to <dir> under --out.
Docs: https://github.com/robmclarty/checkride#readme
`;

const INIT_HELP_TEXT = `checkride init — set up a project (new or existing, auto-detected)

Usage: checkride init [options]

New project: scaffolds a full project. Refuses to overwrite existing files
unless --force.
Existing project, whose root holds a package.json, go.mod, go.work,
Cargo.toml, pyproject.toml, setup.cfg, setup.py, .terraform.lock.hcl or *.tf
file (a tsconfig.json alone doesn't make one): adopts detectable slots
through the root's pack, and proposes the targets its files suggest;
--baseline grandfathers current debt.
Either mode refuses (exit 2) rather than overwrite an AGENTS.md stanza that has
been edited since checkride wrote it.

Options:
  --lang <l>       Language: ts | go | rust (new mode; default ts)
  --shape <s>      Project shape (new mode): flat | monorepo | hybrid for ts
                   (default flat), module | workspace for go (default module),
                   crate | workspace for rust (default crate)
  --module <path>  Go module path (new mode, --lang go; default example.com/<name>)
  --name <n>       Package name (new mode; default: directory name)
  --scope <@s>     npm scope, e.g. @acme (new mode)
  --license <id>   SPDX license id (new mode; default MIT)
  --author <a>     Package author (new mode)
  --add <a,b>      Scaffold blessed configs for empty slots (existing mode)
  --baseline       Grandfather currently-failing slots into a baseline (existing mode)
  --force          Overwrite instead of refusing: existing files (new mode), or
                   an AGENTS.md stanza carrying local edits (existing mode)
  --hook <a,b>     Write only these hooks (${HOOK_NAMES.join(' | ')}; default all)
  --no-hook        Skip writing the agent hooks entirely
  --remove-hook <a,b>  Remove these already-installed hooks (config entry +
                   generated script). Combine with --no-hook to remove without
                   refreshing the others. Cannot name a hook --hook also names.
  --harness <a,b>  Write hooks for these harnesses (${HARNESS_NAMES.join(' | ')};
                   default: claude, plus cursor when .cursor/ exists)
  --dry-run        Plan only; write nothing
  -h, --help       Show this help

Docs: https://github.com/robmclarty/checkride#readme
`;

const GATE_HELP_TEXT = `checkride gate — run the check script as an agent stop gate

Usage: checkride gate [options]

Runs the repo's check with --strict --digest and reports the verdict in the
calling harness's stop-hook protocol. It runs the check the way the repo does:
\`<pm> run check\` from a package.json, \`mise exec -- checkride\` where
mise.toml pins checkride and package.json holds no check script, or
\`checkride\` from PATH where neither applies. The generated hook scripts
invoke this; you rarely run it by hand.

Options:
  --harness <h>    Protocol to answer in (${HARNESS_NAMES.join(' | ')}; default claude)
  --if-dirty       Skip the run when .check/.dirty is absent (no edits this turn)
  -h, --help       Show this help

Config:
  A \`gate\` key in checkride.config.json narrows what the stop hook runs
  (\`only\`, \`skip\`, \`changed\`) when the full check is too slow to pay for on
  every turn. Every verdict then says so — a narrowed green is never reported
  as a full one.

Environment:
  CHECKRIDE_NODE_BIN   A bin directory to put in front of the check run's PATH,
                       or \`off\` to disable checkride's Node-pin alignment.
  CHECKRIDE_CONFIG     Ignored: the gate strips it from the check it runs, which
                       always reads the repo's own checkride.config.json.
  CHECKRIDE_BASE       Ignored the same way, so a profile's \`changed\` measures
                       from the repo's own base.
  CHECKRIDE_OUT        Ignored the same way: the gate's run always writes
                       .check/, where the gate reads its verdict.
  CHECKRIDE_DEFAULTS   Ignored the same way: the gate's run fills no slot from
                       a consumer's defaults file.
  CHECKRIDE_PINS       Ignored the same way: the gate's run uses the repo's own
                       pins.

Three verdicts: green, red, and "could not run" — the last for a package manager
that refused to start the check script (an engines.node pin the hook's Node does
not satisfy, most often). Nothing ran and no artifact describes the turn, so it
names the cause instead of naming a file. It blocks like a red when the repo can
fix it (no check script); when only the environment can, it says so and lets the
turn end rather than re-asking an agent that has no lever to pull.

Exit codes differ by harness, because the harnesses differ: claude blocks on
exit 2 and reads stderr; cursor reads {"followup_message": …} on stdout and
treats any non-zero exit as a broken hook, so it always exits 0.

Docs: https://github.com/robmclarty/checkride#readme
`;

const HOOKS_HELP_TEXT = `checkride hooks — install or remove agent hooks, and nothing else

Usage: checkride hooks add [a,b] [options]
       checkride hooks remove <a,b> [options]

Writes or tears out the harness config entries and the generated scripts for the
named hooks (${HOOK_NAMES.join(' | ')}). It never reads or writes AGENTS.md, so no
state of that file can block it and no run of it can change that file — which is
what separates it from \`agent-setup\`, where the hooks ride along with the stanza,
the check alias, and the Cursor skills.

\`add\` defaults to every hook. \`remove\` requires an explicit list, so a bare
command cannot silently tear out the gate.

Options:
  --harness <a,b>  Act on these harnesses (${HARNESS_NAMES.join(' | ')};
                   default: claude, plus cursor when .cursor/ exists)
  --dry-run        Report what would change without writing
  -h, --help       Show this help

Docs: https://github.com/robmclarty/checkride#readme
`;

const RECOVER_HELP_TEXT = `checkride recover — restore checkride.baseline.json from git history

Usage: checkride recover [--pick <n|sha|union>] [options]

Reconstructs recent committed states of checkride.baseline.json (a merge can
silently drop entries — missing entries fail closed, so grandfathered findings
go red) and lets you restore one. Without --pick, lists a small candidate set
with deltas. With --pick, writes the file directly — never \`git checkout\` —
so the restore lands as an ordinary working-tree edit you review and commit.

The default write is the UNION of the candidate and the current file: nothing
is removed, and a stale resurrected key is pruned by the ratchet on the next
full green run. This is also why \`checkride baseline\` is the wrong remedy for
a clobbered file: a re-capture would grandfather genuinely-new findings too.

Options:
  --pick <p>       Apply a candidate: its listing number, its commit sha (the
                   stable handle — prefer it in scripts), or \`union\` (every
                   walked state folded together)
  --exact          Write the picked snapshot verbatim instead of the union.
                   Refused while checkride.baseline.json has uncommitted
                   changes (commit or stash them first — exact discards them)
  --dry-run        Show what --pick would change, per slot; write nothing
  --depth <n>      Commits of file history to walk (default 25)
  --json           Emit the listing / apply result as JSON on stdout
  -h, --help       Show this help

Exit codes: 0 listed or applied; 2 usage or environment error (git missing,
not a git repository, unknown --pick). \`recover\` never exits 1.

Docs: https://github.com/robmclarty/checkride#readme
`;

const BASELINE_HELP_TEXT = `checkride baseline — grandfather today's findings, or diff them against git

Usage: checkride baseline [--versions] [--only <a,b>] [--skip <a,b>]
                          [--config <path>] [--out <dir>]
       checkride baseline diff [<ref>] [--json]

\`baseline\` runs the checks and writes their current findings, per check, to
checkride.baseline.json at the repo root. Commit the file: a later run fails
only on findings it doesn't list, and a full run prunes the ones fixed since.
It runs only the checks whose findings the file can key, and skips the rest.
With --only or --skip it runs just the checks they select and rewrites only
their entries: every other check keeps its entry as the file holds it.

\`baseline --versions\` runs the checks and adds no key. A tool upgrade holds a
check back from the ratchet when it ran another copy than the file records.
Once the repo pins that copy, this records it, for each check that ran to a
verdict, reported no key the file lacks or past its count, and ran a copy the
repo's pins chose, the toolchain it ran on included, and prunes the keys that
check no longer reports. Every other check is left as it was, and named with why. Since it
never adds a key, an agent may run it; a check with new keys still needs a
human's \`checkride baseline\`.

\`baseline diff\` writes nothing. It reads <ref>'s committed copy of the file
through git (default HEAD), compares it with the working-tree file, and prints
the keys added and removed per check. A file missing on either side reads as
empty, so a ref from before the baseline existed lists every key as added.

Options:
  --versions       Re-record the copy of each check's tool, adding no key
  --only <a,b>     Capture only these checks, each named by a slot, a custom
                   check, a target, or <target>:<slot>; an unknown name is
                   exit 2 (baseline only; with --versions, re-record only them)
  --skip <a,b>     Capture every check but these, named the same way
  --config <path>  Read this config file instead of ./checkride.config.json
                   (baseline only; or set CHECKRIDE_CONFIG). With --versions
                   it must sit inside the repo.
  --out <dir>      Write the capture run's artifacts to <dir> instead of
                   ./.check (baseline only; or set CHECKRIDE_OUT). The baseline
                   itself is still written at the repo root.
  --json           Print the diff as JSON: ref, sha, added, removed,
                   added_count, removed_count (baseline diff only)
  -h, --help       Show this help

Exit codes: \`baseline\` exits 0 once the file is written, or found nothing
to write, and with --versions whenever it ran, a check left or not; 2 for an
unknown or empty --only or --skip, with --only or --skip when the file can't
be parsed, and with --versions when there's no file, it can't be parsed, or
--config names a file outside the repo. \`baseline diff\` exits 0 whenever
it ran, keys added or not, and 2 when the ref names no commit, git is
missing, or either copy can't be parsed.

Docs: https://github.com/robmclarty/checkride#readme
`;

const TARGET_HELP_TEXT = `checkride target — declare the targets a repo is checked as

Usage: checkride target add <name> --lang <pack> --root <dir>
                           [--add <a,b>] [--root-name <n>] [--dry-run]

Adds a target to checkride.config.json, creating the file when there's none.
The target adopts the tools its root already configures, naming each in its
checks. In a repo that declares no targets yet, the repo's implicit target
becomes an explicit one of its pack named --root-name (default app), rooted
at .: the top-level checks entries for target-scope slots move into its
checks, and checkride.baseline.json's entries move from lint to app:lint. A
target of that pack rooted at . takes the implicit one over instead. A root
that marks no pack and configures no tool becomes no target, and the new one
is declared alone. Each change is printed.

Options:
  --lang <pack>       The target's pack: ts, bash, go, rust, python or
                      terraform
  --root <dir>        Its directory, relative to the repo root (. for the root)
  --add <a,b>         Name the blessed tool for these slots, and for a ts,
                      python or terraform target scaffold its config under the
                      root, unless the root configures the tool already
  --root-name <n>     The name a converted repo's implicit target takes
  --dry-run           Print the changes; write nothing
  -h, --help          Show this help

Exit codes: 0 once the target is declared (or the dry run printed); 2 on a
usage error or a config the change would break, having written nothing.

Docs: https://github.com/robmclarty/checkride#readme
`;

/** Per-command `--help` text, falling back to the global help. */
const COMMAND_HELP: Record<string, string> = {
  target: TARGET_HELP_TEXT,
  init: INIT_HELP_TEXT,
  gate: GATE_HELP_TEXT,
  hooks: HOOKS_HELP_TEXT,
  baseline: BASELINE_HELP_TEXT,
  recover: RECOVER_HELP_TEXT,
};

function commandHelp(command: string): string {
  return COMMAND_HELP[command] ?? HELP_TEXT;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The `code` property of an Error-like value (for example Node's `ERR_PARSE_ARGS_*`). */
function errorCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

/** parseArgs appends a long "To specify a positional…" hint; keep the first sentence. */
function firstSentence(message: string): string {
  const head = message.split('. ')[0] ?? message;
  return head.endsWith('.') ? head : `${head}.`;
}

/** Read the package's own version from its shipped package.json (next to dist/). */
function readVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg: { version?: string } = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Parse a comma-separated list flag. Absent (`undefined`) is `null`, so the
 * caller applies its own default.
 *
 * A flag that was *passed* but names nothing after trimming is a usage error,
 * never an empty list. `--only ,` used to parse to `[]`, which is truthy, so
 * `selectChecks` filtered every check out and `validateSelection` found no
 * unknown name to complain about: the run exited 0 having verified nothing —
 * exactly the vacuous green that validation exists to prevent. The two empty
 * spellings also disagreed (`--only ''` ran *everything*, `--only ,` ran
 * nothing); both are now exit 2.
 */
function parseList(value: string | undefined, flag: string): string[] | null {
  if (value === undefined) return null;
  const names = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new Error(`--${flag} was passed with no names (got ${JSON.stringify(value)})`);
  }
  return names;
}

/**
 * Parse a flag's positive-integer value, or `undefined` when the flag is absent
 * (the caller then applies its own default). A non-integer or `< 1` value is a
 * usage error (surfaced as exit 2), never a silent clamp: a gate that quietly
 * ran everything at once when you asked for `1` would be the kind of surprise
 * this tool exists to prevent.
 */
function parsePositiveInt(value: string | undefined, invalid: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${invalid} '${value}' (expected a positive integer)`);
  }
  return n;
}

/** `--concurrency <n>`; absent → the orchestrator picks its auto default. */
function parseConcurrency(value: string | undefined): number | undefined {
  return parsePositiveInt(value, 'invalid --concurrency');
}

/** The command is the first non-flag token; the rest are its arguments. */
function detectCommand(argv: string[]): { command: string; rest: string[] } {
  const first = argv[0];
  if (first !== undefined && !first.startsWith('-')) {
    return { command: first, rest: argv.slice(1) };
  }
  return { command: 'run', rest: argv };
}

/**
 * Parse argv into a command name, the run flags, and the raw `--config`,
 * `--base`, `--out`, `--defaults` and `--pins` values (each absent when not
 * passed; {@link namedConfig}, {@link namedBase}, `namedOut`,
 * {@link namedDefaults} and {@link namedPins} resolve them against their
 * variables).
 */
export function parseCliArgs(argv: string[]): { command: string; flags: RunFlags; config?: string; base?: string; out?: string; defaults?: string; pins?: string } {
  const { command, rest } = detectCommand(argv);
  const { values } = parseArgs({ args: rest, allowPositionals: true, options: RUN_OPTIONS });
  const concurrency = parseConcurrency(values.concurrency);
  const flags: RunFlags = {
    bail: values.bail,
    json: values.json,
    all: values.all,
    changed: values.changed,
    discover: values.discover,
    staticOnly: values['static-only'],
    digest: values.digest,
    strict: values.strict,
    only: parseList(values.only, 'only'),
    skip: parseList(values.skip, 'skip'),
    include: parseList(values.include, 'include'),
    // Omitted when absent, so the orchestrator's auto default applies (exact
    // optional types: an explicit `undefined` is not the same as absent).
    ...(concurrency !== undefined ? { concurrency } : {}),
  };
  return {
    command,
    flags,
    ...(values.config !== undefined ? { config: values.config } : {}),
    ...(values.base !== undefined ? { base: values.base } : {}),
    ...(values.out !== undefined ? { out: values.out } : {}),
    ...(values.defaults !== undefined ? { defaults: values.defaults } : {}),
    ...(values.pins !== undefined ? { pins: values.pins } : {}),
  };
}

/** A config file named on the command line or in the environment, read and resolved. */
type NamedConfig = { path: string; config: CheckrideConfig };

/**
 * The config a command reads in place of `<cwd>/checkride.config.json`:
 * `--config`, else `CHECKRIDE_CONFIG` (an empty variable counts as unset),
 * resolved against `cwd`. `null` when neither names one, so the command reads
 * the repo's own file. A named file that is missing is a usage error (exit 2):
 * falling back to the repo's config would check against rules nobody asked for.
 */
function namedConfig(flag: string | undefined, deps: CliDeps): NamedConfig | null {
  const path = namedFile('--config', flag, CONFIG_ENV, deps);
  return path === null ? null : { path, config: loadConfigFile(path, deps.cwd, warnOn(deps)) };
}

/** Where a config read reports a key nothing reads: the command's stderr, a line each. */
function warnOn(deps: CliDeps): (message: string) => void {
  return (message) => deps.stderr.write(`${message}\n`);
}

/**
 * The file a flag or, in its absence, its variable names (an empty variable
 * counts as unset), resolved against `cwd`, or `null` when neither names one.
 * A flag with no path and a named file that is missing are usage errors.
 */
function namedFile(flag: string, value: string | undefined, variable: string, deps: CliDeps): string | null {
  if (value === '') throw new Error(`${flag} was passed with no path`);
  const set = (deps.env ?? process.env)[variable];
  const named = value ?? (set === '' ? undefined : set);
  if (named === undefined) return null;
  const path = resolve(deps.cwd, named);
  if (!existsSync(path)) throw new Error(`${value === undefined ? variable : flag} names a missing file: ${path}`);
  return path;
}

/**
 * The defaults layer a run reads (R13.1): `--defaults`, else
 * `CHECKRIDE_DEFAULTS`, read and validated, or `null` when neither names a
 * file. A missing file is a usage error, as it is for `--config`.
 */
function namedDefaults(flag: string | undefined, deps: CliDeps): NamedConfig | null {
  const path = namedFile('--defaults', flag, DEFAULTS_ENV, deps);
  return path === null ? null : { path, config: loadDefaultsFile(path, deps.cwd) };
}

/**
 * The override pins a run reads (R13.3): the `mise.toml` `--pins` names, else
 * `CHECKRIDE_PINS`, with each `[tools]` entry's version, or `null` when
 * neither names a file. A missing file, or an entry with no version, is a
 * usage error.
 */
function namedPins(flag: string | undefined, deps: CliDeps): { path: string; tools: ReadonlyMap<string, string> } | null {
  const path = namedFile('--pins', flag, PINS_ENV, deps);
  return path === null ? null : { path, tools: loadPinsFile(path) };
}

/**
 * The base a `--changed` run measures from, when one is named: `--base`, else
 * `CHECKRIDE_BASE` (an empty variable counts as unset). `null` when neither
 * names one, so the run falls back to the config's `changedBase`, then
 * `origin/main`, then `HEAD`. Whether the ref resolves is the run's to check.
 */
function namedBase(flag: string | undefined, deps: CliDeps): NamedBase | null {
  if (flag === '') throw new Error('--base was passed with no ref');
  if (flag !== undefined) return { ref: flag, from: '--base' };
  const variable = (deps.env ?? process.env)[BASE_ENV];
  return variable === undefined || variable === '' ? null : { ref: variable, from: BASE_ENV };
}

function asShape(value: string | undefined): Shape | undefined {
  if (value === undefined) return undefined;
  const shapes = [...new Set(Object.values(LANG_SHAPES).flat())];
  const hit = shapes.find((s) => s === value);
  if (hit === undefined) throw new Error(`invalid --shape '${value}' (expected ${shapes.join(' | ')})`);
  return hit;
}

function asLang(value: string | undefined): Lang | undefined {
  if (value === undefined) return undefined;
  if (value === 'ts' || value === 'go' || value === 'rust') return value;
  throw new Error(`invalid --lang '${value}' (expected ts | go | rust)`);
}

/**
 * Parse `--hook <a,b>` / `--remove-hook <a,b>` against the hook registry; an
 * unknown name is a usage error naming the valid set. `flag` is the one being
 * parsed, so the error points at the flag the user actually typed.
 */
function asHooks(value: string | undefined, flag = 'hook'): HookName[] | undefined {
  const names = parseList(value, flag);
  if (!names) return undefined;
  return names.map((name) => {
    const hit = HOOK_NAMES.find((h) => h === name);
    if (hit === undefined) {
      throw new Error(`invalid --${flag} '${name}' (expected ${HOOK_NAMES.join(' | ')})`);
    }
    return hit;
  });
}

/** Parse `--harness <a,b>` against the harness registry; an unknown name is a usage error. */
function asHarnesses(value: string | undefined): HarnessName[] | undefined {
  const names = parseList(value, 'harness');
  if (!names) return undefined;
  return names.map((name) => {
    const hit = HARNESS_NAMES.find((h) => h === name);
    if (hit === undefined) {
      throw new Error(`invalid --harness '${name}' (expected ${HARNESS_NAMES.join(' | ')})`);
    }
    return hit;
  });
}

/** Parse the single-valued `--harness <h>` on `gate`. */
function asHarness(value: string | undefined): HarnessName | undefined {
  const names = asHarnesses(value);
  if (!names) return undefined;
  if (names.length !== 1) {
    throw new Error(`invalid --harness '${value}' (gate answers one harness at a time)`);
  }
  return names[0];
}

/** The new-project half of `init`'s flags: what to scaffold, and the names it carries. */
function newProjectArgs(values: { lang?: string; shape?: string; module?: string; name?: string; scope?: string; license?: string; author?: string }): Partial<InitOptions> {
  const lang = asLang(values.lang);
  const shape = asShape(values.shape);
  return {
    ...(lang ? { lang } : {}),
    ...(shape ? { shape } : {}),
    ...(values.module ? { module: values.module } : {}),
    ...(values.name ? { name: values.name } : {}),
    ...(values.scope ? { scope: values.scope } : {}),
    ...(values.license ? { license: values.license } : {}),
    ...(values.author ? { author: values.author } : {}),
  };
}

/** Parse `init` arguments into init options. */
export function parseInitArgs(argv: string[]): Partial<InitOptions> {
  const { rest } = detectCommand(argv);
  const { values } = parseArgs({ args: rest, allowPositionals: true, options: INIT_OPTIONS });
  const opts: Partial<InitOptions> = newProjectArgs(values);
  if (values['dry-run']) opts.dryRun = true;
  if (values.baseline) opts.baseline = true;
  if (values['no-hook']) opts.hook = false;
  const hooks = asHooks(values.hook);
  if (hooks) opts.hooks = hooks;
  const removeHooks = asHooks(values['remove-hook'], 'remove-hook');
  if (removeHooks) {
    // Writing and removing the same hook has no coherent reading, and silently
    // picking one would leave the user's repo in the state they did not ask for.
    const both = removeHooks.filter((h) => hooks?.includes(h));
    if (both.length > 0) {
      throw new Error(`'${both.join(', ')}' named by both --hook and --remove-hook`);
    }
    opts.removeHooks = removeHooks;
  }
  const harnesses = asHarnesses(values.harness);
  if (harnesses) opts.harnesses = harnesses;
  if (values.force) opts.force = true;
  const add = parseList(values.add, 'add');
  if (add) opts.add = add;
  return opts;
}

/** The output directory `--out` or `CHECKRIDE_OUT` named, as the option a command takes, or nothing. */
function outOption(flag: string | undefined, deps: CliDeps): { out?: string } {
  const out = namedOut(deps.cwd, flag, deps.env ?? process.env);
  return out === null ? {} : { out };
}

async function dispatchRun(argv: string[], deps: CliDeps): Promise<number> {
  const { flags, config, base, out, defaults, pins } = parseCliArgs(argv);
  const named = namedConfig(config, deps);
  const changedBase = namedBase(base, deps);
  const layer = namedDefaults(defaults, deps);
  const overrides = namedPins(pins, deps);
  const result = await runChecks({
    ...flags,
    ...(named ? { config: named.config, configPath: named.path } : {}),
    ...(changedBase ? { base: changedBase } : {}),
    ...(layer ? { defaults: layer } : {}),
    ...(overrides ? { pins: overrides } : {}),
    ...outOption(out, deps),
    cwd: deps.cwd,
    stdout: deps.stdout,
    stderr: deps.stderr,
  });
  return result.exitCode;
}

async function dispatchInit(argv: string[], deps: CliDeps): Promise<number> {
  const result = await runInit({ ...parseInitArgs(argv), cwd: deps.cwd, stdout: deps.stdout });
  return result.exitCode;
}

/**
 * The config `doctor` reads: the named one, else the repo's, with the targets
 * `--discover` proposes declared in memory (R13.2), or nothing to inject when
 * neither applies, so `doctor` reads the repo's own. A config that declares
 * its own targets keeps them, and stderr names them once as the reason (D73).
 */
async function doctorConfig(discover: boolean, named: NamedConfig | null, deps: CliDeps): Promise<{ config?: CheckrideConfig | null }> {
  if (!discover) return named ? { config: named.config } : {};
  const found = await discoverRun(deps.cwd, named?.config ?? loadConfig(deps.cwd, warnOn(deps)), null);
  if (found.declared.length > 0) deps.stderr.write(`${declaredNote(found.declared)}\n`);
  return { config: found.config };
}

async function dispatchDoctor(argv: string[], deps: CliDeps): Promise<number> {
  const { flags, config, out, defaults, pins } = parseCliArgs(argv);
  const named = namedConfig(config, deps);
  const layer = namedDefaults(defaults, deps);
  const overrides = namedPins(pins, deps);
  const result = await runDoctor({
    json: flags.json ?? false,
    ...(await doctorConfig(flags.discover === true, named, deps)),
    ...(layer ? { defaults: layer.config } : {}),
    ...(overrides ? { pins: overrides } : {}),
    ...(flags.staticOnly === true ? { staticOnly: true } : {}),
    ...outOption(out, deps),
    cwd: deps.cwd,
    stdout: deps.stdout,
    stderr: deps.stderr,
  });
  return result.exitCode;
}

/**
 * Why `fix` refuses the consumer flag `parsed` carries, or `null` when it
 * carries none. Each would change which files the fixers rewrite or with
 * which tool, and a fixer writes into the repo, so each is a usage error
 * rather than a flag `fix` takes and ignores, as it does the run flags 0.14
 * accepted. The variables behind them (`CHECKRIDE_PINS`, `CHECKRIDE_DEFAULTS`,
 * `CHECKRIDE_OUT`, `CHECKRIDE_BASE`) aren't read here at all.
 */
function fixRefusal(parsed: ReturnType<typeof parseCliArgs>): string | null {
  const given: readonly (readonly [boolean, string, string])[] = [
    [parsed.flags.staticOnly === true, '--static-only', "fixers rewrite files and can load the repo's code"],
    [parsed.flags.discover === true, '--discover', 'fixers run over the targets the config declares'],
    [parsed.base !== undefined, '--base', 'fixers rewrite the repo as it stands'],
    [parsed.out !== undefined, '--out', 'fix writes no artifacts'],
    [parsed.defaults !== undefined, '--defaults', "fixers are the ones the repo's own config picks"],
    [parsed.pins !== undefined, '--pins', 'fixers run each tool the repo pins'],
  ];
  const refused = given.find(([on]) => on);
  return refused === undefined ? null : `fix doesn't take ${refused[1]}: ${refused[2]}`;
}

async function dispatchFix(argv: string[], deps: CliDeps): Promise<number> {
  const parsed = parseCliArgs(argv);
  const refusal = fixRefusal(parsed);
  if (refusal !== null) throw new Error(refusal);
  const { flags, config } = parsed;
  const named = namedConfig(config, deps);
  const result = await runFix({ ...flags, ...(named ? { config: named.config } : {}), cwd: deps.cwd, stderr: deps.stderr });
  return result.exitCode;
}

async function dispatchBaseline(argv: string[], deps: CliDeps): Promise<number> {
  const { rest } = detectCommand(argv);
  if (rest[0] === 'diff') return dispatchBaselineDiff(rest.slice(1), deps);
  // `baseline` takes only `--versions`, `--only`, `--skip`, `--config` and
  // `--out` and no positionals, so a stray flag (for example a typo) or a
  // `diff` that isn't first throws ERR_PARSE_ARGS_* → runCli's catch maps it
  // to exit 2, rather than rewriting the file. It is the repo's explicit
  // write, so it writes the baseline at the repo root wherever the config
  // lives and wherever the artifacts go.
  const { values } = parseArgs({ args: rest, options: BASELINE_OPTIONS });
  const named = namedConfig(values.config, deps);
  const only = parseList(values.only, 'only');
  const skip = parseList(values.skip, 'skip');
  const options = {
    ...(named ? { config: named.config } : {}),
    ...outOption(values.out, deps),
    ...(only !== null ? { only } : {}),
    ...(skip !== null ? { skip } : {}),
    cwd: deps.cwd,
    stdout: deps.stdout,
    stderr: deps.stderr,
  };
  const result = values.versions ? await runBaselineVersions({ ...options, ...(named ? { configPath: named.path } : {}) }) : await runBaseline(options);
  return result.exitCode;
}

/** `baseline diff [<ref>] [--json]`: at most one positional, the ref. */
async function dispatchBaselineDiff(args: string[], deps: CliDeps): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: BASELINE_DIFF_OPTIONS });
  if (positionals.length > 1) throw new Error(`baseline diff takes one ref, got ${positionals.length}: ${positionals.join(' ')}`);
  const [ref] = positionals;
  const result = await runBaselineDiff({
    cwd: deps.cwd,
    stdout: deps.stdout,
    json: values.json,
    ...(ref !== undefined ? { ref } : {}),
  });
  return result.exitCode;
}

/** `--depth <n>`; absent → the history walk uses its default. */
export function parseDepth(value: string | undefined): number | undefined {
  return parsePositiveInt(value, 'recover: invalid --depth');
}

async function dispatchRecover(argv: string[], deps: CliDeps): Promise<number> {
  const { rest } = detectCommand(argv);
  // No positionals: a stray token throws ERR_PARSE_ARGS_* → exit 2.
  const { values } = parseArgs({ args: rest, options: RECOVER_OPTIONS });
  const depth = parseDepth(values.depth);
  const result = await runRecover({
    cwd: deps.cwd,
    stdout: deps.stdout,
    stderr: deps.stderr,
    ...(values.pick !== undefined ? { pick: values.pick } : {}),
    ...(values.exact ? { exact: true } : {}),
    ...(values['dry-run'] ? { dryRun: true } : {}),
    ...(depth !== undefined ? { depth } : {}),
    ...(values.json ? { json: true } : {}),
  });
  return result.exitCode;
}

/** `target add <name> --lang <pack> --root <dir> …`: the one subcommand, the name its one positional. */
async function dispatchTarget(argv: string[], deps: CliDeps): Promise<number> {
  const { rest } = detectCommand(argv);
  if (rest[0] !== 'add') throw new Error(`target takes one subcommand, add (got ${rest[0] === undefined ? 'none' : JSON.stringify(rest[0])})`);
  const { values, positionals } = parseArgs({ args: rest.slice(1), allowPositionals: true, options: TARGET_ADD_OPTIONS });
  const [name, ...extra] = positionals;
  if (name === undefined || extra.length > 0) throw new Error(`target add takes one target name, got ${positionals.length}`);
  if (values.lang === undefined || values.root === undefined) throw new Error('target add needs --lang <pack> and --root <dir>');
  const add = parseList(values.add, 'add');
  const result = await runTargetAdd({
    cwd: deps.cwd,
    stdout: deps.stdout,
    name,
    lang: values.lang,
    root: values.root,
    ...(add !== null ? { add } : {}),
    ...(values['root-name'] !== undefined ? { rootName: values['root-name'] } : {}),
    dryRun: values['dry-run'],
  });
  return result.exitCode;
}

async function dispatchAgentSetup(argv: string[], deps: CliDeps): Promise<number> {
  const parsed = parseInitArgs(argv);
  const opts: AgentSetupOptions = { cwd: deps.cwd, stdout: deps.stdout };
  if (parsed.hook !== undefined) opts.hook = parsed.hook;
  if (parsed.hooks) opts.hooks = parsed.hooks;
  if (parsed.removeHooks) opts.removeHooks = parsed.removeHooks;
  if (parsed.harnesses) opts.harnesses = parsed.harnesses;
  if (parsed.dryRun) opts.dryRun = true;
  if (parsed.force) opts.force = true;
  const result = await runAgentSetup(opts);
  return result.exitCode;
}

/**
 * Parse `hooks <add|remove> [a,b]` into options.
 *
 * The hook names are a positional rather than a flag: the command exists to do
 * one thing to a named set, and `checkride hooks remove protect` reads the way
 * the user thinks about it. An unknown action or name is a usage error naming
 * the valid set, the same rule `--hook` follows.
 */
export function parseHooksArgs(argv: string[]): HooksOptions {
  const { rest } = detectCommand(argv);
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: HOOKS_OPTIONS });
  const [action, ...names] = positionals;
  if (action !== 'add' && action !== 'remove') {
    throw new Error(`hooks: expected 'add' or 'remove'${action === undefined ? '' : `, got '${action}'`}`);
  }
  // Only parse a list that is actually there: an empty one is not a malformed
  // `--hook`, it is "no names given", which `runHooks` answers per action.
  const hooks = names.length > 0 ? asHooks(names.join(','), 'hook') : undefined;
  const harnesses = asHarnesses(values.harness);
  return {
    action,
    ...(hooks ? { hooks } : {}),
    ...(harnesses ? { harnesses } : {}),
    ...(values['dry-run'] ? { dryRun: true } : {}),
  };
}

async function dispatchHooks(argv: string[], deps: CliDeps): Promise<number> {
  const result = await runHooks({ ...parseHooksArgs(argv), cwd: deps.cwd, stdout: deps.stdout });
  return result.exitCode;
}

async function dispatchGate(argv: string[], deps: CliDeps): Promise<number> {
  const { rest } = detectCommand(argv);
  const { values } = parseArgs({ args: rest, allowPositionals: true, options: GATE_OPTIONS });
  const harness = asHarness(values.harness);
  const result = await runGate({
    cwd: deps.cwd,
    ifDirty: values['if-dirty'],
    stdout: deps.stdout,
    stderr: deps.stderr,
    ...(harness ? { harness } : {}),
  });
  return result.exitCode;
}

/**
 * The reader commands' arguments: the optional repo-path positional, and the
 * output directory `--out` or `CHECKRIDE_OUT` named, resolved against the
 * working directory (`null` for the repo's own `.check/`).
 */
function readerArgs(argv: string[], deps: CliDeps): { cwd: string; out: string | null } {
  const { rest } = detectCommand(argv);
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: READER_OPTIONS });
  return { cwd: positionals[0] ?? deps.cwd, out: namedOut(deps.cwd, values.out, deps.env ?? process.env) };
}

async function dispatchTriage(argv: string[], deps: CliDeps): Promise<number> {
  const { cwd, out } = readerArgs(argv, deps);
  const report = await triage(cwd, realEnv, out);
  deps.stdout.write(`${renderTriage(report)}\n`);
  return 0;
}

async function dispatchQa(argv: string[], deps: CliDeps): Promise<number> {
  const { cwd, out } = readerArgs(argv, deps);
  const report = await qaExtract(cwd, Date.now, out);
  deps.stdout.write(`${renderQa(report)}\n`);
  return 0;
}

const DISPATCH: Record<string, (a: string[], d: CliDeps) => Promise<number>> = {
  run: dispatchRun,
  init: dispatchInit,
  doctor: dispatchDoctor,
  fix: dispatchFix,
  baseline: dispatchBaseline,
  recover: dispatchRecover,
  target: dispatchTarget,
  'agent-setup': dispatchAgentSetup,
  hooks: dispatchHooks,
  gate: dispatchGate,
  triage: dispatchTriage,
  qa: dispatchQa,
};

/** Every command name in the dispatch table — the truth the site currency tests assert against. */
export const CLI_COMMANDS: readonly string[] = Object.keys(DISPATCH);

/** Dispatch a CLI invocation; returns the process exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const { command } = detectCommand(argv);
  if (argv.includes('--help') || argv.includes('-h')) {
    deps.stdout.write(commandHelp(command));
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-V')) {
    deps.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  const handler = DISPATCH[command];
  if (!handler) {
    deps.stderr.write(`checkride: unknown command '${command}'.\nRun \`checkride --help\` for usage.\n`);
    return 2;
  }
  try {
    return await handler(argv, deps);
  } catch (err) {
    if (errorCode(err)?.startsWith('ERR_PARSE_ARGS')) {
      deps.stderr.write(`checkride: ${firstSentence(errorMessage(err))}\nRun \`checkride --help\` for usage.\n`);
    } else {
      deps.stderr.write(`checkride: ${errorMessage(err)}\n`);
    }
    return 2;
  }
}

/**
 * True when this module is the process entry point — invoked as a command, not
 * imported. Package managers expose the bin as a symlink
 * (`node_modules/.bin/checkride` → `../checkride/dist/cli.js`), so
 * `process.argv[1]` is the symlink path while `import.meta.url` resolves to the
 * real target. The comparison must therefore be on real, symlink-resolved
 * paths: a naive URL equality check is false through the symlink, which would
 * silently no-op `pnpm exec checkride`, `npx checkride`, and the generated
 * `pnpm check` alias — the way every consumer actually runs it.
 */
function isEntryPoint(): boolean {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) return false;
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * Die clean on Ctrl-C. Checks run in their own detached process groups (so the
 * timeout kill can reap grandchildren — see `spawnCheck`), which also means a
 * terminal's SIGINT never reaches them: without forwarding, an interrupted run
 * leaves every in-flight check tree running as orphans. Each handler reaps the
 * live registry (SIGTERM per group, SIGKILL after the grace —
 * `killLiveChecks`), then removes both handlers and re-raises, so the process
 * still dies by the signal's default disposition and the shell sees the
 * conventional 130/143 — the 0/1/2 exit contract never learns about signals.
 * `once`, so a second Ctrl-C during the grace window kills immediately instead
 * of queueing another cleanup. Installed only on the entry-point path: an
 * importing test must not have its process signals rewired.
 */
function installSignalForwarding(): void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  const forward = (signal: NodeJS.Signals): void => {
    void killLiveChecks().finally(() => {
      for (const [sig, handler] of handlers) process.removeListener(sig, handler);
      process.kill(process.pid, signal);
    });
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = (): void => { forward(signal); };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
}

if (isEntryPoint()) {
  installSignalForwarding();
  const code = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
  });
  process.exit(code);
}

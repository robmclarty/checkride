#!/usr/bin/env node
/**
 * CLI entry — arg parsing and command dispatch (the package `bin`).
 *
 * Commands: default `run`, plus `init`, `doctor`, `fix`, `baseline`,
 * `agent-setup`, `gate`, `triage` and `qa`. The command is the first non-flag
 * token; everything after it is parsed against that command's options. The
 * module is import-safe: it only executes when invoked directly, so tests can
 * import {@link runCli} without triggering a process exit.
 *
 * Exit codes: 0 pass, 1 check/verification failure, 2 orchestrator/usage error.
 * `gate` is the documented exception — it speaks a harness's hook protocol
 * rather than checkride's own split (see `./gate.ts`).
 */

import { readFileSync, realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { HOOK_NAMES, type HookName } from './agent-setup/index.js';
import { runBaseline } from './baseline-command.js';
import { runDoctor } from './doctor.js';
import { HARNESS_NAMES, type HarnessName, runGate } from './gate.js';
import type { AgentSetupOptions, InitOptions, Shape } from './init.js';
import { runAgentSetup, runInit } from './init.js';
import type { Out, RunFlags } from './orchestrator.js';
import { killLiveChecks, runChecks, runFix } from './orchestrator.js';
import { qaExtract, renderQa } from './qa/index.js';
import { realEnv, renderTriage, triage } from './triage/index.js';

/** Injected process surface, so {@link runCli} is testable. */
export type CliDeps = { cwd: string; stdout: Out; stderr: Out };

const RUN_OPTIONS = {
  bail: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  only: { type: 'string' },
  skip: { type: 'string' },
  include: { type: 'string' },
  all: { type: 'boolean', default: false },
  changed: { type: 'boolean', default: false },
  digest: { type: 'boolean', default: false },
  strict: { type: 'boolean', default: false },
  concurrency: { type: 'string' },
} as const;

const INIT_OPTIONS = {
  shape: { type: 'string' },
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

const GATE_OPTIONS = {
  'if-dirty': { type: 'boolean', default: false },
  harness: { type: 'string' },
} as const;

const HELP_TEXT = `checkride — an agent harness for TypeScript repositories

Usage: checkride [command] [options]

Commands:
  (default)        Run the checks. Exit 0 pass / 1 fail / 2 error.
  init             Set up a project (new or existing — auto-detected). Writes the
                   agent stop-gate hooks (--no-hook to skip). New mode refuses to
                   overwrite existing files (--force to override). Existing mode:
                   --baseline grandfathers current debt.
  doctor           Verify the environment and every slot's status (read-only).
  fix              Run every active adapter's fix command.
  baseline         Record current diagnostics as a committed baseline.
  agent-setup      Add the AGENTS.md stanza + agent hooks to an existing repo
                   (--hook <a,b> to select; --no-hook to skip them all;
                   --remove-hook <a,b> to tear installed ones back out;
                   --harness <a,b> to pick the harnesses; --force to refresh a
                   stanza carrying local edits).
  gate             Run the check script as a stop gate and answer in a harness's
                   hook protocol. Invoked by the generated hook scripts.
  triage           Triage a red gate: run it, then read .check/ as a bounded
                   report. Takes an optional repo path.
  qa               Read the quality artifacts (mutation, dead, dupes, health)
                   a previous run left. Takes an optional repo path.

Run options:
  --only <a,b>     Run only these slots
  --skip <a,b>     Skip these slots
  --include <a,b>  Add opt-in slots (format, dupes, health, mutation, security, publint, attw) to the run
  --all            Include every opt-in slot
  --changed        Affected-only mode (incremental)
  --bail           Stop at the first failure (sequential; overrides --concurrency)
  --concurrency <n>  Max checks running at once within a wave (default auto; 1 = sequential)
  --json           Emit the summary as JSON on stdout
  --digest         Write a capped failure excerpt to .check/digest.md
  --strict         Zero checks actually running is an error (exit 2), not a pass
  -h, --help       Show this help
  -V, --version    Show the version

Every run writes a report to .check/summary.json.
Docs: https://github.com/robmclarty/checkride#readme
`;

const INIT_HELP_TEXT = `checkride init — set up a project (new or existing, auto-detected)

Usage: checkride init [options]

New project (no package.json): scaffolds a full project. Refuses to overwrite
existing files unless --force.
Existing project: adopts detectable slots; --baseline grandfathers current debt.
Either mode refuses (exit 2) rather than overwrite an AGENTS.md stanza that has
been edited since checkride wrote it.

Options:
  --shape <s>      Project shape: flat | monorepo | hybrid (new mode; default flat)
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

Runs \`<pm> run check --strict --digest\` and reports the verdict in the calling
harness's stop-hook protocol. The generated hook scripts invoke this; you rarely
run it by hand.

Options:
  --harness <h>    Protocol to answer in (${HARNESS_NAMES.join(' | ')}; default claude)
  --if-dirty       Skip the run when .check/.dirty is absent (no edits this turn)
  -h, --help       Show this help

Exit codes differ by harness, because the harnesses differ: claude blocks on
exit 2 and reads stderr; cursor reads {"followup_message": …} on stdout and
treats any non-zero exit as a broken hook, so it always exits 0.

Docs: https://github.com/robmclarty/checkride#readme
`;

/** Per-command `--help` text, falling back to the global help. */
const COMMAND_HELP: Record<string, string> = { init: INIT_HELP_TEXT, gate: GATE_HELP_TEXT };

function commandHelp(command: string): string {
  return COMMAND_HELP[command] ?? HELP_TEXT;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The `code` property of an Error-like value (e.g. Node's `ERR_PARSE_ARGS_*`). */
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
 * Parse `--concurrency <n>` into a positive integer, or `undefined` when the flag
 * is absent (the orchestrator then picks its auto default). A non-integer or
 * `< 1` value is a usage error (surfaced as exit 2), never a silent clamp: a
 * gate that quietly ran everything at once when you asked for `1` would be the
 * kind of surprise this tool exists to prevent.
 */
function parseConcurrency(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`invalid --concurrency '${value}' (expected a positive integer)`);
  }
  return n;
}

/** The command is the first non-flag token; the rest are its arguments. */
function detectCommand(argv: string[]): { command: string; rest: string[] } {
  const first = argv[0];
  if (first !== undefined && !first.startsWith('-')) {
    return { command: first, rest: argv.slice(1) };
  }
  return { command: 'run', rest: argv };
}

/** Parse argv into a command name and the run flags. */
export function parseCliArgs(argv: string[]): { command: string; flags: RunFlags } {
  const { command, rest } = detectCommand(argv);
  const { values } = parseArgs({ args: rest, allowPositionals: true, options: RUN_OPTIONS });
  const concurrency = parseConcurrency(values.concurrency);
  const flags: RunFlags = {
    bail: values.bail,
    json: values.json,
    all: values.all,
    changed: values.changed,
    digest: values.digest,
    strict: values.strict,
    only: parseList(values.only, 'only'),
    skip: parseList(values.skip, 'skip'),
    include: parseList(values.include, 'include'),
    // Omitted when absent, so the orchestrator's auto default applies (exact
    // optional types: an explicit `undefined` is not the same as absent).
    ...(concurrency !== undefined ? { concurrency } : {}),
  };
  return { command, flags };
}

function asShape(value: string | undefined): Shape | undefined {
  if (value === undefined) return undefined;
  if (value === 'flat' || value === 'monorepo' || value === 'hybrid') return value;
  throw new Error(`invalid --shape '${value}' (expected flat | monorepo | hybrid)`);
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

/** Parse `init` arguments into init options. */
export function parseInitArgs(argv: string[]): Partial<InitOptions> {
  const { rest } = detectCommand(argv);
  const { values } = parseArgs({ args: rest, allowPositionals: true, options: INIT_OPTIONS });
  const opts: Partial<InitOptions> = {};
  const shape = asShape(values.shape);
  if (shape) opts.shape = shape;
  if (values.name) opts.name = values.name;
  if (values.scope) opts.scope = values.scope;
  if (values.license) opts.license = values.license;
  if (values.author) opts.author = values.author;
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

async function dispatchRun(argv: string[], deps: CliDeps): Promise<number> {
  const { flags } = parseCliArgs(argv);
  const result = await runChecks({ ...flags, cwd: deps.cwd, stdout: deps.stdout, stderr: deps.stderr });
  return result.exitCode;
}

async function dispatchInit(argv: string[], deps: CliDeps): Promise<number> {
  const result = await runInit({ ...parseInitArgs(argv), cwd: deps.cwd, stdout: deps.stdout });
  return result.exitCode;
}

async function dispatchDoctor(argv: string[], deps: CliDeps): Promise<number> {
  const { flags } = parseCliArgs(argv);
  const result = await runDoctor({ json: flags.json ?? false, cwd: deps.cwd, stdout: deps.stdout });
  return result.exitCode;
}

async function dispatchFix(argv: string[], deps: CliDeps): Promise<number> {
  const { flags } = parseCliArgs(argv);
  const result = await runFix({ ...flags, cwd: deps.cwd, stderr: deps.stderr });
  return result.exitCode;
}

async function dispatchBaseline(argv: string[], deps: CliDeps): Promise<number> {
  // `baseline` takes no options; parse against an empty set so a stray flag
  // (e.g. a typo) throws ERR_PARSE_ARGS_* → runCli's catch maps it to exit 2.
  const { rest } = detectCommand(argv);
  parseArgs({ args: rest, allowPositionals: true, options: {} });
  const result = await runBaseline({ cwd: deps.cwd, stdout: deps.stdout, stderr: deps.stderr });
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

/** The optional repo-path positional the reader commands take. */
function readerCwd(argv: string[], deps: CliDeps): string {
  const { rest } = detectCommand(argv);
  const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
  return positionals[0] ?? deps.cwd;
}

async function dispatchTriage(argv: string[], deps: CliDeps): Promise<number> {
  const report = await triage(readerCwd(argv, deps), realEnv);
  deps.stdout.write(`${renderTriage(report)}\n`);
  return 0;
}

async function dispatchQa(argv: string[], deps: CliDeps): Promise<number> {
  const report = await qaExtract(readerCwd(argv, deps));
  deps.stdout.write(`${renderQa(report)}\n`);
  return 0;
}

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

  const dispatch: Record<string, (a: string[], d: CliDeps) => Promise<number>> = {
    run: dispatchRun,
    init: dispatchInit,
    doctor: dispatchDoctor,
    fix: dispatchFix,
    baseline: dispatchBaseline,
    'agent-setup': dispatchAgentSetup,
    gate: dispatchGate,
    triage: dispatchTriage,
    qa: dispatchQa,
  };
  const handler = dispatch[command];
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
  });
  process.exit(code);
}

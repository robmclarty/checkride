#!/usr/bin/env node
/**
 * CLI entry — arg parsing and command dispatch (the package `bin`).
 *
 * Commands: default `run`, plus `init`, `doctor`, and `fix`. The command is the
 * first non-flag token; everything after it is parsed against that command's
 * options. The module is import-safe: it only executes when invoked directly,
 * so tests can import {@link runCli} without triggering a process exit.
 *
 * Exit codes: 0 pass, 1 check/verification failure, 2 orchestrator/usage error.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { runBaseline } from './baseline/index.js';
import { runDoctor } from './doctor.js';
import type { AgentSetupOptions, InitOptions, Shape } from './init.js';
import { runAgentSetup, runInit } from './init.js';
import type { Out, RunFlags } from './orchestrator.js';
import { runChecks, runFix } from './orchestrator.js';

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
  'no-hook': { type: 'boolean', default: false },
} as const;

const HELP_TEXT = `checkride — an agent harness for TypeScript repositories

Usage: checkride [command] [options]

Commands:
  (default)        Run the checks. Exit 0 pass / 1 fail / 2 error.
  init             Set up a project (new or existing — auto-detected). Writes a
                   Claude Code Stop hook (--no-hook to skip). Existing mode:
                   --baseline grandfathers current debt.
  doctor           Verify the environment and every slot's status (read-only).
  fix              Run every active adapter's fix command.
  baseline         Record current diagnostics as a committed baseline.
  agent-setup      Add the AGENTS.md stanza + Claude Code Stop hook to an
                   existing repo (--no-hook to skip the hook).

Run options:
  --only <a,b>     Run only these slots
  --skip <a,b>     Skip these slots
  --include <a,b>  Add opt-in slots (format, mutation, security) to the run
  --all            Include every opt-in slot
  --changed        Affected-only mode (incremental)
  --bail           Stop at the first failure
  --json           Emit the summary as JSON on stdout
  --digest         Write a capped failure excerpt to .check/digest.md
  --strict         Zero checks actually running is an error (exit 2), not a pass
  -h, --help       Show this help
  -V, --version    Show the version

Every run writes a report to .check/summary.json.
Docs: https://github.com/robmclarty/checkride#readme
`;

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

function parseList(value: string | undefined): string[] | null {
  if (!value) return null;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
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
  const flags: RunFlags = {
    bail: values.bail,
    json: values.json,
    all: values.all,
    changed: values.changed,
    digest: values.digest,
    strict: values.strict,
    only: parseList(values.only),
    skip: parseList(values.skip),
    include: parseList(values.include),
  };
  return { command, flags };
}

function asShape(value: string | undefined): Shape | undefined {
  if (value === undefined) return undefined;
  if (value === 'flat' || value === 'monorepo' || value === 'hybrid') return value;
  throw new Error(`invalid --shape '${value}' (expected flat | monorepo | hybrid)`);
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
  const add = parseList(values.add);
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

async function dispatchBaseline(_argv: string[], deps: CliDeps): Promise<number> {
  const result = await runBaseline({ cwd: deps.cwd, stdout: deps.stdout, stderr: deps.stderr });
  return result.exitCode;
}

async function dispatchAgentSetup(argv: string[], deps: CliDeps): Promise<number> {
  const parsed = parseInitArgs(argv);
  const opts: AgentSetupOptions = { cwd: deps.cwd, stdout: deps.stdout };
  if (parsed.hook !== undefined) opts.hook = parsed.hook;
  if (parsed.dryRun) opts.dryRun = true;
  const result = await runAgentSetup(opts);
  return result.exitCode;
}

/** Dispatch a CLI invocation; returns the process exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    deps.stdout.write(HELP_TEXT);
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-V')) {
    deps.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  const { command } = detectCommand(argv);
  const dispatch: Record<string, (a: string[], d: CliDeps) => Promise<number>> = {
    run: dispatchRun,
    init: dispatchInit,
    doctor: dispatchDoctor,
    fix: dispatchFix,
    baseline: dispatchBaseline,
    'agent-setup': dispatchAgentSetup,
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

if (isEntryPoint()) {
  const code = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exit(code);
}

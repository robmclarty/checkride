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

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { runDoctor } from '../doctor/index.js';
import type { InitOptions, Shape } from '../init/index.js';
import { runInit } from '../init/index.js';
import type { Out, RunFlags } from '../orchestrator/index.js';
import { runChecks, runFix } from '../orchestrator/index.js';

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
} as const;

const INIT_OPTIONS = {
  shape: { type: 'string' },
  name: { type: 'string' },
  scope: { type: 'string' },
  license: { type: 'string' },
  author: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  add: { type: 'string' },
} as const;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/** Dispatch a CLI invocation; returns the process exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const { command } = detectCommand(argv);
  const dispatch: Record<string, (a: string[], d: CliDeps) => Promise<number>> = {
    run: dispatchRun,
    init: dispatchInit,
    doctor: dispatchDoctor,
    fix: dispatchFix,
  };
  const handler = dispatch[command];
  if (!handler) {
    deps.stderr.write(`checkride: unknown command '${command}'.\n`);
    return 2;
  }
  try {
    return await handler(argv, deps);
  } catch (err) {
    deps.stderr.write(`checkride: ${errorMessage(err)}\n`);
    return 2;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const code = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exit(code);
}

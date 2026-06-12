#!/usr/bin/env node
/**
 * CLI entry — arg parsing and command dispatch (the package `bin`).
 *
 * Phase 1 implements the default `run` command (flags ported from the interim
 * `scripts/check.mjs`). `init`, `doctor`, and `fix` are stubbed until their
 * phases. The module is import-safe: it only runs when invoked directly, so
 * tests can import {@link runCli} without triggering a process exit.
 *
 * Exit codes: 0 pass, 1 check failure, 2 orchestrator/usage error.
 */

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import type { Out, RunFlags } from '../orchestrator/index.js';
import { runChecks } from '../orchestrator/index.js';

/** Injected process surface, so {@link runCli} is testable. */
export type CliDeps = { cwd: string; stdout: Out; stderr: Out };

const STUB_COMMANDS = new Set(['init', 'doctor', 'fix']);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorStack(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

function parseList(value: string | undefined): string[] | null {
  if (!value) return null;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Parse argv into a command name and the run flags. */
export function parseCliArgs(argv: string[]): { command: string; flags: RunFlags } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      bail: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      only: { type: 'string' },
      skip: { type: 'string' },
      include: { type: 'string' },
      all: { type: 'boolean', default: false },
      changed: { type: 'boolean', default: false },
    },
  });
  const command = positionals[0] ?? 'run';
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

/** Dispatch a CLI invocation; returns the process exit code. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  let parsed: { command: string; flags: RunFlags };
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    deps.stderr.write(`checkride: ${errorMessage(err)}\n`);
    return 2;
  }

  const { command, flags } = parsed;
  if (STUB_COMMANDS.has(command)) {
    deps.stderr.write(`checkride ${command}: not implemented until a later phase.\n`);
    return 2;
  }
  if (command !== 'run') {
    deps.stderr.write(`checkride: unknown command '${command}'.\n`);
    return 2;
  }

  try {
    const result = await runChecks({
      ...flags,
      cwd: deps.cwd,
      stdout: deps.stdout,
      stderr: deps.stderr,
    });
    return result.exitCode;
  } catch (err) {
    deps.stderr.write(`orchestrator error: ${errorStack(err)}\n`);
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

/**
 * Toolchain gating for the e2e suite (D42 toolchain-tests).
 *
 * A pack's e2e cases need that pack's real tools, and a laptop may lack some
 * of them. Each case group asks `describeWithToolchain(<pack>)` for its
 * `describe`: every tool runs, so the cases run; one is missing, so they skip
 * with the reason on stderr. Under `CHECKRIDE_REQUIRE_TOOLCHAINS=1`, which CI
 * sets after installing the root `mise.toml`, a missing tool throws instead,
 * so a broken install can't pass as a skip.
 *
 * Each probe runs from the OS temp directory, where the e2e cases run their
 * copies: a mise shim that resolves here but not there would otherwise count
 * as present and fail every case it gates. A failed probe's own line rides
 * along in the reason, so a CI log says why a tool didn't run without a rerun.
 */

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';

import { describe } from 'vitest';

/** One tool a pack's e2e cases spawn, keyed to its `[tools]` entry in `mise.toml`. */
type Tool = {
  readonly name: string;
  readonly mise: string;
  readonly probe: readonly [string, ...string[]];
};

/** What each pack's e2e cases need on `PATH`; the `ts` pack needs only Node. */
export const TOOLCHAINS = {
  bash: [
    { name: 'shellcheck', mise: 'shellcheck', probe: ['shellcheck', '--version'] },
    { name: 'shfmt', mise: 'shfmt', probe: ['shfmt', '--version'] },
  ],
  go: [
    { name: 'go', mise: 'go', probe: ['go', 'version'] },
    { name: 'golangci-lint', mise: 'golangci-lint', probe: ['golangci-lint', '--version'] },
  ],
  rust: [
    { name: 'cargo clippy', mise: 'rust', probe: ['cargo', 'clippy', '--version'] },
    { name: 'cargo fmt', mise: 'rust', probe: ['cargo', 'fmt', '--version'] },
    { name: 'cargo-machete', mise: 'ubi:bnjbvr/cargo-machete', probe: ['cargo-machete', '--version'] },
    { name: 'cargo nextest', mise: 'aqua:nextest-rs/nextest/cargo-nextest', probe: ['cargo', 'nextest', '--version'] },
  ],
  python: [
    { name: 'python3', mise: 'python', probe: ['python3', '--version'] },
    { name: 'uv', mise: 'uv', probe: ['uv', '--version'] },
  ],
  terraform: [
    { name: 'tofu', mise: 'opentofu', probe: ['tofu', 'version'] },
    { name: 'tflint', mise: 'tflint', probe: ['tflint', '--version'] },
    { name: 'trivy', mise: 'trivy', probe: ['trivy', '--version'] },
  ],
  // The repo-scope slots' Node-free alternates.
  repo: [
    { name: 'typos', mise: 'typos', probe: ['typos', '--version'] },
    { name: 'rumdl', mise: 'rumdl', probe: ['rumdl', '--version'] },
    { name: 'vale', mise: 'vale', probe: ['vale', '--version'] },
    { name: 'ast-grep', mise: 'ast-grep', probe: ['ast-grep', '--version'] },
  ],
} as const satisfies Record<string, readonly Tool[]>;

type Toolchain = keyof typeof TOOLCHAINS;

type GateOptions = {
  /** Read for `CHECKRIDE_REQUIRE_TOOLCHAINS`; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** `true` when a probe exits 0, else `false` or the line that says why; defaults to {@link spawnProbe}. */
  readonly runs?: (probe: Tool['probe']) => Outcome;
};

/** A probe's result: `true` when it runs, else `false` or the line that says why it didn't. */
type Outcome = boolean | string;

type Gate = { readonly run: true } | { readonly run: false; readonly reason: string };

const probed = new Map<string, Outcome>();

/**
 * Why a probe failed, in one line: the spawn's own error, else the first line
 * of its output that names an error, since a warning or a hint can come
 * before or after it, else its first line, else how it ended.
 */
function failure({ error, status, signal, stdout, stderr }: SpawnSyncReturns<string>): string {
  if (error) return 'code' in error && error.code === 'ENOENT' ? 'not found' : error.message;
  const lines = stripVTControlCharacters(`${stderr}\n${stdout}`).split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /error/i.test(line)) ?? lines[0] ?? `exited ${status ?? signal}`;
}

/** Run a probe from the temp directory, once per command: `true` when it exits 0, else why it didn't. */
export function spawnProbe([bin, ...args]: Tool['probe']): Outcome {
  const key = [bin, ...args].join(' ');
  const cached = probed.get(key);
  if (cached !== undefined) return cached;
  const result = spawnSync(bin, args, { cwd: tmpdir(), encoding: 'utf8', timeout: 30_000 });
  const outcome = result.status === 0 || failure(result);
  probed.set(key, outcome);
  return outcome;
}

/** The tools that didn't run, then each probe's line for why, where it gave one. */
function missingText(failed: readonly { readonly tool: Tool; readonly outcome: Outcome }[]): string {
  const names = `${failed.map(({ tool }) => tool.name).join(', ')} not found or not runnable`;
  const why = failed.flatMap(({ tool, outcome }) => (typeof outcome === 'string' ? [`${tool.probe.join(' ')}: ${outcome}`] : []));
  return why.length === 0 ? names : `${names} (${why.join('; ')})`;
}

/** Decide whether a pack's e2e cases run, skip, or (under the require flag) fail. */
export function toolchainGate(toolchain: Toolchain, options: GateOptions = {}): Gate {
  const { env = process.env, runs = spawnProbe } = options;
  const tools: readonly Tool[] = TOOLCHAINS[toolchain];
  const failed = tools.map((tool) => ({ tool, outcome: runs(tool.probe) })).filter(({ outcome }) => outcome !== true);
  if (failed.length === 0) return { run: true };

  const what = missingText(failed);
  const fix = 'run `mise install`, then `mise exec -- pnpm test:e2e`';
  if (env['CHECKRIDE_REQUIRE_TOOLCHAINS'] === '1') {
    throw new Error(`CHECKRIDE_REQUIRE_TOOLCHAINS=1 and the ${toolchain} toolchain is incomplete: ${what}; ${fix}`);
  }
  return { run: false, reason: `${what} (${fix}, or set CHECKRIDE_REQUIRE_TOOLCHAINS=1 to fail instead)` };
}

/** `describe` when the pack's tools all run, else `describe.skip` with the reason on stderr. */
export function describeWithToolchain(toolchain: Toolchain, options: GateOptions = {}) {
  const gate = toolchainGate(toolchain, options);
  if (gate.run) return describe;
  console.warn(`skipping the ${toolchain} e2e cases: ${gate.reason}`);
  return describe.skip;
}

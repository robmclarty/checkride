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
 * as present and fail every case it gates.
 */

import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

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
  /** Whether a probe exits 0; defaults to spawning it from the temp directory. */
  readonly runs?: (probe: Tool['probe']) => boolean;
};

type Gate = { readonly run: true } | { readonly run: false; readonly reason: string };

const probed = new Map<string, boolean>();

function spawnProbe([bin, ...args]: Tool['probe']): boolean {
  const key = [bin, ...args].join(' ');
  const cached = probed.get(key);
  if (cached !== undefined) return cached;
  const ok = spawnSync(bin, args, { cwd: tmpdir(), stdio: 'ignore', timeout: 30_000 }).status === 0;
  probed.set(key, ok);
  return ok;
}

/** Decide whether a pack's e2e cases run, skip, or (under the require flag) fail. */
export function toolchainGate(toolchain: Toolchain, options: GateOptions = {}): Gate {
  const { env = process.env, runs = spawnProbe } = options;
  const tools: readonly Tool[] = TOOLCHAINS[toolchain];
  const missing = tools.filter((tool) => !runs(tool.probe)).map((tool) => tool.name);
  if (missing.length === 0) return { run: true };

  const what = `${missing.join(', ')} not found or not runnable`;
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

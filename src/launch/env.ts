/**
 * The spawn environment a check runs with (R6.4): the variables its pack sets
 * over the user's own, so no launcher downloads a toolchain, a module or a
 * crate on a check's behalf (D14). A pack's variables apply to every check of
 * that pack that spawns, a target's custom checks included, and they come from
 * the pack's own data in `PACKS`, so a new pack is a new row here, not a new
 * branch.
 *
 * A check whose tool needs the network, an advisory scan, runs without the
 * variables that block downloads and keeps the rest. And when a tool fails
 * because one of those variables stopped it, the message it prints names the
 * variable but not the way out, so a red check gets one line that does.
 */

import { PACKS } from '../packs/index.js';

/**
 * The variables that stop a tool reaching the network, which a check whose
 * adapter is marked `network: true` runs without. The others a pack sets, the
 * ones that pin a toolchain or switch off an install, it keeps.
 */
const NETWORK_BLOCKING: ReadonlySet<string> = new Set(['GOPROXY', 'CARGO_NET_OFFLINE', 'PIP_NO_INDEX', 'UV_OFFLINE']);

/**
 * The variables a check of `pack` spawns with, over the user's own: the
 * pack's `env`, less the network-blocking ones when `network` is set. A check
 * with no pack, every check in a repo without targets, sets none.
 */
export function packEnv(pack: string | undefined, network = false): Readonly<Record<string, string>> {
  const env = (pack === undefined ? undefined : Object.values(PACKS).find((p) => p.name === pack)?.env) ?? {};
  return network ? Object.fromEntries(Object.entries(env).filter(([name]) => !NETWORK_BLOCKING.has(name))) : env;
}

/**
 * What a tool prints when a piece of its setup is missing, and the line a red
 * check prints beneath its status to say what to do, from what the message
 * matched. The tool's own message names the variable that blocked a download,
 * or the missing piece, not the command that provides it.
 */
const SETUP_HINTS: readonly { printed: RegExp; hint: (match: RegExpExecArray) => string }[] = [
  {
    // Go 1.27.2, a module missing from the module cache under GOPROXY=off.
    printed: /module lookup disabled by GOPROXY=off/,
    hint: () => 'a Go module is missing from the module cache, and checks never download one: run `go mod download` first',
  },
  {
    // rustup 1.29.1, under RUSTUP_AUTO_INSTALL=0, names the toolchain with its host.
    printed: /toolchain '([^']+)' is not installed/,
    hint: ([, toolchain = '']) => `the toolchain the repo pins isn't installed, and checks never install one: run \`rustup toolchain install ${toolchain}\` first`,
  },
  {
    // cargo 1.99.0, a crate missing from cargo's cache under CARGO_NET_OFFLINE.
    printed: /offline mode \(via `--offline`\)/,
    hint: () => "a crate is missing from cargo's cache, and checks never fetch one: run `cargo fetch` first",
  },
  {
    // uv 0.13.1, a `uv run` or `uv sync` that needs a package its cache lacks, under UV_OFFLINE.
    printed: /Network connectivity is disabled, but the requested data wasn't found in the cache/,
    hint: () => "a Python package is missing from uv's cache, and checks never download one: run `uv sync` first",
  },
  {
    // oxlint 1.87.0, type-aware (`--type-aware`, or `options.typeAware` in its config) with no tsgolint to run.
    printed: /Failed to find tsgolint executable/,
    hint: () =>
      "oxlint's type-aware rules need the oxlint-tsgolint package: install it, or turn type-aware linting off (`--type-aware` in the check's args, `options.typeAware` in .oxlintrc.json)",
  },
];

/**
 * The line a failed check prints to say what to do before it can pass, when
 * its output shows a piece of its setup missing, a variable that blocks
 * downloads among them, or `null`. The raw output is left as the tool wrote
 * it; this only reads it.
 */
export function setupHint(outcome: { stdout: string; stderr: string }): string | null {
  for (const { printed, hint } of SETUP_HINTS) {
    const match = printed.exec(outcome.stderr) ?? printed.exec(outcome.stdout);
    if (match !== null) return hint(match);
  }
  return null;
}

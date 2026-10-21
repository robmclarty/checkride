/**
 * The toolchain a check runs on, and the version a run records for it
 * (R6.3): the executable every check of a pack runs on, `go` for the go pack,
 * whose release each such check records beside its own tool's as
 * `toolchain_version`. A tool's findings can move with its toolchain:
 * golangci-lint compiles its type checker and gofmt in, and go/packages runs
 * the `go` it finds, so a Nix bump that rebuilds golangci-lint on a newer Go
 * under the same name, or a new Go minor that deprecates stdlib API, re-keys
 * findings while the tool's own version stands still.
 *
 * The version comes from what the launch already knows, never from running
 * the toolchain, in this order: the version the launch's own pin source named,
 * when the check spawns the toolchain itself (`go vet` through mise, a Nix
 * shell or `--pins`); the version of the `go` a `go.mod` tool runs through,
 * which the launch carries; for any other tool mise runs, the `go` mise
 * resolves, since `mise exec` puts its copy first on the tool's `PATH`, which
 * costs one spawn; and otherwise the `VERSION` file of the `go` the spawn's
 * `PATH` finds.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Tool } from '../packs/index.js';
import { GO_TOOLCHAIN, PACKS, TOOLCHAINS } from '../packs/index.js';
import { miseCanRun, miseVersion } from './mise.js';
import { findOnPath } from './path.js';
import type { Launch, LaunchContext, Spawn } from './resolve.js';
import { launchCheck } from './resolve.js';

/** The toolchain `pack` runs every check on, by its executable, or `undefined` for no pack or a pack that names none. */
export function packToolchain(pack: string | undefined): string | undefined {
  return pack === undefined ? undefined : Object.values(PACKS).find((p) => p.name === pack)?.toolchain;
}

/**
 * The first line Go writes in `$GOROOT/VERSION`, with the release after its
 * `go`: `go1.26.1`, or a release candidate's `go1.27rc1`. A development
 * build's `devel …` names none.
 */
const GO_VERSION_LINE = /^go(\d+\.\d+\S*)$/;

/**
 * The release of the Go toolchain whose executable `bin` is, `go` or `gofmt`,
 * read from the `VERSION` file at its GOROOT, two directories above the file
 * `bin` resolves to: Homebrew's `libexec/bin/go`, mise's `<version>/bin/go`,
 * or a Nix store's `share/go/bin/go`, which its `bin/go` links to. A mise shim
 * resolves to the mise binary, beside no such file, so it records none.
 */
export function goRootVersion(bin: string): string | undefined {
  try {
    const goroot = dirname(dirname(realpathSync(bin)));
    const first = readFileSync(join(goroot, 'VERSION'), 'utf8').split('\n')[0]?.trim() ?? '';
    return GO_VERSION_LINE.exec(first)?.[1];
  } catch {
    return undefined;
  }
}

/** How each toolchain's release is read off the copy of it a `PATH` holds, by the toolchain's executable. */
const INSTALLED_RELEASE: ReadonlyMap<string, (bin: string) => string | undefined> = new Map([[GO_TOOLCHAIN.bin, goRootVersion]]);

/** Where a launch's toolchain release is looked for: the check's own command, the toolchain, and the directory and environment the check launches from. */
type ToolchainQuery = { command: string; toolchain: Tool; cwd: string; env: Readonly<Record<string, string | undefined>> };

/**
 * Whether `command` is the toolchain's own, `go` or the `gofmt` that ships
 * with it, which resolves through the toolchain's pin, as their shared mise
 * ids say, so the launch's pin is the toolchain's.
 */
function runsToolchain(command: string, toolchain: Tool): boolean {
  const ran = TOOLCHAINS.find((t) => t.bin === command);
  return ran !== undefined && ran.mise?.[0] !== undefined && ran.mise[0] === toolchain.mise?.[0];
}

/** The environment a spawn runs in: the one it launched from, under the variables the launch sets. */
function spawnEnv(launch: Spawn, env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>> {
  return { ...env, ...launch.env };
}

/** The release of `exe`, the toolchain's own executable or the toolchain itself, that `env`'s `PATH` finds, read off its install. */
function installedRelease(exe: string, toolchain: Tool, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const found = findOnPath(exe, env);
  return found === null ? undefined : INSTALLED_RELEASE.get(toolchain.bin)?.(found);
}

/** The release of the toolchain mise resolves for `cwd`, asked as the `mise` source asks it, or `undefined` when mise has none. */
function miseRelease(toolchain: Tool, cwd: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const mise = findOnPath('mise', env);
  const answer = mise === null ? null : miseCanRun(mise, toolchain.bin, cwd, env);
  return answer?.ok === true ? miseVersion(answer) : undefined;
}

/**
 * The release of the toolchain `at.toolchain` that `launch` runs on, or
 * `undefined` where none can be found: the launch's own version when the
 * check spawns the toolchain itself, the toolchain release the launch carries
 * for a tool it runs through, mise's answer for any other tool mise runs, and
 * otherwise the release the spawn's `PATH` finds.
 */
function toolchainRelease(launch: Spawn, at: ToolchainQuery): string | undefined {
  const env = spawnEnv(launch, at.env);
  if (runsToolchain(at.command, at.toolchain)) return launch.pin?.version ?? installedRelease(at.command, at.toolchain, env);
  if (launch.pin?.toolchain !== undefined) return launch.pin.toolchain;
  const viaMise = launch.command === 'mise' ? miseRelease(at.toolchain, at.cwd, env) : undefined;
  return viaMise ?? installedRelease(at.toolchain.bin, at.toolchain, env);
}

/**
 * Launch a check as {@link launchCheck} does, and record on its spawn's pin,
 * as `toolchain`, the release of the toolchain `ctx.toolchain` names that the
 * check's tool runs on. A refusal, a command spawned as written through no pin
 * source, and a context that names no toolchain launch as they would, and so
 * does a spawn whose toolchain release can't be found.
 */
export function launchOnToolchain(slot: string, command: string, args: readonly string[], ctx: LaunchContext): Launch {
  const launch = launchCheck(slot, command, args, ctx);
  const toolchain = TOOLCHAINS.find((t) => t.bin === ctx.toolchain);
  if (toolchain === undefined || 'refusal' in launch || launch.pin === undefined) return launch;
  const release = toolchainRelease(launch, { command, toolchain, cwd: ctx.cwd, env: ctx.env ?? process.env });
  return release === undefined ? launch : { ...launch, pin: { ...launch.pin, toolchain: release } };
}

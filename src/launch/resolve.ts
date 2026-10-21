/**
 * The launcher: the argv a check spawns, built from the invocation its adapter
 * row or custom check declares, through its pack's pin chain (R6).
 *
 * A canonical `pnpm exec <tool> …` names a tool, and the chain decides which
 * copy of it runs. The first source that declares the tool runs it, and when
 * that source can't, the check fails rather than reach for another copy: a
 * declared pin is an input to the verdict, and a quiet substitute would make
 * the verdict depend on the machine (D12). A chain that ends in `path` runs a
 * tool nothing declared from `PATH`, unpinned, and `requirePins` fails it
 * instead. A chain without `path` lets its last source run what no earlier one
 * declared, which is how `[js-lockfile]` keeps 0.13's behavior exactly.
 *
 * Any other `pnpm …` is a package-manager subcommand (`run`, `audit`, `pack`)
 * that the `js-lockfile` source translates for the detected manager. A
 * toolchain's own executable, such as `go` or `gofmt`, resolves through the
 * toolchain's pin in a chain that reads `mise`. Anything else, such as a
 * custom check's own `node scripts/x.mjs`, spawns as written, through no pin
 * source.
 */

import { dirname, isAbsolute, relative } from 'node:path';

import { isInside } from '../artifacts/index.js';
import type { PinSourceName, Tool } from '../packs/index.js';
import { CARGO_TOOLCHAIN, GO_TOOLCHAIN, PACKS, TERRAFORM_TOOLCHAIN, TOOLCHAINS, TOOLS } from '../packs/index.js';
import type { GoModDeclaration } from './go-mod.js';
import { goModDeclaration } from './go-mod.js';
import { execTool, jsLockfileDeclares, jsLockfileVersion, missingToolRefusal } from './js-lockfile.js';
import type { MiseAnswer, MiseDeclaration } from './mise.js';
import { MISE_NO_INSTALL, miseCanRun, miseDeclaration, miseHasInstalled, overrideEnv } from './mise.js';
import { nixCopy } from './nix.js';
import type { PackageManager } from './package-manager.js';
import { findOnPath } from './path.js';
import type { RustToolchainDeclaration } from './rust-toolchain.js';
import { isExactChannel, rustToolchainDeclaration, rustupCargo, toolchainFileEnv } from './rust-toolchain.js';
import type { TfVersionDeclaration } from './terraform.js';
import { cliVersion, terraformCli, tfVersionDeclaration } from './terraform.js';
import { translateExec } from './translate.js';
import type { UvLockDeclaration } from './uv.js';
import { environmentTool, projectEnvironment, uvLockDeclaration } from './uv.js';

/**
 * A process to start: the executable, its arguments, the variables it sets
 * over the inherited environment, and the pin it resolved through, with the
 * version a file read found for it (R6.3). A command spawned as written
 * resolved through none.
 */
export type Spawn = {
  command: string;
  args: string[];
  env?: Readonly<Record<string, string>>;
  pin?: { source: PinSourceName; version?: string };
};

/**
 * What a check launches as: the process to spawn, or the message it fails with
 * instead, because the source it resolves through won't run it here.
 */
export type Launch = Spawn | { refusal: string };

/** Where a check launches from, and the rules its tool resolves by. */
export type LaunchContext = {
  /** The directory the check runs from. */
  cwd: string;
  /** The package manager the `js-lockfile` source runs tools under. */
  pm: PackageManager;
  /** The repo root, where every upward search stops. Omitted, `cwd` is the only directory searched. */
  repo?: string;
  /** The pin chain the tool resolves through. Omitted, the `js-lockfile` source alone. */
  pins?: readonly PinSourceName[];
  /**
   * The `--pins` file's tools, by mise id, each with its version (R13.3),
   * which the `override` source at the head of `pins` reads. Omitted, it
   * declares nothing.
   */
  overrides?: ReadonlyMap<string, string>;
  /** Fail a tool that resolves from `PATH` with no pin, instead of running it. */
  requirePins?: boolean;
  /** The environment whose `PATH` is searched. Omitted, this process's own. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The variables the check's pack sets over the user's own (R6.4), which every spawn it launches carries. */
  packEnv?: Readonly<Record<string, string>>;
  /** The tool rows a tool is looked up in: `TOOLS` unless a test swaps it. */
  tools?: readonly Tool[];
  /**
   * A `--static-only` run (R13.4): the `js-lockfile` source refuses a tool
   * missing from `node_modules/.bin` under every package manager, so its check
   * skips as one that needs an install, rather than spawn a launcher that fails.
   */
  staticOnly?: boolean;
};

/**
 * The chain a check outside every pack resolves through, which is every check
 * in implicit `ts` mode: the project's package manager alone, as in 0.13
 * (R5.3, R5.4).
 */
const IMPLICIT_CHAIN: readonly PinSourceName[] = ['js-lockfile'];

/**
 * The pin chain a check's tool resolves through: its pack's, read from
 * `PACKS`, or the implicit chain for a check with no pack, which is every check
 * in implicit mode.
 */
export function pinChain(pack: string | undefined): readonly PinSourceName[] {
  if (pack === undefined) return IMPLICIT_CHAIN;
  return Object.values(PACKS).find((p) => p.name === pack)?.pins ?? IMPLICIT_CHAIN;
}

/** One tool to resolve, with everything a source reads to decide and to run it. */
type ToolRequest = {
  slot: string;
  tool: Tool;
  /** The tool's own arguments, after `pnpm exec <tool>`. */
  args: readonly string[];
  cwd: string;
  repo: string;
  pm: PackageManager;
  chain: readonly PinSourceName[];
  requirePins: boolean;
  env: Readonly<Record<string, string | undefined>>;
  overrides: ReadonlyMap<string, string>;
  staticOnly: boolean;
};

/**
 * What declared a tool, for a refusal or detection to name: the mise config
 * and key, the `go.mod` and its version, the toolchain file and its channel,
 * the `uv.lock` and the version it locks, or the Terraform version file and
 * the release it names.
 */
type Declared = {
  mise?: MiseDeclaration;
  goMod?: GoModDeclaration;
  toolchain?: RustToolchainDeclaration;
  uvLock?: UvLockDeclaration;
  tfVersion?: TfVersionDeclaration;
  override?: Override;
};

/** A tool the `--pins` file pins: the key that names it, and the version. */
type Override = { id: string; version: string };

/** The pin the `--pins` file gives `tool`, under the first of its mise ids the file names, or `null`. */
function overrideOf(req: ToolRequest, tool: Tool): Override | null {
  const id = (tool.mise ?? [tool.bin]).find((candidate) => req.overrides.has(candidate));
  const version = id === undefined ? undefined : req.overrides.get(id);
  return id === undefined || version === undefined ? null : { id, version };
}

/**
 * Run `argv` as the copy of `req.tool` the `--pins` file pins, `mise exec
 * <id>@<version> -- <argv>`, offline, with installs off and no config file
 * inside the repo read (D83), once `mise where` says that version is
 * installed (F38). `mise exec` alone can't be trusted with this: with
 * installs off it runs whatever is on `PATH` for a version it lacks, which is
 * the substitution a pin rules out (D12).
 */
function runOverride(req: ToolRequest, pinned: Override, argv: readonly string[]): Launch {
  const spec = `${pinned.id}@${pinned.version}`;
  const mise = findOnPath('mise', req.env);
  if (mise === null) return { refusal: overrideRefusal(req, spec, "`mise` isn't on PATH", 'uninstalled') };
  const has = miseHasInstalled(mise, spec, req, req.env);
  if (!has.ok) return { refusal: overrideRefusal(req, spec, `mise where ${spec}: ${has.detail}`, overrideCause(req.repo, has)) };
  const env = overrideEnv(req.repo, req.env);
  return { command: 'mise', args: ['exec', spec, '--', ...argv], env, pin: { source: 'override', version: pinned.version } };
}

/** The `override` source (R13.3): the copy the `--pins` file pins, ahead of every source the repo declares. */
const OVERRIDE: Source = {
  declares: (req) => {
    const override = overrideOf(req, req.tool);
    return override === null ? null : { override };
  },
  run: (req, declared) => {
    const pinned = declared?.override ?? null;
    return pinned === null ? { refusal: notFoundRefusal(req) } : runOverride(req, pinned, argvOf(req.tool, req.args));
  },
};

/** The argv a tool runs as, its arguments after: its `run` form, such as `cargo clippy`, else its own executable. */
function argvOf(tool: Tool, args: readonly string[]): string[] {
  return [...(tool.run ?? [tool.bin]), ...args];
}

/**
 * A pin source the launcher can read: whether it declares a tool, and how it
 * runs one. `declares` returns what declared it, or `null`; `run` takes `null`
 * when the source runs a tool nothing declared.
 */
type Source = {
  declares: (req: ToolRequest) => Declared | null;
  run: (req: ToolRequest, declared: Declared | null) => Launch;
};

/** The `js-lockfile` source: the copy the project's package manager installed. */
const JS_LOCKFILE: Source = {
  declares: (req) => (jsLockfileDeclares(req.cwd, req.repo, req.tool.bin) ? {} : null),
  run: (req) => {
    const canonical = ['exec', req.tool.bin, ...req.args];
    const refusal = missingToolRefusal(req.slot, 'pnpm', canonical, { cwd: req.cwd, pm: req.pm, everyManager: req.staticOnly });
    if (refusal !== null) return { refusal };
    const version = jsLockfileVersion(req.cwd, req.repo, req.tool.bin);
    return { ...translateExec('pnpm', canonical, req.pm), pin: { source: 'js-lockfile', ...(version !== undefined ? { version } : {}) } };
  },
};

/**
 * The `mise` source: the copy a repo `mise.toml` declares, run through mise
 * with its installs switched off, once mise confirms that copy is installed.
 */
const MISE: Source = {
  declares: (req) => {
    const mise = miseDeclaration(req.cwd, req.repo, req.tool.mise ?? [req.tool.bin]);
    return mise === null ? null : { mise };
  },
  run: (req, declared) => {
    const mise = findOnPath('mise', req.env);
    if (mise === null) return { refusal: miseMissingRefusal(req, declared?.mise ?? null) };
    const can = miseCanRun(mise, req.tool.bin, req.cwd, req.env);
    if (!can.ok) return { refusal: miseInactiveRefusal(req, declared?.mise ?? null, can) };
    return { command: 'mise', args: ['exec', '--', ...argvOf(req.tool, req.args)], env: MISE_NO_INSTALL, pin: { source: 'mise' } };
  },
};

/**
 * The `go-mod-tool` source: a tool the `go.mod` nearest the check declares in
 * a `tool` directive, run as `go tool <bin>` through the Go toolchain, with the
 * version `go.mod` requires for its module (R6.1, R6.3). A tool `TOOLS` gives
 * no `goTool` path is never declared here.
 */
const GO_MOD_TOOL: Source = {
  declares: (req) => {
    const goMod = req.tool.goTool === undefined ? null : goModDeclaration(req.cwd, req.repo, req.tool.goTool);
    return goMod === null ? null : { goMod };
  },
  run: (req, declared) => {
    const launch = viaToolchain(req, GO_TOOLCHAIN, ['tool', req.tool.bin, ...req.args]);
    if ('refusal' in launch) return launch;
    const version = declared?.goMod?.version;
    return { ...launch, pin: { source: 'go-mod-tool', ...(version !== undefined ? { version } : {}) } };
  },
};

/**
 * The `rust-toolchain` source: a rustup component, such as clippy, that a
 * `rust-toolchain.toml` or `rust-toolchain` from the check's directory up to
 * the repo root pins with the toolchain it names, run through rustup's `cargo`
 * from `PATH`, which reads that file (R6.1). Only rustup reads it, so without
 * rustup on `PATH` the check fails rather than run a `cargo` that ignores the
 * pin, and so does a `cargo` with no rustup beside it, which isn't rustup's
 * proxy. It records the file's channel when it names one exact release
 * (R6.3). A tool that isn't a component is never declared here.
 */
const RUST_TOOLCHAIN: Source = {
  declares: (req) => {
    const toolchain = req.tool.component === undefined ? null : rustToolchainDeclaration(req.cwd, req.repo);
    return toolchain === null ? null : { toolchain };
  },
  run: (req, declared) => {
    if (findOnPath(RUSTUP, req.env) === null) return { refusal: rustupMissingRefusal(req, declared?.toolchain ?? null) };
    if (findOnPath(CARGO_TOOLCHAIN.bin, req.env) === null) return { refusal: toolchainMissingRefusal(req, CARGO_TOOLCHAIN) };
    // Only rustup's own proxy reads the file, and launchCheck puts it first on PATH.
    if (rustupCargo(req.env) === null) return { refusal: proxyMissingRefusal(req) };
    const [command = CARGO_TOOLCHAIN.bin, ...args] = argvOf(req.tool, req.args);
    const channel = declared?.toolchain?.channel;
    const version = channel !== undefined && isExactChannel(channel) ? { version: channel } : {};
    return { command, args, env: MISE_NO_INSTALL, pin: { source: 'rust-toolchain', ...version } };
  },
};

/**
 * The `uv-lock` source: a tool the `uv.lock` nearest the check lists, run
 * straight from the project's environment, where `uv sync` installed the copy
 * the lock pins, and recorded with the version it locks (R6.1, R6.3). Nothing
 * runs through uv, so nothing can resolve or download. An environment that
 * doesn't exist yet, or lacks the tool, fails the check naming `uv sync`
 * (F41), rather than reach for a copy on `PATH`. A tool `TOOLS` gives no
 * `pypi` package is never declared here.
 */
const UV_LOCK: Source = {
  declares: (req) => {
    const uvLock = req.tool.pypi === undefined ? null : uvLockDeclaration(req.cwd, req.repo, req.tool.pypi);
    return uvLock === null ? null : { uvLock };
  },
  run: (req, declared) => {
    const lock = declared?.uvLock ?? null;
    if (lock === null) return { refusal: notFoundRefusal(req) };
    const [exe = req.tool.bin, ...args] = argvOf(req.tool, req.args);
    const found = environmentTool(projectEnvironment(lock.dir, req.env), exe);
    if (!found.tool) return { refusal: environmentRefusal(req, lock, found) };
    const command = named(req, req.cwd, found.path);
    return {
      command: command.includes('/') ? command : `./${command}`,
      args,
      pin: { source: 'uv-lock', ...(lock.version !== undefined ? { version: lock.version } : {}) },
    };
  },
};

/**
 * The `tf-version` source: the CLI a `.terraform-version` or
 * `.opentofu-version` from the check's directory up to the repo root
 * declares, run from `PATH` (R6.1). A version manager on `PATH` reads the
 * file itself, but a plain CLI doesn't, so a file that names an exact release
 * is checked against the copy that would run, and a mismatch fails the check
 * naming the release it asks for rather than run another. It records that
 * release (R6.3). A file declares only its own CLI, so `tofu` for an
 * `.opentofu-version`, and never a tool such as tflint.
 */
const TF_VERSION: Source = {
  declares: (req) => {
    const tfVersion = tfVersionDeclaration(req.cwd, req.repo);
    return tfVersion === null || tfVersion.cli.bin !== req.tool.bin ? null : { tfVersion };
  },
  run: (req, declared) => {
    const found = findOnPath(req.tool.bin, req.env);
    if (found === null) return { refusal: toolchainMissingRefusal(req, req.tool) };
    const pinned = declared?.tfVersion;
    const version = pinned?.version;
    if (pinned !== undefined && version !== undefined) {
      const reported = cliVersion(found, req.cwd, req.env);
      if (!reported.ok || reported.version !== version) return { refusal: tfVersionRefusal(req, pinned, version, { path: found, reported }) };
    }
    return { command: req.tool.bin, args: [...req.args], env: MISE_NO_INSTALL, pin: { source: 'tf-version', ...(version !== undefined ? { version } : {}) } };
  },
};

/** The sources the launcher reads, by name. `path` declares nothing, so it has no row; a name without one isn't readable yet. */
const SOURCES: { readonly [K in PinSourceName]?: Source } = {
  override: OVERRIDE,
  'js-lockfile': JS_LOCKFILE,
  'go-mod-tool': GO_MOD_TOOL,
  'rust-toolchain': RUST_TOOLCHAIN,
  'uv-lock': UV_LOCK,
  'tf-version': TF_VERSION,
  mise: MISE,
};

/**
 * Launch `args` through the Go toolchain for a tool `go.mod` declares, as
 * `go tool <bin>` (R6.2): through mise, as `mise exec -- go`, when a
 * `mise.toml` up to the repo root pins it and mise can run that copy, else
 * from `PATH`. A toolchain from `PATH` isn't refused under `requirePins`, since
 * the project's own files set the oldest version it accepts, and the pack's
 * environment stops it fetching another. The caller records the source that
 * declared the tool.
 */
function viaToolchain(req: ToolRequest, toolchain: Tool, args: readonly string[]): Launch {
  const asked = { ...req, tool: toolchain };
  const pinned = overrideOf(req, toolchain);
  if (pinned !== null) return runOverride(asked, pinned, [toolchain.bin, ...args]);
  const declared = miseDeclaration(req.cwd, req.repo, toolchain.mise ?? [toolchain.bin]);
  if (declared === null) {
    if (findOnPath(toolchain.bin, req.env) === null) return { refusal: toolchainMissingRefusal(req, toolchain) };
    return { command: toolchain.bin, args: [...args], env: MISE_NO_INSTALL, pin: { source: 'path' } };
  }
  const mise = findOnPath('mise', req.env);
  if (mise === null) return { refusal: miseMissingRefusal(asked, declared) };
  const can = miseCanRun(mise, toolchain.bin, req.cwd, req.env);
  if (!can.ok) return { refusal: miseInactiveRefusal(asked, declared, can) };
  return { command: 'mise', args: ['exec', '--', toolchain.bin, ...args], env: MISE_NO_INSTALL, pin: { source: 'mise' } };
}

/** True for a pin source the launcher can read, `path` included. */
export function isReadableSource(name: PinSourceName): boolean {
  return name === 'path' || SOURCES[name] !== undefined;
}

/**
 * Whether a check of `pack`, `undefined` for implicit ts mode, can run the
 * tool `invocation` names through that pack's pin chain. A chain of the
 * project's package manager alone provides only a tool an npm package ships,
 * so it can't run rumdl or typos, whose `TOOLS` rows have none. Anything that
 * isn't a `pnpm exec` tool (a built-in, `pnpm audit`, `pnpm run build`) runs
 * under any chain, and so does a tool `TOOLS` doesn't describe, since nothing
 * says it can't.
 */
export function chainCanRun(pack: string | undefined, invocation: { command: string; args: readonly string[] }): boolean {
  if (pinChain(pack).some((source) => source !== 'js-lockfile')) return true;
  const tool = execTool(invocation.command, invocation.args);
  const row = tool === null ? undefined : TOOLS.find((t) => t.bin === tool);
  return row === undefined || row.npm !== undefined;
}

/** The row for `bin` in `tools`, `TOOLS` by default, or a bare row for a tool it doesn't describe. */
function toolRow(bin: string, tools: readonly Tool[] = TOOLS): Tool {
  return tools.find((t) => t.bin === bin) ?? { bin, install: `install ${bin}, or pin it in mise.toml` };
}

/** Where a source declared a tool, as detection names it: the pin file and the key in it. */
function declarationSignal(declared: Declared, tool: Tool): string {
  if (declared.mise !== undefined) return `${declared.mise.file}: ${declared.mise.id}`;
  if (declared.override !== undefined) return `--pins: ${declared.override.id}`;
  return languageSignal(declared, tool) ?? `package.json: ${tool.npm ?? tool.bin}`;
}

/**
 * Where a language's own pin file declared a tool, as `<file>: <key>`, keyed
 * by the name that file gives the tool, or `null` when none did.
 */
function languageSignal(declared: Declared, tool: Tool): string | null {
  if (declared.goMod !== undefined) return `${declared.goMod.file}: ${tool.goTool ?? tool.bin}`;
  if (declared.toolchain !== undefined) return `${declared.toolchain.file}: ${tool.component ?? tool.bin}`;
  if (declared.uvLock !== undefined) return `${declared.uvLock.file}: ${tool.pypi ?? tool.bin}`;
  if (declared.tfVersion !== undefined) return `${declared.tfVersion.file}: ${tool.bin}`;
  return null;
}

/**
 * Where a check's tool is looked up: the directory it runs from, the repo
 * root a search stops at, its pin chain, and the `--pins` file's tools, which
 * an `override` source in that chain reads.
 */
type PinQuery = { cwd: string; repo: string; pins: readonly PinSourceName[]; overrides?: ReadonlyMap<string, string> };

/** The overrides a query's chain reads: the `--pins` file's tools when an `override` source heads it, else none. */
function queryOverrides(at: PinQuery): ReadonlyMap<string, string> {
  return at.pins.includes('override') ? (at.overrides ?? new Map()) : new Map();
}

/**
 * The source a check's tool would resolve through, found by file reads alone,
 * and where that source declares it (`<file>: <key>`), or `null` when it runs
 * a tool nothing declared: `path`, unpinned, when the chain ends there, else
 * the chain's last source. `null` when a source this checkride can't read
 * comes first, since it may be the one that declares the tool. Unlike a
 * launch it never asks a source whether it can run the tool.
 */
export function pinResolution(bin: string, at: PinQuery): { source: PinSourceName; declaredBy: string | null } | null {
  const tool = toolRow(bin);
  const req: ToolRequest = { slot: '', tool, args: [], cwd: at.cwd, repo: at.repo, pm: 'pnpm', chain: at.pins, requirePins: false, env: {}, overrides: queryOverrides(at), staticOnly: false };
  const sources = at.pins.filter((n) => n !== 'path');
  for (const name of sources) {
    const source = SOURCES[name];
    if (source === undefined) return null;
    const declared = source.declares(req);
    if (declared !== null) return { source: name, declaredBy: declarationSignal(declared, tool) };
  }
  const last = at.pins.includes('path') ? 'path' : sources.at(-1);
  return last === undefined ? null : { source: last, declaredBy: null };
}

/**
 * Where a source in `at.pins` other than `path` declares `bin` for a check in
 * `at.cwd`, as `<file>: <key>`, or `null` when none does: what an adapter's
 * `detectPin` detects by.
 */
export function pinDeclaration(bin: string, at: PinQuery): string | null {
  return pinResolution(bin, at)?.declaredBy ?? null;
}

/**
 * The copy of a tool or toolchain the `--pins` file pins for a check's
 * invocation, found by file reads alone as the launcher finds it: a tool the
 * `override` source at the head of `at.pins` declares, or a toolchain the
 * check runs, which runs the file's copy in any chain (R13.3). `null` when
 * the check runs nothing the file pins, or no `override` source heads its
 * chain.
 */
export function overridePin(command: string, args: readonly string[], at: PinQuery): { bin: string; id: string; version: string } | null {
  if (!at.pins.includes('override')) return null;
  const ctx: LaunchContext = { cwd: at.cwd, repo: at.repo, pm: 'pnpm', pins: at.pins, overrides: queryOverrides(at) };
  const tool = execTool(command, args);
  const asked = tool === null ? chosenToolchain(command, at.pins, ctx) : toolRow(tool);
  const pinned = asked === undefined ? null : overrideOf(toolRequest('', asked, [], at.pins, ctx), asked);
  return asked === undefined || pinned === null ? null : { bin: asked.bin, ...pinned };
}

/**
 * The `cargo <sub>` a check's invocation runs, as a cargo plugin such as
 * nextest runs, or `null` for anything else, a toolchain component included,
 * which the `rust-toolchain` source governs itself.
 */
function cargoPlugin(command: string, args: readonly string[], ctx: LaunchContext): string | null {
  const tool = execTool(command, args);
  const row = tool === null ? null : toolRow(tool, ctx.tools);
  return row?.component === undefined && row?.run?.[0] === CARGO_TOOLCHAIN.bin ? row.run.join(' ') : null;
}

/**
 * Launch the tool a check's `command` and `args` declare, for the check
 * filling `slot` from `ctx.cwd`. `args` arrive with their placeholders already
 * expanded. A fix launches the same way, so it runs the copy the check runs
 * and is refused where the check would be. Whatever it spawns carries the
 * variables the check's pack sets (R6.4), a command spawned as written
 * included, and, in a chain that reads `rust-toolchain` where a toolchain
 * file pins the toolchain, the ones that let it: rustup's proxy first on
 * `PATH`, and no `RUSTUP_TOOLCHAIN` from the shell. A cargo plugin there
 * builds through `cargo`, so without rustup to read the file it's refused.
 */
export function launchCheck(slot: string, command: string, args: readonly string[], ctx: LaunchContext): Launch {
  const toolchain = ctx.pins?.includes('rust-toolchain') === true ? rustToolchainDeclaration(ctx.cwd, ctx.repo ?? ctx.cwd) : null;
  if (toolchain === null) return withPackEnv(resolveLaunch(slot, command, args, ctx), { ...ctx.packEnv });
  const env = ctx.env ?? process.env;
  const plugin = cargoPlugin(command, args, ctx);
  if (plugin !== null && findOnPath(RUSTUP, env) === null) return { refusal: pluginRefusal(slot, plugin, toolchain) };
  const pinned = toolchainFileEnv(ctx.cwd, ctx.repo ?? ctx.cwd, env);
  // Search the PATH the spawn gets, rustup's directory first, so the copy found is the copy that runs.
  return withPackEnv(resolveLaunch(slot, command, args, { ...ctx, env: { ...env, ...pinned } }), { ...ctx.packEnv, ...pinned });
}

/**
 * `launch` with the pack's variables under the ones its source sets, or as it
 * was when it's a refusal or the pack sets none, so a check of no pack spawns
 * exactly as before.
 */
function withPackEnv(launch: Launch, packEnv: Readonly<Record<string, string>>): Launch {
  if ('refusal' in launch || Object.keys(packEnv).length === 0) return launch;
  return { ...launch, env: { ...packEnv, ...launch.env } };
}

/** Resolve the process a check's invocation launches as, through its pin chain, before the pack's variables join it. */
function resolveLaunch(slot: string, command: string, args: readonly string[], ctx: LaunchContext): Launch {
  const chain = ctx.pins !== undefined && ctx.pins.length > 0 ? ctx.pins : IMPLICIT_CHAIN;
  const tool = execTool(command, args);
  if (tool === null) {
    const toolchain = chosenToolchain(command, chain, ctx);
    if (toolchain === undefined) return passThrough(command, args, ctx.pm);
    const request = toolRequest(slot, toolchain, args, chain, ctx);
    // A toolchain the `--pins` file pins runs that copy, in any chain (R13.3).
    const pinned = chain.includes('override') ? overrideOf(request, toolchain) : null;
    if (pinned !== null) return runOverride(request, pinned, [toolchain.bin, ...args]);
    if (!chain.includes('mise')) return passThrough(command, args, ctx.pm);
    // A toolchain walks its pack's chain like a tool, so a toolchain file pins
    // cargo itself; from PATH it runs even under requirePins, since the
    // project's own files set the version it accepts (R6.2).
    return walkChain({ ...request, requirePins: false });
  }
  return walkChain(toolRequest(slot, toolRow(tool, ctx.tools), args.slice(2), chain, ctx));
}

/**
 * The executable a check's `command` runs as from `ctx`, before a launcher
 * such as `mise exec` wraps it, for a message to name: the CLI the repo
 * declares where a toolchain has a stand-in, `tofu` for a terraform pack's
 * `terraform` where it declares OpenTofu, and otherwise `command` itself.
 */
export function commandBin(command: string, ctx: LaunchContext): string {
  const chain = ctx.pins !== undefined && ctx.pins.length > 0 ? ctx.pins : IMPLICIT_CHAIN;
  return chosenToolchain(command, chain, ctx)?.bin ?? command;
}

/**
 * The toolchain `command` names, if it names one. In a chain that reads
 * `tf-version`, the terraform pack's, `terraform` runs as the CLI the repo
 * declares, which is `tofu` where it declares OpenTofu (R5.8).
 */
function chosenToolchain(command: string, chain: readonly PinSourceName[], ctx: LaunchContext): Tool | undefined {
  const toolchain = TOOLCHAINS.find((t) => t.bin === command);
  if (toolchain !== TERRAFORM_TOOLCHAIN || !chain.includes('tf-version')) return toolchain;
  return terraformCli(ctx.cwd, ctx.repo ?? ctx.cwd, chain.includes('override') ? (ctx.overrides ?? new Map()) : new Map());
}

/** What a source reads to resolve `tool`, run with `args`, for the check filling `slot`. */
function toolRequest(slot: string, tool: Tool, args: readonly string[], chain: readonly PinSourceName[], ctx: LaunchContext): ToolRequest {
  return {
    slot,
    tool,
    args,
    cwd: ctx.cwd,
    repo: ctx.repo ?? ctx.cwd,
    pm: ctx.pm,
    chain,
    requirePins: ctx.requirePins ?? false,
    env: ctx.env ?? process.env,
    overrides: chain.includes('override') ? (ctx.overrides ?? new Map()) : new Map(),
    staticOnly: ctx.staticOnly ?? false,
  };
}

/**
 * Walk `req.chain` in order (R6.2). The first source that declares the tool
 * runs it, and a source that can't be read stops the walk, since passing over
 * it could pass over the pin. With nothing declaring it, `path` runs the tool
 * when the chain names it, and otherwise the last source does.
 */
function walkChain(req: ToolRequest): Launch {
  const sources = req.chain.filter((name) => name !== 'path');
  for (const [i, name] of sources.entries()) {
    const source = SOURCES[name];
    if (source === undefined) return { refusal: unreadableRefusal(req, name) };
    const declared = source.declares(req);
    if (declared !== null) return source.run(req, declared);
    if (i === sources.length - 1 && !req.chain.includes('path')) return source.run(req, null);
  }
  return fromPath(req);
}

/**
 * The `path` source: the tool from `PATH`, unpinned, unless a Nix dev shell
 * the repo declares put it there, which pins it (`nix`, with the version its
 * store path names). Under `requirePins` an unpinned copy fails instead, and a
 * tool `PATH` doesn't have fails naming how to install it. A tool that runs
 * through another, as `cargo deny` runs `cargo-deny`, is never classified,
 * since its runner picks the copy that runs. The mise variables ride along,
 * because a tool on `PATH` may be one of mise's shims.
 */
function fromPath(req: ToolRequest): Launch {
  const found = findOnPath(req.tool.bin, req.env);
  if (found === null) return { refusal: notFoundRefusal(req) };
  const nix = req.tool.run === undefined ? nixCopy(found, req) : null;
  if (req.requirePins && nix === null) return { refusal: unpinnedRefusal(req, found) };
  const [command = req.tool.bin, ...args] = argvOf(req.tool, req.args);
  return { command, args, env: MISE_NO_INSTALL, pin: pathPin(nix) };
}

/** The pin a copy from `PATH` records: `nix`, with the version its store path names, for a Nix dev shell's, else `path`. */
function pathPin(nix: { version?: string } | null): NonNullable<Spawn['pin']> {
  return nix === null ? { source: 'path' } : { source: 'nix', ...nix };
}

/**
 * An invocation that names no tool: a package-manager subcommand, which the
 * `js-lockfile` source translates, or any other command, spawned as written.
 */
function passThrough(command: string, args: readonly string[], pm: PackageManager): Spawn {
  const spawn = translateExec(command, args, pm);
  return command === 'pnpm' ? { ...spawn, pin: { source: 'js-lockfile' } } : spawn;
}

/** `dir` as a message names it: relative to the repo root, `.` for the root itself. */
function shown(req: ToolRequest, dir: string): string {
  return relative(req.repo, dir) || '.';
}

/**
 * `path` named from `from`: relative when it lies inside the repo, so an argv
 * or a message reads the same on every machine, and absolute when it lies
 * outside, as an environment `UV_PROJECT_ENVIRONMENT` puts elsewhere does.
 */
function named(req: ToolRequest, from: string, path: string): string {
  const inRepo = relative(req.repo, path);
  return inRepo.startsWith('..') || isAbsolute(inRepo) ? path : relative(from, path) || '.';
}

/** The refusal for a tool mise pins when mise itself isn't on `PATH` (F11). */
function miseMissingRefusal(req: ToolRequest, declared: MiseDeclaration | null): string {
  const bin = req.tool.bin;
  return [
    `checkride: the \`${req.slot}\` slot's \`${bin}\` is pinned through mise, but \`mise\` isn't on PATH.`,
    '',
    ...(declared !== null ? [`  declared in: ${declared.file} ([tools] ${declared.id})`, ''] : []),
    'A pinned tool runs only through the source that pins it, so checkride',
    `won't fall back to a \`${bin}\` on PATH, whose version is whatever this`,
    'machine has. Install mise (https://mise.jdx.dev) and run `mise install`,',
    'or remove the pin.',
    '',
    `  ${req.tool.install}`,
    '',
  ].join('\n');
}

/** Why a check's mise refused: a config file it hasn't trusted, or no copy at the version it pins. */
type MiseRefusal = Extract<MiseAnswer, { ok: false }>;

/** How a refusal's headline ends when mise refused a config file it hasn't trusted. */
const UNTRUSTED_CAUSE = "mise won't read a config file here until it's trusted.";

/**
 * What a refusal for a config file mise hasn't trusted asks for (D82). Never
 * `mise install`: outside paranoid mode it trusts the config it reads as a
 * side effect (mise 2026.10.4), so naming it would trust a file nobody chose
 * to, and in paranoid mode it fails the same way.
 */
const TRUST_REMEDY = [
  "mise won't load a config file that sets a tool option or an env var until",
  "someone trusts it, so it can't run the pinned copy. Review the file mise",
  'names, trust it from the directory that holds it, then re-run:',
  '',
  '  mise trust',
  '',
];

/** The refusal for a tool mise pins when mise can't run it: a config it hasn't trusted, or a version it hasn't installed. */
function miseInactiveRefusal(req: ToolRequest, declared: MiseDeclaration | null, why: MiseRefusal): string {
  const bin = req.tool.bin;
  return [
    `checkride: the \`${req.slot}\` slot's \`${bin}\` is pinned through mise, but ${why.untrusted ? UNTRUSTED_CAUSE : "mise can't run the copy it pins."}`,
    '',
    ...(declared !== null ? [`  declared in: ${declared.file} ([tools] ${declared.id})`] : []),
    `  mise which ${bin}: ${why.detail}`,
    '',
    ...(why.untrusted
      ? TRUST_REMEDY
      : [
          'checkride never installs a tool, and it won\'t let mise run another',
          `\`${bin}\` from PATH in place of the pinned one. Install the pinned`,
          'version, then re-run:',
          '',
          '  mise install',
          '',
        ]),
  ].join('\n');
}

/** The refusal for a tool found only on `PATH` while `requirePins` is on (F12). */
function unpinnedRefusal(req: ToolRequest, found: string): string {
  const bin = req.tool.bin;
  const id = req.tool.mise?.[0] ?? bin;
  return [
    `checkride: ${bin} is not pinned; pin it with: mise use ${id}@<version>`,
    '',
    `  found: ${found} (on PATH)`,
    '',
    `The \`${req.slot}\` slot would run whatever copy of ${bin} this machine has,`,
    'and requirePins is on, so a tool no pin source declares fails its check',
    'instead of running.',
    '',
  ].join('\n');
}

/**
 * Why mise won't run an override pin: no copy at that version, a config file
 * outside the repo it hasn't trusted, or one inside the repo, which a mise
 * honoring `MISE_IGNORED_CONFIG_PATHS` never reads (D83).
 */
export type OverrideCause = 'uninstalled' | 'untrusted' | 'repo-config';

/**
 * Why `mise where` refused an override pin for the repo at `repo`. An
 * untrusted config counts as one outside the repo only when mise names a path
 * there, so a refusal never asks a consumer to trust a file in a repo it may
 * be reviewing.
 */
export function overrideCause(repo: string, why: MiseRefusal): OverrideCause {
  if (!why.untrusted) return 'uninstalled';
  return why.config !== undefined && !isInside(repo, why.config) ? 'untrusted' : 'repo-config';
}

/** How an override refusal's headline ends, and what it asks for, by cause. */
const OVERRIDE_REFUSALS: Readonly<Record<OverrideCause, { cause: string; remedy: (spec: string) => readonly string[] }>> = {
  uninstalled: {
    cause: "which mise can't run here.",
    remedy: (spec) => [
      'checkride never installs a tool, and it won\'t run another copy in place',
      'of the pinned one. Install that version, then re-run:',
      '',
      `  mise install ${spec}`,
      '',
    ],
  },
  untrusted: {
    cause: "but mise won't read a config file outside the repo until it's trusted.",
    remedy: () => ['--pins keeps mise out of the config files inside the repo, but not out', 'of the ones above it.', '', ...TRUST_REMEDY],
  },
  'repo-config': {
    cause: 'but mise read a config file inside the repo, which --pins tells it to skip.',
    remedy: () => [
      '--pins runs your own toolbelt, so checkride names the repo root in',
      'MISE_IGNORED_CONFIG_PATHS and mise reads none of its config files. This',
      "mise read one anyway, so it doesn't honor that variable. Trusting the file",
      'would let a repo you may be reviewing set what the check runs with, so',
      'upgrade mise instead, then re-run.',
      '',
    ],
  },
};

/**
 * The refusal for a tool the `--pins` file pins at a version mise can't run
 * here (F38), or that mise won't look for while a config file it reads is
 * untrusted. It names `mise trust` only for a config outside the repo (D83).
 */
function overrideRefusal(req: ToolRequest, spec: string, detail: string, cause: OverrideCause): string {
  const refusal = OVERRIDE_REFUSALS[cause];
  return [
    `checkride: the \`${req.slot}\` slot's \`${req.tool.bin}\` is pinned by --pins to ${spec}, ${refusal.cause}`,
    '',
    `  ${detail}`,
    '',
    ...refusal.remedy(spec),
  ].join('\n');
}

/** The toolchain manager whose `cargo` reads a `rust-toolchain.toml`. */
const RUSTUP = 'rustup';

/** The refusal for a component a toolchain file pins when rustup, the only reader of that file, isn't on `PATH`. */
/** The line naming where a toolchain file pins the toolchain, and its channel, as a refusal shows it. */
function declaredLine(declared: RustToolchainDeclaration): string {
  return `  declared in: ${declared.file}${declared.channel !== undefined ? ` (channel ${declared.channel})` : ''}`;
}

/**
 * The refusal for a cargo plugin, such as `cargo nextest`, where a toolchain
 * file pins the toolchain and rustup isn't on PATH: the plugin builds through
 * `cargo`, and only rustup's would read the file.
 */
function pluginRefusal(slot: string, plugin: string, declared: RustToolchainDeclaration): string {
  return [
    `checkride: the \`${slot}\` slot's \`${plugin}\` builds with the toolchain \`${declared.file}\` pins, but \`rustup\` isn't on PATH to honor it.`,
    '',
    declaredLine(declared),
    '',
    'Only rustup reads that file, so a `cargo` without it would build with',
    'whatever toolchain it came with instead of the pinned one. Install rustup',
    '(https://rustup.rs), or remove the file.',
    '',
  ].join('\n');
}

/**
 * The refusal for a toolchain component where rustup is on PATH but no
 * directory holds it with a `cargo`, so every `cargo` there is another one,
 * which would ignore the toolchain file. It names the first rustup's directory.
 */
function proxyMissingRefusal(req: ToolRequest): string {
  const rustup = findOnPath(RUSTUP, req.env) ?? RUSTUP;
  return [
    `checkride: the \`${req.slot}\` slot's \`${req.tool.bin}\` is pinned by a toolchain file, but no \`cargo\` sits beside \`rustup\` in ${dirname(rustup)} to read it.`,
    '',
    'The `cargo` on PATH isn\'t rustup\'s proxy, so it would run whatever',
    'toolchain it came with instead of the pinned one. Reinstall Rust with',
    'rustup (https://rustup.rs), or remove the file.',
    '',
  ].join('\n');
}

function rustupMissingRefusal(req: ToolRequest, declared: RustToolchainDeclaration | null): string {
  return [
    `checkride: the \`${req.slot}\` slot's \`${req.tool.bin}\` is pinned by a toolchain file, but \`rustup\` isn't on PATH.`,
    '',
    ...(declared !== null ? [declaredLine(declared), ''] : []),
    'Only rustup reads that file, so a `cargo` without it would run whatever',
    'toolchain it came with instead of the pinned one. Install rustup',
    '(https://rustup.rs), or remove the file.',
    '',
  ].join('\n');
}

/**
 * The refusal for a tool `uv.lock` pins when the project environment it runs
 * from doesn't exist yet, or exists without it (F41). Both name `uv sync`, run
 * where the lock is, and the second says why a sync can leave a tool out.
 */
function environmentRefusal(req: ToolRequest, lock: UvLockDeclaration, found: { path: string; venv: boolean }): string {
  const bin = req.tool.bin;
  const where = shown(req, lock.dir);
  const version = lock.version === undefined ? '' : ` ${lock.version}`;
  return [
    found.venv
      ? `checkride: the \`${req.slot}\` slot's \`${bin}\` is locked in ${lock.file}, but the project environment it runs from has no \`${bin}\`.`
      : `checkride: the \`${req.slot}\` slot's \`${bin}\` is locked in ${lock.file}, but the project environment it runs from doesn't exist yet.`,
    '',
    `  declared in: ${lock.file} (${req.tool.pypi ?? bin}${version})`,
    `  looked for: ${named(req, req.repo, found.path)}`,
    '',
    `checkride never installs a tool, and it won't run another \`${bin}\``,
    'from PATH in place of the locked one. Sync the environment from the',
    'lock, then re-run:',
    '',
    `  ${where === '.' ? 'uv sync' : `uv sync --directory ${where}`}`,
    '',
    ...(found.venv
      ? [
        'A tool in a dependency group or a workspace member that `uv sync`',
        'leaves out by default needs `--group <name>`, `--all-groups` or',
        '`--all-packages`.',
        '',
      ]
      : []),
  ].join('\n');
}

/**
 * The refusal for a CLI a Terraform version file pins to `version` when the
 * copy on `PATH` reports another, or can't say which it is. A version
 * manager that reads the file, tfenv or tofuenv, installs the release it
 * names; a plain CLI has to be that release.
 */
function tfVersionRefusal(
  req: ToolRequest,
  pinned: TfVersionDeclaration,
  version: string,
  found: { path: string; reported: { ok: true; version: string } | { ok: false; detail: string } },
): string {
  const bin = req.tool.bin;
  const reported = found.reported;
  return [
    reported.ok
      ? `checkride: the \`${req.slot}\` slot's \`${bin}\` is pinned by ${pinned.file} to ${version}, but the \`${bin}\` on PATH is ${reported.version}.`
      : `checkride: the \`${req.slot}\` slot's \`${bin}\` is pinned by ${pinned.file} to ${version}, but the \`${bin}\` on PATH didn't say which version it is.`,
    '',
    `  declared in: ${pinned.file} (${version})`,
    reported.ok ? `  found: ${found.path} (${reported.version})` : `  ${bin} version -json: ${reported.detail}`,
    '',
    `checkride never installs a CLI, and it won't run another \`${bin}\` in place`,
    `of the pinned one. Put ${version} on PATH, or let ${pinned.manager} pick it, then re-run:`,
    '',
    `  ${pinned.manager} install ${version}`,
    '',
  ].join('\n');
}

/** The refusal for a toolchain `PATH` doesn't have, run itself or to run a tool a source declares. */
function toolchainMissingRefusal(req: ToolRequest, toolchain: Tool): string {
  const running = req.tool.bin === toolchain.bin ? '' : ` to run \`${req.tool.bin}\``;
  return [
    `checkride: the \`${req.slot}\` slot needs \`${toolchain.bin}\`${running}, which isn't on PATH.`,
    '',
    `  ${toolchain.install}`,
    '',
  ].join('\n');
}

/** The refusal for a tool nothing declares and `PATH` doesn't have. */
function notFoundRefusal(req: ToolRequest): string {
  const bin = req.tool.bin;
  const looked = req.chain.map((name) => (name === 'path' ? `\`${bin}\` on PATH` : name)).join(', then ');
  return [
    `checkride: the \`${req.slot}\` slot needs \`${bin}\`, which no source in its pin chain provides.`,
    '',
    `  looked for: ${looked} (from ${shown(req, req.cwd)} up to the repo root)`,
    '',
    `  ${req.tool.install}`,
    '',
  ].join('\n');
}

/** The refusal for a chain naming a pin source this checkride can't read. */
function unreadableRefusal(req: ToolRequest, name: PinSourceName): string {
  return [
    `checkride: the \`${req.slot}\` slot resolves \`${req.tool.bin}\` through the \`${name}\` pin source, which this checkride can't read.`,
    '',
    'Skipping it could skip the pin that declares the tool, so the check fails',
    'instead. Upgrade checkride.',
    '',
  ].join('\n');
}

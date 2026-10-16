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
 * that the `js-lockfile` source translates for the detected manager. Anything
 * else, such as a custom check's own `node scripts/x.mjs`, spawns as written,
 * through no pin source.
 */

import { relative } from 'node:path';

import type { PinSourceName, Tool } from '../packs/index.js';
import { PACKS, TOOLS } from '../packs/index.js';
import { execTool, jsLockfileDeclares, jsLockfileVersion, missingToolRefusal } from './js-lockfile.js';
import type { MiseDeclaration } from './mise.js';
import { MISE_NO_INSTALL, miseCanRun, miseDeclaration } from './mise.js';
import type { PackageManager } from './package-manager.js';
import { findOnPath } from './path.js';
import { translateExec } from './translate.js';

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
  /** Fail a tool that resolves from `PATH` with no pin, instead of running it. */
  requirePins?: boolean;
  /** The environment whose `PATH` is searched. Omitted, this process's own. */
  env?: Readonly<Record<string, string | undefined>>;
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
};

/** What declared a tool, for a refusal to name: the mise config and key, when it was mise. */
type Declared = { mise?: MiseDeclaration };

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
    const refusal = missingToolRefusal(req.slot, 'pnpm', canonical, { cwd: req.cwd, pm: req.pm });
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
    if (!can.ok) return { refusal: miseInactiveRefusal(req, declared?.mise ?? null, can.detail) };
    return { command: 'mise', args: ['exec', '--', req.tool.bin, ...req.args], env: MISE_NO_INSTALL, pin: { source: 'mise' } };
  },
};

/** The sources the launcher reads, by name. `path` declares nothing, so it has no row; a name without one isn't readable yet. */
const SOURCES: { readonly [K in PinSourceName]?: Source } = {
  'js-lockfile': JS_LOCKFILE,
  mise: MISE,
};

/** True for a pin source the launcher can read, `path` included. */
export function isReadableSource(name: PinSourceName): boolean {
  return name === 'path' || SOURCES[name] !== undefined;
}

/** The `TOOLS` row for `bin`, or a bare row for a tool it doesn't describe. */
function toolRow(bin: string): Tool {
  return TOOLS.find((t) => t.bin === bin) ?? { bin, install: `install ${bin}, or pin it in mise.toml` };
}

/**
 * Launch the tool a check's `command` and `args` declare, for the check
 * filling `slot` from `ctx.cwd`. `args` arrive with their placeholders already
 * expanded. A fix launches the same way, so it runs the copy the check runs
 * and is refused where the check would be.
 */
export function launchCheck(slot: string, command: string, args: readonly string[], ctx: LaunchContext): Launch {
  const tool = execTool(command, args);
  if (tool === null) return passThrough(command, args, ctx.pm);
  const chain = ctx.pins !== undefined && ctx.pins.length > 0 ? ctx.pins : IMPLICIT_CHAIN;
  const req: ToolRequest = {
    slot,
    tool: toolRow(tool),
    args: args.slice(2),
    cwd: ctx.cwd,
    repo: ctx.repo ?? ctx.cwd,
    pm: ctx.pm,
    chain,
    requirePins: ctx.requirePins ?? false,
    env: ctx.env ?? process.env,
  };
  return walkChain(req);
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
 * The `path` source: the tool from `PATH`, unpinned. Under `requirePins` it
 * fails instead, and a tool `PATH` doesn't have fails naming how to install
 * it. The mise variables ride along, because a tool on `PATH` may be one of
 * mise's shims.
 */
function fromPath(req: ToolRequest): Launch {
  const found = findOnPath(req.tool.bin, req.env);
  if (found === null) return { refusal: notFoundRefusal(req) };
  if (req.requirePins) return { refusal: unpinnedRefusal(req, found) };
  return { command: req.tool.bin, args: [...req.args], env: MISE_NO_INSTALL, pin: { source: 'path' } };
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

/** The refusal for a tool mise pins at a version it hasn't installed. */
function miseInactiveRefusal(req: ToolRequest, declared: MiseDeclaration | null, detail: string): string {
  const bin = req.tool.bin;
  return [
    `checkride: the \`${req.slot}\` slot's \`${bin}\` is pinned through mise, but mise can't run the copy it pins.`,
    '',
    ...(declared !== null ? [`  declared in: ${declared.file} ([tools] ${declared.id})`] : []),
    `  mise which ${bin}: ${detail}`,
    '',
    'checkride never installs a tool, and it won\'t let mise run another',
    `\`${bin}\` from PATH in place of the pinned one. Install the pinned`,
    'version, then re-run:',
    '',
    '  mise install',
    '',
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

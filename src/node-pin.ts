/**
 * The repo's Node pin, and aligning a child process to it.
 *
 * Agent harnesses run their hooks in a **non-login shell**. A version manager
 * puts its shims on `PATH` from a shell rc file, so the hook never sees them: it
 * gets whatever `node` the machine defaults to, not the one the contributor's
 * terminal has. In a repo that pins `engines.node`, that is enough for the
 * package manager to refuse to run anything at all — the gate then reports a red
 * that no code change can clear, every turn, and the rational response is to
 * turn the gate off.
 *
 * So before running the check script, checkride puts the pinned interpreter back
 * in front of the child's `PATH`. Four rules bound that, because silently
 * choosing which Node a repo's whole pipeline runs on is not a small thing to
 * do:
 *
 * 1. **Only on an explicit version-manager pin** — `.nvmrc` or `.node-version`,
 *    a file whose entire purpose is to name the interpreter this repo wants.
 *    `engines.node` is a *range*, a compatibility declaration about what will
 *    work, and reading it as an instruction to switch interpreters would be
 *    inventing intent the author did not express. It is read for diagnosis only.
 * 2. **Only when the running Node does not already satisfy the pin.** A healthy
 *    environment is never touched.
 * 3. **Only an interpreter already installed** in a known version-manager
 *    layout. Nothing is downloaded, and no version manager is invoked — under a
 *    non-login shell there is nothing to invoke, since `nvm` is a shell
 *    function rather than a binary.
 * 4. **Never silently.** Every caller that aligns says so in its report.
 *
 * When any of those fails, this module returns what it found and changes
 * nothing; the caller then has an honest cause to name instead of a false red.
 * `CHECKRIDE_NODE_BIN` is the escape hatch in both directions — a directory to
 * use verbatim (the wrapping point for a layout this module does not know), or
 * `off` to disable alignment entirely.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** The environment variable that overrides, or disables, alignment. */
export const NODE_BIN_VAR = 'CHECKRIDE_NODE_BIN';

/** The value of {@link NODE_BIN_VAR} that turns alignment off. */
const OFF = 'off';

/** Files that name the interpreter a repo wants, in the order they are consulted. */
const PIN_FILES: readonly string[] = ['.nvmrc', '.node-version'];

/**
 * Where version managers keep their installs: a directory of per-version
 * folders, and the path from one of those to its `bin`.
 *
 * Home-relative only, and deliberately so. A relocated install root is
 * configured through the manager's own environment variable (`NVM_DIR`,
 * `N_PREFIX`, …), which a non-login shell does not have either — the very
 * condition this module exists for. Reading them would work exactly when
 * alignment is not needed. {@link NODE_BIN_VAR} covers the rest.
 */
const LAYOUTS: readonly { root: readonly string[]; bin: readonly string[] }[] = [
  { root: ['.nvm', 'versions', 'node'], bin: ['bin'] },
  { root: ['.local', 'share', 'fnm', 'node-versions'], bin: ['installation', 'bin'] },
  { root: ['.fnm', 'node-versions'], bin: ['installation', 'bin'] },
  { root: ['.nodenv', 'versions'], bin: ['bin'] },
  { root: ['.asdf', 'installs', 'nodejs'], bin: ['bin'] },
  { root: ['.volta', 'tools', 'image', 'node'], bin: ['bin'] },
  { root: ['n', 'versions', 'node'], bin: ['bin'] },
];

/** A version-manager pin: the file that carries it, and the version it names. */
export type NodePin = { file: string; version: string };

/** An installed interpreter: its `bin` directory and the exact version there. */
export type NodeInstall = { bin: string; version: string };

/**
 * What aligning found. Produced only when there is something to do or to
 * report, so the three shapes are all meaningful:
 *
 * - `bin` set — put it in front of the child's `PATH`, and say so.
 * - `pin` set with no `bin` — the repo names a Node that is installed nowhere
 *   this module looks. The actionable case: nothing changes, and the caller now
 *   has a cause to name instead of a red it cannot explain.
 * - no `pin` — {@link NODE_BIN_VAR} named the directory outright, so there was
 *   no pin to consult.
 */
export type NodeAlignment = {
  pin: NodePin | null;
  /** The Node running this process, without the leading `v`. */
  running: string;
  /** The `bin` directory to prepend, or `null` when nothing satisfying the pin is installed. */
  bin: string | null;
  /** The version behind `bin`, when checkride resolved it rather than being handed it. */
  version: string | null;
};

/** Every environment touch, injectable so the layouts are testable without them. */
export type PinEnv = {
  exists: (path: string) => boolean;
  read: (path: string) => string | null;
  list: (dir: string) => string[];
  home: () => string;
  /** The running Node's version, without the leading `v`. */
  running: () => string;
  variable: (name: string) => string | undefined;
};

function readReal(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function listReal(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export const realPinEnv: PinEnv = {
  exists: existsSync,
  read: readReal,
  list: listReal,
  home: homedir,
  running: () => process.version.replace(/^v/, ''),
  variable: (name) => process.env[name],
};

/** `v22.22.3` / `22.22.3 ` → `22.22.3`; anything not starting with a digit → `null`. */
function normalize(raw: string): string | null {
  const trimmed = raw.trim().replace(/^v/, '');
  return /^\d/.test(trimmed) ? trimmed : null;
}

/**
 * The pin `cwd` declares, or `null`.
 *
 * `null` covers both "no pin file" and a pin naming something this module cannot
 * resolve to a version — `lts/*`, `lts/jod`, `node`, `system`. Those are aliases
 * a version manager resolves against its own alias directory and its own idea of
 * the current LTS, and guessing at either would pick an interpreter the repo
 * never named.
 */
export function readNodePin(cwd: string, env: PinEnv = realPinEnv): NodePin | null {
  for (const file of PIN_FILES) {
    const raw = env.read(join(cwd, file));
    if (raw === null) continue;
    const version = normalize(raw);
    if (version !== null) return { file, version };
  }
  return null;
}

/** A version as numbers, for comparison. Non-numeric segments sort as 0. */
function segments(version: string): number[] {
  return version.split('.').map((s) => Number.parseInt(s, 10) || 0);
}

/**
 * Does `version` satisfy `pin`, reading the pin as a prefix?
 *
 * That is how every version manager reads these files: `.nvmrc` holding `22`
 * means "the newest 22 you have", not "22.0.0". A fully-spelled pin therefore
 * matches only itself, and a partial one matches its whole line.
 */
export function satisfiesPin(pin: string, version: string): boolean {
  const wanted = pin.split('.');
  const found = version.split('.');
  return wanted.every((part, i) => found[i] === part);
}

/** The higher of two versions, compared segment by segment. */
function newer(a: string, b: string): string {
  const [as, bs] = [segments(a), segments(b)];
  const length = Math.max(as.length, bs.length);
  for (let i = 0; i < length; i++) {
    const diff = (as[i] ?? 0) - (bs[i] ?? 0);
    if (diff !== 0) return diff > 0 ? a : b;
  }
  return a;
}

/** The best installed version under one layout root, or `null` if none satisfies the pin. */
function bestUnder(root: string, pin: string, env: PinEnv): string | null {
  const matching = env
    .list(root)
    .map((name) => normalize(name))
    .filter((v): v is string => v !== null && satisfiesPin(pin, v));
  return matching.length === 0 ? null : matching.reduce(newer);
}

/**
 * Find an installed interpreter satisfying `pin`, searching the known layouts in
 * order and taking the newest match within the first layout that has one.
 *
 * Order matters only when two managers both hold a match, which is rare and
 * where either answer is defensible; searching the first hit keeps this from
 * stat-ing every layout on every gate run.
 */
export function findPinnedNode(pin: NodePin, env: PinEnv = realPinEnv): NodeInstall | null {
  for (const layout of LAYOUTS) {
    const root = join(env.home(), ...layout.root);
    const version = bestUnder(root, pin.version, env);
    if (version === null) continue;
    // The directory name may carry the `v` the normalized version dropped.
    const dir = env.exists(join(root, `v${version}`)) ? `v${version}` : version;
    const bin = join(root, dir, ...layout.bin);
    if (env.exists(join(bin, 'node'))) return { bin, version };
  }
  return null;
}

/**
 * Decide whether this process should align a child to the repo's Node pin, and
 * to what.
 *
 * `null` means "nothing to do, change nothing" — alignment is off, the repo
 * pins nothing resolvable, or the running Node already satisfies the pin. A
 * returned alignment always describes a real divergence, whether or not an
 * interpreter was found for it, because the caller has something to report
 * either way.
 *
 * An explicit {@link NODE_BIN_VAR} path is honored *before* the pin is read and
 * regardless of what it says: someone who names the directory has stated an
 * intent more specific than any file in the repo, and a wrapping point that only
 * worked in the cases checkride already handles would not be one.
 */
export function alignNode(cwd: string, env: PinEnv = realPinEnv): NodeAlignment | null {
  const override = env.variable(NODE_BIN_VAR);
  if (override === OFF) return null;
  const running = env.running();
  if (override !== undefined && override.length > 0) {
    return { pin: readNodePin(cwd, env), running, bin: override, version: null };
  }
  const pin = readNodePin(cwd, env);
  if (pin === null || satisfiesPin(pin.version, running)) return null;
  const install = findPinnedNode(pin, env);
  return { pin, running, bin: install?.bin ?? null, version: install?.version ?? null };
}

/**
 * `env` with `bin` in front of `PATH`. Prepending rather than replacing is what
 * keeps the rest of the toolchain reachable: only the interpreter resolution
 * changes, and every other binary the check script needs still resolves exactly
 * as it did.
 */
export function withNodeBin(
  env: Readonly<Record<string, string | undefined>>,
  bin: string,
): Record<string, string | undefined> {
  const current = env['PATH'] ?? '';
  return { ...env, PATH: current.length > 0 ? `${bin}${delimiter}${current}` : bin };
}

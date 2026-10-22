/**
 * `checkride doctor` — read-only environment + tooling verification.
 *
 * Verifies node/pnpm/git are present at the required versions, the project has
 * been installed, and `.check/` is writable. It names the mode, and the targets
 * a multi-target repo declares. It then enumerates *every* check — not just the
 * ones the default run executes — and reports each one's enablement (default /
 * opt-in / disabled / unavailable) alongside its tool's presence and the pin
 * source it resolves through, so off and opt-in slots are visible instead of
 * silently dropped. A tool nothing pins gets a row of its own, a warning, or a
 * failure under `requirePins`. Under `--pins` each tool resolves through the
 * file's `override` source first, as in a run, and reports the version
 * `mise where` finds for it; under `--static-only` each check a static run
 * skips reports why instead, and the install fails nothing. Last come the
 * markers no target claims: the ones `unclaimed` reports, or, in a repo
 * checked as one ts project, the other languages' code no check reads.
 * Renders a human table (or `--json`) and
 * exits 0 when everything required is present, 1 otherwise. Only checks that
 * run by default are required; opt-in/disabled/unavailable ones never fail it.
 *
 * One row deliberately describes a shell this process is not in. `doctor` runs
 * in the user's terminal; the gate runs in a hook, which agent harnesses launch
 * from a non-login shell with a different Node. Reporting only what is true here
 * is how `doctor` said `environment ok` about a repo whose gate could not start
 * — see {@link checkNodePin}.
 *
 * Every environment touch (PATH, fs, package.json) goes through an injectable
 * {@link DoctorEnv}, so the logic is unit-testable without a real toolchain.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { arch as osArch, platform as osPlatform } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { Adapter, Slot } from './adapters.js';
import { outDir, outLabel } from './artifacts/index.js';
import { BASELINE_FILE, countGrandfathered, parseBaseline } from './baseline/index.js';
import { AGENTS_IMPORT, CLAUDE_FILES, hasStanza, loadsStanza } from './claude-md.js';
import type { CheckOrigin, CheckrideConfig, ResolvedCheck } from './config.js';
import { resolveChecks, tsTargets } from './config.js';
import { isRecord } from './json.js';
import type { Launch, LaunchContext, MiseAnswer, OverrideCause, PackageManager, Spawn } from './launch/index.js';
import {
  detectPackageManager,
  entryText,
  execTool,
  installCommand,
  isAvailableUnder,
  isPnPInstall,
  launchCheck,
  miseHasInstalled,
  miseWhereVersion,
  nearestPackageManager,
  nixCopy,
  overrideCause,
  overridePin,
  PIN_CHECKRIDE,
  pinChain,
  pinResolution,
  resolveEntry,
  resolveSlotTool,
  setupHint,
} from './launch/index.js';
import type { PinEnv } from './node-pin.js';
import { findPinnedNode, NODE_BIN_VAR, readNodePin, realPinEnv } from './node-pin.js';
import type { Out } from './orchestrator/index.js';
import { enableCandidates, enableEntry, installHint, installSkip, provenanceTag, resolveCommonOptions, selectChecks, withStaticOnly } from './orchestrator/index.js';
import type { PinSourceName } from './packs/index.js';
import { PACKS, TOOLCHAINS, TOOLS } from './packs/index.js';
import type { Unclaimed } from './targets/index.js';
import { checkKeys, checkName, configuredTargets, findUnclaimed, findUnreached, implicitPack, markerAt, unreachedLine } from './targets/index.js';

export type DoctorStatus = 'ok' | 'outdated' | 'missing' | 'unknown' | 'n/a';

/** Why a slot is, or is not, part of the default `checkride` run. */
export type SlotEnablement = 'default' | 'opt-in' | 'disabled' | 'unavailable';

export type DoctorCheck = {
  name: string;
  /** `pin` rows name a tool nothing pins; the rest group as their names say. */
  category: 'env' | 'install' | 'tool' | 'pin' | 'workspace';
  required: boolean;
  status: DoctorStatus;
  found: string | null;
  expected: string | null;
  hint: string | null;
  /** Slot name (category `'tool'` rows only). */
  slot?: string;
  /** Adapter filling the slot, or `null` when nothing does. */
  adapter?: string | null;
  /** Slot enablement (category `'tool'` rows only). */
  enablement?: SlotEnablement;
  /** Why the slot would run, as the run's summary records it (rows whose adapter can run only). */
  origin?: CheckOrigin;
  /** With `origin: 'detected'`, the signal that chose the adapter (the summary's `detected_by`). */
  detectedBy?: string;
  /** In multi-target mode, the target a tool row's check belongs to. */
  target?: string;
  /**
   * The pin source a tool row's tool resolves through, for a check that
   * launches one: read from files, or for a copy from `PATH`, `nix` where a
   * Nix dev shell the repo declares put it there, as a run records it.
   */
  pinSource?: PinSourceName;
  /**
   * With `pinSource`, the version that source names, as a run records it: a
   * file's, such as a lockfile's or `go.mod`'s, the one mise resolved the pin
   * to for `mise`, the `--pins` copy `mise where` finds for `override`, a
   * prefix resolved to the installed release, and for `nix`, the version the
   * copy's store path names.
   */
  toolVersion?: string;
  /** Under `--static-only`, why a static run skips the check: `static-only: <cause>`, the `reason` its summary row records. */
  skip?: string;
};

/** A target as `doctor` lists it: its name, pack and root, relative to the repo root. */
export type DoctorTarget = { name: string; pack: string; root: string };

export type DoctorReport = {
  ok: boolean;
  platform: { os: string; arch: string };
  /** The package manager checkride detected for this repo. */
  packageManager: PackageManager;
  /** `implicit` for a repo checked as one project at its root, `multi-target` once the config declares targets. */
  mode: 'implicit' | 'multi-target';
  /** In implicit mode, the pack that checks the repo, the one its root marks (R2.1). */
  pack?: string;
  /** The targets a multi-target repo declares, in config order. */
  targets?: DoctorTarget[];
  /**
   * The markers no target claims, when the repo's files could be listed: in
   * multi-target mode the ones `unclaimed` reports, and without targets the
   * markers of other languages, which the one implicit project leaves
   * unchecked.
   */
  unclaimed?: Unclaimed[];
  checks: DoctorCheck[];
};

export type DoctorResult = { ok: boolean; report: DoctorReport; exitCode: number };

/**
 * Version probes get a generous budget: Node-CLI startup alone can exceed several
 * seconds on a slow-spawn machine (CI under load, cold caches), and a diagnostic
 * tool must not misread a slow-but-healthy tool as broken. 5s was proven too tight.
 */
const VERSION_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_S = VERSION_TIMEOUT_MS / 1000;

/**
 * `env.version` resolves to this when the probe exceeded {@link VERSION_TIMEOUT_MS} —
 * kept distinct from `null` (the probe ran but its output could not be parsed) so
 * `doctor` reports "timed out" rather than misdiagnosing a hung tool as a parse failure.
 */
export const PROBE_TIMED_OUT = Symbol('checkride.probe.timed-out');

/**
 * Result of a `<cmd> --version` probe: raw output, `{ failed }` with the line
 * that says why when it exited non-zero, `null` if it printed nothing a
 * version can be read from, or {@link PROBE_TIMED_OUT}.
 */
export type VersionProbe = string | { failed: string } | typeof PROBE_TIMED_OUT | null;

/**
 * Result of a `<pm> bin <tool>` probe: the resolved path, `null` when the tool
 * is not a dependency, or {@link PROBE_TIMED_OUT}.
 *
 * The timeout is a distinct answer on purpose. Collapsing it into `null` would
 * report a tool the probe never got an answer about as *missing* and tell the
 * reader to install something they already have.
 */
export type BinProbe = string | typeof PROBE_TIMED_OUT | null;

/** Every environment touch, injectable for tests. */
export type DoctorEnv = {
  which: (cmd: string) => Promise<string | null>;
  version: (cmd: string, args: string[]) => Promise<VersionProbe>;
  /** `<pm> bin <tool>` — the tool's resolved path, `null` if it does not resolve, or {@link PROBE_TIMED_OUT}. */
  binPath: (pm: PackageManager, tool: string, cwd: string) => Promise<BinProbe>;
  exists: (path: string) => boolean;
  /** Read a UTF-8 file; `null` when unreadable. */
  readText: (path: string) => string | null;
  canWrite: (dir: string) => Promise<boolean>;
  /** The names in a directory, `null` when it can't be read. Omitted, nothing is listed, and the install row asks only {@link exists}. */
  listDir?: (dir: string) => readonly string[] | null;
  readEngines: (cwd: string) => { node?: string; pnpm?: string };
  platform: () => { os: string; arch: string };
  packageManager: (cwd: string) => PackageManager;
  /**
   * `mise where <spec>` run by the `mise` at `mise`, asked from `at.cwd` as a
   * `--pins` run asks it, offline and reading no config file inside the repo
   * at `at.repo` (D83): the directory mise installed that copy in, on stdout,
   * or why it can't run it.
   */
  miseWhere: (mise: string, spec: string, at: { cwd: string; repo: string }) => Promise<MiseAnswer>;
  /** The launcher a run spawns each check through, which `--static-only` asks whether a check's tool resolves without an install. */
  launch: (slot: string, command: string, args: readonly string[], ctx: LaunchContext) => Launch;
  /**
   * Whether `found`, the copy of a tool `PATH` holds for a check in `at.cwd`,
   * is a Nix dev shell's the repo declares, and the version its store path
   * names, as a run classifies it. Omitted, the real one, under this process's
   * environment.
   */
  nixCopy?: (found: string, at: { cwd: string; repo: string }) => { version?: string } | null;
};

export type DoctorOptions = {
  cwd?: string;
  json?: boolean;
  stdout?: Out;
  /** Where a warning about the config goes, such as a key nothing reads; `process.stderr` by default. */
  stderr?: Out;
  slots?: readonly Slot[];
  adapters?: readonly Adapter[];
  config?: CheckrideConfig | null;
  env?: DoctorEnv;
  /** The Node-pin surface; injectable so the hook-context row is testable. */
  pinEnv?: PinEnv;
  /** The output directory `--out` or `CHECKRIDE_OUT` named, which the workspace row probes instead of `<cwd>/.check`. */
  out?: string;
  /** The defaults layer `--defaults` or `CHECKRIDE_DEFAULTS` named, whose entries fill the slots the repo leaves empty, as in a run. */
  defaults?: CheckrideConfig | null;
  /** The `--pins` or `CHECKRIDE_PINS` file and the tools it pins, by mise id: an `override` source heads every chain, as in a run (R13.3). */
  pins?: { path: string; tools: ReadonlyMap<string, string> };
  /** `--static-only`: report each check a static run skips, with its reason, and fail none for a missing install (R13.4). */
  staticOnly?: boolean;
};

type Semver = { major: number; minor: number; patch: number; raw: string };

const execFileP = promisify(execFile);

const INSTALL_HINTS: Record<string, string> = {
  node: 'Install Node >=22.18: https://nodejs.org/ or `nvm install 22 && nvm use 22`',
  pnpm: 'Install pnpm >=9: `corepack enable && corepack prepare pnpm@latest --activate`',
  git: 'Install git: https://git-scm.com/downloads',
};

async function whichReal(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(process.platform === 'win32' ? 'where' : 'which', [cmd]);
    const first = stdout.split('\n').find((l) => l.trim());
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

/**
 * A `<cmd> --version` probe that exceeded its timeout: promisified `execFile` rejects
 * with `killed: true` when it kills the child on timeout — the only reason it kills here.
 */
export function isProbeTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'killed' in err && err.killed === true;
}

async function versionReal(cmd: string, args: string[]): Promise<VersionProbe> {
  try {
    const { stdout } = await execFileP(cmd, args, { timeout: VERSION_TIMEOUT_MS });
    return stdout.trim();
  } catch (err) {
    return isProbeTimeout(err) ? PROBE_TIMED_OUT : { failed: probeFailure(err) };
  }
}

/** One stream of a rejected `execFile`, as text, or `''`. */
function streamOf(err: unknown, stream: 'stdout' | 'stderr'): string {
  const text = isRecord(err) ? err[stream] : undefined;
  return typeof text === 'string' ? text : '';
}

/**
 * Why a probe that exited non-zero failed, in one line: the setup step its
 * output names, as a run's status line would say it (a pnpm the repo's
 * `packageManager` pin refuses, say), else the first line naming an error,
 * pnpm's `ERR_PNPM_*` codes included, else its first line, else how it ended.
 */
export function probeFailure(err: unknown): string {
  const stdout = streamOf(err, 'stdout');
  const stderr = streamOf(err, 'stderr');
  const hint = setupHint({ stdout, stderr });
  if (hint !== null) return hint;
  const lines = `${stderr}\n${stdout}`.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /\bERR_|error/i.test(line)) ?? lines[0] ?? (err instanceof Error ? err.message.trim() : 'exited non-zero');
}

/**
 * Ask the package manager where a tool's binary is — the only way to answer that
 * under Yarn PnP, where no `node_modules/.bin` exists to stat.
 *
 * `yarn bin <tool>` prints the resolved path and exits 0, or exits 1 when the
 * tool is not a dependency, so the exit code carries the whole answer. Shares
 * the version probe's timeout: this spawns a package manager, and a doctor that
 * hangs is worse than one that reports a tool unresolved.
 *
 * A timeout is reported as {@link PROBE_TIMED_OUT} rather than folded into
 * `null`, for the same reason the version probe distinguishes it: "the probe
 * never answered" is not "the tool is absent", and the remediation for the
 * second is wrong advice for the first.
 */
async function binPathReal(pm: PackageManager, tool: string, cwd: string): Promise<BinProbe> {
  try {
    const { stdout } = await execFileP(pm, ['bin', tool], { cwd, timeout: VERSION_TIMEOUT_MS });
    const path = stdout.trim();
    return path.length > 0 ? path : null;
  } catch (err) {
    return isProbeTimeout(err) ? PROBE_TIMED_OUT : null;
  }
}

async function canWriteReal(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${process.pid}`);
    await writeFile(probe, '');
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function readEnginesReal(cwd: string): { node?: string; pnpm?: string } {
  try {
    const raw = readFileSync(join(cwd, 'package.json'), 'utf8');
    const pkg: { engines?: { node?: string; pnpm?: string } } = JSON.parse(raw);
    return pkg.engines ?? {};
  } catch {
    return {};
  }
}

function readTextReal(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Whether a copy from `PATH` is a Nix dev shell's, under this process's environment, as a run asks it. */
function realNixCopy(found: string, at: { cwd: string; repo: string }): { version?: string } | null {
  return nixCopy(found, { ...at, env: process.env });
}

function listDirReal(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

const realEnv: DoctorEnv = {
  which: whichReal,
  version: versionReal,
  binPath: binPathReal,
  exists: existsSync,
  readText: readTextReal,
  canWrite: canWriteReal,
  listDir: listDirReal,
  readEngines: readEnginesReal,
  platform: () => ({ os: osPlatform(), arch: osArch() }),
  packageManager: (cwd) => detectPackageManager({ cwd }),
  miseWhere: (mise, spec, at) => Promise.resolve(miseHasInstalled(mise, spec, at, process.env)),
  launch: launchCheck,
  nixCopy: realNixCopy,
};

function parseSemver(text: string | null | undefined): Semver | null {
  if (!text) return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: m[0] };
}

function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function formatExpected(min: Semver): string {
  return `>=${min.major}.${min.minor}.${min.patch}`;
}

async function checkVersioned(name: string, cmd: string, min: Semver, env: DoctorEnv): Promise<DoctorCheck> {
  const expected = formatExpected(min);
  const asked = await askVersion(name, cmd, expected, env);
  if ('row' in asked) return asked.row;
  const found = parseSemver(asked.raw);
  if (!found) {
    return { name, category: 'env', required: true, status: 'unknown', found: null, expected, hint: `Could not parse \`${cmd} --version\` output.` };
  }
  if (compareSemver(found, min) < 0) {
    return { name, category: 'env', required: true, status: 'outdated', found: found.raw, expected, hint: INSTALL_HINTS[name] ?? `Upgrade \`${cmd}\` to ${expected}.` };
  }
  return { name, category: 'env', required: true, status: 'ok', found: found.raw, expected, hint: null };
}

async function checkPresent(name: string, cmd: string, env: DoctorEnv): Promise<DoctorCheck> {
  const expected = 'present on PATH';
  const asked = await askVersion(name, cmd, expected, env);
  if ('row' in asked) return asked.row;
  return { name, category: 'env', required: true, status: 'ok', found: asked.raw ?? asked.path, expected, hint: null };
}

/**
 * `cmd`'s answer to `--version`, with where `PATH` found it, or the row that
 * says why there is none: it isn't on `PATH`, or its probe gave no answer
 * ({@link unansweredProbe}).
 */
async function askVersion(name: string, cmd: string, expected: string, env: DoctorEnv): Promise<{ row: DoctorCheck } | { raw: string | null; path: string }> {
  const path = await env.which(cmd);
  if (!path) {
    return { row: { name, category: 'env', required: true, status: 'missing', found: null, expected, hint: INSTALL_HINTS[name] ?? `Install \`${cmd}\`.` } };
  }
  const raw = await env.version(cmd, ['--version']);
  const unanswered = unansweredProbe(cmd, raw);
  if (unanswered !== null) return { row: { name, category: 'env', required: true, status: 'unknown', found: null, expected, hint: unanswered } };
  return { raw: typeof raw === 'string' ? raw : null, path };
}

/**
 * The hint for a `<cmd> --version` that gave no answer: one that timed out,
 * or one that exited non-zero, with the line that says why, such as a
 * package manager refusing the repo's `packageManager` pin. `null` for one
 * that answered, whatever it printed.
 */
function unansweredProbe(cmd: string, raw: VersionProbe): string | null {
  if (raw === PROBE_TIMED_OUT) return `\`${cmd} --version\` timed out (>${VERSION_TIMEOUT_S}s). Is ${cmd} responsive?`;
  if (raw !== null && typeof raw === 'object') return `\`${cmd} --version\` failed: ${raw.failed}`;
  return null;
}

/** Lockfiles that count as "installed" for each package manager. */
const PM_LOCKFILES: Record<PackageManager, readonly string[]> = {
  pnpm: ['pnpm-lock.yaml'],
  npm: ['package-lock.json'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
};

/**
 * pnpm has a documented `>=9` floor; npm, yarn, and bun are presence-only
 * (no per-PM minimums pinned). A root with no `package.json` has no package
 * manager to run anything, as {@link checkInstall} has no install to check
 * there, so its row is `n/a` and never required (D84).
 */
async function checkPackageManager(cwd: string, pm: PackageManager, pnpmMin: Semver, env: DoctorEnv): Promise<DoctorCheck> {
  if (!env.exists(join(cwd, 'package.json'))) {
    return { name: pm, category: 'env', required: false, status: 'n/a', found: 'no package.json', expected: null, hint: null };
  }
  return pm === 'pnpm' ? checkVersioned('pnpm', 'pnpm', pnpmMin, env) : checkPresent(pm, pm, env);
}

/**
 * Is the project installed? Lockfile plus the linker's own install artifact.
 *
 * Under Yarn PnP that artifact is `.pnp.cjs`, not a `node_modules/` directory —
 * a PnP repo never has one, so asserting the directory reported every correctly
 * installed PnP project as "lockfile only" and made `doctor` exit 1 on a repo
 * whose checks all pass.
 *
 * Under a `node_modules` linker the artifact is the marker the manager writes
 * as an install finishes ({@link finishedInstall}), not the directory: an
 * install that failed part-way can leave an empty `node_modules/` behind.
 *
 * A root with no `package.json`, a Go or Rust project or a scaffold that runs
 * checkride through mise, has no Node install to check, so its row is `n/a`
 * and never required.
 */
function checkInstall(cwd: string, pm: PackageManager, env: DoctorEnv): DoctorCheck {
  const locks = PM_LOCKFILES[pm];
  const hint = `Run \`${pm} install\` from the repo root.`;
  const base = { name: 'install', category: 'install' as const, required: true };
  if (!env.exists(join(cwd, 'package.json'))) {
    return { ...base, required: false, status: 'n/a', found: 'no package.json', expected: null, hint: null };
  }
  if (!locks.some((lock) => env.exists(join(cwd, lock)))) {
    return { ...base, status: 'missing', found: null, expected: `${locks.join(' or ')} present`, hint };
  }
  // PnP is a Yarn feature; gating on the manager keeps a stale `.pnp.cjs` left
  // behind by a migration off Yarn from rerouting an npm or pnpm repo.
  if (pm === 'yarn' && isPnPInstall(cwd, env.exists)) {
    return { ...base, status: 'ok', found: '.pnp.cjs + lockfile (Yarn PnP)', expected: null, hint: null };
  }
  if (!env.exists(join(cwd, 'node_modules'))) {
    return { ...base, status: 'missing', found: 'lockfile only', expected: 'node_modules/ populated', hint };
  }
  if (!finishedInstall(join(cwd, 'node_modules'), pm, env)) {
    const unfinished = `Run \`${pm} install\` from the repo root: node_modules/ is there, but no ${pm} install finished in it.`;
    return { ...base, status: 'missing', found: 'node_modules, no finished install', expected: installExpected(pm), hint: unfinished };
  }
  return { ...base, status: 'ok', found: 'node_modules + lockfile', expected: null, hint: null };
}

/**
 * The file each package manager writes into `node_modules/` as an install
 * finishes, which an install that failed part-way leaves out: pnpm's
 * `.modules.yaml`, npm's hidden lockfile, and Yarn's `.yarn-integrity`
 * (classic) or `.yarn-state.yml` (Berry's node-modules linker). bun writes
 * none, so for bun a package directory has to do.
 */
const INSTALL_MARKERS: Record<PackageManager, readonly string[]> = {
  pnpm: ['.modules.yaml'],
  npm: ['.package-lock.json'],
  yarn: ['.yarn-integrity', '.yarn-state.yml'],
  bun: [],
};

/** What the install row expects in `node_modules/` from `pm`. */
function installExpected(pm: PackageManager): string {
  const markers = INSTALL_MARKERS[pm];
  return markers.length === 0 ? 'node_modules/ holding a package' : `node_modules/${markers.join(' or node_modules/')}`;
}

/**
 * Whether an install by `pm` finished in `dir`, a `node_modules/`: its marker
 * is there, or, for bun, which writes none, a package is. A listing that
 * can't be read can't tell, so it passes, as it always did.
 */
function finishedInstall(dir: string, pm: PackageManager, env: DoctorEnv): boolean {
  const markers = INSTALL_MARKERS[pm];
  if (markers.length > 0) return markers.some((marker) => env.exists(join(dir, marker)));
  const names = env.listDir?.(dir) ?? null;
  return names === null || names.some((name) => !name.startsWith('.'));
}

/**
 * The install row as `--static-only` reads it: a warning that fails nothing,
 * since a static run skips each check whose tool needs the install, and its
 * row says so, rather than fail for a checkout nobody has installed yet.
 */
function staticInstall(row: DoctorCheck): DoctorCheck {
  if (row.status === 'ok' || !row.required) return row;
  return { ...row, required: false, status: 'outdated', hint: `${row.hint ?? ''} A --static-only run needs no install: it skips each check whose tool does.`.trim() };
}

type ToolProbe = { status: DoctorStatus; found: string | null; expected: string | null; hint: string | null; pinSource?: PinSourceName; toolVersion?: string };

/**
 * Where a check's tool is looked up: the directory it runs from, the repo
 * root, its pin chain and package manager, and the `--pins` file's tools,
 * which an `override` source at the head of that chain reads.
 */
type ProbeAt = { cwd: string; repo: string; pins: readonly PinSourceName[]; pm: PackageManager; overrides?: ReadonlyMap<string, string> };

/**
 * Where a slot's tool has to be, and whether it is there.
 *
 * Two layouts, two questions. Under a `node_modules` install the lookup walks
 * `cwd` upward via {@link resolveSlotTool}, so a workspace tool hoisted to the
 * repo root reports `ok` from a package subdirectory instead of a false
 * `missing`. Under Yarn PnP there is no `node_modules/.bin` to stat at all, so
 * the question goes to the resolver that owns the answer: `<pm> bin <tool>`
 * prints the path and exits 0, or exits 1. Gated on yarn for the same reason as
 * {@link checkInstall} — a `.pnp.cjs` left by a migration off Yarn must not
 * reroute an npm or pnpm repo.
 *
 * Either way a tool that does not resolve reports `missing`: the PnP path asks a
 * looser question, not a softer one.
 */
async function probeExecTool(tool: string, cwd: string, pm: PackageManager, env: DoctorEnv): Promise<ToolProbe> {
  // The hint names the detected manager's own install command — the row a reader
  // lands on when a slot is red is the wrong place to be told to run another PM.
  const missing = (expected: string): ToolProbe => ({
    status: 'missing',
    found: null,
    expected,
    hint: `Run \`${pm} install\`, or declare it: \`${installCommand(pm, tool)}\`.`,
  });
  if (pm === 'yarn' && isPnPInstall(cwd, env.exists)) {
    const expected = `resolvable via \`${pm} bin ${tool}\``;
    const resolved = await env.binPath(pm, tool, cwd);
    // A probe that never answered is `unknown`, not `missing` — the same
    // treatment `checkVersioned` gives a timed-out `--version`. Reporting it as
    // missing would advise installing a tool that may well be right there.
    if (resolved === PROBE_TIMED_OUT) {
      return { status: 'unknown', found: null, expected, hint: `\`${pm} bin ${tool}\` timed out (>${VERSION_TIMEOUT_S}s). Is ${pm} responsive?` };
    }
    return resolved ? { status: 'ok', found: resolved, expected, hint: null } : missing(expected);
  }
  const bin = resolveSlotTool(cwd, tool, env.exists);
  return bin
    ? { status: 'ok', found: bin, expected: `node_modules/.bin/${tool}`, hint: null }
    : missing(`node_modules/.bin/${tool}`);
}

/**
 * A tool nothing declares, run from `PATH`: a Nix dev shell's copy records
 * `nix` and the version its store path names, as a run records it, and any
 * other copy is unpinned.
 */
async function probePathTool(tool: string, at: ProbeAt, env: DoctorEnv): Promise<ToolProbe> {
  const path = await env.which(tool);
  const expected = `${tool} on PATH`;
  if (!path) return { status: 'missing', found: null, expected, hint: `${installHint(tool)}.` };
  return { status: 'ok', found: path, expected, hint: null, ...nixFields((env.nixCopy ?? realNixCopy)(path, at)) };
}

/** The pin a probe records for a Nix dev shell's copy, with its version when the store path names one; none for any other copy. */
function nixFields(nix: { version?: string } | null): Pick<ToolProbe, 'pinSource' | 'toolVersion'> {
  if (nix === null) return {};
  return { pinSource: 'nix', ...(nix.version !== undefined ? { toolVersion: nix.version } : {}) };
}

/**
 * A refusal as a row's hint: its cause and remedy in the run's own words, on
 * the one line every hint takes, its `checkride: ` prefix dropped as a skip
 * reason drops it.
 */
function refusalHint(refusal: string): string {
  const lines = refusal.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines.join(' ').replace(/^checkride:\s*/, '');
}

/**
 * What a launch spawns, up to the tool it picks and no further: `go tool
 * deadcode`, `mise exec -- go tool deadcode`, `cargo clippy` or
 * `.venv/bin/ruff`, with the check's own arguments, the `toolArgs` after
 * `pnpm exec <tool>`, left off.
 */
function spawnShown(spawn: Spawn, toolArgs: readonly string[]): string {
  return [spawn.command, ...spawn.args.slice(0, spawn.args.length - toolArgs.length)].join(' ');
}

/** The pin a probe records for a launch, as a run records it: the source it resolved through, and the version that source named. */
function launchPin(pin: Spawn['pin']): Pick<ToolProbe, 'pinSource' | 'toolVersion'> {
  return pin === undefined ? {} : { pinSource: pin.source, ...(pin.version !== undefined ? { toolVersion: pin.version } : {}) };
}

/**
 * A tool a pin file declares, a language's own or a `mise.toml`, probed by
 * asking the run's launcher, as `--static-only` asks it (D84): the launcher
 * holds each source's rules and remedies, so the row is `ok` where it would
 * spawn, naming what it spawns and the pin it records, and `missing` where it
 * would refuse, its hint the refusal, such as a version mise pins and hasn't
 * installed.
 */
function probeLaunch(launch: Launch, declaredBy: string | null, source: PinSourceName, toolArgs: readonly string[]): ToolProbe {
  const expected = `declared in ${declaredBy ?? source}`;
  if ('refusal' in launch) return { status: 'missing', found: null, expected, hint: refusalHint(launch.refusal) };
  return { status: 'ok', found: spawnShown(launch, toolArgs), expected, hint: null, ...launchPin(launch.pin) };
}

/**
 * Probe a tool where its pin source says it comes from, recording that
 * source. `unknown` stays for a source this checkride can't read, which may
 * be the one that declares the tool.
 */
async function probeExecPin(tool: string, toolArgs: readonly string[], at: ProbeAt, env: DoctorEnv, launch: () => Launch): Promise<ToolProbe> {
  const pin = pinResolution(tool, at);
  if (pin === null) {
    return { status: 'unknown', found: null, expected: null, hint: `\`${tool}\` resolves through a pin source this checkride can't read. Upgrade checkride.` };
  }
  const viaLauncher = (): Promise<ToolProbe> => Promise.resolve(probeLaunch(launch(), pin.declaredBy, pin.source, toolArgs));
  const probes: { readonly [K in PinSourceName]?: () => Promise<ToolProbe> } = {
    'js-lockfile': () => probeExecTool(tool, at.cwd, at.pm, env),
    mise: viaLauncher,
    path: () => probePathTool(tool, at, env),
    'go-mod-tool': viaLauncher,
    'rust-toolchain': viaLauncher,
    'uv-lock': viaLauncher,
  };
  const probe = await (probes[pin.source]?.() ?? Promise.resolve<ToolProbe>({ status: 'unknown', found: null, expected: null, hint: null }));
  // A probe that classified the copy it found, as `path` does a Nix shell's, names its own source.
  return { pinSource: pin.source, ...probe };
}

/** What each override refusal asks for, by cause, as the run's refusal for the same pin does (D83). */
const OVERRIDE_HINTS: Readonly<Record<OverrideCause, (spec: string, why: Extract<MiseAnswer, { ok: false }>) => string>> = {
  uninstalled: (spec, why) => `mise where ${spec}: ${why.detail}. Checks never install a tool: run \`mise install ${spec}\`.`,
  untrusted: (_spec, why) =>
    `mise won't read ${why.config ?? 'a config file above the repo'} until it's trusted. --pins skips only the config files inside the repo: review that one, then run \`mise trust\` beside it.`,
  'repo-config': () =>
    'mise read a config file inside the repo, which --pins names in MISE_IGNORED_CONFIG_PATHS for it to skip, so this mise ignores that variable. Upgrade mise rather than trust a repo you may be reviewing.',
};

/**
 * A tool the `--pins` file pins, probed as a run's `override` source asks
 * for it: `mise where <id>@<version>`, which names the directory mise
 * installed that copy in, so the row reports the version a prefix resolved
 * to, or names a version mise hasn't installed, since a run fails that check
 * rather than download it (R13.3).
 */
async function probeOverride(pin: { bin: string; id: string; version: string }, at: ProbeAt, env: DoctorEnv): Promise<ToolProbe> {
  const spec = `${pin.id}@${pin.version}`;
  const base = { expected: `${spec} installed`, pinSource: 'override' as const };
  const mise = await env.which('mise');
  if (mise === null) {
    return { ...base, status: 'missing', found: null, hint: `--pins runs \`${pin.bin}\` as ${spec} through mise, which isn't on PATH. Install mise (https://mise.jdx.dev).` };
  }
  const where = await env.miseWhere(mise, spec, { cwd: at.cwd, repo: at.repo });
  if (!where.ok) return { ...base, status: 'missing', found: null, hint: OVERRIDE_HINTS[overrideCause(at.repo, where)](spec, where) };
  const dir = where.stdout.trim().split('\n').at(-1)?.trim() ?? '';
  return { ...base, status: 'ok', found: dir, toolVersion: miseWhereVersion(where) ?? pin.version, hint: null };
}

/**
 * Whether a run resolves `command` as a toolchain through its check's chain,
 * as the launcher does: `go`, `gofmt`, `cargo` or `terraform`, in a chain
 * that reads `mise`, the go, rust and terraform packs'. Anywhere else the
 * command spawns as written.
 */
function launchesToolchain(command: string, pins: readonly PinSourceName[]): boolean {
  return pins.includes('mise') && TOOLCHAINS.some((t) => t.bin === command);
}

/**
 * A toolchain's own executable, probed by asking the run's launcher, which
 * picks the copy a run spawns: the CLI a Terraform version file names at the
 * release it names, rustup's `cargo` where a toolchain file pins it, the `go`
 * a `mise.toml` pins, or the one on `PATH`. `ok` names that spawn, with the
 * source it resolved through and the version that source read, and `missing`
 * carries the refusal a run would fail the check with, so a repo pinned to
 * OpenTofu reads as one, not as a missing `terraform`.
 */
function probeToolchain(launch: Launch, toolArgs: readonly string[]): ToolProbe {
  if ('refusal' in launch) return { status: 'missing', found: null, expected: null, hint: refusalHint(launch.refusal) };
  return { status: 'ok', found: spawnShown(launch, toolArgs), expected: null, hint: null, ...launchPin(launch.pin) };
}

/**
 * Presence-only probe: does the adapter's tool resolve? Dispatch by adapter
 * shape, after the copy a `--pins` file pins, which runs ahead of every
 * source the repo declares. `launch` asks the run's launcher what it would
 * spawn for the check, for the sources and toolchains only it can answer for.
 */
async function probeTool(adapter: Adapter, at: ProbeAt, env: DoctorEnv, launch: () => Launch): Promise<ToolProbe> {
  if (adapter.builtin) {
    return { status: 'ok', found: 'built-in', expected: null, hint: null };
  }
  const pinned = overridePin(adapter.command, adapter.args, at);
  if (pinned !== null) return probeOverride(pinned, at, env);
  if (adapter.command === 'pnpm' && adapter.args[0] === 'exec') {
    const tool = execTool(adapter.command, adapter.args);
    if (!tool) return { status: 'unknown', found: null, expected: null, hint: null };
    return probeExecPin(tool, adapter.args.slice(2), at, env, launch);
  }
  if (launchesToolchain(adapter.command, at.pins)) return probeToolchain(launch(), adapter.args);
  const path = await env.which(adapter.command);
  return path
    ? { status: 'ok', found: path, expected: `${adapter.command} on PATH`, hint: null }
    : { status: 'missing', found: null, expected: `${adapter.command} on PATH`, hint: `Install \`${adapter.command}\`.` };
}

/**
 * What an unavailable check could be turned on with: its own pack's
 * candidate adapters, or `adapters` for a check with no pack, each with what
 * would turn it on, as the run's vacuous-green warning names them, led by a
 * candidate's copy `PATH` already holds, when there is one.
 */
async function possibilitiesHint(r: ResolvedCheck, at: ProbeAt, ctx: SlotContext): Promise<string | null> {
  const candidates = enableCandidates(r.slot, r.pack, ctx.adapters);
  if (candidates.length === 0) return null;
  const enable = `Enable by adding one of: ${candidates.map((a) => enableEntry(a, false)).join(', ')}.`;
  const onPath = await copyOnPath(candidates, at, ctx.env);
  return onPath === null ? enable : `${onPath}, but nothing in the repo turns the slot on. ${enable}`;
}

/**
 * A candidate's tool that `PATH` already holds, as a hint leads with it:
 * `shellcheck is on PATH (0.10.0, nix)`, classed as a run would class the
 * copy, or `null`. A copy in a dev shell turns no slot on, since detection
 * reads only the repo, and someone who sees it run in their shell needs to
 * hear why the check doesn't. Only in a chain that would run a copy from
 * `PATH`, so a ts repo is never pointed at one its package manager won't run.
 */
async function copyOnPath(candidates: readonly Adapter[], at: ProbeAt, env: DoctorEnv): Promise<string | null> {
  if (!at.pins.includes('path')) return null;
  const tools = [...new Set(candidates.map((a) => execTool(a.command, a.args)).filter((tool) => tool !== null))];
  const found = await Promise.all(tools.map(async (tool) => ({ tool, path: await env.which(tool) })));
  const first = found.find((f): f is { tool: string; path: string } => f.path !== null);
  if (first === undefined) return null;
  return `${first.tool} is on PATH (${copyLabel(first.path, (env.nixCopy ?? realNixCopy)(first.path, at))})`;
}

/** How a hint names a copy on `PATH`: a Nix dev shell's by its version, any other by its path. */
function copyLabel(path: string, nix: { version?: string } | null): string {
  if (nix === null) return path;
  return nix.version === undefined ? 'nix' : `${nix.version}, nix`;
}

/** The shared prefix of every `tool`-category doctor row: the check's name in the slot column, and its target. */
type ToolRowBase = { category: 'tool'; slot: string; adapter: string | null; target?: string };

/** The reason resolution gives a check its config switched off. */
const DISABLED_REASON = 'disabled in checkride.config.json';

/**
 * A row for a slot that is off but not simply missing its tool — disabled in
 * config, or its adapter can't run under this PM. `null` when neither applies
 * (the caller then handles the no-adapter case and the live probe).
 */
function offRow(base: ToolRowBase, r: ResolvedCheck, adapter: Adapter | null, pm: PackageManager): DoctorCheck | null {
  // Explicitly disabled in config, at any layer: off by the user's choice.
  if (adapter === null && r.skip === DISABLED_REASON) {
    return { ...base, name: base.slot, required: false, status: 'n/a', enablement: 'disabled', found: DISABLED_REASON, expected: null, hint: null };
  }
  // Adapter is PM-specific and can't run here — for example `pnpm audit` off pnpm.
  if (adapter && !isAvailableUnder(adapter.command, adapter.args, pm)) {
    return { ...base, name: base.slot, required: false, status: 'n/a', enablement: 'unavailable', found: `unavailable under ${pm}`, expected: null, hint: `\`${adapter.command} ${adapter.args[0]}\` is pnpm-specific; the ${r.slot} slot needs pnpm for now.` };
  }
  return null;
}

/**
 * What each publish built-in slot inspects — surfaced as a doctor note so an
 * always-available opt-in slot explains what it would check.
 * `build`'s signal (`scripts.build`) already rides its `detectScript` detection,
 * so it isn't repeated here.
 */
const PUBLISH_INSPECTS: Record<string, string> = {
  pack: "the package's exports/main/types/bin + README against the packed tarball's file list",
  smoke: "the package's exports (fallback main) — the built entry points import cleanly",
  snippets: 'doc fences tagged `<!-- snippet: check -->` in README.md and docs/*.md',
};

/**
 * The inspection clause for a publish built-in row, or '' for every other
 * row: another pack's adapter in one of those slots, as Rust's doctests fill
 * `snippets`, inspects something else.
 */
function inspectsClause(adapter: Adapter, slot: string): string {
  const inspects = adapter.builtin === undefined ? undefined : PUBLISH_INSPECTS[slot];
  return inspects ? ` Inspects ${inspects}.` : '';
}

/** A row for a slot whose adapter is runnable: probe result classified by default-run membership. */
function toolRow(
  base: ToolRowBase,
  r: ResolvedCheck,
  adapter: Adapter,
  defaultActive: ReadonlySet<string>,
  probe: ToolProbe,
): DoctorCheck {
  const isDefault = defaultActive.has(base.slot);
  const enablement: SlotEnablement = isDefault ? 'default' : 'opt-in';
  const lead = isDefault
    ? probe.hint
    : `Opt-in — run with \`--include ${base.slot}\` or \`--all\`.${probe.status === 'missing' ? ' Tool not installed.' : ''}`;
  const body = `${lead ?? ''}${inspectsClause(adapter, r.slot)}`.trim();
  const hint = body.length > 0 ? body : null;
  const pin = {
    ...(probe.pinSource !== undefined ? { pinSource: probe.pinSource } : {}),
    ...(probe.toolVersion !== undefined ? { toolVersion: probe.toolVersion } : {}),
  };
  return { ...base, name: `${adapter.name} (${base.slot})`, required: isDefault, status: probe.status, enablement, found: probe.found, expected: probe.expected, hint, ...provenanceOf(r), ...pin };
}

/** Why a check would run, as the run's summary records it: its `origin`, and with `detected` the signal that chose it. */
function provenanceOf(r: ResolvedCheck): Pick<DoctorCheck, 'origin' | 'detectedBy'> {
  return {
    ...(r.origin !== undefined ? { origin: r.origin } : {}),
    ...(r.detectedBy !== undefined ? { detectedBy: r.detectedBy } : {}),
  };
}

/**
 * A row for a check a `--static-only` run skips, with the reason its summary
 * row would give. It fails nothing, whether or not it runs by default, since
 * the run skips it rather than fail it, and its tool goes unprobed, since
 * nothing would launch it.
 */
function skipRow(base: ToolRowBase, r: ResolvedCheck, adapter: Adapter, defaultActive: ReadonlySet<string>, skip: string): DoctorCheck {
  const enablement: SlotEnablement = defaultActive.has(base.slot) ? 'default' : 'opt-in';
  return { ...base, name: `${adapter.name} (${base.slot})`, required: false, status: 'n/a', enablement, found: null, expected: null, hint: null, skip, ...provenanceOf(r) };
}

/**
 * What every slot row reads: the repo root, the checks a default run runs,
 * the adapters, the package manager per directory, the env, and how a run
 * would launch each check: its pin chain, the `--pins` file's tools, whether
 * an unpinned tool fails, and whether the run is `--static-only`.
 */
type SlotContext = {
  repo: string;
  defaultActive: ReadonlySet<string>;
  adapters: readonly Adapter[];
  pmAt: (dir: string) => PackageManager;
  env: DoctorEnv;
  chainOf: (r: ResolvedCheck) => readonly PinSourceName[];
  overrides?: ReadonlyMap<string, string>;
  requirePins: boolean;
  staticOnly: boolean;
};

/** The directory a check runs from: its target's root, else the repo root. */
function checkDir(repo: string, r: ResolvedCheck): string {
  return r.root === undefined ? repo : join(repo, r.root);
}

/**
 * Build a doctor row for one resolved check, classified by enablement, with
 * `staticSkip` the reason a `--static-only` run's sniffs skip it with, if
 * they do. Only `default` checks are required; `opt-in`, `disabled`,
 * `unavailable` and skipped ones are surfaced for visibility but never fail
 * the report.
 */
async function classifySlot(r: ResolvedCheck, ctx: SlotContext, staticSkip: string | null): Promise<DoctorCheck> {
  const base = rowBase(r);
  const { adapter } = r;
  const where = launchAt(r, ctx);
  const at: ProbeAt = { ...where, pm: ctx.pmAt(where.cwd) };

  const off = offRow(base, r, adapter, at.pm);
  if (off) return off;
  // No adapter fills the slot: nothing to run. Point at what would enable it.
  if (!adapter) {
    return { ...base, name: base.slot, required: false, status: 'n/a', enablement: 'unavailable', found: r.skip ?? 'no tool detected', expected: null, hint: await possibilitiesHint(r, at, ctx) };
  }
  const skip = ctx.staticOnly ? (staticSkip ?? needsInstall(r, adapter, at, ctx)) : null;
  if (skip !== null) return skipRow(base, r, adapter, ctx.defaultActive, skip);
  // Adapter resolved: probe the tool where its pin chain finds it, classify by default-run membership.
  const probe = await probeTool(adapter, at, ctx.env, () => askLauncher(r, adapter, at, ctx));
  return toolRow(base, r, adapter, ctx.defaultActive, probe);
}

/** The prefix of a check's row: its name in the slot column, its adapter, and its target. */
function rowBase(r: ResolvedCheck): ToolRowBase {
  return { category: 'tool', slot: checkName(r), adapter: r.adapter?.name ?? null, ...(r.target !== undefined ? { target: r.target } : {}) };
}

/** Where a run launches a check from, and the chain and `--pins` tools its tool resolves through. */
function launchAt(r: ResolvedCheck, ctx: Pick<SlotContext, 'repo' | 'chainOf' | 'overrides'>): Omit<ProbeAt, 'pm'> {
  return { cwd: checkDir(ctx.repo, r), repo: ctx.repo, pins: ctx.chainOf(r), ...(ctx.overrides !== undefined ? { overrides: ctx.overrides } : {}) };
}

/** The tool a check launches through `pnpm exec`, or `null` for a built-in, a slot with no adapter, or any other command. */
function launchedTool(r: ResolvedCheck): string | null {
  return r.adapter === null || r.adapter.builtin !== undefined ? null : execTool(r.adapter.command, r.adapter.args);
}

/**
 * What a run would spawn for `adapter`'s check from `at`, or the refusal it
 * would fail with, asked of the launcher the run spawns it through, with the
 * chain, `--pins` tools and flags that run would give it.
 */
function askLauncher(r: ResolvedCheck, adapter: Adapter, at: ProbeAt, ctx: SlotContext): Launch {
  return ctx.env.launch(r.slot, adapter.command, adapter.args, {
    cwd: at.cwd,
    pm: at.pm,
    repo: at.repo,
    pins: at.pins,
    requirePins: ctx.requirePins,
    staticOnly: ctx.staticOnly,
    ...(at.overrides !== undefined ? { overrides: at.overrides } : {}),
  });
}

/**
 * Under `--static-only`, the reason a kept check is skipped because its tool
 * needs an install, asked of the launcher a run spawns it through, which
 * pre-flights `node_modules/.bin` under every package manager but a PnP
 * install (R13.4), or `null` when its tool resolves as the checkout stands.
 * A built-in launches no tool.
 */
function needsInstall(r: ResolvedCheck, adapter: Adapter, at: ProbeAt, ctx: SlotContext): string | null {
  if (adapter.builtin !== undefined) return null;
  const launch = askLauncher(r, adapter, at, ctx);
  return 'refusal' in launch ? installSkip(launch.refusal) : null;
}

/**
 * Each tool that would run from `PATH` with nothing pinning it, with the
 * checks that run it and whether one runs by default: `unpinned` holds the
 * checks whose row's probe resolved them through `path`, so a tool the
 * `--pins` file pins, or a Nix dev shell's copy, isn't among them, as in a run.
 */
function unpinnedTools(unpinned: readonly ResolvedCheck[], defaultActive: ReadonlySet<string>): Map<string, { checks: string[]; byDefault: boolean }> {
  const tools = new Map<string, { checks: string[]; byDefault: boolean }>();
  for (const r of unpinned) {
    const tool = launchedTool(r);
    if (tool === null) continue;
    const entry = tools.get(tool) ?? { checks: [], byDefault: false };
    tools.set(tool, { checks: [...entry.checks, checkName(r)], byDefault: entry.byDefault || defaultActive.has(checkName(r)) });
  }
  return tools;
}

/**
 * A row for each tool nothing pins: a warning, since its verdict depends on
 * whichever copy a machine's `PATH` holds, and under `requirePins` a failure
 * for a tool a default check runs, since every such check fails.
 */
function unpinnedRows(tools: ReadonlyMap<string, { checks: string[]; byDefault: boolean }>, requirePins: boolean): DoctorCheck[] {
  return [...tools].map(([tool, { checks, byDefault }]) => {
    const id = TOOLS.find((t) => t.bin === tool)?.mise?.[0] ?? tool;
    const one = checks.length === 1;
    const fails = requirePins ? ` requirePins is on, so ${one ? 'it fails' : 'they fail'} until it is.` : '';
    return {
      name: tool,
      category: 'pin',
      required: requirePins && byDefault,
      status: requirePins ? 'missing' : 'outdated',
      found: 'unpinned (from PATH)',
      expected: 'a pin in mise.toml',
      hint: `${checks.join(', ')} ${one ? 'runs' : 'run'} whatever \`${tool}\` PATH holds; pin it with: mise use ${id}@<version>.${fails}`,
    };
  });
}

/** The markers in `found`, as a row names them: the first few, and how many more. */
function markerList(found: readonly Unclaimed[]): string {
  const shown = found.slice(0, 3).map((u) => `${u.path} (${u.kind})`);
  return found.length > 3 ? `${shown.join(', ')} and ${found.length - 3} more` : shown.join(', ');
}

/**
 * The workspace row for the markers no target claims: in multi-target mode
 * the ones `unclaimed` reports, and without targets, the code of other
 * languages the one implicit project, of pack `implicit`, leaves unchecked, a
 * row only when there is some. A repo whose files can't be listed says so.
 */
function markersRow(found: readonly Unclaimed[] | string, implicit: string | null): DoctorCheck | null {
  const base = { category: 'workspace' as const, required: false, expected: null };
  const multiTarget = implicit === null;
  const name = multiTarget ? 'unclaimed' : 'other languages';
  if (typeof found === 'string') return multiTarget ? { ...base, name, status: 'unknown', found: null, hint: found } : null;
  if (found.length === 0) return multiTarget ? { ...base, name, status: 'ok', found: 'every marker sits in a target', hint: null } : null;
  const hint = multiTarget
    ? 'The unclaimed check fails until a target claims each one, or unclaimed.ignore lists it.'
    : `checkride checks this repo as one ${implicit} project, so no check reads that code. Declare targets in checkride.config.json to check each part from its own root.`;
  return { ...base, name, status: 'outdated', found: markerList(found), hint };
}

/**
 * The ts configs no check reaches (#12): a ts target whose `types` or `test`
 * found no tool while its packages hold configs for one. A warning, never
 * required, since a repo may leave them unchecked on purpose, and `null` when
 * there are none or the file list can't be read.
 */
async function checkUnreached(cwd: string, config: CheckrideConfig | null, common: { slots: readonly Slot[]; adapters: readonly Adapter[] }): Promise<DoctorCheck | null> {
  const resolved = resolveChecks({ slots: common.slots, adapters: common.adapters, config, cwd });
  const found = await findUnreached(cwd, tsTargets(selectChecks(resolved, {})), config?.unclaimed?.ignore ?? []).catch(() => []);
  if (found.length === 0) return null;
  const hint = found.map((u) => unreachedLine(u)).join(' ');
  return { name: 'unchecked ts configs', category: 'workspace', required: false, status: 'outdated', found: found.map((u) => `${u.check}: ${u.files.length} nested`).join(', '), expected: null, hint };
}

/** The markers no target claims, the implicit target's included, or why they couldn't be listed. */
async function unclaimedMarkers(repo: string, config: CheckrideConfig | null, claims: readonly DoctorTarget[], out: string | undefined): Promise<Unclaimed[] | string> {
  try {
    return await findUnclaimed(repo, { targets: claims, ignore: config?.unclaimed?.ignore ?? [], taken: checkKeys(config), ...(out !== undefined ? { out } : {}) });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The one thing `doctor` cannot see by looking at itself: what a hook would get.
 *
 * Every other row here describes the shell `doctor` was typed into. An agent
 * harness runs its hooks in a **non-login shell**, which never sources the rc
 * file a version manager puts its shims in, so the hook gets the machine's
 * default Node instead. In a repo pinning `engines.node` that is enough for the
 * package manager to refuse to run anything — and `doctor`, running on the right
 * Node, reported `environment ok` throughout. This bug was invisible to every
 * read-only command checkride had.
 *
 * So the row does not ask "is the Node here correct" — it is, that is the whole
 * problem. It asks the question that *is* answerable from any shell: **if a hook
 * arrives on a different Node, can checkride put the pinned one back?** That
 * depends only on the pin and on what is installed, both of which are the same
 * from either shell.
 *
 * Never required. A repo whose contributors always work in the right shell is
 * not broken, and flipping `doctor` red for it would be the false alarm this
 * whole change is about removing.
 */
function checkNodePin(cwd: string, engines: { node?: string }, env: PinEnv): DoctorCheck | null {
  const base = { name: 'node pin', category: 'env' as const, required: false as const };
  const pin = readNodePin(cwd, env);
  if (pin === null) return engines.node === undefined ? null : unpinnedRow(base, engines);
  const install = findPinnedNode(pin, env);
  const expected = `${pin.file} ${pin.version}`;
  if (install === null) {
    return {
      ...base,
      status: 'outdated',
      found: 'no matching install found',
      expected,
      hint:
        `Agent hooks run in a non-login shell and get this machine's default Node, not this shell's ` +
        `(${env.running()}). No Node satisfying ${pin.version} is installed in a layout checkride knows ` +
        `(nvm, fnm, nodenv, asdf, volta, n), so it cannot align a hook that arrives on the wrong one — ` +
        `the gate will report "could not run" rather than a misleading red. Install it, or set ` +
        `${NODE_BIN_VAR} to its bin directory.`,
    };
  }
  return {
    ...base,
    status: 'ok',
    found: install.bin,
    expected,
    hint: "Agent hooks run in a non-login shell; the gate aligns to this when the hook's Node differs.",
  };
}

/**
 * The row for a repo with `engines.node` and no `.nvmrc`/`.node-version` — a
 * repo whose package manager can refuse a hook, with no exact version for
 * checkride to align to when it does.
 */
function unpinnedRow(base: { name: string; category: 'env'; required: false }, engines: { node?: string }): DoctorCheck {
  return {
    ...base,
    status: 'outdated',
    found: 'no .nvmrc or .node-version',
    expected: engines.node ?? null,
    hint:
      `This repo pins \`engines.node\` ${engines.node} but names no exact version. Agent hooks run in ` +
      `a non-login shell and get this machine's default Node, which a package manager may then refuse ` +
      `to run under. Add a \`.nvmrc\` so checkride can align the gate to it, or set ${NODE_BIN_VAR}.`,
  };
}

/**
 * The committed baseline's health. No row when the repo has none — an absent
 * optional file is not a finding. Never required: a broken baseline degrades a
 * run (grandfathered findings report red), it does not break checkride. The
 * unparseable state is worth a row because the run-time warning only prints
 * during a run — doctor is where someone checks the environment *between* runs.
 */
function checkBaseline(cwd: string, env: DoctorEnv): DoctorCheck | null {
  const path = join(cwd, BASELINE_FILE);
  if (!env.exists(path)) return null;
  const raw = env.readText(path);
  const baseline = raw === null ? null : parseBaseline(raw);
  const base = { name: 'baseline', category: 'workspace' as const, required: false };
  if (baseline === null) {
    return {
      ...base,
      status: 'outdated',
      found: `${BASELINE_FILE} present but unparseable`,
      expected: 'valid baseline JSON',
      hint: 'A merge likely mangled it; grandfathered findings report red until it is restored. Run `checkride recover` to rebuild it from git history.',
    };
  }
  return { ...base, status: 'ok', found: `${countGrandfathered(baseline)} grandfathered finding(s)`, expected: null, hint: null };
}

/**
 * Whether the checkride stanza in AGENTS.md reaches Claude Code. Claude Code
 * reads AGENTS.md on its own only while no CLAUDE file exists; once one does,
 * the stanza loads only through an `@AGENTS.md` import (see `claude-md.ts`).
 * No row without a stanza, or while no CLAUDE file stops that read. Never
 * required: an unreachable stanza costs the agent its instructions, not the run.
 */
function checkAgentInstructions(cwd: string, env: DoctorEnv): DoctorCheck | null {
  const agents = env.readText(join(cwd, 'AGENTS.md'));
  if (agents === null || !hasStanza(agents)) return null;
  const present = CLAUDE_FILES.filter((file) => env.exists(join(cwd, file)));
  if (present.length === 0) return null;
  const base = { name: 'agent instructions', category: 'workspace' as const, required: false };
  const loading = present.find((file) => loadsStanza(env.readText(join(cwd, file)) ?? '', posix.dirname(file)));
  if (loading !== undefined) {
    return { ...base, status: 'ok', found: `${loading} loads AGENTS.md`, expected: null, hint: null };
  }
  return {
    ...base,
    status: 'outdated',
    found: `${present.join(', ')}, with no ${AGENTS_IMPORT} import`,
    expected: `${AGENTS_IMPORT} in CLAUDE.md`,
    hint: `Claude Code reads ${present.join(' and ')} in place of AGENTS.md, so the checkride stanza never loads. Add a line \`${AGENTS_IMPORT}\` to CLAUDE.md, or run \`checkride agent-setup\`, which adds it.`,
  };
}

/** The rows that apply, in order: an optional row is `null` when it has nothing to say. */
function applicable(...rows: readonly (DoctorCheck | null)[]): DoctorCheck[] {
  return rows.filter((row): row is DoctorCheck => row !== null);
}

/**
 * Whether the output directory can be written: `<cwd>/.check`, or the one
 * `--out` named. The row is named the way a run's `report:` line names the
 * directory, so `.check` by default.
 */
async function checkWritable(cwd: string, out: string | undefined, env: DoctorEnv): Promise<DoctorCheck> {
  const dir = out === undefined ? outDir(cwd) : resolve(cwd, out);
  const name = outLabel(cwd, dir);
  const ok = await env.canWrite(dir);
  return ok
    ? { name, category: 'workspace', required: true, status: 'ok', found: 'writable', expected: 'writable', hint: null }
    : { name, category: 'workspace', required: true, status: 'missing', found: 'not writable', expected: 'writable', hint: `Ensure ${dir} is writable.` };
}

function statusMark(status: DoctorStatus): string {
  if (status === 'ok') return '✔';
  if (status === 'outdated') return '⚠';
  if (status === 'n/a') return '·';
  return '✘';
}

/** Glyph for a slot row — driven by enablement, since "off" is not "broken", and a check a static run skips is off. */
function slotMark(c: DoctorCheck): string {
  if (c.skip !== undefined) return '·';
  if (c.enablement === 'default') return c.status === 'ok' ? '✔' : '✘';
  if (c.enablement === 'opt-in') return '○';
  return '·'; // disabled / unavailable: off, not a failure
}

/** Short presence note for a slot row (full paths stay in the JSON report). */
function slotNote(c: DoctorCheck): string {
  if (c.skip !== undefined) return 'skipped';
  if (c.enablement === 'disabled') return 'disabled in config';
  if (c.enablement === 'unavailable') return 'no tool detected';
  if (c.status === 'ok') return c.found === 'built-in' ? 'built-in' : 'installed';
  if (c.status === 'missing') return 'not installed';
  return c.status;
}

const GROUPS: { key: DoctorCheck['category']; label: string }[] = [
  { key: 'env', label: 'ENVIRONMENT' },
  { key: 'install', label: 'INSTALL' },
  { key: 'tool', label: 'CHECKS' },
  { key: 'pin', label: 'UNPINNED TOOLS' },
  { key: 'workspace', label: 'WORKSPACE' },
];

/** The padding widths for a tool table, measured from the rows it will hold. */
type ToolWidths = { slot: number; adapter: number; enablement: number; note: number; pin: number };

/**
 * Size each column to its widest row, never below the historical minimum.
 * Fixed widths were sized for catalogue slot names and a config custom check
 * blows straight past them — `typecheck-tests` (15) against a 10-wide column,
 * `custom:typecheck-tests` (22) against 18 — which shunts every following
 * column right on that row alone and makes the table unreadable at exactly the
 * moment someone is reading it to debug their config.
 */
function toolWidths(items: readonly DoctorCheck[]): ToolWidths {
  const widest = (pick: (c: DoctorCheck) => string, min: number): number =>
    items.reduce((n, c) => Math.max(n, pick(c).length), min);
  return {
    slot: widest((c) => c.slot ?? c.name, 10),
    adapter: widest((c) => c.adapter ?? '—', 18),
    enablement: widest((c) => c.enablement ?? '', 12),
    note: widest(slotNote, 0),
    pin: widest(pinNote, 0),
  };
}

/** The pin column: the source a row's tool resolves through, and the version that source named, as a run records it. */
function pinNote(c: DoctorCheck): string {
  return [c.pinSource, c.toolVersion].filter((part) => part !== undefined).join(' ');
}

/**
 * One slot row: its presence, the pin source its tool resolves through, and
 * the provenance tag a run prints for the same check, then its hint, or the
 * reason a static run skips it.
 */
function renderToolRow(c: DoctorCheck, w: ToolWidths, out: Out): void {
  const slot = (c.slot ?? c.name).padEnd(w.slot);
  const adapter = (c.adapter ?? '—').padEnd(w.adapter);
  const enablement = (c.enablement ?? '').padEnd(w.enablement);
  const tag = provenanceTag(c.origin, c.detectedBy);
  const note = [slotNote(c).padEnd(w.note), pinNote(c).padEnd(w.pin), tag ?? ''].join('  ').trimEnd();
  out.write(`  ${slotMark(c)} ${slot} ${adapter} ${enablement} ${note}\n`);
  const hint = c.skip ?? c.hint;
  if (hint) out.write(`      -> ${hint}\n`);
}

function renderSlotSummary(tools: DoctorCheck[], out: Out): void {
  const count = (e: SlotEnablement): number => tools.filter((c) => c.enablement === e).length;
  const skipped = tools.filter((c) => c.skip !== undefined).length;
  out.write(
    `  ${tools.length} slots — ${count('default')} default, ${count('opt-in')} opt-in, ` +
      `${count('disabled')} disabled, ${count('unavailable')} unavailable` +
      `${skipped > 0 ? `; ${skipped} skipped by --static-only` : ''}\n`,
  );
}

/** Render one non-tool row (env / install / workspace category). */
function renderEnvRow(c: DoctorCheck, out: Out): void {
  const found = c.found ?? '—';
  const expected = c.expected ? `  (${c.expected})` : '';
  out.write(`  ${statusMark(c.status)} ${c.name.padEnd(22)} ${found}${expected}\n`);
  if (c.status !== 'ok' && c.hint) out.write(`      -> ${c.hint}\n`);
}

/** Render one category group's rows; a no-op when the group has no checks. */
function renderGroup(
  group: { key: DoctorCheck['category']; label: string },
  report: DoctorReport,
  out: Out,
): void {
  const items = report.checks.filter((c) => c.category === group.key);
  if (items.length === 0) return;
  out.write(`  ${group.label}\n`);
  if (group.key === 'tool') {
    const widths = toolWidths(items);
    for (const c of items) renderToolRow(c, widths, out);
    renderSlotSummary(items, out);
    return;
  }
  for (const c of items) renderEnvRow(c, out);
}

/** The mode line, naming the implicit pack, and in multi-target mode the targets, one per line, their columns aligned. */
function renderMode(report: DoctorReport, out: Out): void {
  const targets = report.targets ?? [];
  if (report.mode === 'implicit') {
    out.write(`  mode: implicit (the repo is one ${report.pack ?? PACKS.ts.name} project at its root)\n\n`);
    return;
  }
  out.write(`  mode: multi-target (${targets.length} target${targets.length === 1 ? '' : 's'})\n\n  TARGETS\n`);
  const name = targets.reduce((n, t) => Math.max(n, t.name.length), 0);
  const pack = targets.reduce((n, t) => Math.max(n, t.pack.length), 0);
  for (const t of targets) out.write(`    ${t.name.padEnd(name)}  ${t.pack.padEnd(pack)}  ${t.root}\n`);
  out.write('\n');
}

function renderTable(report: DoctorReport, out: Out): void {
  out.write('\ncheckride doctor\n\n');
  out.write(`  package manager: ${report.packageManager} (detected)\n`);
  renderMode(report, out);
  for (const group of GROUPS) renderGroup(group, report, out);
  out.write(report.ok ? '\n✔ environment ok\n\n' : '\n✘ environment has problems (see above)\n\n');
}

/**
 * How the hooks, the stanza and the skills run checkride here (R6.6), when
 * it isn't the package manager's `check` script: mise's pinned copy, or the
 * one on `PATH`, which nothing pins, so a hook runs whatever copy a machine
 * has. Never required: the gate runs either way. `null` for a `package.json`
 * repo, whose `check` script is the harness as it always has been.
 */
function checkHarness(cwd: string, pm: PackageManager, env: DoctorEnv): DoctorCheck | null {
  const entry = resolveEntry(cwd, pm, env.readText);
  if (entry.kind === 'script') return null;
  const base = { name: 'harness', category: 'env' as const, required: false, expected: 'checkride pinned in mise.toml' };
  if (entry.kind === 'mise') return { ...base, status: 'ok', found: entryText(entry), hint: null };
  return {
    ...base,
    status: 'outdated',
    found: 'unpinned (`checkride` from PATH)',
    hint:
      'harness unpinned: with no package.json, the hooks and the AGENTS.md stanza run whatever `checkride` PATH holds. ' +
      `Pin it with \`${PIN_CHECKRIDE}\`, and they run \`mise exec -- checkride\` instead.`,
  };
}

/**
 * The environment and install rows: node and its pin, the package manager,
 * git, the harness, and the install, which fails nothing under
 * `--static-only`.
 */
async function environmentRows(cwd: string, pm: PackageManager, env: DoctorEnv, pinEnv: PinEnv, staticOnly: boolean): Promise<DoctorCheck[]> {
  const engines = env.readEngines(cwd);
  const nodeMin = parseSemver(engines.node) ?? { major: 22, minor: 18, patch: 0, raw: '22.18.0' };
  const pnpmMin = parseSemver(engines.pnpm) ?? { major: 9, minor: 0, patch: 0, raw: '9.0.0' };
  const nodePin = checkNodePin(cwd, engines, pinEnv);
  const harness = checkHarness(cwd, pm, env);
  return [
    await checkVersioned('node', 'node', nodeMin, env),
    ...(nodePin === null ? [] : [nodePin]),
    await checkPackageManager(cwd, pm, pnpmMin, env),
    await checkPresent('git', 'git', env),
    ...(harness === null ? [] : [harness]),
    staticOnly ? staticInstall(checkInstall(cwd, pm, env)) : checkInstall(cwd, pm, env),
  ];
}

/**
 * A row for every check, so off/opt-in/disabled slots stay visible instead of
 * silently dropped, then one for each tool nothing pins. The orchestrator
 * decides what runs by default. A slot the config hasn't activated
 * (`unclaimed` without targets) isn't one this repo runs, so it has no row.
 */
async function checkRows(
  common: { cwd: string; slots: readonly Slot[]; adapters: readonly Adapter[]; config: CheckrideConfig | null; defaults: CheckrideConfig | null },
  run: Pick<DoctorOptions, 'pins' | 'staticOnly'>,
  pm: PackageManager,
  env: DoctorEnv,
): Promise<DoctorCheck[]> {
  const { cwd, slots, adapters, config, defaults } = common;
  const resolved = resolveChecks({ slots, adapters, config, defaults, cwd }).filter((r) => r.inactive !== true);
  const overrides = run.pins?.tools;
  const ctx: SlotContext = {
    repo: cwd,
    defaultActive: new Set(selectChecks(resolved, {}).map(checkName)),
    adapters,
    pmAt: (dir) => (dir === cwd ? pm : nearestPackageManager(dir, cwd)),
    env,
    // Under `--pins`, the override source heads every chain, as in a run (R13.3).
    chainOf: (r) => (overrides === undefined ? pinChain(r.pack) : ['override', ...pinChain(r.pack)]),
    ...(overrides !== undefined ? { overrides } : {}),
    requirePins: (config?.requirePins ?? defaults?.requirePins) === true,
    staticOnly: run.staticOnly === true,
  };
  const skips = ctx.staticOnly ? staticSkips(resolved, await withStaticOnly(resolved, cwd)) : resolved.map(() => null);
  // Independent per-check probes: run them concurrently, `map` preserves order.
  const rows = await Promise.all(resolved.map((r, i) => classifySlot(r, ctx, skips[i] ?? null)));
  // A check a static run skips runs no tool, unpinned or otherwise, and its row records no pin source.
  const unpinned = resolved.filter((_, i) => rows[i]?.pinSource === 'path');
  return [...rows, ...unpinnedRows(unpinnedTools(unpinned, ctx.defaultActive), ctx.requirePins)];
}

/** The reason `--static-only` gave each check in `before`, read from `after`, or `null` for one it left as it was. */
function staticSkips(before: readonly ResolvedCheck[], after: readonly ResolvedCheck[]): (string | null)[] {
  return before.map((r, i) => {
    const skip = after[i]?.skip ?? null;
    return skip === r.skip ? null : skip;
  });
}

/**
 * The repo's mode as the report gives it (its targets, or the implicit pack
 * its root marks, and the markers no target claims) and the row that names
 * those markers, when there is one.
 */
async function modeOf(
  cwd: string,
  config: CheckrideConfig | null,
  out: string | undefined,
): Promise<{ fields: Pick<DoctorReport, 'mode' | 'pack' | 'targets' | 'unclaimed'>; row: DoctorCheck | null }> {
  const targets = configuredTargets(config)?.map(({ name, pack, root }) => ({ name, pack, root })) ?? null;
  const implicit = targets === null ? implicitPack(markerAt(cwd)) : null;
  const unclaimed = await unclaimedMarkers(cwd, config, targets ?? [{ name: '', pack: implicit ?? PACKS.ts.name, root: '.' }], out);
  const fields = {
    mode: targets === null ? 'implicit' : 'multi-target',
    ...(implicit !== null ? { pack: implicit } : {}),
    ...(targets !== null ? { targets } : {}),
    ...(typeof unclaimed === 'string' ? {} : { unclaimed }),
  } as const;
  return { fields, row: markersRow(unclaimed, implicit) };
}

/** Run the doctor against `cwd`; render and return the report. */
export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const common = resolveCommonOptions(options);
  const { cwd, config, stdout } = common;
  const env = options.env ?? realEnv;
  const pm = env.packageManager(cwd);

  const checks: DoctorCheck[] = [
    ...(await environmentRows(cwd, pm, env, options.pinEnv ?? realPinEnv, options.staticOnly === true)),
    ...(await checkRows({ ...common, defaults: options.defaults ?? null }, options, pm, env)),
    await checkWritable(cwd, options.out, env),
  ];
  const mode = await modeOf(cwd, config, options.out);
  const unreached = await checkUnreached(cwd, config, common);
  checks.push(...applicable(checkBaseline(cwd, env), checkAgentInstructions(cwd, env), mode.row, unreached));

  const ok = checks.every((c) => !c.required || c.status === 'ok');
  const report: DoctorReport = { ok, platform: env.platform(), packageManager: pm, ...mode.fields, checks };

  if (options.json === true) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    renderTable(report, stdout);
  }

  return { ok, report, exitCode: ok ? 0 : 1 };
}

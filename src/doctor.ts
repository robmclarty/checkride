/**
 * `checkride doctor` — read-only environment + tooling verification.
 *
 * Verifies node/pnpm/git are present at the required versions, the project has
 * been installed, and `.check/` is writable. It then enumerates *every* catalogue slot — not just the ones the
 * default run executes — and reports each slot's enablement (default / opt-in /
 * disabled / unavailable) alongside its tool presence, so off and opt-in slots
 * are visible instead of silently dropped. Renders a human table (or `--json`)
 * and exits 0 when everything required is present, 1 otherwise. Only slots that
 * run by default are required; opt-in/disabled/unavailable slots never fail it.
 *
 * Every environment touch (PATH, fs, package.json) goes through an injectable
 * {@link DoctorEnv}, so the logic is unit-testable without a real toolchain.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { arch as osArch, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Adapter, Slot } from './adapters.js';
import type { CheckrideConfig, ResolvedCheck } from './config.js';
import { resolveChecks } from './config.js';
import type { Out } from './orchestrator.js';
import { resolveCommonOptions, selectChecks } from './orchestrator.js';
import type { PackageManager } from './pm/index.js';
import {
  detectPackageManager,
  execTool,
  installCommand,
  isAvailableUnder,
  isPnPInstall,
  resolveSlotTool,
} from './pm/index.js';

export type DoctorStatus = 'ok' | 'outdated' | 'missing' | 'unknown' | 'n/a';

/** Why a slot is, or is not, part of the default `checkride` run. */
export type SlotEnablement = 'default' | 'opt-in' | 'disabled' | 'unavailable';

export type DoctorCheck = {
  name: string;
  category: 'env' | 'install' | 'tool' | 'workspace';
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
};

export type DoctorReport = {
  ok: boolean;
  platform: { os: string; arch: string };
  /** The package manager checkride detected for this repo. */
  packageManager: PackageManager;
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
export const VERSION_TIMED_OUT = Symbol('checkride.version.timed-out');

/** Result of a `<cmd> --version` probe: raw output, `null` if it failed or could not be parsed, or {@link VERSION_TIMED_OUT}. */
export type VersionProbe = string | typeof VERSION_TIMED_OUT | null;

/** Every environment touch, injectable for tests. */
export type DoctorEnv = {
  which: (cmd: string) => Promise<string | null>;
  version: (cmd: string, args: string[]) => Promise<VersionProbe>;
  /** `<pm> bin <tool>` — the tool's resolved path, or `null` if it does not resolve. */
  binPath: (pm: PackageManager, tool: string, cwd: string) => Promise<string | null>;
  exists: (path: string) => boolean;
  canWrite: (dir: string) => Promise<boolean>;
  readEngines: (cwd: string) => { node?: string; pnpm?: string };
  platform: () => { os: string; arch: string };
  packageManager: (cwd: string) => PackageManager;
};

export type DoctorOptions = {
  cwd?: string;
  json?: boolean;
  stdout?: Out;
  slots?: readonly Slot[];
  adapters?: readonly Adapter[];
  config?: CheckrideConfig | null;
  env?: DoctorEnv;
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
    return isProbeTimeout(err) ? VERSION_TIMED_OUT : null;
  }
}

/**
 * Ask the package manager where a tool's binary is — the only way to answer that
 * under Yarn PnP, where no `node_modules/.bin` exists to stat.
 *
 * `yarn bin <tool>` prints the resolved path and exits 0, or exits 1 when the
 * tool is not a dependency, so the exit code carries the whole answer. Shares
 * the version probe's timeout: this spawns a package manager, and a doctor that
 * hangs is worse than one that reports a tool unresolved.
 */
async function binPathReal(pm: PackageManager, tool: string, cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(pm, ['bin', tool], { cwd, timeout: VERSION_TIMEOUT_MS });
    const path = stdout.trim();
    return path.length > 0 ? path : null;
  } catch {
    return null;
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

const realEnv: DoctorEnv = {
  which: whichReal,
  version: versionReal,
  binPath: binPathReal,
  exists: existsSync,
  canWrite: canWriteReal,
  readEngines: readEnginesReal,
  platform: () => ({ os: osPlatform(), arch: osArch() }),
  packageManager: (cwd) => detectPackageManager({ cwd }),
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
  const path = await env.which(cmd);
  if (!path) {
    return { name, category: 'env', required: true, status: 'missing', found: null, expected, hint: INSTALL_HINTS[name] ?? `Install \`${cmd}\`.` };
  }
  const raw = await env.version(cmd, ['--version']);
  if (raw === VERSION_TIMED_OUT) {
    return { name, category: 'env', required: true, status: 'unknown', found: null, expected, hint: `\`${cmd} --version\` timed out (>${VERSION_TIMEOUT_S}s). Is ${cmd} responsive?` };
  }
  const found = parseSemver(raw);
  if (!found) {
    return { name, category: 'env', required: true, status: 'unknown', found: null, expected, hint: `Could not parse \`${cmd} --version\` output.` };
  }
  if (compareSemver(found, min) < 0) {
    return { name, category: 'env', required: true, status: 'outdated', found: found.raw, expected, hint: INSTALL_HINTS[name] ?? `Upgrade \`${cmd}\` to ${expected}.` };
  }
  return { name, category: 'env', required: true, status: 'ok', found: found.raw, expected, hint: null };
}

async function checkPresent(name: string, cmd: string, env: DoctorEnv): Promise<DoctorCheck> {
  const path = await env.which(cmd);
  if (!path) {
    return { name, category: 'env', required: true, status: 'missing', found: null, expected: 'present on PATH', hint: INSTALL_HINTS[name] ?? `Install \`${cmd}\`.` };
  }
  const raw = await env.version(cmd, ['--version']);
  return { name, category: 'env', required: true, status: 'ok', found: typeof raw === 'string' ? raw : path, expected: 'present on PATH', hint: null };
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
 * (no per-PM minimums pinned).
 */
function checkPackageManager(pm: PackageManager, pnpmMin: Semver, env: DoctorEnv): Promise<DoctorCheck> {
  return pm === 'pnpm' ? checkVersioned('pnpm', 'pnpm', pnpmMin, env) : checkPresent(pm, pm, env);
}

/**
 * Is the project installed? Lockfile plus the linker's own install artifact.
 *
 * Under Yarn PnP that artifact is `.pnp.cjs`, not a `node_modules/` directory —
 * a PnP repo never has one, so asserting the directory reported every correctly
 * installed PnP project as "lockfile only" and made `doctor` exit 1 on a repo
 * whose checks all pass.
 */
function checkInstall(cwd: string, pm: PackageManager, env: DoctorEnv): DoctorCheck {
  const locks = PM_LOCKFILES[pm];
  const hint = `Run \`${pm} install\` from the repo root.`;
  const base = { name: 'install', category: 'install' as const, required: true };
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
  return { ...base, status: 'ok', found: 'node_modules + lockfile', expected: null, hint: null };
}

type ToolProbe = { status: DoctorStatus; found: string | null; expected: string | null; hint: string | null };

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
    return resolved ? { status: 'ok', found: resolved, expected, hint: null } : missing(expected);
  }
  const bin = resolveSlotTool(cwd, tool, env.exists);
  return bin
    ? { status: 'ok', found: bin, expected: `node_modules/.bin/${tool}`, hint: null }
    : missing(`node_modules/.bin/${tool}`);
}

/** Presence-only probe: does the adapter's tool resolve? Dispatch by adapter shape. */
async function probeTool(adapter: Adapter, cwd: string, pm: PackageManager, env: DoctorEnv): Promise<ToolProbe> {
  if (adapter.builtin) {
    return { status: 'ok', found: 'built-in', expected: null, hint: null };
  }
  if (adapter.command === 'pnpm' && adapter.args[0] === 'exec') {
    const tool = execTool(adapter.command, adapter.args);
    if (!tool) return { status: 'unknown', found: null, expected: null, hint: null };
    return probeExecTool(tool, cwd, pm, env);
  }
  const path = await env.which(adapter.command);
  return path
    ? { status: 'ok', found: path, expected: `${adapter.command} on PATH`, hint: null }
    : { status: 'missing', found: null, expected: `${adapter.command} on PATH`, hint: `Install \`${adapter.command}\`.` };
}

/** The signal that would turn an adapter on: its detect files, `scripts.<name>`, a dep, or always-available. */
function enableSignal(a: Adapter): string {
  if (a.detect.length > 0) return a.detect.slice(0, 2).join(' or ');
  if (a.detectScript !== undefined) return `scripts.${a.detectScript}`;
  if (a.detectDeps && a.detectDeps.length > 0) return `dep ${a.detectDeps.join('/')}`;
  return 'always available';
}

/** What an unavailable slot could be turned on with: candidate adapters + their detection signals. */
function possibilitiesHint(slot: string, adapters: readonly Adapter[]): string | null {
  const candidates = adapters.filter((a) => a.slot === slot);
  if (candidates.length === 0) return null;
  const parts = candidates.map((a) => `${a.name} (${enableSignal(a)})`);
  return `Enable by adding one of: ${parts.join(', ')}.`;
}

/** The shared prefix of every `tool`-category doctor row. */
type ToolRowBase = { category: 'tool'; slot: string; adapter: string | null };

/**
 * A row for a slot that is off but not simply missing its tool — disabled in
 * config, or its adapter can't run under this PM. `null` when neither applies
 * (the caller then handles the no-adapter case and the live probe).
 */
function offRow(
  base: ToolRowBase,
  r: ResolvedCheck,
  adapter: Adapter | null,
  config: CheckrideConfig | null,
  pm: PackageManager,
): DoctorCheck | null {
  // Explicitly disabled in config: off by the user's choice.
  if (config?.checks?.[r.slot] === false) {
    return { ...base, name: r.slot, required: false, status: 'n/a', enablement: 'disabled', found: r.skip ?? 'disabled in checkride.config.json', expected: null, hint: null };
  }
  // Adapter is PM-specific and can't run here — e.g. `pnpm audit` off pnpm.
  if (adapter && !isAvailableUnder(adapter.command, adapter.args, pm)) {
    return { ...base, name: r.slot, required: false, status: 'n/a', enablement: 'unavailable', found: `unavailable under ${pm}`, expected: null, hint: `\`${adapter.command} ${adapter.args[0]}\` is pnpm-specific; the ${r.slot} slot needs pnpm for now.` };
  }
  return null;
}

/** The detection-provenance clause for a tool row — concrete signals only (not "always available"). */
function detectedClause(r: ResolvedCheck): string {
  return r.detectedVia && r.detectedVia !== 'always available' ? ` Detected via ${r.detectedVia}.` : '';
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

/** The inspection clause for a publish built-in row, or '' for every other slot. */
function inspectsClause(slot: string): string {
  const inspects = PUBLISH_INSPECTS[slot];
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
  const isDefault = defaultActive.has(r.slot);
  const enablement: SlotEnablement = isDefault ? 'default' : 'opt-in';
  const lead = isDefault
    ? probe.hint
    : `Opt-in — run with \`--include ${r.slot}\` or \`--all\`.${probe.status === 'missing' ? ' Tool not installed.' : ''}`;
  const body = `${lead ?? ''}${detectedClause(r)}${inspectsClause(r.slot)}`.trim();
  const hint = body.length > 0 ? body : null;
  return { ...base, name: `${adapter.name} (${r.slot})`, required: isDefault, status: probe.status, enablement, found: probe.found, expected: probe.expected, hint };
}

/**
 * Build a doctor row for one resolved catalogue slot, classified by enablement.
 * Only `default` slots are required; `opt-in`/`disabled`/`unavailable` slots are
 * surfaced for visibility but never fail the report.
 */
async function classifySlot(
  r: ResolvedCheck,
  defaultActive: ReadonlySet<string>,
  adapters: readonly Adapter[],
  config: CheckrideConfig | null,
  cwd: string,
  env: DoctorEnv,
  pm: PackageManager,
): Promise<DoctorCheck> {
  const base = { category: 'tool' as const, slot: r.slot, adapter: r.adapter?.name ?? null };
  const { adapter } = r;

  const off = offRow(base, r, adapter, config, pm);
  if (off) return off;
  // No adapter fills the slot: nothing to run. Point at what would enable it.
  if (!adapter) {
    return { ...base, name: r.slot, required: false, status: 'n/a', enablement: 'unavailable', found: r.skip ?? 'no tool detected', expected: null, hint: possibilitiesHint(r.slot, adapters) };
  }
  // Adapter resolved: probe the tool, classify by default-run membership.
  const probe = await probeTool(adapter, cwd, pm, env);
  return toolRow(base, r, adapter, defaultActive, probe);
}

async function checkWritable(cwd: string, env: DoctorEnv): Promise<DoctorCheck> {
  const dir = join(cwd, '.check');
  const ok = await env.canWrite(dir);
  return ok
    ? { name: '.check', category: 'workspace', required: true, status: 'ok', found: 'writable', expected: 'writable', hint: null }
    : { name: '.check', category: 'workspace', required: true, status: 'missing', found: 'not writable', expected: 'writable', hint: `Ensure ${dir} is writable.` };
}

function statusMark(status: DoctorStatus): string {
  if (status === 'ok') return '✔';
  if (status === 'outdated') return '⚠';
  if (status === 'n/a') return '·';
  return '✘';
}

/** Glyph for a slot row — driven by enablement, since "off" is not "broken". */
function slotMark(c: DoctorCheck): string {
  if (c.enablement === 'default') return c.status === 'ok' ? '✔' : '✘';
  if (c.enablement === 'opt-in') return '○';
  return '·'; // disabled / unavailable: off, not a failure
}

/** Short presence note for a slot row (full paths stay in the JSON report). */
function slotNote(c: DoctorCheck): string {
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
  { key: 'workspace', label: 'WORKSPACE' },
];

/** The padding widths for a tool table, measured from the rows it will hold. */
type ToolWidths = { slot: number; adapter: number; enablement: number };

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
  };
}

function renderToolRow(c: DoctorCheck, w: ToolWidths, out: Out): void {
  const slot = (c.slot ?? c.name).padEnd(w.slot);
  const adapter = (c.adapter ?? '—').padEnd(w.adapter);
  const enablement = (c.enablement ?? '').padEnd(w.enablement);
  out.write(`  ${slotMark(c)} ${slot} ${adapter} ${enablement} ${slotNote(c)}\n`);
  if (c.hint) out.write(`      -> ${c.hint}\n`);
}

function renderSlotSummary(tools: DoctorCheck[], out: Out): void {
  const count = (e: SlotEnablement): number => tools.filter((c) => c.enablement === e).length;
  out.write(
    `  ${tools.length} slots — ${count('default')} default, ${count('opt-in')} opt-in, ` +
      `${count('disabled')} disabled, ${count('unavailable')} unavailable\n`,
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

function renderTable(report: DoctorReport, out: Out): void {
  out.write('\ncheckride doctor\n\n');
  out.write(`  package manager: ${report.packageManager} (detected)\n\n`);
  for (const group of GROUPS) renderGroup(group, report, out);
  out.write(report.ok ? '\n✔ environment ok\n\n' : '\n✘ environment has problems (see above)\n\n');
}

/** Run the doctor against `cwd`; render and return the report. */
export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const { cwd, slots, adapters, config, stdout } = resolveCommonOptions(options);
  const env = options.env ?? realEnv;
  const json = options.json ?? false;

  const engines = env.readEngines(cwd);
  const nodeMin = parseSemver(engines.node) ?? { major: 22, minor: 18, patch: 0, raw: '22.18.0' };
  const pnpmMin = parseSemver(engines.pnpm) ?? { major: 9, minor: 0, patch: 0, raw: '9.0.0' };
  const pm = env.packageManager(cwd);

  const checks: DoctorCheck[] = [
    await checkVersioned('node', 'node', nodeMin, env),
    await checkPackageManager(pm, pnpmMin, env),
    await checkPresent('git', 'git', env),
    checkInstall(cwd, pm, env),
  ];

  // Enumerate every catalogue slot so off/opt-in/disabled slots stay visible
  // instead of silently dropped. The orchestrator decides what runs by default.
  const resolved = resolveChecks({ slots, adapters, config, cwd });
  const defaultActive = new Set(selectChecks(resolved, {}).map((r) => r.slot));
  // Independent per-slot probes: run them concurrently, `map` preserves order.
  checks.push(...(await Promise.all(resolved.map((r) => classifySlot(r, defaultActive, adapters, config, cwd, env, pm)))));

  checks.push(await checkWritable(cwd, env));

  const ok = checks.every((c) => !c.required || c.status === 'ok');
  const report: DoctorReport = { ok, platform: env.platform(), packageManager: pm, checks };

  if (json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    renderTable(report, stdout);
  }

  return { ok, report, exitCode: ok ? 0 : 1 };
}

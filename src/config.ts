/**
 * Configuration: load and validate `checkride.config.json`, detect installed
 * tools, and resolve each slot to an adapter (or a skip reason). The rules its
 * `targets` and `packs` blocks keep live in `./targets/`.
 *
 * Resolution rule per slot:
 *   1. config entry wins  — string picks an adapter; `false` disables the slot;
 *      `{ use, ...overrides }` picks an adapter with overrides; `{ command, args }`
 *      is a custom check needing no adapter.
 *   2. otherwise detection — the first registry adapter for the slot whose
 *      `detect` files exist (or whose `detect` is empty, that is, always available).
 *   3. otherwise the slot is skipped (skipped ≠ failed).
 *
 * With `targets` declared, each target resolves its pack's slots that way from
 * its own root, and its entry comes from the target, then `packs`, then the top
 * level (D10).
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix, relative, resolve } from 'node:path';

import type { Adapter, AdapterOptions, Order, Slot } from './adapters.js';
import { isRecord } from './json.js';
import { pinChain, pinDeclaration } from './launch/index.js';
import type { Pack } from './packs/index.js';
import { PACKS } from './packs/index.js';
import type { Target } from './targets/index.js';
import { configProblem, configuredTargets, presetProblem, skipExitCodeProblem } from './targets/index.js';

/**
 * A comment for whoever reads the config next — never rendered, never reported.
 *
 * JSON has no comments, so the only place a "why is this check here" note could
 * previously live was `description`, which is the *user-facing* string the run
 * prints beside every check. Overloading it made the status output carry
 * paragraphs meant for maintainers. `note` is the other half of that split: it
 * is validated (a typo surfaces as a config error rather than silence) and then
 * deliberately dropped — it is never copied onto an `Adapter`, so no code path
 * can reach it from the CLI output or `.check/summary.json`.
 */
type Noted = { note?: string };

/** A custom check: a bare command, no adapter required. */
export type CustomCheck = Noted & {
  command: string;
  args?: string[];
  description?: string;
  outputFile?: string | null;
  changedArgs?: string[];
  fixArgs?: string[];
  timeout?: number;
  name?: string;
  /**
   * Marker files that gate a config-only custom check: it runs only when at
   * least one listed file exists, and is skipped (`'no detect file present'`,
   * not failed) otherwise. This keeps a shared preset safe across heterogeneous
   * repos — a check for a tool a given repo doesn't use quietly stands down
   * instead of lighting up red. Ignored on entries that fill a catalogue slot —
   * those always run.
   */
  detect?: string[];
  /**
   * Where this check runs on the schedule — a wave number, or one of the five
   * keywords (`'first'`/`'last'`/`'middle'`/`'single'`/`'any'`; see `Order`). A
   * config-only custom check with no `order` defaults to `'any'` (the main
   * group), not the pre-wave implicit `'last'`; set `order: 'last'` to restore
   * trailing. Honored on catalogue-filling entries too (it overrides the slot's
   * default order).
   */
  order?: Order;
  /**
   * `true` holds this check out of the default run — a slow or full-sweep-only
   * custom check runs only under `--all`/`--include <name>`. Absent → runs by
   * default like any custom check. See {@link UseConfig.optIn}.
   */
  optIn?: boolean;
  /**
   * The exit code that means "could not run here" (an integer from 1 to 255).
   * A check that exits with it records as skipped, not failed, with its last
   * stderr line as the reason; `fix` reports it the same way. Without it, a
   * wrapper that can't run in this environment has to choose between a red
   * that isn't a finding and an exit 0 that claims a pass it never verified.
   */
  skipExitCode?: number;
};

/** Pick an adapter by name, with optional field overrides. */
export type UseConfig = Noted & {
  use: string;
  command?: string;
  args?: string[];
  description?: string;
  outputFile?: string | null;
  changedArgs?: string[];
  fixArgs?: string[];
  timeout?: number;
  /** Scheduling order override, beating the adapter's and slot's defaults (see `Order`). */
  order?: Order;
  /**
   * Links built-in only: extra directory names to skip while walking for
   * markdown, on top of the built-in exclude set (for example `docs`, `research`,
   * `.ridgeline`). Ignored by every other slot.
   */
  exclude?: string[];
  /**
   * Links built-in only: regex sources for link targets to treat as always
   * valid — deliberately illustrative links that never resolve on disk. Each is
   * compiled at config load; a bad pattern is a friendly config error. Ignored
   * by every other slot.
   */
  allowlist?: string[];
  /**
   * `attw` slot only: append `--profile <name>` (for example `esm-only`) to the attw
   * invocation — a shortcut for retyping the full `args`. Ignored by every other
   * slot. If `args` is also overridden, the flag is appended to those args.
   */
  profile?: string;
  /**
   * `prose` slot only: repo-relative directory of hand-written voice exemplars.
   * Naming it does two things: the check fails when the directory is missing or
   * empty (an anchor text the config points at must exist), and `agent-setup`
   * adds a stanza section telling writing sessions to read and imitate the
   * exemplars — never edit them. Ignored by every other slot.
   */
  exemplars?: string;
  /**
   * Override the slot's opt-in status. `true` configures the slot *without*
   * opting it into the default run — the escape hatch from "naming a slot opts
   * it in": run it only with `--all`/`--include <slot>`. Handy for a slot you
   * want configured (for example `attw` with a profile) but reserved for the full
   * sweep. `false` forces the slot into the default run. Absent → the slot's
   * catalogue default (see {@link ResolvedCheck.explicit}).
   */
  optIn?: boolean;
};

/**
 * Tune how a slot runs without picking its tool: detection still chooses the
 * adapter. Once targets are declared, this and `false` are the only forms a
 * top-level entry for a target-scope slot takes, since a tool belongs to a pack.
 */
type SlotTuning = Noted & { optIn?: boolean; timeout?: number; order?: Order };

/** Per-slot config: adapter name, `false` to disable, an override, a custom check, or tuning alone. */
export type SlotConfig = string | false | UseConfig | CustomCheck | SlotTuning;

/** A language pack's name: every pack but `repo`, whose slots check the repo as a whole. */
type PackName = Exclude<Pack['name'], 'repo'>;

/** A named (pack, root) pair: target-scope slots run once per target, from its root. */
type TargetConfig = Noted & {
  /** The language pack that checks this target. */
  lang: PackName;
  /** The target's directory, relative to the repo root: `.` for the root itself, never absolute or through `..`. */
  root: string;
  /** Globs relative to `root` for the files a file-list pack checks. No other pack takes them. */
  include?: string[];
  /** Globs relative to `root` that a file-list pack leaves out. */
  exclude?: string[];
  /** This target's own slot config and custom checks, over `packs` and the top-level `checks`. */
  checks?: Record<string, SlotConfig>;
};

/** Slot config for every target of one pack. */
type PackConfig = Noted & { checks?: Record<string, SlotConfig> };

/** Shape of `checkride.config.json`. */
export type CheckrideConfig = Noted & {
  /** URL of the JSON Schema for this file, for editor validation. Ignored by the runner. */
  $schema?: string;
  /**
   * Preset(s) to inherit: a file path (`./base.json`) or a package specifier
   * (`@acme/preset`), or an array of them. Bases merge left-to-right and the
   * local config wins over all of them; objects deep-merge, arrays and scalars
   * replace (arrays are not concatenated). Resolved and folded away by
   * `loadConfig` — the runner never sees it.
   */
  extends?: string | string[];
  checks?: Record<string, SlotConfig>;
  /**
   * Default per-check timeout in seconds. When unset, checks fall back to the
   * built-in 600s cap (`DEFAULT_TIMEOUT_SECONDS`); `0` here or on a check
   * disables the cap.
   */
  timeout?: number;
  /**
   * The base `--changed` measures from when neither `--base` nor
   * `CHECKRIDE_BASE` names one. Unset, it's `origin/main` when that resolves,
   * else `HEAD`. A base named here that doesn't resolve is a usage error.
   */
  changedBase?: string;
  /** What the stop gate runs, when the full check is too slow to pay per turn. */
  gate?: GateProfile;
  /**
   * Named targets. Declaring any switches the repo from one implicit target at
   * its root to multi-target mode. A preset or a defaults file can't declare
   * them, because only the repo knows its own.
   */
  targets?: Record<string, TargetConfig>;
  /** Slot config for every target of a pack, keyed by the pack's name. */
  packs?: Partial<Record<PackName, PackConfig>>;
  /** When true, a tool that resolves from `PATH` with no pin declaring it fails its check. Default false. */
  requirePins?: boolean;
  /** The `unclaimed` check's settings: marker paths it never reports. */
  unclaimed?: { ignore?: string[] };
};

/**
 * A narrower run for the stop-gate hook than for `check` itself.
 *
 * The gate fires on every turn that touched a file, and a full pipeline is
 * minutes in a large repo. Paid on every edit, that is enough friction that the
 * rational response is to turn the gate off — which loses the guarantee
 * entirely. A profile is the middle: a fast gate per turn, with the full check
 * still binding wherever it already is (a commit hook, CI).
 *
 * **A narrowed gate must say so, every time.** Its green means less than a full
 * green, and a green that quietly means less is the vacuous pass this whole
 * contract exists to prevent — the same failure as a red that means nothing,
 * inverted. `../gate.ts` puts the profile in the verdict rather than leaving the
 * reader to infer it from a slot count.
 */
export type GateProfile = Noted & {
  /** Run only these checks: each a slot, a custom check, a target or `<target>:<slot>`, as `--only` takes. */
  only?: string[];
  /** Run everything but these, named the same way. */
  skip?: string[];
  /** Affected-only mode, as `--changed`. */
  changed?: boolean;
  /**
   * A repo-owned script the generated stop-hook gate runs *before* checkride,
   * and the one supported seam for wrapping the gate.
   *
   * checkride owns the generated hook scripts and overwrites them on every
   * refresh, so a repo with something to say before the gate had nowhere to say
   * it: editing the script lost the edit, and re-pointing the harness config lost
   * it to the next `hooks add`. Naming the script *here* survives both, because
   * every write re-reads this file — which is the whole reason this is a config
   * key and not a `hooks add` flag.
   *
   * Path is relative to the repo root. Its exit code is read in the gate's own
   * vocabulary, so there is one meaning per code across the whole system: **0**
   * runs the gate, **2** blocks the turn, and anything else stands the gate down.
   * Either non-zero branch uses the script's stdout as the message, and neither
   * runs checkride at all.
   *
   * It does *not* narrow what the gate runs, so it is not part of the profile
   * clause a narrowed verdict carries — see {@link GateProfile} above.
   */
  preflight?: string;
};

/**
 * The version-pinned URL of the published config schema, for the `$schema`
 * pointer `init` writes into generated configs. The `v<version>` git tag must
 * exist at release for the URL to resolve.
 */
export function configSchemaUrl(version: string): string {
  return `https://raw.githubusercontent.com/robmclarty/checkride/v${version}/schema/checkride.config.schema.json`;
}

/**
 * Why a check is in the run: `config` when `checks` names its slot (presets
 * folded in by `extends` included), `detected` when a detection signal chose
 * its adapter, `built-in` when detection chose an adapter that needs no signal,
 * and `custom` for a config-only custom check keyed by a non-catalogue name.
 */
export type CheckOrigin = 'config' | 'detected' | 'built-in' | 'custom';

/** A slot resolved to a concrete adapter, or marked skipped with a reason. */
export type ResolvedCheck = {
  slot: string;
  optIn: boolean;
  adapter: Adapter | null;
  skip: string | null;
  /**
   * Effective scheduling order — config `order` ?? adapter `order` ?? slot
   * `order` ?? `'any'`. `resolveChecks` sorts on this; the scheduler will wave on
   * it. Absent only on hand-built resolved checks, where it reads as `'any'`.
   */
  order?: Order;
  /**
   * True when `checks` names this slot explicitly (a non-`false` config entry).
   * An explicit entry opts an otherwise opt-in slot into the default run — so
   * `"format": "prettier"` runs without `--include` (see `selectChecks`). A
   * config `optIn: true` clears this (configure-without-opting-in): the slot is
   * marked opt-in and left out of the default run despite being named.
   */
  explicit?: boolean;
  /**
   * Why the check is in the run. Set on every check resolution gave an adapter,
   * and absent on a skipped one (and on hand-built resolved checks).
   */
  origin?: CheckOrigin;
  /**
   * With `origin: 'detected'`, the signal that matched, in the form the summary
   * records as `detected_by`: the `detect` file, `package.json: scripts.<name>`
   * (`detectScript`) or `package.json: <pkg>` (`detectDeps`).
   */
  detectedBy?: string;
  /**
   * The same signal as {@link detectedBy}, in its older form: a `detect` file,
   * `scripts.<name>` or `dependency '<pkg>'`. Kept for callers that read it.
   */
  detectedVia?: string;
  /**
   * A custom check's declared {@link CustomCheck.skipExitCode}, validated.
   * Absent on every adapter-backed check and on custom checks that declare none.
   */
  skipExitCode?: number;
  /**
   * In multi-target mode, the target a target-scope check belongs to: it runs
   * as `<target>:<slot>`. Absent on repo-scope and top-level custom checks, and
   * on every check in implicit mode.
   */
  target?: string;
  /**
   * With {@link target}, the directory the check runs from: its target's root,
   * relative to the repo root, with `.` for the root itself.
   */
  root?: string;
  /**
   * In multi-target mode, the pack that fills the check: its target's for a
   * target-scope check, and `repo` for one that checks the repo as a whole,
   * a top-level custom check included. Absent in implicit mode.
   */
  pack?: string;
  /**
   * True for a slot the config hasn't activated (see `Slot.activeWith`): it's
   * skipped with the reason, and a run leaves it out, `--all` included,
   * unless a token names it (D53).
   */
  inactive?: true;
};

const CONFIG_FILE = 'checkride.config.json';

/**
 * The variable that names a config file in place of `<cwd>/checkride.config.json`,
 * the way `--config` does (the flag wins). The CLI reads it and the gate strips
 * it from the check it spawns; {@link loadConfig} never consults it.
 */
export const CONFIG_ENV = 'CHECKRIDE_CONFIG';

/**
 * Recursive deep-merge with local-wins semantics: plain objects merge key by
 * key; arrays, scalars, and type mismatches from `over` replace `base` (arrays
 * are never concatenated).
 */
function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isRecord(b) && isRecord(v) ? deepMerge(b, v) : v;
  }
  return out;
}

/** Throw the friendly `invalid checkride.config.json: <reason>` error. */
function invalidConfig(reason: string, cause?: unknown): never {
  throw new Error(`invalid ${CONFIG_FILE}: ${reason}`, cause ? { cause } : undefined);
}

/**
 * The config's `changedBase`, validated, or `null` when it sets none. A value
 * that isn't a non-empty string is the friendly config error, read on every
 * run so a typo surfaces before the day someone passes `--changed`.
 */
export function configChangedBase(config: CheckrideConfig | null): string | null {
  const base: unknown = config?.changedBase;
  if (base === undefined) return null;
  if (typeof base !== 'string' || base.length === 0) {
    invalidConfig(`changedBase must be a non-empty string (got ${JSON.stringify(base)})`);
  }
  return base;
}

const ORDER_KEYWORDS: ReadonlySet<string> = new Set(['first', 'last', 'middle', 'single', 'any']);

/** A finite number or one of the five order keywords — everything else is a config error. */
function isOrder(v: unknown): v is Order {
  return (
    (typeof v === 'number' && Number.isFinite(v)) ||
    (typeof v === 'string' && ORDER_KEYWORDS.has(v))
  );
}

/**
 * Read (and validate) a config entry's `order`. Returns `undefined` when absent;
 * throws the friendly error on anything that is not a finite number or a keyword
 * (a bogus string, `NaN`, `Infinity`). `context` names the offending check.
 */
function readOrder(entry: { order?: unknown }, context: string): Order | undefined {
  if (entry.order === undefined) return undefined;
  if (!isOrder(entry.order)) {
    invalidConfig(
      `'${context}' order must be a finite number or one of first, last, middle, single, any (got ${JSON.stringify(entry.order)})`,
    );
  }
  return entry.order;
}

/**
 * Read (and validate) a config entry's `optIn` override. Returns `undefined`
 * when absent (defer to the slot's catalogue default); throws the friendly error
 * on a non-boolean. `context` names the offending check.
 */
function readOptIn(entry: { optIn?: unknown }, context: string): boolean | undefined {
  if (entry.optIn === undefined) return undefined;
  if (typeof entry.optIn !== 'boolean') {
    invalidConfig(`'${context}' optIn must be a boolean (got ${JSON.stringify(entry.optIn)})`);
  }
  return entry.optIn;
}

/**
 * Read (and validate) a custom check's `skipExitCode`. Returns `undefined` when
 * absent; throws the friendly error on anything but an integer from 1 to 255
 * (see `skipExitCodeProblem`). `context` names the offending check.
 */
function readSkipExitCode(entry: CustomCheck, context: string): number | undefined {
  const problem = skipExitCodeProblem(entry, context);
  if (problem !== null) invalidConfig(problem);
  return entry.skipExitCode;
}

/** Carry a validated `skipExitCode` onto a resolved custom check, when it declared one. */
function withSkipExitCode(check: ResolvedCheck, skipExitCode: number | undefined): ResolvedCheck {
  return skipExitCode === undefined ? check : { ...check, skipExitCode };
}

/**
 * Validate a config entry's `note` and discard it. Nothing consumes the value —
 * that is the whole point of {@link Noted} — but a `note` that is not a string
 * is a mistake worth naming, and validating here is what keeps "it never
 * renders" from also meaning "it is never checked". `context` names the
 * offending check.
 */
function checkNote(entry: { note?: unknown }, context: string): void {
  if (entry.note !== undefined && typeof entry.note !== 'string') {
    invalidConfig(`'${context}' note must be a string (got ${JSON.stringify(entry.note)})`);
  }
}

/** True for an array whose every element is a string. */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((e) => typeof e === 'string');
}

/** True when `src` compiles as a regular expression. */
function isRegexSource(src: string): boolean {
  try {
    return new RegExp(src) instanceof RegExp;
  } catch {
    return false;
  }
}

/**
 * Validate the links built-in's `exclude`/`allowlist` off a config entry.
 * `exclude` must be a string array; `allowlist` a string array of compilable
 * regexes (a bad pattern is a friendly config error, so the check never crashes
 * on it). Validated wherever they appear so a typo surfaces as a config error,
 * not silence; whether they *attach* is `applyLinksOptions`'s call. Returns
 * `null` when the entry carries neither. `context` names the check in any error.
 */
function readLinksOptions(
  src: { exclude?: unknown; allowlist?: unknown },
  context: string,
): NonNullable<AdapterOptions['links']> | null {
  if (src.exclude === undefined && src.allowlist === undefined) return null;
  const out: NonNullable<AdapterOptions['links']> = {};
  if (src.exclude !== undefined) {
    if (!isStringArray(src.exclude)) invalidConfig(`'${context}' exclude must be an array of strings`);
    out.exclude = src.exclude;
  }
  if (src.allowlist !== undefined) {
    if (!isStringArray(src.allowlist)) invalidConfig(`'${context}' allowlist must be an array of strings`);
    const bad = src.allowlist.find((p) => !isRegexSource(p));
    if (bad !== undefined) {
      invalidConfig(`'${context}' allowlist entry ${JSON.stringify(bad)} is not a valid regular expression`);
    }
    out.allowlist = src.allowlist;
  }
  return out;
}

/** Merge slot-scoped options onto an adapter, keeping any already set. */
function withOptions(adapter: Adapter, patch: AdapterOptions): Adapter {
  return { ...adapter, options: { ...adapter.options, ...patch } };
}

/**
 * Attach a config entry's `exclude`/`allowlist` as `options.links`. A no-op on
 * any other slot (the fields are documented as links-only) — they are still
 * validated there, so a bad pattern on a mis-slotted entry is an error either
 * way. `context` names the check in the error.
 */
function applyLinksOptions(adapter: Adapter, o: UseConfig, context: string): Adapter {
  const links = readLinksOptions(o, context);
  if (links === null || adapter.slot !== 'links') return adapter;
  return withOptions(adapter, { links });
}

/**
 * Apply a config entry's `optIn` override to a resolved check. Config states the
 * effective opt-in status directly, beating the slot's catalogue default:
 * `true` marks the check opt-in *and* clears `explicit`, so naming a slot
 * configures it without opting it into the default run (reach it with
 * `--all`/`--include`); `false` forces it into the default run. Absent, or a
 * non-object entry (a bare adapter name / `false`) that cannot carry the field,
 * leaves resolution's slot-derived `optIn`/`explicit` untouched. `context` names
 * the check in any error.
 */
function applyOptIn(check: ResolvedCheck, entry: SlotConfig | undefined, context: string): ResolvedCheck {
  if (!(entry && typeof entry === 'object')) return check;
  const optIn = readOptIn(entry, context);
  if (optIn === undefined) return check;
  // optIn:true clears explicit (configured, but not auto-opted-in); optIn:false
  // forces the slot in and leaves the resolved `explicit` as it stands.
  return optIn ? { ...check, optIn, explicit: false } : { ...check, optIn };
}

/**
 * Read, parse, and fully resolve a config file's `extends` chain into a single
 * merged object. `stack` holds the absolute paths currently being resolved, so
 * a config that (transitively) extends itself is caught as a cycle. `label`
 * names the file in error messages — the root config's own filename for the
 * entry point, or a repo-relative path for an inherited base.
 */
/** Read and parse a config file into an object, or throw a friendly error. */
function parseConfigJson(absPath: string, label: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absPath, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    invalidConfig(label === CONFIG_FILE ? reason : `${reason} (in ${label})`, err);
  }
  if (!isRecord(raw)) invalidConfig(`${label} is not a JSON object`);
  return raw;
}

/** Normalize an `extends` field (absent / single / array) into a list. */
function normalizeExtends(ext: unknown): unknown[] {
  return ext === undefined ? [] : Array.isArray(ext) ? ext : [ext];
}

/** Resolve and left-to-right merge every base config named in `specs`. */
function resolveExtends(
  specs: readonly unknown[],
  absPath: string,
  stack: readonly string[],
  label: string,
): Record<string, unknown> {
  const require = createRequire(absPath);
  let merged: Record<string, unknown> = {};
  for (const spec of specs) {
    if (typeof spec !== 'string') invalidConfig(`extends entries must be strings (in ${label})`);
    let baseAbs: string;
    try {
      baseAbs = require.resolve(spec);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      invalidConfig(`cannot resolve extends "${spec}" (in ${label}): ${reason}`, err);
    }
    const base = resolveConfigFile(baseAbs, [...stack, absPath], relative(process.cwd(), baseAbs));
    const problem = presetProblem(base, spec, label);
    if (problem !== null) invalidConfig(problem);
    merged = deepMerge(merged, base);
  }
  return merged;
}

function resolveConfigFile(
  absPath: string,
  stack: readonly string[],
  label: string,
): Record<string, unknown> {
  if (stack.includes(absPath)) {
    invalidConfig(`circular extends: ${[...stack, absPath].map((p) => relative(process.cwd(), p)).join(' -> ')}`);
  }
  const { extends: ext, ...own } = parseConfigJson(absPath, label);
  const merged = resolveExtends(normalizeExtends(ext), absPath, stack, label);
  return deepMerge(merged, own);
}

/**
 * Hold a merged config to the rules its `targets`, `packs` and companion keys
 * keep (see `configProblem`), with `cwd` as the repo root its target roots
 * must exist under, and throw the friendly error on the first one it breaks.
 */
function validated(config: Record<string, unknown>, cwd: string): CheckrideConfig {
  const problem = configProblem(config, { cwd, layer: 'repo' });
  if (problem !== null) invalidConfig(problem);
  return config;
}

/**
 * Read, resolve and validate `checkride.config.json` from `cwd`, or `null`
 * when absent. Any `extends` presets (file paths or package specifiers) are
 * resolved and merged in — local keys win, arrays replace — with `extends`
 * folded away.
 */
export function loadConfig(cwd: string): CheckrideConfig | null {
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) return null;
  return validated(resolveConfigFile(path, [], CONFIG_FILE), cwd);
}

/**
 * Read and resolve the config file at an explicit absolute `path` (`--config`,
 * `CHECKRIDE_CONFIG`) exactly as {@link loadConfig} reads the repo's own: its
 * relative `extends` resolve against that file, while paths inside its values
 * stay relative to the repo being checked, `cwd`. The caller has already
 * confirmed the file exists, since a named file that is missing is a usage
 * error, not "no config".
 */
export function loadConfigFile(path: string, cwd: string): CheckrideConfig {
  return validated(resolveConfigFile(path, [], path), cwd);
}

/**
 * What the repo *declared* it checks — as opposed to what a given run selected.
 *
 * The summary records the slots a run selected; it says nothing about the ones
 * the repo opted into and did not run. Both bundled-plugin readers need that
 * difference: triage uses it to name the slots a narrow run left uncovered, and
 * the quality extractor uses it to tell "opted in but not run this time" apart
 * from "never opted in at all" — three of its four artifacts come from opt-in
 * slots, so the distinction decides whether a gap is a finding or the repo's
 * normal state.
 *
 * Returns the slots the repo names in `checkride.config.json` and has not
 * switched off (`false` disables one), sorted. `null` means *unknowable*, never
 * *empty*: a repo with no config file runs the default catalogue, and neither
 * reader will guess at it; an unparseable config is the gate's problem to
 * report, not the reader's to crash on.
 *
 * `cwd` is resolved first because `loadConfig` throws outright on a relative
 * one, and both readers take their `cwd` from a command-line argument. Left
 * unresolved, `dist/<reader>/cli.js .` would land in the catch below and report
 * the repo's slots as *unknowable* — a silently degraded answer, which is the
 * failure mode these readers exist to prevent.
 */
export function configuredSlots(cwd: string): string[] | null {
  try {
    const checks = loadConfig(resolve(cwd))?.checks;
    if (!checks) return null;
    return Object.entries(checks)
      .filter(([, value]) => value !== false)
      .map(([slot]) => slot)
      .toSorted();
  } catch {
    return null;
  }
}

/**
 * Find an adapter by name, preferring one that also fills `slot`. A single tool
 * can fill several slots under one name — `fallow` fills `dead`, `dupes`, and
 * `health` — so `"dupes": "fallow"` must resolve to the dupes adapter, not the
 * first `fallow` in the registry. Falls back to a name-only match so naming a
 * cross-slot adapter (for example reusing `oxlint` in a custom slot) still works.
 */
function byName(name: string, adapters: readonly Adapter[], slot?: string): Adapter | null {
  return (
    adapters.find((a) => a.name === name && a.slot === slot) ??
    adapters.find((a) => a.name === name) ??
    null
  );
}

/** package.json signals consulted by `detectScript`/`detectDeps` detection. */
type Manifest = { scripts: ReadonlySet<string>; deps: ReadonlySet<string> };

const EMPTY_MANIFEST: Manifest = { scripts: new Set(), deps: new Set() };

/** Read `cwd`'s package.json script names and combined dep names; empty on any read/parse failure. */
function readManifest(cwd: string): Manifest {
  try {
    const pkg: {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    return {
      scripts: new Set(Object.keys(pkg.scripts ?? {})),
      deps: new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]),
    };
  } catch {
    return EMPTY_MANIFEST;
  }
}

/** True when this adapter declares any detection signal (so absence of a match means "off", not "always"). */
function hasAnySignal(a: Adapter): boolean {
  return a.detect.length > 0 || a.detectScript !== undefined || (a.detectDeps?.length ?? 0) > 0 || a.detectPin !== undefined;
}

/**
 * How detection reads one directory: which files sit there, its package.json,
 * and where a pin declares a tool for a check there (`<file>: <key>`, or `null`
 * when nothing but `PATH` would provide it).
 */
type Detection = { fileExists: (file: string) => boolean; manifest: Manifest; pinned: (bin: string) => string | null };

/**
 * What made an adapter's detection fire: a named signal, given in the summary's
 * form (`by`) and the older {@link ResolvedCheck.detectedVia} form (`via`), or
 * `null` for an adapter that declares no signal and so is always available.
 */
type Signal = { by: string; via: string } | null;

/** The `detectDeps` package that appears in the manifest, as a named signal, or `undefined`. */
function depSignal(a: Adapter, manifest: Manifest): Signal | undefined {
  const dep = a.detectDeps?.find((d) => manifest.deps.has(d));
  return dep !== undefined ? { by: `package.json: ${dep}`, via: `dependency '${dep}'` } : undefined;
}

/** The pin that declares an adapter's `detectPin` tool, as a named signal, or `undefined`. */
function pinSignal(a: Adapter, pinned: Detection['pinned']): Signal | undefined {
  const by = a.detectPin === undefined ? null : pinned(a.detectPin);
  return by !== null ? { by, via: `pin '${by}'` } : undefined;
}

/**
 * Which of an adapter's detection signals fires, or `undefined` when none does.
 * Precedence: a present `detect` file, then `detectScript` (`scripts.<name>`),
 * then a `detectDeps` package in dependencies/devDependencies, then a pin that
 * declares its `detectPin` tool. An adapter with no signals at all (empty
 * `detect`, no `detectScript`/`detectDeps`/`detectPin`: `links`, `pnpm audit`
 * and the publish built-ins) is always available, which is the `null` signal.
 */
function detectionSignal(a: Adapter, detection: Detection): Signal | undefined {
  const file = a.detect.find((f) => detection.fileExists(f));
  if (file !== undefined) return { by: file, via: file };
  const script = a.detectScript;
  if (script !== undefined && detection.manifest.scripts.has(script)) {
    return { by: `package.json: scripts.${script}`, via: `scripts.${script}` };
  }
  return depSignal(a, detection.manifest) ?? pinSignal(a, detection.pinned) ?? (hasAnySignal(a) ? undefined : null);
}

/** First adapter for `slot` whose detection fires, plus the signal that matched (for the report). */
function detectAdapter(
  slot: string,
  adapters: readonly Adapter[],
  detection: Detection,
): { adapter: Adapter; signal: Signal } | null {
  for (const a of adapters) {
    if (a.slot !== slot) continue;
    const signal = detectionSignal(a, detection);
    if (signal !== undefined) return { adapter: a, signal };
  }
  return null;
}

/**
 * Why nothing filled `slot` on the detection path. When the slot's adapter gates
 * on a package script (`detectScript`, for example `build`), name the missing script so
 * an opted-in-but-scriptless slot stands down with a clear reason; otherwise the
 * generic no-tool message.
 */
function undetectedReason(slot: string, adapters: readonly Adapter[]): string {
  const scripted = adapters.find((a) => a.slot === slot && a.detectScript !== undefined);
  return scripted ? `no '${scripted.detectScript}' script in package.json` : 'no tool detected for slot';
}

/**
 * A slot whose adapter is gated on a package script (`detectScript`, for example `build`
 * → `scripts.build`) stands down as a skip — never a red check — when that script
 * is absent, however the adapter was selected. Detection already filters the
 * auto-detect path; this also covers an explicit config entry, so a shared preset
 * that names `build` is safe on a repo that has no build script.
 */
function standDownIfScriptless(check: ResolvedCheck, manifest: Manifest): ResolvedCheck {
  const script = check.adapter?.detectScript;
  if (script === undefined || manifest.scripts.has(script)) return check;
  // A check with no adapter isn't in the run, so it says nothing about why it would be.
  const { origin: _origin, detectedBy: _by, detectedVia: _via, ...rest } = check;
  return { ...rest, adapter: null, skip: `no '${script}' script in package.json` };
}

/** The optional adapter fields a config entry may carry onto its adapter. */
type CarriedOverrides = Pick<Adapter, 'changedArgs' | 'fixArgs' | 'timeout' | 'order'>;

/**
 * Carry the optional fields a config entry (`UseConfig` or `CustomCheck`) shares
 * with an adapter, each spread only when present — so `applyOverrides` and
 * `customAdapter` don't each repeat the include-if-defined dance. `order` is
 * validated here (`slot` names the check in any error).
 */
function carriedOverrides(src: CarriedOverrides, slot: string): CarriedOverrides {
  const order = readOrder(src, slot);
  return {
    ...(src.changedArgs !== undefined ? { changedArgs: src.changedArgs } : {}),
    ...(src.fixArgs !== undefined ? { fixArgs: src.fixArgs } : {}),
    ...(src.timeout !== undefined ? { timeout: src.timeout } : {}),
    ...(order !== undefined ? { order } : {}),
  };
}

/**
 * Append attw's `--profile <name>` from the `profile` config shortcut. A no-op
 * on any other slot (the field is documented as attw-only). `profile` must be a
 * string; `context` names the check in the error.
 */
function applyProfile(adapter: Adapter, profile: unknown, context: string): Adapter {
  if (profile === undefined) return adapter;
  if (typeof profile !== 'string') invalidConfig(`'${context}' profile must be a string`);
  if (adapter.slot !== 'attw') return adapter;
  return { ...adapter, args: [...adapter.args, '--profile', profile] };
}

/**
 * Carry the `prose` slot's `exemplars` directory onto its adapter as
 * `options.prose`. A no-op on any other slot (the field is documented as
 * prose-only). `exemplars` must be a string; `context` names the check in the
 * error. Presence on disk is asserted at run time by the orchestrator, never
 * here — see `missingExemplarsOutcome`.
 */
function applyExemplars(adapter: Adapter, exemplars: unknown, context: string): Adapter {
  if (exemplars === undefined) return adapter;
  if (typeof exemplars !== 'string') invalidConfig(`'${context}' exemplars must be a string`);
  if (adapter.slot !== 'prose') return adapter;
  return withOptions(adapter, { prose: { exemplars } });
}

function applyOverrides(base: Adapter, o: UseConfig): Adapter {
  const merged: Adapter = {
    ...base,
    ...(o.command !== undefined ? { command: o.command } : {}),
    ...(o.args !== undefined ? { args: o.args } : {}),
    ...(o.outputFile !== undefined ? { outputFile: o.outputFile } : {}),
    ...(o.description !== undefined ? { description: o.description } : {}),
    ...carriedOverrides(o, base.slot),
  };
  // Links validation runs first, preserving the error order of earlier releases.
  return applyExemplars(
    applyProfile(applyLinksOptions(merged, o, base.slot), o.profile, base.slot),
    o.exemplars,
    base.slot,
  );
}

function customAdapter(slot: string, c: CustomCheck): Adapter {
  return {
    name: c.name ?? `custom:${slot}`,
    slot,
    description: c.description ?? `Custom ${slot} check`,
    detect: c.detect ?? [],
    command: c.command,
    args: c.args ?? [],
    outputFile: c.outputFile ?? null,
    ...carriedOverrides(c, slot),
    devDeps: {},
  };
}

/** Resolve a check's effective order: adapter (config-overridden) `order` ?? slot `order` ?? `'any'`. */
function effectiveOrder(slot: Slot, adapter: Adapter | null): Order {
  return adapter?.order ?? slot.order ?? 'any';
}

/** Why resolution picked an adapter: the origin, and with `detected` the signal that matched. */
type Provenance = Pick<ResolvedCheck, 'origin' | 'detectedBy' | 'detectedVia'>;

const FROM_CONFIG: Provenance = { origin: 'config' };

/** The provenance of a detected adapter: the signal that fired, or `built-in` when it needs none. */
function fromDetection(signal: Signal): Provenance {
  return signal === null
    ? { origin: 'built-in' }
    : { origin: 'detected', detectedBy: signal.by, detectedVia: signal.via };
}

function active(slot: Slot, adapter: Adapter, provenance: Provenance, explicit = false): ResolvedCheck {
  return {
    slot: slot.name,
    optIn: slot.optIn ?? false,
    adapter,
    skip: null,
    order: effectiveOrder(slot, adapter),
    explicit,
    ...provenance,
  };
}

function skipped(slot: Slot, reason: string, explicit = false): ResolvedCheck {
  return {
    slot: slot.name,
    optIn: slot.optIn ?? false,
    adapter: null,
    skip: reason,
    order: effectiveOrder(slot, null),
    explicit,
  };
}

/**
 * Resolve an object-form config entry — `{ use }` (an adapter with overrides) or
 * `{ command }` (a custom adapter) — for `slot`. Returns `null` when the entry is
 * neither, so the caller falls through to detection.
 */
function resolveObjectEntry(
  slot: Slot,
  entry: UseConfig | CustomCheck | SlotTuning,
  adapters: readonly Adapter[],
  explicit: boolean,
): ResolvedCheck | null {
  checkNote(entry, slot.name);
  if ('use' in entry) {
    const problem = skipExitCodeProblem(entry, slot.name);
    if (problem !== null) invalidConfig(problem);
    const base = byName(entry.use, adapters, slot.name);
    return base
      ? active(slot, applyOverrides(base, entry), FROM_CONFIG, explicit)
      : skipped(slot, `configured adapter '${entry.use}' is not in the registry`, explicit);
  }
  if ('command' in entry) {
    const check = active(slot, customAdapter(slot.name, entry), FROM_CONFIG, explicit);
    return withSkipExitCode(check, readSkipExitCode(entry, slot.name));
  }
  return null;
}

/** A config entry in object form: `{ use }`, `{ command }`, or tuning alone. */
type EntryObject = Exclude<SlotConfig, string | false>;

/** True for an entry in object form; a hand-built config's `null` reads as no entry, as it always has. */
function isEntryObject(entry: SlotConfig | undefined): entry is EntryObject {
  return Boolean(entry) && typeof entry === 'object';
}

/**
 * A detected adapter with the `timeout` and `order` of the tuning entry that
 * left the tool to detection, so the entry changes how the slot runs and not
 * which tool fills it.
 */
function tuned(adapter: Adapter, entry: SlotConfig | undefined, context: string): Adapter {
  if (!isEntryObject(entry)) return adapter;
  const order = readOrder(entry, context);
  return {
    ...adapter,
    ...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}),
    ...(order !== undefined ? { order } : {}),
  };
}

function resolveConfigOrDetect(
  slot: Slot,
  entry: SlotConfig | undefined,
  adapters: readonly Adapter[],
  detection: Detection,
  explicit: boolean,
): ResolvedCheck {
  if (typeof entry === 'string') {
    const adapter = byName(entry, adapters, slot.name);
    return adapter
      ? active(slot, adapter, FROM_CONFIG, explicit)
      : skipped(slot, `configured adapter '${entry}' is not in the registry`, explicit);
  }
  if (entry && typeof entry === 'object') {
    const resolved = resolveObjectEntry(slot, entry, adapters, explicit);
    if (resolved !== null) return resolved;
  }
  const detected = detectAdapter(slot.name, adapters, detection);
  if (!detected) return skipped(slot, undetectedReason(slot.name, adapters), explicit);
  return active(slot, tuned(detected.adapter, entry, slot.name), fromDetection(detected.signal));
}

function resolveOne(
  slot: Slot,
  entry: SlotConfig | undefined,
  adapters: readonly Adapter[],
  detection: Detection,
): ResolvedCheck {
  // Any non-`false` config entry is an explicit opt-in for this slot (`false`
  // disables it, so it never runs regardless). Detection (no entry) is not.
  const explicit = entry !== undefined && entry !== false;
  if (entry === false) {
    return skipped(slot, 'disabled in checkride.config.json');
  }
  const resolved = resolveConfigOrDetect(slot, entry, adapters, detection, explicit);
  // Config may override the slot's opt-in default (configure-without-opting-in).
  const overridden = applyOptIn(resolved, entry, slot.name);
  // A script-gated adapter (build) stands down — never red — when its script is
  // absent, even when config named it explicitly.
  return standDownIfScriptless(overridden, detection.manifest);
}

/**
 * Resolve a config-only custom check (an object with `command`, keyed by a name
 * not in the catalogue — for example a project's `"licenses"` check), or `null` when
 * `entry` is not such a check. Its effective order rides on the resolved check
 * (config `order` ?? `'any'`). A custom check with `detect` files stands down
 * (skipped, not failed) when none of them are present.
 */
function customCheckEntry(
  name: string,
  entry: SlotConfig,
  fileExists: (file: string) => boolean,
): ResolvedCheck | null {
  if (!(entry && typeof entry === 'object' && !('use' in entry) && 'command' in entry)) return null;
  checkNote(entry, name);
  // Read before the detect gate, so a bad value surfaces even where the check stands down.
  const skipExitCode = readSkipExitCode(entry, name);
  const detect = entry.detect ?? [];
  if (detect.length > 0 && !detect.some((f) => fileExists(f))) {
    // No adapter carries the order on a skip, so pin it on the synthetic slot.
    const order = readOrder(entry, name);
    return skipped(order !== undefined ? { name, order } : { name }, 'no detect file present');
  }
  const check = active({ name }, customAdapter(name, entry), { origin: 'custom' });
  // A custom check with `optIn: true` is held out of the default run (full-sweep only).
  return applyOptIn(withSkipExitCode(check, skipExitCode), entry, name);
}

/**
 * Resolve every config-only custom check (config key order preserved), skipping
 * any name that fills a catalogue slot. Order is baked onto each resolved check;
 * `resolveChecks` sorts the combined list.
 */
function foldCustomChecks(
  checks: Record<string, SlotConfig>,
  catalogueNames: ReadonlySet<string>,
  fileExists: (file: string) => boolean,
): ResolvedCheck[] {
  const customs: ResolvedCheck[] = [];
  for (const [name, entry] of Object.entries(checks)) {
    if (catalogueNames.has(name)) continue;
    const resolved = customCheckEntry(name, entry, fileExists);
    if (resolved !== null) customs.push(resolved);
  }
  return customs;
}

/** Group rank in the scheduling sequence: firsts (0), the numeric line incl. `'any'`/`'middle'` (1), singles (2), lasts (3). */
function groupRank(order: Order): number {
  if (order === 'first') return 0;
  if (order === 'single') return 2;
  if (order === 'last') return 3;
  return 1; // a number, or 'any'/'middle' — the main line
}

/** Position on the numeric line; `'any'`/`'middle'` sit at 0 (the conservative placement). */
function lineValue(order: Order): number {
  return typeof order === 'number' ? order : 0;
}

/** What {@link resolveChecks} resolves from. */
type ResolveInput = {
  slots: readonly Slot[];
  /**
   * The adapters a check at the repo root resolves against: every check in
   * implicit mode, and the repo-scope ones in multi-target mode, where each
   * target resolves against its own pack's rows in `PACKS`.
   */
  adapters: readonly Adapter[];
  config: CheckrideConfig | null;
  cwd?: string;
  /** Answers for a path relative to the repo root, a target's files included. */
  fileExists?: (file: string) => boolean;
  /**
   * package.json signals for `detectScript`/`detectDeps` detection; read from
   * `cwd` (or a target's root) when omitted (tests inject an empty manifest to
   * stay hermetic, and it then stands for every directory).
   */
  manifest?: { scripts: ReadonlySet<string>; deps: ReadonlySet<string> };
};

/**
 * Detection at `root`, a directory relative to the repo root, with `.` for the
 * root itself, for a check of `pack`. A pin declares a tool through that
 * pack's chain, searched from `root` up; `pack` is omitted in implicit mode.
 */
function detectionAt(input: ResolveInput, root: string, pack?: string): Detection {
  const cwd = input.cwd ?? process.cwd();
  const injected = input.fileExists;
  const fileExists = injected
    ? (file: string) => injected(root === '.' ? file : posix.join(root, file))
    : (file: string) => existsSync(join(cwd, root, file));
  // Read package.json only against an explicit `cwd`; a caller that injects just
  // `fileExists` (a test, `inventory`) wants detection driven by that alone, not
  // the ambient process cwd — so it gets an empty manifest unless one is passed.
  const manifest = input.manifest ?? (input.cwd !== undefined ? readManifest(join(input.cwd, root)) : EMPTY_MANIFEST);
  // Pins are read off disk only against an explicit `cwd`, for the same reason.
  const repo = input.cwd;
  const pinned = repo !== undefined
    ? (bin: string) => pinDeclaration(bin, { cwd: join(repo, root), repo, pins: pinChain(pack) })
    : () => null;
  return { fileExists, manifest, pinned };
}

/**
 * The inactive check for `slot` when the config lacks the key the slot needs
 * (`Slot.activeWith`) and no entry picks its tool, or `null` when the slot is
 * active. An entry that picks a tool, a repo's own custom check of that name
 * among them, runs it either way.
 */
function inactiveCheck(slot: Slot, entry: SlotConfig | undefined, config: CheckrideConfig | null): ResolvedCheck | null {
  const key = slot.activeWith;
  if (key === undefined || decides(entry) || (config !== null && Object.hasOwn(config, key))) return null;
  return { ...skipped(slot, `runs only when checkride.config.json declares ${key}`), inactive: true };
}

/** A repo-scope slot at the repo root: inactive, or resolved from its entry and detection. */
function repoSlotCheck(slot: Slot, input: ResolveInput, detection: Detection): ResolvedCheck {
  const entry = input.config?.checks?.[slot.name];
  return inactiveCheck(slot, entry, input.config) ?? resolveOne(slot, entry, input.adapters, detection);
}

/**
 * The `unclaimed` built-in with what it checks carried on its options: the
 * targets that claim markers, or the one implicit target at the root in a
 * repo without them, and `unclaimed.ignore`. Any other check passes through.
 */
function withClaims(check: ResolvedCheck, config: CheckrideConfig | null): ResolvedCheck {
  if (check.adapter?.builtin !== 'unclaimed') return check;
  const targets = configuredTargets(config) ?? [{ name: '', pack: PACKS.ts.name, root: '.' }];
  const claims = { targets: targets.map(({ name, pack, root }) => ({ name, pack, root })), ignore: config?.unclaimed?.ignore ?? [] };
  return { ...check, adapter: withOptions(check.adapter, { unclaimed: claims }) };
}

/** Implicit mode: every catalogue slot, then every custom check, at the repo root. */
function implicitChecks(input: ResolveInput, catalogueNames: ReadonlySet<string>): ResolvedCheck[] {
  const detection = detectionAt(input, '.');
  const checks = input.config?.checks ?? {};
  const catalogue = input.slots.map((slot) => repoSlotCheck(slot, input, detection));
  return [...catalogue, ...foldCustomChecks(checks, catalogueNames, detection.fileExists)];
}

/** One target as resolution reads it: its pack's adapters, the two blocks above the top level, and detection at its root. */
type TargetScope = {
  target: Target;
  adapters: readonly Adapter[];
  /** `targets.<name>.checks`, the highest layer. */
  own: Readonly<Record<string, SlotConfig>>;
  /** `packs.<pack>.checks`, below the target's own and above the top level. */
  pack: Readonly<Record<string, SlotConfig>>;
  detection: Detection;
};

function targetScope(input: ResolveInput, target: Target): TargetScope {
  const packs: Readonly<Record<string, PackConfig | undefined>> = input.config?.packs ?? {};
  const rows = Object.values(PACKS).find((p) => p.name === target.pack);
  return {
    target,
    adapters: rows?.adapters ?? [],
    own: input.config?.targets?.[target.name]?.checks ?? {},
    pack: packs[target.pack]?.checks ?? {},
    detection: detectionAt(input, target.root, target.pack),
  };
}

/** True for an entry that decides a check: an adapter's name, `false`, `{ use }` or `{ command }`. */
function decides(entry: SlotConfig | undefined): boolean {
  return typeof entry === 'string' || entry === false || (isEntryObject(entry) && ('use' in entry || 'command' in entry));
}

/**
 * The tuning a target's check runs with: each of `optIn`, `timeout` and
 * `order` from the highest layer that sets it, so a target's `timeout` beats
 * its pack's, and the top level's `optIn` reaches every target that sets none.
 * Every layer's values are validated, the ones a higher layer beat included.
 */
function layerTuning(layers: readonly (SlotConfig | undefined)[], context: string): SlotTuning {
  const objects = layers.filter(isEntryObject);
  for (const o of objects) checkNote(o, context);
  const optIn = objects.map((o) => readOptIn(o, context)).find((v) => v !== undefined);
  const order = objects.map((o) => readOrder(o, context)).find((v) => v !== undefined);
  const timeout = objects.map((o) => o.timeout).find((v) => v !== undefined);
  return {
    ...(optIn !== undefined ? { optIn } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(order !== undefined ? { order } : {}),
  };
}

/**
 * The one entry a target's check resolves from (D10), given its layers highest
 * first: the target's own, its pack's, then the top level's. The highest layer
 * that picks a tool, or switches the check off, decides it, and the tuning of
 * every layer applies over it ({@link layerTuning}). With no layer deciding,
 * detection picks the tool.
 */
function layeredEntry(layers: readonly (SlotConfig | undefined)[], context: string): SlotConfig | undefined {
  const decider = layers.find(decides);
  if (decider === false) return false;
  const tuning = layerTuning(layers, context);
  if (typeof decider === 'string') return Object.keys(tuning).length > 0 ? { use: decider, ...tuning } : decider;
  if (decider !== undefined) return { ...decider, ...tuning };
  return layers.some(isEntryObject) ? tuning : undefined;
}

/** In multi-target mode, mark a check as one that checks the repo as a whole, from its root. */
function inRepo(check: ResolvedCheck): ResolvedCheck {
  return { ...check, pack: PACKS.repo.name };
}

/** Mark a check as `target`'s: it runs as `<target>:<slot>`, from the target's root. */
function inTarget(check: ResolvedCheck, target: Target): ResolvedCheck {
  return { ...check, target: target.name, root: target.root, pack: target.pack };
}

/**
 * The target's check for catalogue slot `slot`, or `null` when it has none:
 * its pack fills no such slot, and neither the target nor the pack configures
 * one. The top-level entry, which V6 holds to `false` or tuning, reaches only
 * the targets whose pack fills the slot. Detection reads the target's root.
 */
function targetSlotCheck(slot: Slot, scope: TargetScope, top: SlotConfig | undefined): ResolvedCheck | null {
  const own = scope.own[slot.name];
  const pack = scope.pack[slot.name];
  if (own === undefined && pack === undefined && !scope.adapters.some((a) => a.slot === slot.name)) return null;
  const entry = layeredEntry([own, pack, top], slot.name);
  return inTarget(resolveOne(slot, entry, scope.adapters, scope.detection), scope.target);
}

/**
 * The target's custom checks: each name outside the catalogue that its pack's
 * block or its own declares, pack names first, each resolved from the target's
 * entry over its pack's as a slot is. A `detect` gate reads the target's root.
 */
function targetCustomChecks(scope: TargetScope, catalogueNames: ReadonlySet<string>): ResolvedCheck[] {
  const names = Object.keys({ ...scope.pack, ...scope.own }).filter((name) => !catalogueNames.has(name));
  return names.flatMap((name) => {
    const entry = layeredEntry([scope.own[name], scope.pack[name]], name);
    const check = entry === undefined ? null : customCheckEntry(name, entry, scope.detection.fileExists);
    return check === null ? [] : [inTarget(check, scope.target)];
  });
}

/**
 * Multi-target mode: each repo-scope slot once at the repo root, each
 * target-scope slot once for every target that has it, in target order, then
 * the top-level custom checks at the repo root, then each target's own. That
 * natural order is the tie-break the group sort keeps (R8.4).
 */
function targetChecks(input: ResolveInput, targets: readonly Target[], catalogueNames: ReadonlySet<string>): ResolvedCheck[] {
  const detection = detectionAt(input, '.', PACKS.repo.name);
  const checks = input.config?.checks ?? {};
  const scopes = targets.map((target) => targetScope(input, target));
  const catalogue = input.slots.flatMap((slot) =>
    slot.scope === 'repo'
      ? [inRepo(repoSlotCheck(slot, input, detection))]
      : scopes.flatMap((scope) => targetSlotCheck(slot, scope, checks[slot.name]) ?? []),
  );
  const customs = foldCustomChecks(checks, catalogueNames, detection.fileExists).map(inRepo);
  return [...catalogue, ...customs, ...scopes.flatMap((scope) => targetCustomChecks(scope, catalogueNames))];
}

/** Sort into the group sequence, keeping the given order within a group. */
function sortByGroup(checks: readonly ResolvedCheck[]): ResolvedCheck[] {
  return checks
    .map((check, i) => ({ check, i }))
    .toSorted((a, b) => {
      const orderA = a.check.order ?? 'any';
      const orderB = b.check.order ?? 'any';
      const byGroup = groupRank(orderA) - groupRank(orderB);
      if (byGroup !== 0) return byGroup;
      const byLine = lineValue(orderA) - lineValue(orderB);
      return byLine !== 0 ? byLine : a.i - b.i;
    })
    .map(({ check }) => check);
}

/**
 * Resolve every catalogue slot (in SLOTS order) to an adapter or a skip reason,
 * fold in the config-only custom checks (config key order), then sort into the
 * group sequence: firsts, the numeric line ascending (`'any'`/`'middle'` at 0),
 * singles, lasts. The natural order — catalogue before customs — is the stable
 * within-group tie-break, so within any group catalogue members keep SLOTS order
 * and precede customs, which keep config-key order. The orchestrator's wave
 * scheduler waves on the same effective `order`.
 *
 * With `targets` declared, a repo-scope slot still resolves once at the repo
 * root, and a target-scope slot once for each target that has it, from that
 * target's root and against its pack's adapters, in the order D10 sets: the
 * target's entry, then its pack's, then the top level's, then detection. The
 * catalogue checks then sit in target order within a slot, and the top-level
 * custom checks before each target's own (R8.4).
 */
export function resolveChecks(input: ResolveInput): ResolvedCheck[] {
  const catalogueNames = new Set(input.slots.map((s) => s.name));
  const targets = configuredTargets(input.config);
  const checks = targets === null ? implicitChecks(input, catalogueNames) : targetChecks(input, targets, catalogueNames);
  return sortByGroup(checks.map((check) => withClaims(check, input.config)));
}

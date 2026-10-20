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
 * level (D10). Without them, a repo whose root marks a pack other than ts
 * (R2.1) resolves the same way, as one target of that pack at its root whose
 * checks keep their bare names, and the top level ranks above `packs`, as the
 * implicit target's own entry.
 *
 * A defaults file (`--defaults`, R13.1) sits below detection: its entries fill
 * only a slot the repo's entries and detection leave empty, and its custom
 * checks join only where the repo declares none of that name.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix, relative, resolve } from 'node:path';

import type { Adapter, AdapterOptions, Order, Slot, TableSignal } from './adapters.js';
import { SLOTS } from './adapters.js';
import { isRecord } from './json.js';
import { chainCanRun, pinChain, pinDeclaration } from './launch/index.js';
import type { Pack } from './packs/index.js';
import { PACKS } from './packs/index.js';
import type { Target } from './targets/index.js';
import { configProblem, configuredTargets, implicitPack, markerAt, presetProblem, skipExitCodeProblem } from './targets/index.js';

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
  /**
   * A defaults file only (V12): this check reads the repo as data, so
   * `--static-only` may keep it (R13.4). A consumer vouches for its own
   * checks this way; a repo's config can't vouch for itself.
   */
  static?: boolean;
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
  /** A defaults file only, as on {@link CustomCheck.static}: `--static-only` may keep the check whatever the registry says. */
  static?: boolean;
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

/**
 * One rule for the `schema` slot: the files it validates and the JSON Schema
 * they must satisfy. The slot ships in a later release; until then the loader
 * holds `schema` to its rule and no run acts on the rest.
 */
type SchemaRule = Noted & {
  /** Globs, relative to the repo root, for the files the rule validates. */
  files: string[];
  /** A bundled `checkride:<id>` schema or a repo-relative path, never a URL or an absolute path. */
  schema: string;
  /** How each file is read; unset, it follows the extension. */
  format?: 'json' | 'jsonc' | 'yaml' | 'frontmatter';
};

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
  /** Data-file rules for the `schema` slot, which a later release ships. */
  schemas?: SchemaRule[];
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
 * `custom` for a config-only custom check keyed by a non-catalogue name, and
 * `defaults` when the defaults file filled a slot the repo left empty or added
 * a custom check of its own.
 */
export type CheckOrigin = 'config' | 'detected' | 'built-in' | 'custom' | 'defaults';

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
   * a top-level custom check included. In implicit mode, the same for a repo
   * whose root marks a pack other than ts (R2.1), and absent in a ts one.
   */
  pack?: string;
  /**
   * True for a slot the config hasn't activated (see `Slot.activeWith`): it's
   * skipped with the reason, and a run leaves it out, `--all` included,
   * unless a token names it (D53).
   */
  inactive?: true;
  /**
   * Under `--changed`, the Go package patterns a check narrowed to (R10.4):
   * `units`, the patterns it runs over, and `total`, the workspace's module
   * count. Absent on a check that didn't narrow.
   */
  narrowed?: { units: string[]; total: number };
};

const CONFIG_FILE = 'checkride.config.json';

/**
 * The variable that names a config file in place of `<cwd>/checkride.config.json`,
 * the way `--config` does (the flag wins). The CLI reads it and the gate strips
 * it from the check it spawns; {@link loadConfig} never consults it.
 */
export const CONFIG_ENV = 'CHECKRIDE_CONFIG';

/**
 * The variable that names a defaults file, the way `--defaults` does (the flag
 * wins). The CLI reads it and the gate strips it from the check it spawns;
 * {@link loadDefaultsFile} never consults it.
 */
export const DEFAULTS_ENV = 'CHECKRIDE_DEFAULTS';

/**
 * The top-level keys a defaults file may hold (R13.1), `extends` aside, which
 * folds away as it loads. The rest belong to the repo alone: `targets`, which
 * only the repo knows, and `gate`, `changedBase` and `unclaimed`, which shape
 * the repo's own gate and history.
 */
const DEFAULTS_KEYS: ReadonlySet<string> = new Set(['$schema', 'note', 'checks', 'packs', 'timeout', 'requirePins', 'schemas']);

/**
 * Every top-level key a config file may hold, as the config schema's root
 * declares them. Any other is read by nothing, a typo most often, so a run,
 * `fix` and `doctor` warn about it rather than let it sit unnoticed.
 */
export const CONFIG_KEYS: ReadonlySet<string> = new Set([
  '$schema',
  'note',
  'extends',
  'timeout',
  'changedBase',
  'requirePins',
  'unclaimed',
  'schemas',
  'targets',
  'packs',
  'gate',
  'checks',
]);

/** Where a config read reports a warning: one line, its `checkride:` prefix included. */
export type ConfigWarning = (message: string) => void;

/** One warning for each top-level key of `own`, one file's own keys, that no part of checkride reads, naming `file`. */
function unknownKeyWarnings(own: Record<string, unknown>, file: string): string[] {
  const known = [...CONFIG_KEYS].join(', ');
  return Object.keys(own)
    .filter((key) => !CONFIG_KEYS.has(key))
    .map((key) => `checkride: ${file} has an unknown top-level key ${JSON.stringify(key)}, which nothing reads (the keys are ${known})`);
}

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

/**
 * Throw the friendly `invalid <file>: <reason>` error, where `file` is the
 * config the reason is about: `checkride.config.json` unless the caller knows
 * the file came from `--config` or `--defaults`. The reason rides on the error
 * too, so {@link relabeled} can name the file for a check that only finds the
 * problem while resolving.
 */
function invalidConfig(reason: string, cause?: unknown, file: string = CONFIG_FILE): never {
  throw Object.assign(new Error(`invalid ${file}: ${reason}`, cause ? { cause } : undefined), { configReason: reason });
}

/**
 * The file each config loaded from a path other than `checkride.config.json`
 * came from, so an error found while resolving it names that file. A config
 * loaded from the repo's own file, or built by hand, has none.
 */
const LABELS = new WeakMap<object, string>();

/** The file a config error about `config` names. */
function labelOf(config: object | null | undefined): string {
  return (config ? LABELS.get(config) : undefined) ?? CONFIG_FILE;
}

/** Run `fn`, so a config error it throws names `file` in place of `checkride.config.json`. */
function relabeled<T>(file: string, fn: () => T): T {
  if (file === CONFIG_FILE) return fn();
  try {
    return fn();
  } catch (err) {
    const reason: unknown = isRecord(err) ? err['configReason'] : undefined;
    if (typeof reason === 'string') invalidConfig(reason, err, file);
    throw err;
  }
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
    invalidConfig(`changedBase must be a non-empty string (got ${JSON.stringify(base)})`, undefined, labelOf(config));
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
 * Where one file sits as an `extends` chain resolves: `stack`, the absolute
 * paths above it, so a config that (transitively) extends itself is caught as
 * a cycle; `label`, how a message names this file, the root's name for the
 * root itself or a path relative to the working directory for an inherited
 * base; and `root`, the file the chain started from, which every error's
 * `invalid <file>:` prefix names. `warn`, when given, hears about each
 * top-level key a file in the chain holds that nothing reads.
 */
type Chain = { stack: readonly string[]; label: string; root: string; warn?: ConfigWarning; repo?: RepoShape };

/**
 * The repo a config chain configures, as its presets' tool picks need it
 * ({@link placedPicks}): the pack its root marks (R2.1), and whether the
 * chain's root config declares `targets`. A defaults file's chain carries
 * none, since the defaults layer lands each pick on the checks that can run
 * it as it resolves.
 */
type RepoShape = { pack: string; targets: boolean };

/** The chain a root config file starts, named `file` in every error, for the repo at `cwd` when it's given. */
function rootChain(file: string, warn?: ConfigWarning, cwd?: string): Chain {
  return {
    stack: [],
    label: file,
    root: file,
    ...(warn !== undefined ? { warn } : {}),
    ...(cwd !== undefined ? { repo: { pack: implicitPack(markerAt(cwd)), targets: false } } : {}),
  };
}

/** The target-scope slots, whose tool a check's pack decides. */
const PACK_SLOTS: ReadonlySet<string> = new Set(SLOTS.filter((s) => s.scope === 'target').map((s) => s.name));

/** The packs with an adapter named `adapter` for `slot`. Adapter names are unique per slot, so it's at most one. */
function packsWith(adapter: string, slot: string): string[] {
  return Object.values(PACKS).filter((p) => p.adapters.some((a) => a.name === adapter && a.slot === slot)).map((p) => p.name);
}

/**
 * `base`, a preset an `extends` names, with each top-level tool pick for a
 * target-scope slot that can't apply at the top level moved into the
 * `packs.<pack>.checks` block of the pack whose adapter it names, so it
 * reaches only the checks that can run it, as a defaults file's does. A pick
 * can't apply at the top level when the repo declares targets, where a
 * top-level entry only switches a slot off or tunes it (V6), or when the
 * pack the repo's root marks has no such adapter, where it would switch the
 * root's own tool off. So a fleet preset's `"lint": "oxlint"` lands on a ts
 * root or target and leaves a go one to golangci-lint. A pick the root's
 * pack can run stays where it is, and deep-merges with the repo's own entry
 * as it always has; so does one that names no pack's adapter, a custom
 * command, and an entry that only switches a slot off or tunes it. The
 * preset's own pack block wins over a pick moved into it.
 */
function placedPicks(base: Record<string, unknown>, repo: RepoShape): Record<string, unknown> {
  const checks = base['checks'];
  if (!isRecord(checks)) return base;
  const top: Record<string, unknown> = {};
  const moved = new Map<string, Record<string, unknown>>();
  for (const [slot, entry] of Object.entries(checks)) {
    const owners = movesTo(slot, entry, repo);
    if (owners.length === 0) top[slot] = entry;
    for (const pack of owners) moved.set(pack, { ...moved.get(pack), [slot]: entry });
  }
  if (moved.size === 0) return base;
  return { ...base, checks: top, packs: withPicks(isRecord(base['packs']) ? base['packs'] : {}, moved) };
}

/** The adapter a raw entry picks, by its name or `{ use }`, or `null` for one that picks none. */
function pickedAdapter(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  return isRecord(entry) && typeof entry['use'] === 'string' ? entry['use'] : null;
}

/**
 * The packs a preset's top-level `entry` for `slot` moves to: the one whose
 * adapter it picks, unless the pick can apply at the top level, which a repo
 * without targets whose root's pack has that adapter lets it. None for an
 * entry that picks no target-scope tool, or one no pack has.
 */
function movesTo(slot: string, entry: unknown, repo: RepoShape): string[] {
  const adapter = pickedAdapter(entry);
  if (adapter === null || !PACK_SLOTS.has(slot)) return [];
  const owners = packsWith(adapter, slot);
  return !repo.targets && owners.includes(repo.pack) ? [] : owners;
}

/** `packs` with each pack's moved `picks` under the `checks` its block already holds, which win. */
function withPicks(packs: Record<string, unknown>, moved: ReadonlyMap<string, Record<string, unknown>>): Record<string, unknown> {
  const out = { ...packs };
  for (const [pack, picks] of moved) {
    const current = out[pack];
    const block = isRecord(current) ? current : {};
    const own = isRecord(block['checks']) ? block['checks'] : {};
    out[pack] = { ...block, checks: { ...picks, ...own } };
  }
  return out;
}

/** Read and parse a config file into an object, or throw a friendly error. */
function parseConfigJson(absPath: string, chain: Chain): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absPath, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    invalidConfig(chain.label === chain.root ? reason : `${reason} (in ${chain.label})`, err, chain.root);
  }
  if (!isRecord(raw)) invalidConfig(`${chain.label} is not a JSON object`, undefined, chain.root);
  return raw;
}

/** Normalize an `extends` field (absent / single / array) into a list. */
function normalizeExtends(ext: unknown): unknown[] {
  return ext === undefined ? [] : Array.isArray(ext) ? ext : [ext];
}

/** Resolve and left-to-right merge every base config named in `specs`, which the file at `absPath` extends. */
function resolveExtends(specs: readonly unknown[], absPath: string, chain: Chain): Record<string, unknown> {
  const { label, root } = chain;
  const require = createRequire(absPath);
  let merged: Record<string, unknown> = {};
  for (const spec of specs) {
    if (typeof spec !== 'string') invalidConfig(`extends entries must be strings (in ${label})`, undefined, root);
    let baseAbs: string;
    try {
      baseAbs = require.resolve(spec);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      invalidConfig(`cannot resolve extends "${spec}" (in ${label}): ${reason}`, err, root);
    }
    const base = resolveConfigFile(baseAbs, { ...chain, stack: [...chain.stack, absPath], label: relative(process.cwd(), baseAbs) });
    const problem = presetProblem(base, spec, label);
    if (problem !== null) invalidConfig(problem, undefined, root);
    merged = deepMerge(merged, chain.repo === undefined ? base : placedPicks(base, chain.repo));
  }
  return merged;
}

/**
 * Read, parse, and fully resolve a config file's `extends` chain into a single
 * merged object, with `extends` folded away. Each file's own unknown keys are
 * reported as it's read, before presets merge in, so a warning names the file
 * that holds the key, the repo's own or a preset.
 */
function resolveConfigFile(absPath: string, chain: Chain): Record<string, unknown> {
  if (chain.stack.includes(absPath)) {
    invalidConfig(`circular extends: ${[...chain.stack, absPath].map((p) => relative(process.cwd(), p)).join(' -> ')}`, undefined, chain.root);
  }
  const parsed = parseConfigJson(absPath, chain);
  if (chain.warn !== undefined) for (const warning of unknownKeyWarnings(parsed, chain.label)) chain.warn(warning);
  const { extends: ext, ...own } = parsed;
  const merged = resolveExtends(normalizeExtends(ext), absPath, rootedChain(chain, own));
  return deepMerge(merged, own);
}

/**
 * `chain`, with its repo's `targets` read from `own` when `own` is the root
 * config's, the one file whose `targets` count; a preset's chain keeps the
 * root's.
 */
function rootedChain(chain: Chain, own: Record<string, unknown>): Chain {
  if (chain.repo === undefined || chain.stack.length > 0) return chain;
  return { ...chain, repo: { ...chain.repo, targets: own['targets'] !== undefined } };
}

/**
 * Hold a merged config to the rules its `targets`, `packs` and companion keys
 * keep (see `configProblem`), with `cwd` as the repo root its target roots
 * must exist under, and throw the friendly error, naming `file`, on the first
 * one it breaks. A config from a file other than the repo's own remembers its
 * name, for the errors resolution finds later.
 */
function validated(config: Record<string, unknown>, cwd: string, file: string): CheckrideConfig {
  const problem = configProblem(config, { cwd, layer: 'repo' });
  if (problem !== null) invalidConfig(problem, undefined, file);
  if (file !== CONFIG_FILE) LABELS.set(config, file);
  return config;
}

/**
 * Read, resolve and validate `checkride.config.json` from `cwd`, or `null`
 * when absent. Any `extends` presets (file paths or package specifiers) are
 * resolved and merged in — local keys win, arrays replace — with `extends`
 * folded away. `warn`, when given, hears about each top-level key a file
 * holds that nothing reads.
 */
export function loadConfig(cwd: string, warn?: ConfigWarning): CheckrideConfig | null {
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) return null;
  return validated(resolveConfigFile(path, rootChain(CONFIG_FILE, warn, cwd)), cwd, CONFIG_FILE);
}

/**
 * Resolve and validate `raw` as though it were the config file at `path`: its
 * `extends` resolve against that file, and the merged result keeps every rule
 * {@link loadConfig} holds a file to. For a command that edits a config before
 * writing it (`target add`), so a change that would break the file stops,
 * with the same exit-2 error, before anything lands.
 */
export function validateConfigObject(raw: Record<string, unknown>, path: string, cwd: string): CheckrideConfig {
  const { extends: ext, ...own } = raw;
  const label = relative(cwd, path) === CONFIG_FILE ? CONFIG_FILE : path;
  return validated(deepMerge(resolveExtends(normalizeExtends(ext), path, rootedChain(rootChain(label, undefined, cwd), own)), own), cwd, label);
}

/**
 * Read and resolve the config file at an explicit absolute `path` (`--config`,
 * `CHECKRIDE_CONFIG`) exactly as {@link loadConfig} reads the repo's own: its
 * relative `extends` resolve against that file, while paths inside its values
 * stay relative to the repo being checked, `cwd`. Every error it raises, and
 * every one resolving it raises later, names `path`, and so does every
 * warning `warn` hears. The caller has already confirmed the file exists,
 * since a named file that is missing is a usage error, not "no config".
 */
export function loadConfigFile(path: string, cwd: string, warn?: ConfigWarning): CheckrideConfig {
  return validated(resolveConfigFile(path, rootChain(path, warn, cwd)), cwd, path);
}

/** The first top-level key a defaults file can't hold, as a problem, or `null`. */
function defaultsKeyProblem(config: Record<string, unknown>): string | null {
  const key = Object.keys(config).find((k) => !DEFAULTS_KEYS.has(k));
  if (key === undefined) return null;
  return `a defaults file can't set ${key}: it may hold checks, packs, extends, timeout, requirePins and schemas, and the rest belongs to the repo's own config`;
}

/** Every adapter of every pack, which a defaults file's top-level `checks` may name. */
const PACK_ADAPTERS: readonly Adapter[] = Object.values(PACKS).flatMap((p) => p.adapters);

/** The adapter a top-level defaults entry names, when it names one. */
function namedAdapter(entry: SlotConfig): string | null {
  if (typeof entry === 'string') return entry;
  return isEntryObject(entry) && 'use' in entry ? entry.use : null;
}

/**
 * Hold every entry of a defaults file to the rules resolution holds an entry
 * to, by resolving each one dry: an entry that fills a slot in only some repos
 * would otherwise keep its typo until the day it fills one. A top-level entry
 * that names an adapter no pack has is an error here, since a defaults entry
 * that can't run anywhere fills nothing, silently.
 */
function checkDefaultsEntries(config: CheckrideConfig): void {
  const slots = new Map(SLOTS.map((s) => [s.name, s]));
  const blocks = [config.checks ?? {}, ...Object.values(config.packs ?? {}).map((p) => p?.checks ?? {})];
  for (const [name, entry] of blocks.flatMap((block) => Object.entries(block))) {
    if (isEntryObject(entry)) layerTuning([entry], name);
    const slot = slots.get(name);
    if (slot === undefined) {
      customCheckEntry(name, entry, () => true);
      continue;
    }
    const adapter = namedAdapter(entry);
    if (adapter !== null && byName(adapter, PACK_ADAPTERS, name) === null) {
      invalidConfig(`'${name}' names '${adapter}', which isn't an adapter of any pack`);
    }
    resolveOne(slot, entry, PACK_ADAPTERS, NO_DETECTION);
  }
}

/**
 * Read, resolve and validate the defaults file at an absolute `path`
 * (`--defaults`, `CHECKRIDE_DEFAULTS`, R13.1): its relative `extends` resolve
 * against it, it may hold only {@link DEFAULTS_KEYS}, never `targets` (V11),
 * and every entry it declares is held to resolution's rules now, whether or
 * not it fills a slot in this repo. Every error names `path`. The caller has
 * already confirmed the file exists.
 */
export function loadDefaultsFile(path: string, cwd: string): CheckrideConfig {
  const config = resolveConfigFile(path, rootChain(path));
  const problem = configProblem(config, { cwd, layer: 'defaults' }) ?? defaultsKeyProblem(config);
  if (problem !== null) invalidConfig(problem, undefined, path);
  relabeled(path, () => checkDefaultsEntries(config));
  return config;
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
  return (
    a.detect.length > 0 ||
    (a.detectTable?.length ?? 0) > 0 ||
    a.detectScript !== undefined ||
    (a.detectDeps?.length ?? 0) > 0 ||
    a.detectPin !== undefined
  );
}

/**
 * How detection reads one directory: which files sit there, the header of a
 * TOML table one of them opens (`[tool.ruff]`, or `null` when it opens none),
 * its package.json, and where a pin declares a tool for a check there
 * (`<file>: <key>`, or `null` when nothing but `PATH` would provide it).
 * `admits` says whether a check there can run an adapter's tool at all
 * (`chainCanRun`): one it can't is never picked by detection or the defaults
 * layer, since that would only trade a skip for a refusal, and the repo's
 * own config naming it still does.
 */
type Detection = {
  fileExists: (file: string) => boolean;
  tableIn: (signal: TableSignal) => string | null;
  manifest: Manifest;
  pinned: (bin: string) => string | null;
  admits: (adapter: Adapter) => boolean;
};

/** Detection that finds nothing, so a dry resolution runs only the entry's own rules. */
const NO_DETECTION: Detection = {
  fileExists: () => false,
  tableIn: () => null,
  manifest: EMPTY_MANIFEST,
  pinned: () => null,
  admits: () => true,
};

/**
 * The first header in a TOML file's text that opens `table` or a sub-table of
 * it, an array of tables included, as written (`[tool.ruff.lint]`), or `null`.
 * A best-effort read of the text: a header inside a multi-line string counts.
 */
function tomlTableHeader(text: string, table: string): string | null {
  const name = table.split('.').map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[ \\t]*\\.[ \\t]*');
  const header = new RegExp(`^[ \\t]*(\\[\\[?[ \\t]*${name}(?:[ \\t]*\\.[^\\]\\r\\n]*)?[ \\t]*\\]\\]?)[ \\t]*(?:#.*)?\\r?$`, 'm');
  return header.exec(text)?.[1]?.replaceAll(/\s+/g, '') ?? null;
}

/** The header of the table `signal` names in the file it names under `dir`, or `null` when the file can't be read or opens none. */
function tableAt(dir: string, signal: TableSignal): string | null {
  try {
    return tomlTableHeader(readFileSync(join(dir, signal.file), 'utf8'), signal.table);
  } catch {
    return null;
  }
}

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

/**
 * The config that configures `adapter` in `dir`, absolute: the first of its
 * `detect` files there, or the first `detectTable` header one of its files
 * opens (`pyproject.toml: [tool.ruff]`), or `null` when neither does. A pin,
 * a dependency or a script says the tool should run, not how, so none counts.
 */
export function configuredBy(adapter: Adapter, dir: string): string | null {
  const file = adapter.detect.find((f) => existsSync(join(dir, f)));
  if (file !== undefined) return file;
  for (const signal of adapter.detectTable ?? []) {
    const header = tableAt(dir, signal);
    if (header !== null) return `${signal.file}: ${header}`;
  }
  return null;
}

/** The first `detectTable` table a file opens, as a named signal (`pyproject.toml: [tool.ruff]`), or `undefined`. */
function tableSignal(a: Adapter, detection: Detection): Signal | undefined {
  for (const signal of a.detectTable ?? []) {
    const header = detection.tableIn(signal);
    if (header === null) continue;
    const by = `${signal.file}: ${header}`;
    return { by, via: `table '${by}'` };
  }
  return undefined;
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
  const table = tableSignal(a, detection);
  if (table !== undefined) return table;
  const script = a.detectScript;
  if (script !== undefined && detection.manifest.scripts.has(script)) {
    return { by: `package.json: scripts.${script}`, via: `scripts.${script}` };
  }
  return depSignal(a, detection.manifest) ?? pinSignal(a, detection.pinned) ?? (hasAnySignal(a) ? undefined : null);
}

/** First adapter for `slot` the check can run whose detection fires, plus the signal that matched (for the report). */
function detectAdapter(
  slot: string,
  adapters: readonly Adapter[],
  detection: Detection,
): { adapter: Adapter; signal: Signal } | null {
  for (const a of adapters) {
    if (a.slot !== slot || !detection.admits(a)) continue;
    const signal = detectionSignal(a, detection);
    if (signal !== undefined) return { adapter: a, signal };
  }
  return null;
}

/**
 * Why nothing filled `slot` on the detection path. When the slot's adapter gates
 * on a package script (`detectScript`, for example `build`), name the missing script so
 * an opted-in-but-scriptless slot stands down with a clear reason, and when it
 * applies only beside a file (`onlyWith`), give that file's reason; otherwise
 * the generic no-tool message.
 */
function undetectedReason(slot: string, adapters: readonly Adapter[]): string {
  const scripted = adapters.find((a) => a.slot === slot && a.detectScript !== undefined);
  if (scripted) return `no '${scripted.detectScript}' script in package.json`;
  return adapters.find((a) => a.slot === slot && a.onlyWith !== undefined)?.onlyWith?.skip ?? 'no tool detected for slot';
}

/**
 * A slot whose adapter is gated on a package script (`detectScript`, for example `build`
 * → `scripts.build`) stands down as a skip — never a red check — when that script
 * is absent, however the adapter was selected, and so does one that applies only
 * beside a file (`onlyWith`, for example `terraform validate` → a lock file) where
 * that file is absent. Detection already filters the auto-detect path; this also
 * covers an explicit config entry, so a shared preset that names `build` is safe
 * on a repo that has no build script.
 */
function standDownIfUnfit(check: ResolvedCheck, detection: Detection): ResolvedCheck {
  const script = check.adapter?.detectScript;
  const onlyWith = check.adapter?.onlyWith;
  let skip: string | null = null;
  if (script !== undefined && !detection.manifest.scripts.has(script)) skip = `no '${script}' script in package.json`;
  else if (onlyWith !== undefined && !detection.fileExists(onlyWith.file)) skip = onlyWith.skip;
  if (skip === null) return check;
  // A check with no adapter isn't in the run, so it says nothing about why it would be.
  const { origin: _origin, detectedBy: _by, detectedVia: _via, ...rest } = check;
  return { ...rest, adapter: null, skip };
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

/**
 * What `o` does that takes `row`'s static mark, or `null` when it does
 * neither: swap the command, or hand the tool, in its `args` or
 * `changedArgs`, an argument the row carries in neither (D79), as prettier's
 * `--plugin` or a `--config` naming a code config does. Dropping or
 * reordering the row's own arguments adds none.
 */
function staticDrop(row: Adapter, o: UseConfig): NonNullable<Adapter['staticDrop']> | null {
  if (o.command !== undefined) return { command: o.command };
  const carried = new Set([...row.args, ...(row.changedArgs ?? [])]);
  const arg = [o.args ?? [], o.changedArgs ?? []].flat().find((a) => !carried.has(a));
  return arg === undefined ? null : { arg };
}

/**
 * The `static` mark an entry sets over its adapter's own (R13.4): the
 * defaults file's vouch when it gives one, else none for an entry that swaps
 * the command, which runs a command of the config's, as a custom check does,
 * or that adds an argument to the row's, since the repo's config is as
 * untrusted as its code under `--static-only`, kept as `staticDrop` so the
 * skip names it. A row that isn't static has no mark to lose. A preset the
 * config extends is merged in by now, so its overrides count the same.
 */
function staticMark(row: Adapter, o: UseConfig): Pick<Adapter, 'static' | 'staticDrop'> {
  if (o.static !== undefined) return { static: o.static };
  const drop = staticDrop(row, o);
  return drop === null || row.static !== true ? {} : { static: false, staticDrop: drop };
}

function applyOverrides(base: Adapter, o: UseConfig): Adapter {
  const merged: Adapter = {
    ...base,
    ...staticMark(base, o),
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
    ...(c.static === true ? { static: true } : {}),
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
  // absent, and an `onlyWith` adapter without its file, even when config named it.
  return standDownIfUnfit(overridden, detection);
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
 * How {@link foldCustomChecks} reads a block beyond its own entries: `below`,
 * a lower block whose entry of the same name the block's own resolves over
 * (the pack block, under the top level of a repo without targets), and
 * `taken`, the names it leaves out.
 */
type FoldOptions = { below?: Readonly<Record<string, SlotConfig>>; taken?: ReadonlySet<string> };

/**
 * Resolve every config-only custom check (config key order preserved), skipping
 * any name that fills a catalogue slot. Order is baked onto each resolved check;
 * `resolveChecks` sorts the combined list.
 */
function foldCustomChecks(
  checks: Readonly<Record<string, SlotConfig>>,
  catalogueNames: ReadonlySet<string>,
  fileExists: (file: string) => boolean,
  { below = {}, taken = new Set() }: FoldOptions = {},
): ResolvedCheck[] {
  const customs: ResolvedCheck[] = [];
  for (const [name, own] of Object.entries(checks)) {
    if (catalogueNames.has(name) || taken.has(name)) continue;
    const entry = below[name] === undefined ? own : layeredEntry([own, below[name]], name);
    const resolved = entry === undefined ? null : customCheckEntry(name, entry, fileExists);
    if (resolved !== null) customs.push(resolved);
  }
  return customs;
}

/** A check the defaults layer added, marked as theirs; one that stood down has no origin to mark. */
function fromDefaults(check: ResolvedCheck): ResolvedCheck {
  return check.adapter === null ? check : { ...check, origin: 'defaults' };
}

/**
 * Every check name the repo's config declares, in any block: a custom check of
 * the defaults layer joins only under a name outside it (R13.1), so the
 * repo's own `false` keeps one out too.
 */
function declaredNames(config: CheckrideConfig | null): ReadonlySet<string> {
  const blocks = [
    config?.checks,
    ...Object.values(config?.targets ?? {}).map((t) => t.checks),
    ...Object.values(config?.packs ?? {}).map((p) => p?.checks),
  ];
  return new Set(blocks.flatMap((block) => Object.keys(block ?? {})));
}

/** A config's `packs.<pack>.checks`, or an empty block when it has none. */
function packBlock(config: CheckrideConfig | null | undefined, pack: string): Readonly<Record<string, SlotConfig>> {
  const packs: Readonly<Record<string, PackConfig | undefined>> = config?.packs ?? {};
  return packs[pack]?.checks ?? {};
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
  /**
   * The defaults layer (`--defaults`, R13.1), as {@link loadDefaultsFile}
   * reads it: its entries fill only a slot `config` and detection leave
   * empty, and its custom checks join only under names `config` doesn't
   * declare. Omitted or `null`, there's none.
   */
  defaults?: CheckrideConfig | null;
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
  // Pins and TOML tables are read off disk only against an explicit `cwd`, for the same reason.
  const repo = input.cwd;
  const pinned = repo !== undefined
    ? (bin: string) => pinDeclaration(bin, { cwd: join(repo, root), repo, pins: pinChain(pack) })
    : () => null;
  const tableIn = repo !== undefined ? (signal: TableSignal) => tableAt(join(repo, root), signal) : () => null;
  return { fileExists, tableIn, manifest, pinned, admits: (adapter) => chainCanRun(pack, adapter) };
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

/** One layer's entry for a check, or `undefined` where that layer has none. */
type Layer = SlotConfig | undefined;

/**
 * What the defaults layer fills a check from once the repo's layers and
 * detection leave it empty: the repo's layers (`repo`, highest first), whose
 * tuning still applies; the defaults layer's own entries, highest first (its
 * `packs.<pack>.checks`, then its `checks`, R3); and what the check resolves
 * against.
 */
type Fallback = {
  slot: Slot;
  repo: readonly Layer[];
  defaults: readonly Layer[];
  adapters: readonly Adapter[];
  detection: Detection;
};

/**
 * `resolved`, or, when the repo's layers and detection left it empty, the
 * check the defaults layer fills it with, marked `defaults` (R3, R13.1). The
 * defaults never beat a tool detection found or a repo entry that decides the
 * slot (a `false`, or a pick the registry lacks, included), and never wake an
 * inactive slot. A defaults `false`, or a pick this check can't run (a ts
 * linter, for a go target, or typos at a ts root, whose package manager can't
 * install it), leaves the gap as it was. A slot the defaults fill
 * keeps the opt-in status the repo gave it, since the defaults pick a tool and
 * the flags pick the run, and the repo's tuning applies over theirs.
 */
function filledByDefaults(resolved: ResolvedCheck, entry: Layer, fallback: Fallback): ResolvedCheck {
  if (resolved.adapter !== null || resolved.inactive === true || decides(entry)) return resolved;
  // Without a defaults entry that decides, resolving again would only repeat the detection that just failed.
  if (!fallback.defaults.some(decides)) return resolved;
  const layered = layeredEntry([...fallback.repo, ...fallback.defaults], fallback.slot.name);
  const filled = resolveOne(fallback.slot, layered, fallback.adapters, fallback.detection);
  // A `false`, a pick the check's adapters lack, a script-gated tool with no
  // script, and a tool the check's pin chain can't provide all fill nothing.
  if (filled.adapter === null || !fallback.detection.admits(filled.adapter)) return resolved;
  return { ...filled, origin: 'defaults', explicit: resolved.explicit === true };
}

/**
 * A slot at the repo root: inactive, or resolved from its top-level entry,
 * then detection, then the defaults layer's top-level entry. In a repo without
 * targets, `below` holds the pack block's entry for a target-scope slot, the
 * repo's under its top level and the defaults' over theirs.
 */
function repoSlotCheck(slot: Slot, input: ResolveInput, detection: Detection, below?: { repo: Layer; defaults: Layer }): ResolvedCheck {
  const top = input.config?.checks?.[slot.name];
  const repo = [top, below?.repo];
  // An entry with nothing under it resolves as written, as it always has.
  const entry = below?.repo === undefined ? top : layeredEntry(repo, slot.name);
  const resolved = inactiveCheck(slot, entry, input.config) ?? resolveOne(slot, entry, input.adapters, detection);
  const defaults = [below?.defaults, input.defaults?.checks?.[slot.name]];
  return filledByDefaults(resolved, entry, { slot, repo, defaults, adapters: input.adapters, detection });
}

/**
 * The `unclaimed` built-in with what it checks carried on its options: the
 * targets that claim markers, the one implicit target at the root in a repo
 * without them, and `unclaimed.ignore`. Any other check passes through.
 */
function withClaims(check: ResolvedCheck, targets: readonly Target[], config: CheckrideConfig | null): ResolvedCheck {
  if (check.adapter?.builtin !== 'unclaimed') return check;
  const claims = { targets: targets.map(({ name, pack, root }) => ({ name, pack, root })), ignore: config?.unclaimed?.ignore ?? [] };
  return { ...check, adapter: withOptions(check.adapter, { unclaimed: claims }) };
}

/** The pack of a repo without targets (R2.1), from the markers its root holds. */
function implicitPackOf(input: ResolveInput): string {
  const cwd = input.cwd ?? process.cwd();
  return implicitPack(input.fileExists ?? markerAt(cwd));
}

/** A check of the one implicit target, named by its slot alone, with no target and no root of its own. */
function untargeted(check: ResolvedCheck): ResolvedCheck {
  const { target, root, ...rest } = check;
  return target === undefined && root === undefined ? check : rest;
}

/**
 * The custom checks of a repo without targets, whose top level is the
 * implicit target's own entry: under `top`, each top-level custom check over
 * the pack block's entry of its name, then the ones only the pack block
 * declares, under `pack`. The repo's come first, then the defaults layer's,
 * each under a name the repo declares nowhere.
 */
function implicitCustomChecks(
  input: ResolveInput,
  pack: string,
  catalogueNames: ReadonlySet<string>,
  fileExists: (file: string) => boolean,
): { top: ResolvedCheck[]; pack: ResolvedCheck[] } {
  const layer = (config: CheckrideConfig | null | undefined, taken: ReadonlySet<string>) => {
    const top = config?.checks ?? {};
    const below = packBlock(config, pack);
    return {
      top: foldCustomChecks(top, catalogueNames, fileExists, { below, taken }),
      pack: foldCustomChecks(below, catalogueNames, fileExists, { taken: new Set([...taken, ...Object.keys(top)]) }),
    };
  };
  const repo = layer(input.config, new Set());
  const defaults = layer(input.defaults, declaredNames(input.config));
  return {
    top: [...repo.top, ...defaults.top.map(fromDefaults)],
    pack: [...repo.pack, ...defaults.pack.map(fromDefaults)],
  };
}

/**
 * Implicit mode: the repo is one target at its root, and its top-level
 * entries rank as that target's own, above its pack block. A ts root resolves
 * as 0.13 did: every catalogue slot, then every custom check, against
 * `adapters` through the implicit pin chain, with no pack. Any other pack
 * resolves as a declared target of it rooted at `.` would, its chain and
 * variables included, with each check named by its slot alone (D66).
 */
function implicitChecks(input: ResolveInput, pack: string, catalogueNames: ReadonlySet<string>): ResolvedCheck[] {
  if (pack !== PACKS.ts.name) {
    const target: Target = { name: '', pack, root: '.' };
    const detection = detectionAt(input, '.', PACKS.repo.name);
    const customs = implicitCustomChecks(input, pack, catalogueNames, detection.fileExists);
    const catalogue = catalogueChecks(input, [targetScope(input, target, true)], detection);
    return [...catalogue, ...customs.top.map(inRepo), ...customs.pack.map((c) => inTarget(c, target))].map(untargeted);
  }
  const detection = detectionAt(input, '.');
  const repoPack = packBlock(input.config, pack);
  const defaultsPack = packBlock(input.defaults, pack);
  const catalogue = input.slots.map((slot) =>
    repoSlotCheck(slot, input, detection, slot.scope === 'repo' ? undefined : { repo: repoPack[slot.name], defaults: defaultsPack[slot.name] }),
  );
  const customs = implicitCustomChecks(input, pack, catalogueNames, detection.fileExists);
  return [...catalogue, ...customs.top, ...customs.pack];
}

/** One target as resolution reads it: its pack's adapters, the blocks that configure it, and detection at its root. */
type TargetScope = {
  target: Target;
  adapters: readonly Adapter[];
  /** `targets.<name>.checks`, the highest layer. */
  own: Readonly<Record<string, SlotConfig>>;
  /** `packs.<pack>.checks`, below the target's own and above the top level. */
  pack: Readonly<Record<string, SlotConfig>>;
  /**
   * True for the one target of a repo without targets, whose top-level
   * entries rank as its own, above its pack block, as they will once
   * `target add` moves them into it.
   */
  implicit: boolean;
  /** The defaults layer's `packs.<pack>.checks`, which ranks below detection and above the defaults' top level. */
  defaultsPack: Readonly<Record<string, SlotConfig>>;
  detection: Detection;
};

function targetScope(input: ResolveInput, target: Target, implicit = false): TargetScope {
  const rows = Object.values(PACKS).find((p) => p.name === target.pack);
  return {
    target,
    adapters: rows?.adapters ?? [],
    own: input.config?.targets?.[target.name]?.checks ?? {},
    pack: packBlock(input.config, target.pack),
    implicit,
    defaultsPack: packBlock(input.defaults, target.pack),
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
 * its pack fills no such slot, and neither the target nor either pack block
 * configures one. The top-level entry, which V6 holds to `false` or tuning
 * once targets are declared, reaches only the targets whose pack fills the
 * slot, and the defaults' top-level entry (`defaultsTop`) the same. Detection
 * reads the target's root, and the defaults fill only what it leaves empty.
 */
function targetSlotCheck(slot: Slot, scope: TargetScope, top: Layer, defaultsTop: Layer): ResolvedCheck | null {
  const own = scope.own[slot.name];
  const pack = scope.pack[slot.name];
  const defaultsPack = scope.defaultsPack[slot.name];
  const fills = scope.adapters.some((a) => a.slot === slot.name);
  if (own === undefined && pack === undefined && defaultsPack === undefined && !fills) return null;
  const repo = scope.implicit ? [top, pack] : [own, pack, top];
  const entry = layeredEntry(repo, slot.name);
  const resolved = resolveOne(slot, entry, scope.adapters, scope.detection);
  const fallback = { slot, repo, defaults: [defaultsPack, defaultsTop], adapters: scope.adapters, detection: scope.detection };
  return inTarget(filledByDefaults(resolved, entry, fallback), scope.target);
}

/**
 * The target's custom checks: each name outside the catalogue that its pack's
 * block or its own declares, pack names first, each resolved from the target's
 * entry over its pack's as a slot is, then the defaults' pack block's, each
 * under a name the repo declares nowhere (`taken`). A `detect` gate reads the
 * target's root.
 */
function targetCustomChecks(scope: TargetScope, catalogueNames: ReadonlySet<string>, taken: ReadonlySet<string>): ResolvedCheck[] {
  const names = Object.keys({ ...scope.pack, ...scope.own }).filter((name) => !catalogueNames.has(name));
  const repo = names.flatMap((name) => {
    const entry = layeredEntry([scope.own[name], scope.pack[name]], name);
    const check = entry === undefined ? null : customCheckEntry(name, entry, scope.detection.fileExists);
    return check === null ? [] : [check];
  });
  const defaults = foldCustomChecks(scope.defaultsPack, catalogueNames, scope.detection.fileExists, { taken }).map(fromDefaults);
  return [...repo, ...defaults].map((check) => inTarget(check, scope.target));
}

/**
 * Each repo-scope slot once at the repo root, read through `detection`, and
 * each target-scope slot once for every scope that has it, in scope order.
 */
function catalogueChecks(input: ResolveInput, scopes: readonly TargetScope[], detection: Detection): ResolvedCheck[] {
  const top = input.config?.checks ?? {};
  const defaultsTop = input.defaults?.checks ?? {};
  return input.slots.flatMap((slot) =>
    slot.scope === 'repo'
      ? [inRepo(repoSlotCheck(slot, input, detection))]
      : scopes.flatMap((scope) => targetSlotCheck(slot, scope, top[slot.name], defaultsTop[slot.name]) ?? []),
  );
}

/**
 * Multi-target mode: each repo-scope slot once at the repo root, each
 * target-scope slot once for every target that has it, in target order, then
 * the top-level custom checks at the repo root, the repo's and then the
 * defaults', then each target's own. That natural order is the tie-break the
 * group sort keeps (R8.4).
 */
function targetChecks(input: ResolveInput, targets: readonly Target[], catalogueNames: ReadonlySet<string>): ResolvedCheck[] {
  const detection = detectionAt(input, '.', PACKS.repo.name);
  const scopes = targets.map((target) => targetScope(input, target));
  const taken = declaredNames(input.config);
  const customs = [
    ...foldCustomChecks(input.config?.checks ?? {}, catalogueNames, detection.fileExists),
    ...foldCustomChecks(input.defaults?.checks ?? {}, catalogueNames, detection.fileExists, { taken }).map(fromDefaults),
  ].map(inRepo);
  const targetCustoms = scopes.flatMap((scope) => targetCustomChecks(scope, catalogueNames, taken));
  return [...catalogueChecks(input, scopes, detection), ...customs, ...targetCustoms];
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
 * custom checks before each target's own (R8.4). Without `targets`, the repo
 * is one target of the pack its root marks (R2.1), resolved as 0.13 did when
 * that's ts, with its top-level entries over its pack block.
 *
 * `defaults` ranks below detection (R3): a slot the repo's entries and
 * detection leave empty takes its tool from the defaults' pack block, then
 * their top level, with `origin: 'defaults'`, and the defaults' custom checks
 * follow the repo's wherever the repo declares no check of that name. A config
 * error found here names the file the config came from.
 */
export function resolveChecks(input: ResolveInput): ResolvedCheck[] {
  return relabeled(labelOf(input.config), () => {
    const catalogueNames = new Set(input.slots.map((s) => s.name));
    const claimed = (checks: readonly ResolvedCheck[], targets: readonly Target[]): ResolvedCheck[] =>
      sortByGroup(checks.map((check) => withClaims(check, targets, input.config)));
    const declared = configuredTargets(input.config);
    if (declared !== null) return claimed(targetChecks(input, declared, catalogueNames), declared);
    const pack = implicitPackOf(input);
    return claimed(implicitChecks(input, pack, catalogueNames), [{ name: '', pack, root: '.' }]);
  });
}

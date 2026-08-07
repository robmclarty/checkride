/**
 * Configuration: load `checkride.config.json`, detect installed tools, and
 * resolve each slot to an adapter (or a skip reason).
 *
 * Resolution rule per slot:
 *   1. config entry wins  — string picks an adapter; `false` disables the slot;
 *      `{ use, ...overrides }` picks an adapter with overrides; `{ command, args }`
 *      is a custom check needing no adapter.
 *   2. otherwise detection — the first registry adapter for the slot whose
 *      `detect` files exist (or whose `detect` is empty, that is, always available).
 *   3. otherwise the slot is skipped (skipped ≠ failed).
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

import type { Adapter, Order, Slot } from './adapters.js';
import { isRecord } from './json.js';

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

/** Per-slot config: adapter name, `false` to disable, an override, or a custom check. */
export type SlotConfig = string | false | UseConfig | CustomCheck;

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
  /** What the stop gate runs, when the full check is too slow to pay per turn. */
  gate?: GateProfile;
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
  /** Run only these slots. */
  only?: string[];
  /** Run everything but these. */
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
   * When detection (not config) chose the adapter, the signal that matched — a
   * `detect` file, `scripts.<name>` (`detectScript`), or `dependency '<pkg>'`
   * (`detectDeps`). Surfaced by `doctor`; absent on config-selected or skipped checks.
   */
  detectedVia?: string;
};

const CONFIG_FILE = 'checkride.config.json';

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
 * Validate and carry the links built-in's `exclude`/`allowlist` options off a
 * config entry, each spread only when present. `exclude` must be a string array;
 * `allowlist` must be a string array of compilable regexes (a bad pattern is a
 * friendly config error, so the check never crashes on it). Meaningful only to
 * the `links` slot — other slots ignore the fields, and the JSON schema scopes
 * autocomplete — but validated wherever they appear so a typo surfaces as a
 * config error, not silence. `context` names the check in any error.
 */
function carriedLinksOptions(
  src: { exclude?: unknown; allowlist?: unknown },
  context: string,
): { exclude?: string[]; allowlist?: string[] } {
  const out: { exclude?: string[]; allowlist?: string[] } = {};
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
 * Read and resolve `checkride.config.json` from `cwd`, or `null` when absent.
 * Any `extends` presets (file paths or package specifiers) are resolved and
 * merged in — local keys win, arrays replace — with `extends` folded away.
 */
export function loadConfig(cwd: string): CheckrideConfig | null {
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) return null;
  return resolveConfigFile(path, [], CONFIG_FILE);
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
  return a.detect.length > 0 || a.detectScript !== undefined || (a.detectDeps?.length ?? 0) > 0;
}

/** The `detectDeps` package that appears in the manifest, as a named signal, or `null`. */
function depSignal(a: Adapter, manifest: Manifest): string | null {
  const dep = a.detectDeps?.find((d) => manifest.deps.has(d));
  return dep !== undefined ? `dependency '${dep}'` : null;
}

/**
 * Which of an adapter's detection signals fires — named for the doctor report —
 * or `null` when none does. Precedence: a present `detect` file, then
 * `detectScript` (`scripts.<name>`), then a `detectDeps` package in
 * dependencies/devDependencies. An adapter with no signals at all (empty
 * `detect`, no `detectScript`/`detectDeps` — a built-in, `publint`, `attw`,
 * `pnpm audit`) is always available.
 */
function detectionSignal(a: Adapter, fileExists: (f: string) => boolean, manifest: Manifest): string | null {
  const file = a.detect.find((f) => fileExists(f));
  if (file !== undefined) return file;
  if (a.detectScript !== undefined && manifest.scripts.has(a.detectScript)) return `scripts.${a.detectScript}`;
  return depSignal(a, manifest) ?? (hasAnySignal(a) ? null : 'always available');
}

/** First adapter for `slot` whose detection fires, plus the signal that matched (for the report). */
function detectAdapter(
  slot: string,
  adapters: readonly Adapter[],
  fileExists: (file: string) => boolean,
  manifest: Manifest,
): { adapter: Adapter; via: string } | null {
  for (const a of adapters) {
    if (a.slot !== slot) continue;
    const via = detectionSignal(a, fileExists, manifest);
    if (via !== null) return { adapter: a, via };
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
  if (script !== undefined && !manifest.scripts.has(script)) {
    return { ...check, adapter: null, skip: `no '${script}' script in package.json` };
  }
  return check;
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
 * Carry the `prose` slot's `exemplars` directory onto its adapter. A no-op on
 * any other slot (the field is documented as prose-only). `exemplars` must be a
 * string; `context` names the check in the error. Presence on disk is asserted
 * at run time by the orchestrator, never here — see `missingExemplarsOutcome`.
 */
function applyExemplars(adapter: Adapter, exemplars: unknown, context: string): Adapter {
  if (exemplars === undefined) return adapter;
  if (typeof exemplars !== 'string') invalidConfig(`'${context}' exemplars must be a string`);
  if (adapter.slot !== 'prose') return adapter;
  return { ...adapter, exemplars };
}

function applyOverrides(base: Adapter, o: UseConfig): Adapter {
  const merged: Adapter = {
    ...base,
    ...(o.command !== undefined ? { command: o.command } : {}),
    ...(o.args !== undefined ? { args: o.args } : {}),
    ...(o.outputFile !== undefined ? { outputFile: o.outputFile } : {}),
    ...(o.description !== undefined ? { description: o.description } : {}),
    ...carriedOverrides(o, base.slot),
    ...carriedLinksOptions(o, base.slot),
  };
  return applyExemplars(applyProfile(merged, o.profile, base.slot), o.exemplars, base.slot);
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

function active(slot: Slot, adapter: Adapter, explicit = false, detectedVia?: string): ResolvedCheck {
  return {
    slot: slot.name,
    optIn: slot.optIn ?? false,
    adapter,
    skip: null,
    order: effectiveOrder(slot, adapter),
    explicit,
    ...(detectedVia !== undefined ? { detectedVia } : {}),
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
  entry: UseConfig | CustomCheck,
  adapters: readonly Adapter[],
  explicit: boolean,
): ResolvedCheck | null {
  checkNote(entry, slot.name);
  if ('use' in entry) {
    const base = byName(entry.use, adapters, slot.name);
    return base
      ? active(slot, applyOverrides(base, entry), explicit)
      : skipped(slot, `configured adapter '${entry.use}' is not in the registry`, explicit);
  }
  if ('command' in entry) {
    return active(slot, customAdapter(slot.name, entry), explicit);
  }
  return null;
}

function resolveConfigOrDetect(
  slot: Slot,
  entry: SlotConfig | undefined,
  adapters: readonly Adapter[],
  fileExists: (file: string) => boolean,
  manifest: Manifest,
  explicit: boolean,
): ResolvedCheck {
  if (typeof entry === 'string') {
    const adapter = byName(entry, adapters, slot.name);
    return adapter
      ? active(slot, adapter, explicit)
      : skipped(slot, `configured adapter '${entry}' is not in the registry`, explicit);
  }
  if (entry && typeof entry === 'object') {
    const resolved = resolveObjectEntry(slot, entry, adapters, explicit);
    if (resolved !== null) return resolved;
  }
  const detected = detectAdapter(slot.name, adapters, fileExists, manifest);
  if (!detected) return skipped(slot, undetectedReason(slot.name, adapters), explicit);
  // Record only a concrete signal (file/script/dep); an always-available adapter
  // matched nothing in particular, so it carries no detection provenance.
  const via = detected.via === 'always available' ? undefined : detected.via;
  return active(slot, detected.adapter, false, via);
}

function resolveOne(
  slot: Slot,
  entry: SlotConfig | undefined,
  adapters: readonly Adapter[],
  fileExists: (file: string) => boolean,
  manifest: Manifest,
): ResolvedCheck {
  // Any non-`false` config entry is an explicit opt-in for this slot (`false`
  // disables it, so it never runs regardless). Detection (no entry) is not.
  const explicit = entry !== undefined && entry !== false;
  if (entry === false) {
    return skipped(slot, 'disabled in checkride.config.json');
  }
  const resolved = resolveConfigOrDetect(slot, entry, adapters, fileExists, manifest, explicit);
  // Config may override the slot's opt-in default (configure-without-opting-in).
  const overridden = applyOptIn(resolved, entry, slot.name);
  // A script-gated adapter (build) stands down — never red — when its script is
  // absent, even when config named it explicitly.
  return standDownIfScriptless(overridden, manifest);
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
  const detect = entry.detect ?? [];
  if (detect.length > 0 && !detect.some((f) => fileExists(f))) {
    // No adapter carries the order on a skip, so pin it on the synthetic slot.
    const order = readOrder(entry, name);
    return skipped(order !== undefined ? { name, order } : { name }, 'no detect file present');
  }
  // A custom check with `optIn: true` is held out of the default run (full-sweep only).
  return applyOptIn(active({ name }, customAdapter(name, entry)), entry, name);
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

/**
 * Resolve every catalogue slot (in SLOTS order) to an adapter or a skip reason,
 * fold in the config-only custom checks (config key order), then sort into the
 * group sequence: firsts, the numeric line ascending (`'any'`/`'middle'` at 0),
 * singles, lasts. The natural order — catalogue before customs — is the stable
 * within-group tie-break, so within any group catalogue members keep SLOTS order
 * and precede customs, which keep config-key order. The orchestrator's wave
 * scheduler waves on the same effective `order`.
 */
export function resolveChecks(input: {
  slots: readonly Slot[];
  adapters: readonly Adapter[];
  config: CheckrideConfig | null;
  cwd?: string;
  fileExists?: (file: string) => boolean;
  /**
   * package.json signals for `detectScript`/`detectDeps` detection; read from
   * `cwd` when omitted (tests inject an empty manifest to stay hermetic).
   */
  manifest?: { scripts: ReadonlySet<string>; deps: ReadonlySet<string> };
}): ResolvedCheck[] {
  const cwd = input.cwd ?? process.cwd();
  const fileExists = input.fileExists ?? ((file: string) => existsSync(join(cwd, file)));
  // Read package.json only against an explicit `cwd`; a caller that injects just
  // `fileExists` (a test, `inventory`) wants detection driven by that alone, not
  // the ambient process cwd — so it gets an empty manifest unless one is passed.
  const manifest = input.manifest ?? (input.cwd !== undefined ? readManifest(input.cwd) : EMPTY_MANIFEST);
  const checks = input.config?.checks ?? {};
  const catalogue = input.slots.map((slot) =>
    resolveOne(slot, checks[slot.name], input.adapters, fileExists, manifest),
  );

  const catalogueNames = new Set(input.slots.map((s) => s.name));
  const customs = foldCustomChecks(checks, catalogueNames, fileExists);

  return [...catalogue, ...customs]
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

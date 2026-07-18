/**
 * Configuration: load `checkride.config.json`, detect installed tools, and
 * resolve each slot to an adapter (or a skip reason).
 *
 * Resolution rule per slot (see plan §4):
 *   1. config entry wins  — string picks an adapter; `false` disables the slot;
 *      `{ use, ...overrides }` picks an adapter with overrides; `{ command, args }`
 *      is a custom check needing no adapter.
 *   2. otherwise detection — the first registry adapter for the slot whose
 *      `detect` files exist (or whose `detect` is empty, i.e. always available).
 *   3. otherwise the slot is skipped (skipped ≠ failed).
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

import type { Adapter, Order, Slot } from './adapters.js';

/** A custom check: a bare command, no adapter required. */
export type CustomCheck = {
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
};

/** Pick an adapter by name, with optional field overrides. */
export type UseConfig = {
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
};

/** Per-slot config: adapter name, `false` to disable, an override, or a custom check. */
export type SlotConfig = string | false | UseConfig | CustomCheck;

/** Shape of `checkride.config.json`. */
export type CheckrideConfig = {
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
   * `"format": "prettier"` runs without `--include` (see `selectChecks`).
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
    out[k] = isPlainObject(b) && isPlainObject(v) ? deepMerge(b, v) : v;
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
  if (!isPlainObject(raw)) invalidConfig(`${label} is not a JSON object`);
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
  return resolveConfigFile(path, [], CONFIG_FILE) as CheckrideConfig;
}

/**
 * Find an adapter by name, preferring one that also fills `slot`. A single tool
 * can fill several slots under one name — `fallow` fills `dead`, `dupes`, and
 * `health` — so `"dupes": "fallow"` must resolve to the dupes adapter, not the
 * first `fallow` in the registry. Falls back to a name-only match so naming a
 * cross-slot adapter (e.g. reusing `oxlint` in a custom slot) still works.
 */
function byName(name: string, adapters: readonly Adapter[], slot?: string): Adapter | null {
  return (
    adapters.find((a) => a.name === name && a.slot === slot) ??
    adapters.find((a) => a.name === name) ??
    null
  );
}

/** package.json signals consulted by `detectScript`/`detectDeps` detection (D18). */
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
 * or `null` when none does (D18). Precedence: a present `detect` file, then
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
 * on a package script (`detectScript`, e.g. `build`), name the missing script so
 * an opted-in-but-scriptless slot stands down with a clear reason; otherwise the
 * generic no-tool message.
 */
function undetectedReason(slot: string, adapters: readonly Adapter[]): string {
  const scripted = adapters.find((a) => a.slot === slot && a.detectScript !== undefined);
  return scripted ? `no '${scripted.detectScript}' script in package.json` : 'no tool detected for slot';
}

/**
 * A slot whose adapter is gated on a package script (`detectScript`, e.g. `build`
 * → `scripts.build`) stands down as a skip — never a red check — when that script
 * is absent, however the adapter was selected. Detection already filters the
 * auto-detect path; this also covers an explicit config entry, so a shared preset
 * that names `build` is safe on a repo that has no build script (D18).
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

function applyOverrides(base: Adapter, o: UseConfig): Adapter {
  return {
    ...base,
    ...(o.command !== undefined ? { command: o.command } : {}),
    ...(o.args !== undefined ? { args: o.args } : {}),
    ...(o.outputFile !== undefined ? { outputFile: o.outputFile } : {}),
    ...(o.description !== undefined ? { description: o.description } : {}),
    ...carriedOverrides(o, base.slot),
  };
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

/** Resolve a check's effective order: adapter (config-overridden) `order` ?? slot `order` ?? `'any'` (D1). */
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
  // A script-gated adapter (build) stands down — never red — when its script is
  // absent, even when config named it explicitly (D18).
  return standDownIfScriptless(resolved, manifest);
}

/**
 * Resolve a config-only custom check (an object with `command`, keyed by a name
 * not in the catalogue — e.g. a project's `"licenses"` check), or `null` when
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
  const detect = entry.detect ?? [];
  if (detect.length > 0 && !detect.some((f) => fileExists(f))) {
    // No adapter carries the order on a skip, so pin it on the synthetic slot.
    const order = readOrder(entry, name);
    return skipped(order !== undefined ? { name, order } : { name }, 'no detect file present');
  }
  return active({ name }, customAdapter(name, entry));
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

/** Group rank in D1's sequence: firsts (0), the numeric line incl. `'any'`/`'middle'` (1), singles (2), lasts (3). */
function groupRank(order: Order): number {
  if (order === 'first') return 0;
  if (order === 'single') return 2;
  if (order === 'last') return 3;
  return 1; // a number, or 'any'/'middle' — the main line
}

/** Position on the numeric line; `'any'`/`'middle'` sit at 0 (v1's conservative placement, D1). */
function lineValue(order: Order): number {
  return typeof order === 'number' ? order : 0;
}

/**
 * Resolve every catalogue slot (in SLOTS order) to an adapter or a skip reason,
 * fold in the config-only custom checks (config key order), then sort into D1's
 * group sequence: firsts, the numeric line ascending (`'any'`/`'middle'` at 0),
 * singles, lasts. The natural order — catalogue before customs — is the stable
 * within-group tie-break, so within any group catalogue members keep SLOTS order
 * and precede customs, which keep config-key order. Execution stays sequential;
 * the scheduler (a later step) waves on the same effective `order`.
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

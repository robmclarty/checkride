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

import type { Adapter, Slot } from './adapters.js';

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
   * Where a config-only custom check runs relative to the built-in catalogue:
   * `'first'` (ahead of every built-in check) or `'last'` (after them, the
   * default). Ignored on entries that fill a catalogue slot — those keep their
   * fixed catalogue position.
   */
  order?: 'first' | 'last';
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
  /** Default per-check timeout in seconds (no cap when unset). `0` on a check disables its cap. */
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
   * True when `checks` names this slot explicitly (a non-`false` config entry).
   * An explicit entry opts an otherwise opt-in slot into the default run — so
   * `"format": "prettier"` runs without `--include` (see `selectChecks`).
   */
  explicit?: boolean;
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

/**
 * Read, parse, and fully resolve a config file's `extends` chain into a single
 * merged object. `stack` holds the absolute paths currently being resolved, so
 * a config that (transitively) extends itself is caught as a cycle. `label`
 * names the file in error messages — the root config's own filename for the
 * entry point, or a repo-relative path for an inherited base.
 */
function resolveConfigFile(
  absPath: string,
  stack: readonly string[],
  label: string,
): Record<string, unknown> {
  if (stack.includes(absPath)) {
    invalidConfig(`circular extends: ${[...stack, absPath].map((p) => relative(process.cwd(), p)).join(' -> ')}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absPath, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    invalidConfig(label === CONFIG_FILE ? reason : `${reason} (in ${label})`, err);
  }
  if (!isPlainObject(raw)) invalidConfig(`${label} is not a JSON object`);

  const { extends: ext, ...own } = raw;
  const specs = ext === undefined ? [] : Array.isArray(ext) ? ext : [ext];

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

function byName(name: string, adapters: readonly Adapter[]): Adapter | null {
  return adapters.find((a) => a.name === name) ?? null;
}

/** First adapter for `slot` whose detect files are present (empty detect = always). */
function detectAdapter(
  slot: string,
  adapters: readonly Adapter[],
  fileExists: (file: string) => boolean,
): Adapter | null {
  for (const a of adapters) {
    if (a.slot !== slot) continue;
    if (a.detect.length === 0 || a.detect.some((f) => fileExists(f))) return a;
  }
  return null;
}

function applyOverrides(base: Adapter, o: UseConfig): Adapter {
  return {
    ...base,
    ...(o.command !== undefined ? { command: o.command } : {}),
    ...(o.args !== undefined ? { args: o.args } : {}),
    ...(o.outputFile !== undefined ? { outputFile: o.outputFile } : {}),
    ...(o.changedArgs !== undefined ? { changedArgs: o.changedArgs } : {}),
    ...(o.fixArgs !== undefined ? { fixArgs: o.fixArgs } : {}),
    ...(o.timeout !== undefined ? { timeout: o.timeout } : {}),
    ...(o.description !== undefined ? { description: o.description } : {}),
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
    ...(c.changedArgs !== undefined ? { changedArgs: c.changedArgs } : {}),
    ...(c.fixArgs !== undefined ? { fixArgs: c.fixArgs } : {}),
    ...(c.timeout !== undefined ? { timeout: c.timeout } : {}),
    devDeps: {},
  };
}

function active(slot: Slot, adapter: Adapter, explicit = false): ResolvedCheck {
  return { slot: slot.name, optIn: slot.optIn ?? false, adapter, skip: null, explicit };
}

function skipped(slot: Slot, reason: string, explicit = false): ResolvedCheck {
  return { slot: slot.name, optIn: slot.optIn ?? false, adapter: null, skip: reason, explicit };
}

function resolveOne(
  slot: Slot,
  entry: SlotConfig | undefined,
  adapters: readonly Adapter[],
  fileExists: (file: string) => boolean,
): ResolvedCheck {
  // Any non-`false` config entry is an explicit opt-in for this slot (`false`
  // disables it, so it never runs regardless). Detection (no entry) is not.
  const explicit = entry !== undefined && entry !== false;
  if (entry === false) {
    return skipped(slot, 'disabled in checkride.config.json');
  }
  if (typeof entry === 'string') {
    const adapter = byName(entry, adapters);
    return adapter
      ? active(slot, adapter, explicit)
      : skipped(slot, `configured adapter '${entry}' is not in the registry`, explicit);
  }
  if (entry && typeof entry === 'object') {
    if ('use' in entry) {
      const base = byName(entry.use, adapters);
      return base
        ? active(slot, applyOverrides(base, entry), explicit)
        : skipped(slot, `configured adapter '${entry.use}' is not in the registry`, explicit);
    }
    if ('command' in entry) {
      return active(slot, customAdapter(slot.name, entry), explicit);
    }
  }
  const detected = detectAdapter(slot.name, adapters, fileExists);
  return detected ? active(slot, detected) : skipped(slot, 'no tool detected for slot');
}

/**
 * Resolve every catalogue slot (in order) to an adapter or a skip reason, and
 * fold in any config-only custom checks (an object with a `command`, keyed by a
 * name not in the catalogue — e.g. a project's `"licenses"` check). Each custom
 * check runs ahead of the catalogue (`order: 'first'`) or after it (`'last'`,
 * the default); within a group, config key order is preserved. A custom check
 * that declares `detect` files is skipped when none of them are present.
 */
export function resolveChecks(input: {
  slots: readonly Slot[];
  adapters: readonly Adapter[];
  config: CheckrideConfig | null;
  cwd?: string;
  fileExists?: (file: string) => boolean;
}): ResolvedCheck[] {
  const cwd = input.cwd ?? process.cwd();
  const fileExists = input.fileExists ?? ((file: string) => existsSync(join(cwd, file)));
  const checks = input.config?.checks ?? {};
  const catalogue = input.slots.map((slot) =>
    resolveOne(slot, checks[slot.name], input.adapters, fileExists),
  );

  const catalogueNames = new Set(input.slots.map((s) => s.name));
  const firsts: ResolvedCheck[] = [];
  const lasts: ResolvedCheck[] = [];
  for (const [name, entry] of Object.entries(checks)) {
    if (catalogueNames.has(name)) continue;
    if (entry && typeof entry === 'object' && !('use' in entry) && 'command' in entry) {
      const detect = entry.detect ?? [];
      const resolved =
        detect.length > 0 && !detect.some((f) => fileExists(f))
          ? skipped({ name }, 'no detect file present')
          : active({ name }, customAdapter(name, entry));
      (entry.order === 'first' ? firsts : lasts).push(resolved);
    }
  }

  return [...firsts, ...catalogue, ...lasts];
}

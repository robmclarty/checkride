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
import { join } from 'node:path';

import type { Adapter, Slot } from '../adapters/index.js';

/** A custom check: a bare command, no adapter required. */
export type CustomCheck = {
  command: string;
  args?: string[];
  description?: string;
  outputFile?: string | null;
  changedArgs?: string[];
  fixArgs?: string[];
  name?: string;
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
};

/** Per-slot config: adapter name, `false` to disable, an override, or a custom check. */
export type SlotConfig = string | false | UseConfig | CustomCheck;

/** Shape of `checkride.config.json`. */
export type CheckrideConfig = {
  checks?: Record<string, SlotConfig>;
};

/** A slot resolved to a concrete adapter, or marked skipped with a reason. */
export type ResolvedCheck = {
  slot: string;
  optIn: boolean;
  adapter: Adapter | null;
  skip: string | null;
};

const CONFIG_FILE = 'checkride.config.json';

/** Read and parse `checkride.config.json` from `cwd`, or `null` when absent. */
export function loadConfig(cwd: string): CheckrideConfig | null {
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const config: CheckrideConfig = JSON.parse(text);
  return config;
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
    ...(o.description !== undefined ? { description: o.description } : {}),
  };
}

function customAdapter(slot: string, c: CustomCheck): Adapter {
  return {
    name: c.name ?? `custom:${slot}`,
    slot,
    description: c.description ?? `Custom ${slot} check`,
    detect: [],
    command: c.command,
    args: c.args ?? [],
    outputFile: c.outputFile ?? null,
    ...(c.changedArgs !== undefined ? { changedArgs: c.changedArgs } : {}),
    ...(c.fixArgs !== undefined ? { fixArgs: c.fixArgs } : {}),
    devDeps: {},
  };
}

function active(slot: Slot, adapter: Adapter): ResolvedCheck {
  return { slot: slot.name, optIn: slot.optIn ?? false, adapter, skip: null };
}

function skipped(slot: Slot, reason: string): ResolvedCheck {
  return { slot: slot.name, optIn: slot.optIn ?? false, adapter: null, skip: reason };
}

function resolveOne(
  slot: Slot,
  entry: SlotConfig | undefined,
  adapters: readonly Adapter[],
  fileExists: (file: string) => boolean,
): ResolvedCheck {
  if (entry === false) {
    return skipped(slot, 'disabled in checkride.config.json');
  }
  if (typeof entry === 'string') {
    const adapter = byName(entry, adapters);
    return adapter
      ? active(slot, adapter)
      : skipped(slot, `configured adapter '${entry}' is not in the registry`);
  }
  if (entry && typeof entry === 'object') {
    if ('use' in entry) {
      const base = byName(entry.use, adapters);
      return base
        ? active(slot, applyOverrides(base, entry))
        : skipped(slot, `configured adapter '${entry.use}' is not in the registry`);
    }
    if ('command' in entry) {
      return active(slot, customAdapter(slot.name, entry));
    }
  }
  const detected = detectAdapter(slot.name, adapters, fileExists);
  return detected ? active(slot, detected) : skipped(slot, 'no tool detected for slot');
}

/**
 * Resolve every catalogue slot (in order) to an adapter or a skip reason, then
 * append any config-only custom checks (an object with a `command`, keyed by a
 * name not in the catalogue — e.g. a project's `"licenses"` check).
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
  const extras: ResolvedCheck[] = [];
  for (const [name, entry] of Object.entries(checks)) {
    if (catalogueNames.has(name)) continue;
    if (entry && typeof entry === 'object' && !('use' in entry) && 'command' in entry) {
      extras.push(active({ name }, customAdapter(name, entry)));
    }
  }

  return [...catalogue, ...extras];
}

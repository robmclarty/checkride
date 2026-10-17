/**
 * Writing a change to a repo's targets: the config as written (not as its
 * presets fold it), validated whole before anything lands, and the baseline
 * entries that follow renamed checks. `target add` and existing-mode `init`
 * both declare targets this way.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic.js';
import type { Baseline } from './baseline/index.js';
import { BASELINE_FILE, parseBaseline, renameBaselineSlots, writeBaseline } from './baseline/index.js';
import { validateConfigObject } from './config.js';
import { isRecord } from './json.js';
import type { TargetChange } from './targets/index.js';

const CONFIG_FILE = 'checkride.config.json';

/** The repo's config as written, or `fresh()` when there is none. */
export function readRawConfig(cwd: string, fresh: () => Record<string, unknown>): Record<string, unknown> {
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) return fresh();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`invalid ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!isRecord(raw)) throw new Error(`invalid ${CONFIG_FILE}: ${CONFIG_FILE} is not a JSON object`);
  return raw;
}

/** The committed baseline, `null` when there's none, and an error when it can't be parsed, since its keys couldn't follow. */
function readBaseline(cwd: string, command: string): Baseline | null {
  const path = join(cwd, BASELINE_FILE);
  if (!existsSync(path)) return null;
  const baseline = parseBaseline(readFileSync(path, 'utf8'));
  if (baseline === null) {
    throw new Error(`${command}: ${BASELINE_FILE} can't be parsed, so its keys can't follow the renamed checks; run checkride recover first`);
  }
  return baseline;
}

/** The baseline with `renames` applied, and a line for each entry that moved, or `null` when nothing moves. */
function renamedBaseline(baseline: Baseline | null, renames: TargetChange['renames']): { baseline: Baseline; changes: string[] } | null {
  if (baseline === null) return null;
  const moved = Object.entries(baseline.slots).filter(([slot]) => renames.has(slot));
  if (moved.length === 0) return null;
  const changes = moved.map(([slot, keys]) => `${BASELINE_FILE}: ${slot} renamed ${renames.get(slot)} (${keys.length} key${keys.length === 1 ? '' : 's'})`);
  return { baseline: renameBaselineSlots(baseline, renames), changes };
}

/**
 * Validate `change.config` whole, presets folded in, then write it and the
 * baseline its renames reach, unless `dryRun`. A config that breaks a rule,
 * or a baseline that can't be parsed, throws before anything is written.
 * Returns the baseline's change lines and the files it wrote, or would.
 */
export async function writeTargetChange(cwd: string, change: TargetChange, opts: { dryRun: boolean; command: string }): Promise<{ changes: string[]; files: string[] }> {
  validateConfigObject(change.config, join(cwd, CONFIG_FILE), cwd);
  const baseline = renamedBaseline(readBaseline(cwd, opts.command), change.renames);
  if (!opts.dryRun) {
    await writeFileAtomic(join(cwd, CONFIG_FILE), `${JSON.stringify(change.config, null, 2)}\n`);
    if (baseline !== null) await writeBaseline(cwd, baseline.baseline);
  }
  return { changes: baseline?.changes ?? [], files: [CONFIG_FILE, ...(baseline !== null ? [BASELINE_FILE] : [])] };
}

/**
 * `checkride target add` (R7.4): declare a target in `checkride.config.json`,
 * creating the file when there's none, and convert a repo that declares no
 * targets yet (see `./targets/add.ts`, which plans the change without reading
 * a file).
 *
 * The new target adopts the tools its root already configures: each
 * non-opt-in slot detection fills there is named in its `checks`, as `init`
 * names what it adopts, so a tool added later doesn't take the slot over. The
 * slots `--add` names get their blessed tool named too, and, for a ts target,
 * the blessed config scaffolded under its root. The whole config is merged and
 * validated before anything is written, so a change that breaks a rule, such
 * as a ts target nesting under the converted root, exits 2 having written
 * nothing. Every change is printed, and `--dry-run` prints them and stops.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import { ADAPTERS, SLOTS } from './adapters.js';
import { writeFileAtomic } from './atomic.js';
import type { Baseline } from './baseline/index.js';
import { BASELINE_FILE, parseBaseline, renameBaselineSlots, writeBaseline } from './baseline/index.js';
import { resolveChecks, validateConfigObject } from './config.js';
import { generatedSchemaUrl, scaffoldSlotConfigs } from './init.js';
import { isRecord } from './json.js';
import type { Out } from './orchestrator/index.js';
import type { Pack } from './packs/index.js';
import { PACKS } from './packs/index.js';
import type { TargetChange } from './targets/index.js';
import { addTarget, normalizeRoot } from './targets/index.js';

export type TargetAddOptions = {
  cwd?: string;
  name: string;
  /** The target's pack. */
  lang: string;
  /** The target's root, relative to the repo root. */
  root: string;
  /** Slots to scaffold the blessed config for and name in the target's checks. */
  add?: readonly string[];
  /** The name a converted repo's implicit target takes (default `app`). */
  rootName?: string;
  dryRun?: boolean;
  stdout?: Out;
};

export type TargetAddResult = { exitCode: number; changes: string[]; written: string[] };

const CONFIG_FILE = 'checkride.config.json';

/** The name a converted repo's implicit target takes by default. */
const DEFAULT_ROOT_NAME = 'app';

/** The slots a target's pack fills, the repo-scope ones being the repo's. */
const TARGET_SLOTS: ReadonlySet<string> = new Set(SLOTS.filter((s) => s.scope !== 'repo').map((s) => s.name));

/** The repo's config as written, or a fresh one naming the schema when there is none. */
function readRawConfig(cwd: string): Record<string, unknown> {
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) return { $schema: generatedSchemaUrl() };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`invalid ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!isRecord(raw)) throw new Error(`invalid ${CONFIG_FILE}: ${CONFIG_FILE} is not a JSON object`);
  return raw;
}

/** A pack a target can name: every pack but `repo`, whose slots check the repo as a whole. */
type TargetPack = Pack & { name: Exclude<Pack['name'], 'repo'> };

function isTargetPack(pack: Pack): pack is TargetPack {
  return pack.name !== PACKS.repo.name;
}

/** The pack named `lang`, or a usage error naming the packs a target takes. */
function packOf(lang: string): TargetPack {
  const packs = Object.values(PACKS).filter(isTargetPack);
  const pack = packs.find((p) => p.name === lang);
  if (pack !== undefined) return pack;
  throw new Error(`target add: --lang ${JSON.stringify(lang)} isn't a pack (packs: ${packs.map((p) => p.name).join(', ')})`);
}

/** `--add`'s slots, each with the blessed adapter its pack fills it with; a slot the pack doesn't fill is a usage error. */
function blessedFor(pack: TargetPack, slots: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    slots.map((slot) => {
      const adapter = TARGET_SLOTS.has(slot) ? pack.adapters.find((a) => a.slot === slot) : undefined;
      if (adapter === undefined) {
        const why = TARGET_SLOTS.has(slot) ? `${pack.name} fills no ${slot} slot` : `${slot} is a repo-scope slot; scaffold it with checkride init --add ${slot}`;
        throw new Error(`target add: --add ${slot}: ${why}`);
      }
      return [slot, adapter.name];
    }),
  );
}

/** The tools the target's root already configures: each non-opt-in slot detection fills there, named. */
function adopted(cwd: string, name: string, pack: TargetPack, root: string): Record<string, string> {
  const checks = resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config: { targets: { [name]: { lang: pack.name, root } } }, cwd });
  return Object.fromEntries(
    checks.flatMap((r) => (r.target === name && r.origin === 'detected' && !r.optIn && r.adapter !== null ? [[r.slot, r.adapter.name]] : [])),
  );
}

/** The committed baseline, `null` when there's none, and a usage error when it can't be parsed. */
function readBaseline(cwd: string): Baseline | null {
  const path = join(cwd, BASELINE_FILE);
  if (!existsSync(path)) return null;
  const baseline = parseBaseline(readFileSync(path, 'utf8'));
  if (baseline === null) {
    throw new Error(`target add: ${BASELINE_FILE} can't be parsed, so its keys can't follow the renamed checks; run checkride recover first`);
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

/** Print the changes, and what was written, or that nothing was. */
function report(stdout: Out, heading: string, changes: readonly string[], written: readonly string[], dryRun: boolean): void {
  stdout.write(`\ncheckride target add: ${heading}\n\n`);
  for (const line of changes) stdout.write(`  ${line}\n`);
  stdout.write(dryRun ? '\ndry run: nothing written\n\n' : `\nwrote ${written.join(', ')}\n\n`);
}

/** Declare a target (R7.4); see the module comment. */
export async function runTargetAdd(options: TargetAddOptions): Promise<TargetAddResult> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const dryRun = options.dryRun ?? false;
  const pack = packOf(options.lang);
  const root = normalizeRoot(options.root);
  const add = options.add ?? [];
  const checks = { ...adopted(cwd, options.name, pack, root), ...blessedFor(pack, add) };
  const change = addTarget(readRawConfig(cwd), { name: options.name, lang: pack.name, root, checks }, {
    rootName: options.rootName ?? DEFAULT_ROOT_NAME,
    implicitPack: PACKS.ts.name,
    targetSlots: TARGET_SLOTS,
  });
  validateConfigObject(change.config, join(cwd, CONFIG_FILE), cwd);
  const baseline = renamedBaseline(readBaseline(cwd), change.renames);
  // The blessed configs are the ts pack's; another pack names its tool and scaffolds nothing yet.
  const scaffold = pack.name === PACKS.ts.name ? await scaffoldSlotConfigs(join(cwd, root), add, dryRun) : { written: [], skipped: [] };
  const scaffolded = scaffold.written.map((file) => `${posix.join(root, file)} written (--add)`);
  const changes = [...change.changes, ...(baseline?.changes ?? []), ...scaffolded];
  const written = [CONFIG_FILE, ...(baseline !== null ? [BASELINE_FILE] : []), ...scaffold.written.map((file) => posix.join(root, file))];
  if (!dryRun) {
    await writeFileAtomic(join(cwd, CONFIG_FILE), `${JSON.stringify(change.config, null, 2)}\n`);
    if (baseline !== null) await writeBaseline(cwd, baseline.baseline);
  }
  report(stdout, `${options.name} (${pack.name} at ${root})`, changes, written, dryRun);
  return { exitCode: 0, changes, written: dryRun ? [] : written };
}

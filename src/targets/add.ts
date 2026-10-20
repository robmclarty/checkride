/**
 * `target add` (R7.4) as a change to a config, without reading or writing a
 * file: the target it declares, and, for a repo that declares none yet, the
 * conversion that names the implicit target. `--discover` reuses the
 * conversion in memory.
 *
 * A repo without `targets` is one implicit target at its root. Declaring a
 * target ends that mode, so the implicit target becomes an explicit one named
 * `app` (or `--root-name`), rooted at `.`, which keeps checking what it
 * checked: the top-level entries for target-scope slots move into its own
 * `checks`, where they keep applying to it alone, and its baseline entries
 * move from `lint` to `app:lint`. Their keys already name paths from the repo
 * root, which is its root, so they still match the findings they masked.
 *
 * A root that marks no pack is checked as ts only by default, and when it
 * checks nothing of its own, making it a ts target would only block a later
 * ts target below it, since two can't nest. So an unmarked root becomes a
 * target only when an entry of its picks a tool; otherwise the added target
 * stands alone, and the top-level entries, which can only switch a slot off
 * or tune it, stay where they are.
 */

import { isRecord } from '../json.js';

/** A target as the config declares it. */
export type TargetEntry = { lang: string; root: string; checks?: Record<string, unknown> };

/** What a conversion or an addition changes. */
export type TargetChange = {
  /** The config to write. */
  config: Record<string, unknown>;
  /** Baseline entries to rename, by their old name, to their new one. */
  renames: ReadonlyMap<string, string>;
  /** What changed, one line each, as the command prints it. */
  changes: string[];
};

/** The target to add, by name. */
export type TargetToAdd = TargetEntry & { name: string };

/** How a conversion names the implicit target, and which slots it lifts. */
export type ConversionRules = {
  /** The name the implicit target takes, unless the added target takes it over. */
  rootName: string;
  /** The implicit target's pack (R2.1). */
  implicitPack: string;
  /** The target-scope slots, whose top-level entries the implicit target takes. */
  targetSlots: ReadonlySet<string>;
  /**
   * Whether the implicit target is one to keep: its root marks a pack
   * (R2.1), or, as `target add` reads it, it resolves a target-scope check
   * that runs a tool. Unmarked, it becomes a target only when a top-level
   * entry picks a tool.
   */
  marked: boolean;
};

/** The entries of `checks` that `keep` accepts, by name. */
function entriesOf(checks: Record<string, unknown>, keep: (name: string) => boolean): Record<string, unknown> {
  return Object.fromEntries(Object.entries(checks).filter(([name]) => keep(name)));
}

/**
 * `raw`, an implicit-mode config, with its implicit target named `name` and
 * rooted at `.`, of pack `lang`: the top-level entries for target-scope slots
 * move into the target's own `checks`, and its baseline entries take
 * `<name>:<slot>`. `extra` fills the target's checks the lifted entries leave.
 */
function liftImplicit(
  raw: Record<string, unknown>,
  target: { name: string; lang: string; extra?: Record<string, unknown> },
  targetSlots: ReadonlySet<string>,
): TargetChange {
  const { checks: rawChecks, targets: _none, ...rest } = raw;
  const checks = isRecord(rawChecks) ? rawChecks : {};
  const lifted = entriesOf(checks, (name) => targetSlots.has(name));
  const kept = entriesOf(checks, (name) => !targetSlots.has(name));
  const own = { ...target.extra, ...lifted };
  const entry: TargetEntry = { lang: target.lang, root: '.', ...(Object.keys(own).length > 0 ? { checks: own } : {}) };
  const config = { ...rest, targets: { [target.name]: entry }, ...(Object.keys(kept).length > 0 ? { checks: kept } : {}) };
  const renames = new Map([...targetSlots].map((slot) => [slot, `${target.name}:${slot}`]));
  const changes = [
    `targets.${target.name}: the repo's implicit ${target.lang} target, named and rooted at .`,
    ...Object.keys(lifted).map((slot) => `checks.${slot} moved to targets.${target.name}.checks.${slot}`),
  ];
  return { config, renames, changes };
}

/** How `--discover` names the implicit target's successor: the pack the root marks, and the slots its top-level entries fill. */
export type DiscoveryRules = Pick<ConversionRules, 'implicitPack' | 'targetSlots'>;

/**
 * `raw`, an implicit-mode config, with `proposed` declared (R13.2), in their
 * order. The proposed target at `.` of the root's pack takes the implicit
 * target over, as `target add` hands it over: the top-level entries for
 * target-scope slots move into its `checks`, and the baseline's entries take
 * its name. With no such target those entries go nowhere, so they're dropped,
 * each named in `dropped` and in `changes`, and nothing is renamed.
 */
export function liftDiscovered(
  raw: Record<string, unknown>,
  proposed: readonly TargetToAdd[],
  rules: DiscoveryRules,
): TargetChange & { dropped: string[] } {
  const heir = proposed.find((t) => t.root === '.' && t.lang === rules.implicitPack);
  const lifted = liftImplicit(raw, { name: heir?.name ?? '', lang: rules.implicitPack }, rules.targetSlots);
  const own = isRecord(lifted.config['targets']) ? lifted.config['targets'] : {};
  const targets = Object.fromEntries(proposed.map((t) => [t.name, t === heir ? own[t.name] : entryOf(t)]));
  const checks = isRecord(raw['checks']) ? raw['checks'] : {};
  const dropped = heir === undefined ? Object.keys(checks).filter((name) => rules.targetSlots.has(name)) : [];
  const added = proposed.filter((t) => t !== heir).flatMap(addedLines);
  const gone = dropped.map((slot) => `checks.${slot} dropped: no ${rules.implicitPack} target sits at the repo root to take it`);
  return {
    config: { ...lifted.config, targets },
    renames: heir === undefined ? new Map() : lifted.renames,
    changes: heir === undefined ? [...added, ...gone] : [...lifted.changes, ...added],
    dropped,
  };
}

/** The line that announces an added target's entry, and each check it names. */
function addedLines(target: TargetToAdd): string[] {
  const checks = Object.entries(target.checks ?? {}).map(([slot, value]) => `targets.${target.name}.checks.${slot}: ${JSON.stringify(value)}`);
  return [`targets.${target.name}: a ${target.lang} target rooted at ${target.root}`, ...checks];
}

/** `target` as the config entry declares it. */
function entryOf(target: TargetToAdd): TargetEntry {
  const { name: _name, checks, ...rest } = target;
  return { ...rest, ...(checks !== undefined && Object.keys(checks).length > 0 ? { checks } : {}) };
}

/** True when a top-level entry for one of `targetSlots` picks a tool: an adapter's name, `{ use }` or `{ command }`. */
export function picksTool(raw: Record<string, unknown>, targetSlots: ReadonlySet<string>): boolean {
  const checks = isRecord(raw['checks']) ? raw['checks'] : {};
  return Object.entries(checks).some(([slot, entry]) => {
    if (!targetSlots.has(slot)) return false;
    return typeof entry === 'string' || (isRecord(entry) && ('use' in entry || 'command' in entry));
  });
}

/**
 * `raw` with `target` declared (R7.4). A repo with targets gains one more. A
 * repo without them is converted first, and a target of the implicit pack
 * rooted at `.` takes the implicit target over instead of sitting beside it;
 * an unmarked implicit target that no entry gives a tool is left out, and
 * `target` declared alone. Throws when the name is taken; every other rule is
 * the config's own, checked once the result is merged and validated.
 */
export function addTarget(raw: Record<string, unknown>, target: TargetToAdd, rules: ConversionRules): TargetChange {
  if (raw['targets'] !== undefined) {
    const targets = isRecord(raw['targets']) ? raw['targets'] : {};
    if (Object.hasOwn(targets, target.name)) throw new Error(`target add: targets.${target.name} already exists`);
    return { config: { ...raw, targets: { ...targets, [target.name]: entryOf(target) } }, renames: new Map(), changes: addedLines(target) };
  }
  if (target.lang === rules.implicitPack && target.root === '.') {
    return liftImplicit(raw, { name: target.name, lang: target.lang, ...(target.checks ? { extra: target.checks } : {}) }, rules.targetSlots);
  }
  if (!rules.marked && !picksTool(raw, rules.targetSlots)) {
    return { config: { ...raw, targets: { [target.name]: entryOf(target) } }, renames: new Map(), changes: addedLines(target) };
  }
  if (target.name === rules.rootName) {
    throw new Error(`target add: the repo's implicit target takes the name ${rules.rootName}; pass --root-name <name> to name it something else`);
  }
  const lifted = liftImplicit(raw, { name: rules.rootName, lang: rules.implicitPack }, rules.targetSlots);
  const targets = isRecord(lifted.config['targets']) ? lifted.config['targets'] : {};
  return {
    config: { ...lifted.config, targets: { ...targets, [target.name]: entryOf(target) } },
    renames: lifted.renames,
    changes: [...lifted.changes, ...addedLines(target)],
  };
}

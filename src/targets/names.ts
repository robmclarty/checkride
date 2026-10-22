/**
 * Target names (R11.4), for discovery's proposals and `unclaimed`'s
 * suggestions alike. A target takes the last segment of its root, `.`
 * becoming `app`, which reads as what it checks. When two targets would take
 * one name, or one would take a name a slot, a reserved name or a custom
 * check already holds, the name says nothing about either, as `app-2` and
 * `infra-2` didn't (#18), so every one of them takes a longer name instead,
 * and none depends on the order discovery found them in:
 *
 * - targets that share a root take their pack's name, `ts` and `go` for a ts
 *   and a go target both at `.`;
 * - targets at different roots take the shortest run of their root's
 *   trailing segments that no other of them shares, `api-infra` and
 *   `web-infra` for `services/api/infra` and `services/web/infra`;
 * - and one that has neither, a top-level directory named like a slot, say,
 *   takes its pack's name after its own, `test-ts`, then a number.
 */

import { NAME_LENGTH, numbered, slugName } from './markers.js';

/** A target to name: its pack, its root, and the name its root alone gives it. */
export type Nameable = { readonly lang: string; readonly root: string; readonly base: string };

/**
 * A name for each of `targets`, in order, free of every name in `taken` and
 * of each other's: its `base` where no other target or taken name has it,
 * and otherwise a longer one, as this module's comment lays out.
 */
export function nameTargets(targets: readonly Nameable[], taken: ReadonlySet<string>): string[] {
  const bases = new Map<string, number>();
  for (const { base } of targets) bases.set(base, (bases.get(base) ?? 0) + 1);
  const names: (string | null)[] = targets.map(({ base }) => (bases.get(base) === 1 && !taken.has(base) ? base : null));
  const used = new Set([...taken, ...names.filter((n): n is string => n !== null)]);
  for (const base of new Set(targets.map((t) => t.base))) {
    const group = targets.flatMap((target, index) => (target.base === base && names[index] === null ? [{ target, index }] : []));
    const widened = widen(group.map(({ target }) => target), used);
    group.forEach(({ index }, at) => { names[index] = widened[at] ?? null; });
  }
  return names.map((n) => n ?? '');
}

/** Names for one group of colliding targets, claimed from `used` as they're given. */
function widen(group: readonly Nameable[], used: Set<string>): string[] {
  const names: (string | null)[] = group.map((t, i) => (group.some((o, j) => j !== i && o.root === t.root) ? claim(t.lang, used) : null));
  const deepest = Math.max(...group.map((t) => t.root.split('/').length));
  for (let depth = 2; depth <= deepest; depth += 1) bySuffix(group, names, depth, used);
  return group.map((t, i) => names[i] ?? claim(withPack(t.base, t.lang), used) ?? numberedClaim(t.base, used));
}

/** `base` with its pack's name after it, `base` cut short so the pack's name always fits (V1). */
function withPack(base: string, lang: string): string {
  return `${base.slice(0, NAME_LENGTH - lang.length - 1).replace(/-+$/, '')}-${lang}`;
}

/**
 * Give each unnamed target of `group` its root's last `depth` segments as a
 * name, where it has that many and no other unnamed target of the group
 * shares the result.
 */
function bySuffix(group: readonly Nameable[], names: (string | null)[], depth: number, used: Set<string>): void {
  const suffixes = group.map((t, i) => (names[i] === null ? suffixOf(t, depth) : null));
  suffixes.forEach((suffix, i) => {
    if (suffix === null || suffixes.filter((s) => s === suffix).length > 1) return;
    names[i] = claim(suffix, used);
  });
}

/**
 * The last `depth` segments of a target's root as one name, or `null` when it
 * has fewer, or the name comes out as the one that collided. A name starts
 * with a letter (V1), so segments that start with a digit, as `2024/infra`
 * does, follow the pack's name, `terraform-2024-infra`, rather than lose it.
 */
function suffixOf(target: Nameable, depth: number): string | null {
  const segments = target.root === '.' ? [] : target.root.split('/');
  if (segments.length < depth) return null;
  const joined = segments.slice(-depth).join('-');
  const name = slugName(/^[a-z]/i.test(joined) ? joined : `${target.lang}-${joined}`);
  return name === '' || name === target.base ? null : name;
}

/** `name`, claimed from `used`, or `null` when it's taken or empty. */
function claim(name: string, used: Set<string>): string | null {
  if (name === '' || used.has(name)) return null;
  used.add(name);
  return name;
}

/** `base` with the first number `used` lacks, claimed. */
function numberedClaim(base: string, used: Set<string>): string {
  const name = numbered(base, used);
  used.add(name);
  return name;
}

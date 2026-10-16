/**
 * The rules a config's `targets`, `packs` and their companion keys keep
 * (R2.3's V1 to V12), checked as the config loads, so a broken block exits 2
 * before any check runs.
 *
 * Each check returns the first problem it finds, worded as the reason in
 * `invalid checkride.config.json: <reason>`, or `null`; `../config.ts` throws
 * it. The rules read the slot catalogue and the pack registry as data, so a new
 * slot or pack moves them without an edit here.
 */

import { existsSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

import type { Adapter, Slot } from '../adapters.js';
import { SLOTS } from '../adapters.js';
import { isRecord } from '../json.js';
import { PACKS } from '../packs/index.js';

/** Which config a rule reads: the repo's own, presets folded in, or a defaults file (R13.1). */
type ConfigLayer = 'repo' | 'defaults';

/** The part of a pack the rules read: its name and its adapter rows. */
type PackRows = { readonly name: string; readonly adapters: readonly Adapter[] };

/** What the rules check a config against. */
type ValidationContext = {
  /** The repo root, which every target root is relative to. */
  cwd: string;
  layer: ConfigLayer;
  /** The slot catalogue: `SLOTS` unless a test swaps it. */
  slots?: readonly Slot[];
  /** The pack registry's rows: `PACKS` unless a test swaps it. */
  packs?: readonly PackRows[];
};

/** The context with the catalogue read into the sets the rules ask about. */
type Catalogue = {
  cwd: string;
  layer: ConfigLayer;
  /** Every name a target can't take: the catalogue's slots and the reserved two. */
  slotNames: ReadonlySet<string>;
  /** Slots that run once per target. */
  targetSlots: ReadonlySet<string>;
  /** Slots that run once for the whole repo, the reserved two included. */
  repoSlots: ReadonlySet<string>;
  /** The language packs, by name. */
  packs: ReadonlyMap<string, PackRows>;
};

/** A target that passed its own rules, with its root normalized. */
type Declared = { name: string; lang: string; root: string };

/**
 * A target as a run reads it: its name, the pack that checks it, and its root,
 * relative to the repo root and normalized, with `.` for the root itself.
 */
export type Target = { readonly name: string; readonly pack: string; readonly root: string };

/**
 * Repo-scope slots R5.1 appends after `snippets`. Until each joins `SLOTS`, V2
 * reserves its name anyway, so a target named after one doesn't break on the
 * upgrade that adds it (R5.1).
 */
const RESERVED_SLOTS: readonly string[] = ['schema', 'unclaimed'];

/** The pack whose slots check the repo as a whole; a target or a `packs` key never names it. */
const REPO_PACK = 'repo';

/** V1: a target name is a short lowercase word, so it reads well as `<target>:<slot>`. */
const TARGET_NAME = /^[a-z][a-z0-9-]{0,31}$/;

const TARGET_KEYS: readonly string[] = ['lang', 'root', 'include', 'exclude', 'checks', 'note'];
const PACK_KEYS: readonly string[] = ['checks', 'note'];
const UNCLAIMED_KEYS: readonly string[] = ['ignore'];
const FILE_LIST_KEYS: readonly string[] = ['include', 'exclude'];

/** V6: what a top-level entry for a target-scope slot may still set once targets are declared. */
const LIFTABLE_KEYS: readonly string[] = ['optIn', 'timeout', 'order', 'note'];

/** The argv placeholder a file-list pack's adapters take their files through (R11.2). */
const FILES_TOKEN = '{files}';

/** A value as the config spelled it, for a message. */
function show(value: unknown): string {
  return JSON.stringify(value);
}

/** True for an array whose every element is a string. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((e) => typeof e === 'string');
}

function catalogue(context: ValidationContext): Catalogue {
  const slots = context.slots ?? SLOTS;
  const packs = (context.packs ?? Object.values(PACKS)).filter((p) => p.name !== REPO_PACK);
  const names = (keep: (s: Slot) => boolean): string[] => slots.filter(keep).map((s) => s.name);
  return {
    cwd: context.cwd,
    layer: context.layer,
    slotNames: new Set([...names(() => true), ...RESERVED_SLOTS]),
    targetSlots: new Set(names((s) => s.scope !== 'repo')),
    repoSlots: new Set([...names((s) => s.scope === 'repo'), ...RESERVED_SLOTS]),
    packs: new Map(packs.map((p) => [p.name, p])),
  };
}

/** The language packs a config may name, for a message. */
function packList(cat: Catalogue): string {
  return `packs: ${[...cat.packs.keys()].join(', ')}`;
}

function unknownKeyProblem(record: Record<string, unknown>, where: string, allowed: readonly string[]): string | null {
  const extra = Object.keys(record).find((k) => !allowed.includes(k));
  return extra === undefined ? null : `${where} has an unknown key '${extra}' (expected ${allowed.join(', ')})`;
}

function noteProblem(note: unknown, where: string): string | null {
  return note === undefined || typeof note === 'string' ? null : `'${where}' note must be a string (got ${show(note)})`;
}

/**
 * V12's first half: a custom check's `skipExitCode`, an integer from 1 to 255
 * on a `{ command }` entry. 0 already means a pass, and no process exits above
 * 255. `context` names the check.
 */
export function skipExitCodeProblem(entry: Record<string, unknown>, context: string): string | null {
  const code = entry['skipExitCode'];
  if (code === undefined) return null;
  if ('use' in entry) {
    return `'${context}' skipExitCode applies only to a custom check ({ command }), not a { use } entry`;
  }
  if (!('command' in entry)) return `'${context}' skipExitCode applies only to a custom check ({ command })`;
  if (typeof code !== 'number' || !Number.isInteger(code) || code < 1 || code > 255) {
    return `'${context}' skipExitCode must be an integer from 1 to 255 (got ${show(code)})`;
  }
  return null;
}

/**
 * V12's second half: `static` vouches for a check under `--static-only`, and
 * only a defaults file may say that about its own checks. A repo can't vouch
 * for itself.
 */
function staticProblem(entry: Record<string, unknown>, context: string, layer: ConfigLayer): string | null {
  if (entry['static'] === undefined) return null;
  if (layer === 'repo') return `'${context}' sets static, which only a defaults file may set`;
  return typeof entry['static'] === 'boolean' ? null : `'${context}' static must be true or false (got ${show(entry['static'])})`;
}

/** The V12 keys on one check entry, wherever it sits. */
function entryKeysProblem(entry: unknown, context: string, layer: ConfigLayer): string | null {
  if (!isRecord(entry)) return null;
  return staticProblem(entry, context, layer) ?? skipExitCodeProblem(entry, context);
}

/**
 * V10 for one entry: a string or a `{ use }` entry names an adapter of the
 * pack it configures. The name may fill another slot, as at the top level.
 */
function adapterProblem(entry: unknown, where: string, slot: string, pack: PackRows): string | null {
  const name = typeof entry === 'string' ? entry : isRecord(entry) && 'use' in entry ? String(entry['use']) : null;
  if (name === null || pack.adapters.some((a) => a.name === name)) return null;
  const fill = pack.adapters.filter((a) => a.slot === slot).map((a) => a.name);
  const hint = fill.length > 0 ? `${pack.name} fills ${slot} with ${fill.join(', ')}` : `${pack.name} has no adapter for ${slot}`;
  return `${where} names '${name}', which isn't a ${pack.name} adapter (${hint})`;
}

/** One entry under `packs.<pack>.checks` or `targets.<name>.checks`. */
function scopedEntryProblem(key: string, entry: unknown, where: string, pack: PackRows, cat: Catalogue): string | null {
  if (cat.repoSlots.has(key)) {
    return `${where} configures ${key}, a repo-scope slot that runs once for the whole repo: configure it in the top-level checks`;
  }
  return adapterProblem(entry, where, key, pack) ?? entryKeysProblem(entry, where, cat.layer);
}

/** A `checks` block that configures one pack's targets. */
function scopedChecksProblem(checks: unknown, where: string, pack: PackRows, cat: Catalogue): string | null {
  if (checks === undefined) return null;
  if (!isRecord(checks)) return `${where} must be an object of check entries (got ${show(checks)})`;
  for (const [key, entry] of Object.entries(checks)) {
    const problem = scopedEntryProblem(key, entry, `${where}.${key}`, pack, cat);
    if (problem !== null) return problem;
  }
  return null;
}

/** Each target's or pack's `checks` block, under the path a message names it by. */
function scopedBlocks(key: 'targets' | 'packs', blocks: unknown): [string, unknown][] {
  if (!isRecord(blocks)) return [];
  return Object.entries(blocks).map(([name, block]) => [`${key}.${name}.checks`, isRecord(block) ? block['checks'] : undefined]);
}

/**
 * Where the config declares a check named `name`, as `<block>.<name>`, or
 * `null` when it declares none: the top-level `checks`, then each target's,
 * then each pack's. A target's name is never a slot's, so a check it finds is
 * a custom one.
 */
function customHome(name: string, config: Record<string, unknown>): string | null {
  const blocks: [string, unknown][] = [
    ['checks', config['checks']],
    ...scopedBlocks('targets', config['targets']),
    ...scopedBlocks('packs', config['packs']),
  ];
  const home = blocks.find(([, checks]) => isRecord(checks) && Object.hasOwn(checks, name));
  return home === undefined ? null : `${home[0]}.${name}`;
}

/**
 * V1 and V2: a target's name is well formed and means one thing as a selection
 * token, so it's no slot's name and no custom check's, wherever the config
 * declares that check: `--only web` would otherwise select target `web` and
 * `api:web` both.
 */
function nameProblem(name: string, config: Record<string, unknown>, cat: Catalogue): string | null {
  if (!TARGET_NAME.test(name)) {
    return `target name ${show(name)} must start with a lowercase letter and hold only lowercase letters, digits and hyphens, 32 characters at most`;
  }
  if (cat.slotNames.has(name)) {
    return `target name '${name}' is reserved: it's a slot's name, and a token like --only ${name} has to mean one thing`;
  }
  const home = customHome(name, config);
  if (home !== null) {
    return `target name '${name}' is taken by the custom check ${home}, and a token like --only ${name} has to mean one thing`;
  }
  return null;
}

/** A root as one path: no `./`, no doubled or trailing slash, and `.` for the repo root. */
function normalizeRoot(root: string): string {
  const normal = posix.normalize(root).replace(/\/+$/, '');
  return normal === '' ? '.' : normal;
}

/** V3: a root is a directory inside the repo, given relative to its root. */
function rootProblem(root: unknown, where: string, cwd: string): string | null {
  if (root === undefined) return `${where} has no root: give its directory relative to the repo root`;
  if (typeof root !== 'string' || root === '') {
    return `${where}.root must be a directory relative to the repo root (got ${show(root)})`;
  }
  if (posix.isAbsolute(root)) return `${where}.root ${show(root)} is absolute: give it relative to the repo root`;
  if (root.split('/').includes('..')) return `${where}.root ${show(root)} has a '..' segment: give a directory inside the repo`;
  const abs = join(cwd, root);
  if (!existsSync(abs)) return `${where}.root ${show(root)} doesn't exist in the repo`;
  return statSync(abs).isDirectory() ? null : `${where}.root ${show(root)} is a file, not a directory`;
}

/** True when a pack's checks run over a list of files rather than a root. */
function checksFileList(pack: PackRows): boolean {
  return pack.adapters.some((a) => a.args.includes(FILES_TOKEN));
}

/** V5: `include` and `exclude` pick a file-list pack's files, and no other pack takes them. */
function fileListProblem(target: Record<string, unknown>, where: string, pack: PackRows): string | null {
  for (const key of FILE_LIST_KEYS) {
    const value = target[key];
    if (value === undefined) continue;
    if (!checksFileList(pack)) {
      return `${where} sets ${key}, but ${pack.name} checks its root rather than a list of files, so it takes neither include nor exclude`;
    }
    if (!isStringArray(value)) return `${where}.${key} must be an array of globs (got ${show(value)})`;
  }
  return null;
}

/** The pack a target names, or why it names none. */
function langOf(target: Record<string, unknown>, where: string, cat: Catalogue): PackRows | string {
  const lang = target['lang'];
  if (lang === undefined) return `${where} has no lang: name its pack (${packList(cat)})`;
  const pack = typeof lang === 'string' ? cat.packs.get(lang) : undefined;
  return pack ?? `${where}.lang ${show(lang)} isn't a pack (${packList(cat)})`;
}

/** Every rule one target keeps on its own. */
function targetProblem(name: string, raw: unknown, config: Record<string, unknown>, cat: Catalogue): string | null {
  const where = `targets.${name}`;
  const named = nameProblem(name, config, cat);
  if (named !== null) return named;
  if (!isRecord(raw)) return `${where} must be an object with lang and root (got ${show(raw)})`;
  const pack = langOf(raw, where, cat);
  if (typeof pack === 'string') return pack;
  return (
    unknownKeyProblem(raw, where, TARGET_KEYS) ??
    noteProblem(raw['note'], where) ??
    rootProblem(raw['root'], where, cat.cwd) ??
    fileListProblem(raw, where, pack) ??
    scopedChecksProblem(raw['checks'], `${where}.checks`, pack, cat)
  );
}

/** The configured targets, once each has passed its own rules. */
function declaredTargets(targets: unknown): Declared[] {
  if (!isRecord(targets)) return [];
  return Object.entries(targets).flatMap(([name, t]) =>
    isRecord(t) ? [{ name, lang: String(t['lang']), root: normalizeRoot(String(t['root'])) }] : [],
  );
}

/**
 * The targets a config declares, in config order, or `null` when it declares
 * none: implicit mode, where the repo is one unnamed target at its root
 * (R2.1). Declaring any is multi-target mode, where each target's slots run
 * once from its root.
 */
export function configuredTargets(config: { readonly targets?: unknown } | null): Target[] | null {
  if (config?.targets === undefined) return null;
  return declaredTargets(config.targets).map(({ name, lang, root }) => ({ name, pack: lang, root }));
}

/** True when `inner` sits below `outer`. */
function isWithin(inner: string, outer: string): boolean {
  return outer === '.' || inner.startsWith(`${outer}/`);
}

/** V4 for one pair: two targets of one pack never share or nest their roots. Different packs may. */
function overlapProblem(a: Declared, b: Declared): string | null {
  if (a.lang !== b.lang) return null;
  if (a.root === b.root) {
    return `${a.lang} targets '${a.name}' and '${b.name}' share the root '${a.root}', and two targets of one pack can't overlap`;
  }
  const [outer, inner] = isWithin(a.root, b.root) ? [b, a] : [a, b];
  if (!isWithin(inner.root, outer.root)) return null;
  return `${a.lang} target '${inner.name}' sits inside '${outer.name}' ('${inner.root}' is under '${outer.root}'), and two targets of one pack can't nest`;
}

function nestingProblem(declared: readonly Declared[]): string | null {
  for (const [i, a] of declared.entries()) {
    for (const b of declared.slice(i + 1)) {
      const problem = overlapProblem(a, b);
      if (problem !== null) return problem;
    }
  }
  return null;
}

/** V9 and V11, then each target's own rules, then V4 across them. */
function targetsProblem(config: Record<string, unknown>, cat: Catalogue): string | null {
  const targets = config['targets'];
  if (targets === undefined) return null;
  if (cat.layer === 'defaults') {
    return "a defaults file can't declare targets: it fills in for any repo, and only the repo knows its own";
  }
  if (!isRecord(targets)) return `targets must be an object of named targets (got ${show(targets)})`;
  const entries = Object.entries(targets);
  if (entries.length === 0) return 'targets is empty: declare at least one target, or drop the key to check the repo as one';
  for (const [name, raw] of entries) {
    const problem = targetProblem(name, raw, config, cat);
    if (problem !== null) return problem;
  }
  return nestingProblem(declaredTargets(targets));
}

/** Where a top-level entry for `slot` belongs once targets are declared: each pack's block, with its targets. */
function homesOf(slot: string, declared: readonly Declared[], cat: Catalogue): string {
  const fills = declared.filter((t) => cat.packs.get(t.lang)?.adapters.some((a) => a.slot === slot));
  const byPack = Map.groupBy(fills.length > 0 ? fills : declared, (t) => t.lang);
  const homes = [...byPack].map(([pack, ts]) => `packs.${pack}.checks.${slot} (targets ${ts.map((t) => t.name).join(', ')})`);
  return `move it to ${homes.join(' or ')}, or into one target's checks`;
}

/**
 * V6: once targets are declared, a top-level entry for a target-scope slot
 * applies to every target whose pack fills it, so it may switch the slot off
 * or tune its scheduling, but it can't pick a tool: tools differ by pack.
 */
function liftProblem(slot: string, entry: unknown, declared: readonly Declared[], cat: Catalogue): string | null {
  if (declared.length === 0 || !cat.targetSlots.has(slot) || entry === false) return null;
  const extra = isRecord(entry) ? Object.keys(entry).filter((k) => !LIFTABLE_KEYS.includes(k)) : null;
  if (extra?.length === 0) return null;
  const what = extra === null ? `names ${show(entry)}` : `sets ${extra.join(', ')}`;
  return `checks.${slot} ${what}, but once targets are declared a top-level target-scope slot may set only ${LIFTABLE_KEYS.join(', ')}: ${homesOf(slot, declared, cat)}`;
}

function topChecksProblem(checks: unknown, declared: readonly Declared[], cat: Catalogue): string | null {
  if (!isRecord(checks)) return null;
  for (const [key, entry] of Object.entries(checks)) {
    const problem = liftProblem(key, entry, declared, cat) ?? entryKeysProblem(entry, key, cat.layer);
    if (problem !== null) return problem;
  }
  return null;
}

/** V10: `packs` keys are pack names, and each block configures that pack's adapters. */
function packsProblem(packs: unknown, cat: Catalogue): string | null {
  if (packs === undefined) return null;
  if (!isRecord(packs)) return `packs must be an object keyed by pack name (got ${show(packs)})`;
  for (const [name, block] of Object.entries(packs)) {
    const where = `packs.${name}`;
    const pack = cat.packs.get(name);
    if (pack === undefined) return `packs has '${name}', which isn't a pack (${packList(cat)})`;
    if (!isRecord(block)) return `${where} must be an object with checks (got ${show(block)})`;
    const problem =
      unknownKeyProblem(block, where, PACK_KEYS) ??
      noteProblem(block['note'], where) ??
      scopedChecksProblem(block['checks'], `${where}.checks`, pack, cat);
    if (problem !== null) return problem;
  }
  return null;
}

/** V8 for one rule: a schema is bundled or in the repo, never fetched. */
function schemaRefProblem(ref: unknown, where: string): string | null {
  if (typeof ref !== 'string' || ref === '') {
    return `${where} must name a bundled checkride:<id> schema or a repo-relative path (got ${show(ref)})`;
  }
  if (/^https?:\/\//i.test(ref)) {
    return `${where} ${show(ref)} is a URL, and a check never fetches: name a bundled checkride:<id> schema or a repo-relative path`;
  }
  return posix.isAbsolute(ref) ? `${where} ${show(ref)} is absolute: give it relative to the repo root` : null;
}

function schemasProblem(schemas: unknown): string | null {
  if (schemas === undefined) return null;
  if (!Array.isArray(schemas)) return `schemas must be an array of rules (got ${show(schemas)})`;
  for (const [i, rule] of schemas.entries()) {
    const problem = schemaRefProblem(isRecord(rule) ? rule['schema'] : undefined, `schemas[${i}].schema`);
    if (problem !== null) return problem;
  }
  return null;
}

/** The two top-level keys that aren't blocks of targets or checks. */
function keysProblem(config: Record<string, unknown>): string | null {
  const pins = config['requirePins'];
  if (pins !== undefined && typeof pins !== 'boolean') return `requirePins must be true or false (got ${show(pins)})`;
  const unclaimed = config['unclaimed'];
  if (unclaimed === undefined) return null;
  if (!isRecord(unclaimed)) return `unclaimed must be an object (got ${show(unclaimed)})`;
  const ignore = unclaimed['ignore'];
  return (
    unknownKeyProblem(unclaimed, 'unclaimed', UNCLAIMED_KEYS) ??
    (ignore === undefined || isStringArray(ignore) ? null : `unclaimed.ignore must be an array of globs (got ${show(ignore)})`)
  );
}

/**
 * The first rule a config breaks, as the reason for its config error, or
 * `null` when it keeps them all. `config` is the merged config, presets
 * folded in; `presetProblem` holds V7 for each preset as it folds.
 */
export function configProblem(config: Record<string, unknown>, context: ValidationContext): string | null {
  const cat = catalogue(context);
  return (
    keysProblem(config) ??
    targetsProblem(config, cat) ??
    topChecksProblem(config['checks'], declaredTargets(config['targets']), cat) ??
    packsProblem(config['packs'], cat) ??
    schemasProblem(config['schemas'])
  );
}

/**
 * V7: a preset that `extends` names can't declare targets, because it can't
 * know the repo's. `base` is the preset with its own presets folded in,
 * `spec` what `extends` said, and `label` the file that said it.
 */
export function presetProblem(base: Record<string, unknown>, spec: string, label: string): string | null {
  if (!('targets' in base)) return null;
  return `extends ${show(spec)} declares targets (in ${label}): a preset can't know a repo's targets, so only the repo's own config may declare them`;
}

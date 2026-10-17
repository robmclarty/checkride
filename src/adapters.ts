/**
 * Slot catalogue and adapter registry — data only.
 *
 * A `Slot` is a role in the pipeline (the catalogue; order matters, cheapest
 * first), and its scope says whether it checks one language's code or the repo
 * as a whole. An `Adapter` is a concrete tool that can fill a slot. The adapter
 * rows live in their language packs (`./packs/`); `ADAPTERS` is the ts and repo
 * packs' rows in catalogue order. Resolution (config vs detection) lives in
 * `./config.ts`, and execution lives in `./orchestrator/`.
 */

import { PACKS } from './packs/index.js';

/** The aggregate-report schema version written to `.check/summary.json`. */
export const SCHEMA_VERSION = 1;

/**
 * A check's scheduling order. Numbers form a single ascending line — equal
 * values run together as one concurrent wave, decimals sequence steps within a
 * wave (`1` before `1.1`), a barrier sits between distinct values. The five
 * keywords place a check relative to that line: `'first'`/`'last'` before/after
 * everything, `'single'` exclusively on its own (after the numeric line, before
 * `'last'`), and `'middle'`/`'any'` unordered in the main group. Effective order
 * resolves config `order` ?? `Adapter.order` ?? `Slot.order` ?? `'any'`.
 */
export type OrderString = 'first' | 'last' | 'middle' | 'single' | 'any';
export type Order = number | OrderString;

/** A role in the pipeline. */
export type Slot = {
  /** Stable slot name, for example `'lint'`. Used by `--only`/`--skip` and the report. */
  name: string;
  /**
   * Opt-in slots are excluded from the default run. Enable one with
   * `--all`/`--include <slot>`, or by naming it in `checks` (an explicit config
   * entry opts you in — see `resolveChecks`/`selectChecks`).
   */
  optIn?: boolean;
  /**
   * Default scheduling order for this slot — the lowest-precedence source, which
   * config and adapter overrides beat. Omitted means `'any'` (the main group).
   */
  order?: Order;
  /**
   * What the slot checks: `'target'` for one language's code, filled by that
   * language's pack (`ts`), or `'repo'` for the repo as a whole, filled by the
   * repo pack. Every slot in `SLOTS` declares one.
   */
  scope?: 'target' | 'repo';
  /**
   * A `checkride.config.json` key the slot needs before its tool can run:
   * `unclaimed` needs `targets`. Without the key the slot is inactive, absent
   * from a run the way an unselected opt-in slot is, even under `--all`,
   * unless a token names it, which records it as skipped with the reason. A
   * config entry that picks a tool for the slot runs it either way.
   */
  activeWith?: string;
};

/**
 * Slot-scoped options a config entry carries onto its adapter, keyed by the
 * one slot that reads each key. Config resolution attaches a key only when the
 * adapter fills that slot (see `config.ts`), so `options.links` never lands on
 * an oxlint adapter. Never authored in `ADAPTERS`: the registry ships no
 * defaults for these. Adding a slot-scoped option adds a key here, not a field
 * on `Adapter`.
 */
export type AdapterOptions = {
  /**
   * Read by the `links` built-in. `exclude`: extra directory names to skip
   * while walking for markdown, on top of its built-in exclude set.
   * `allowlist`: regex sources for link targets to treat as always valid
   * (deliberately illustrative links); validated at config load.
   */
  links?: { exclude?: string[]; allowlist?: string[] };
  /**
   * Read by the `prose` slot's pre-flight: repo-relative directory of
   * hand-written voice exemplars. The orchestrator fails the check when the
   * directory is missing or holds no files — the exemplars are load-bearing
   * anchor texts, and a config that points at nothing must not stay green.
   */
  prose?: { exemplars: string };
  /**
   * Read by the `unclaimed` built-in, from the config rather than a `checks`
   * entry: the targets that claim markers (the one implicit target at the
   * root, in a repo without `targets`), and `unclaimed.ignore`, the globs of
   * marker paths it never reports.
   */
  unclaimed?: { targets: { name: string; pack: string; root: string }[]; ignore: string[] };
};

/** A concrete tool that can fill a slot. */
export type Adapter = {
  /** Adapter name, for example `'oxlint'`. Recorded as `adapter` in the report. */
  name: string;
  /** The slot this adapter fills, for example `'lint'`. */
  slot: string;
  /** Human description for the report. */
  description: string;
  /** Config files whose presence activates this adapter. `[]` = always available. */
  detect: string[];
  /**
   * Detection by package script: the slot is available when `scripts.<name>`
   * exists in package.json. `build` uses `scripts.build` — an opted-in `build`
   * on a repo with no build script stands down as a skip, never a red check.
   */
  detectScript?: string;
  /**
   * Backup detection signal: the slot activates when a `detect` file exists OR
   * one of these packages appears in dependencies/devDependencies. Populated only
   * on adapters whose tool runs correctly with zero config, so a repo that
   * installed the tool but never wrote its config file still opts in.
   */
  detectDeps?: string[];
  /**
   * Detection by pin: the slot is available when a source in the check's pin
   * chain other than `PATH` declares this tool, such as a `[tools]` key in a
   * `mise.toml`. For a tool that needs no config file, a pin is the repo's
   * word that the tool should run, where a copy on one machine's `PATH` isn't.
   */
  detectPin?: string;
  /** Command to spawn (usually `'pnpm'`). Ignored when `builtin` is set. */
  command: string;
  /**
   * Arguments to the command. Ignored when `builtin` is set. `{out}` in any of
   * them expands to the check's artifact directory, `.check` by default. In a
   * target of a pack that checks a list of files (bash), an argument that is
   * exactly `{files}` expands to the target's files, one argument each.
   */
  args: string[];
  /**
   * `.check/<file>` target when stdout is JSON, or JSON lines when the file is a
   * `.jsonl`; `null` if the tool writes its own.
   */
  outputFile: string | null;
  /**
   * Fail the check when the tool exits 0 but prints to stdout, for a tool such
   * as `gofmt -l` that reports what it found by printing it and exits 0 anyway.
   */
  failOnOutput?: boolean;
  /**
   * The tool needs the network, as a vulnerability scan that reads an
   * advisory feed does, so its check runs without the variables its pack sets
   * to block downloads (R6.4). It keeps the ones that pin a toolchain or
   * switch off an install.
   */
  network?: boolean;
  /**
   * Appended to `args` under `--changed`. `{base}` in any of them expands to the
   * base ref the run measures changes from (see `resolveChangedBase`).
   */
  changedArgs?: string[];
  /** Used by `checkride fix`. */
  fixArgs?: string[];
  /** Per-check timeout in seconds; `0` disables the cap. Falls back to the config-level `timeout`, then the built-in 600s default. */
  timeout?: number;
  /** In-process check id (for example `'links'`); when set, the orchestrator runs it directly. */
  builtin?: string;
  /** Slot-scoped options carried from config; see {@link AdapterOptions}. */
  options?: AdapterOptions;
  /**
   * Scheduling order override for this adapter, beating the slot's default (used
   * when one slot carries adapters that schedule differently). Omitted defers to
   * the slot.
   */
  order?: Order;
  /**
   * A key two checks never run under at the same time, even in one wave: the
   * one that would overlap waits, unstarted, so its timeout doesn't run while
   * it waits. `{root}` expands to the check's target root, `.` for the repo
   * root, so `cargo:{root}` keeps one target's cargo checks apart and leaves
   * another target's free. Omitted, the check takes no lock.
   */
  lock?: string;
  /** Pinned versions `init` writes into package.json. */
  devDeps: Record<string, string>;
};

/**
 * Pipeline catalogue in cheapest-first order — the within-wave tie-break and the
 * full `--bail` sequence. Most slots take the default `'any'` wave; `mutation`
 * runs exclusively (`'single'`) because stryker saturates every core, `build`
 * runs in wave 10, and the artifact checks (`publint`/`attw`) share wave 20 so
 * the build precedes them. See `config.ts` for how effective order resolves and sorts.
 */
export const SLOTS: readonly Slot[] = [
  { name: 'types', scope: 'target' },
  { name: 'format', scope: 'target', optIn: true },
  { name: 'lint', scope: 'target' },
  { name: 'struct', scope: 'repo' },
  { name: 'dead', scope: 'target' },
  { name: 'dupes', scope: 'target', optIn: true },
  { name: 'health', scope: 'target', optIn: true },
  { name: 'test', scope: 'target' },
  { name: 'docs', scope: 'repo' },
  { name: 'links', scope: 'repo' },
  { name: 'spell', scope: 'repo' },
  { name: 'prose', scope: 'repo', optIn: true },
  { name: 'mutation', scope: 'target', optIn: true, order: 'single' },
  { name: 'security', scope: 'target', optIn: true },
  { name: 'build', scope: 'target', optIn: true, order: 10 },
  { name: 'publint', scope: 'target', optIn: true, order: 20 },
  { name: 'attw', scope: 'target', optIn: true, order: 20 },
  { name: 'pack', scope: 'target', optIn: true, order: 20 },
  { name: 'smoke', scope: 'target', optIn: true, order: 20 },
  { name: 'snippets', scope: 'target', optIn: true },
  { name: 'unclaimed', scope: 'repo', activeWith: 'targets' },
];

/**
 * Adapter registry: the ts and repo packs' rows, laid out in catalogue order.
 * Within a slot the rows keep their pack order, so the FIRST adapter for a slot
 * is its blessed default: it wins detection when several tool configs coexist,
 * and is the only one `init` generates config for. Alternates follow so
 * checkride can still *run* them.
 */
const PACK_ROWS: readonly Adapter[] = [...PACKS.ts.adapters, ...PACKS.repo.adapters];

export const ADAPTERS: readonly Adapter[] = SLOTS.flatMap((slot) => PACK_ROWS.filter((a) => a.slot === slot.name));

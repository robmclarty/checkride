/**
 * The shapes the pack registry is made of. A pack is one language's adapters,
 * with the root markers and pin sources that go with them; a tool is an
 * external executable those adapters run, described once. Both are plain data
 * that survive a JSON round trip, like the adapter rows they carry.
 */

import type { Adapter } from '../adapters.js';

/**
 * Where a pack's tools are pinned. `js-lockfile` is the package manager's own:
 * a tool is the copy its lockfile installed under `node_modules/.bin`.
 */
type PinSourceName = 'js-lockfile';

/** One language's adapters, with the root markers and pin sources that go with them. */
export type Pack = {
  /** The pack's name, which is also its key in `PACKS`. */
  name: 'ts' | 'repo';
  /**
   * Files whose presence marks a directory as holding this pack's code. The
   * repo pack has none: its slots check the repo as a whole.
   */
  markers: readonly string[];
  /** Where this pack's tools are pinned, in the order they're looked up. */
  pins: readonly PinSourceName[];
  /** Variables this pack's checks run with, over the user's own. */
  env: Readonly<Record<string, string>>;
  /**
   * The pack's adapter rows. The FIRST adapter for a slot is its blessed
   * default: it wins detection when several tool configs coexist, and is the
   * only one `init` generates config for.
   */
  adapters: readonly Adapter[];
};

/** An external tool, described once however many adapters run it. */
export type Tool = {
  /** The executable's name, which an adapter runs it by. */
  bin: string;
  /** The npm package that provides `bin`. */
  npm?: string;
  /** What to tell someone whose project lacks the tool. */
  install: string;
};

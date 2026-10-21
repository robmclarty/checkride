/**
 * The shapes the pack registry is made of. A pack is one language's adapters,
 * with the root markers and pin sources that go with them; a tool is an
 * external executable those adapters run, described once. Both are plain data
 * that survive a JSON round trip, like the adapter rows they carry.
 */

import type { Adapter } from '../adapters.js';

/**
 * Where a tool's version is declared in a repo: a pin source. `js-lockfile` is
 * the package manager's own, a tool being the copy its lockfile installed under
 * `node_modules/.bin`. `mise` is a `[tools]` key in a `mise.toml`, and `path`
 * declares nothing: it's the copy a machine's `PATH` holds, unpinned.
 * `override` is a `--pins` file's `[tools]` entry, which heads every chain
 * when a run names one, and `go-mod-tool`, `rust-toolchain`, `uv-lock` and
 * `tf-version` the go, rust, python and terraform packs' own. No chain names
 * `nix`: it's what the `path` step records for a copy a Nix dev shell the
 * repo declares put on `PATH`, which its Nix files pin.
 */
export type PinSourceName =
  | 'override'
  | 'js-lockfile'
  | 'go-mod-tool'
  | 'rust-toolchain'
  | 'uv-lock'
  | 'tf-version'
  | 'mise'
  | 'nix'
  | 'path';

/** One language's adapters, with the root markers and pin sources that go with them. */
export type Pack = {
  /** The pack's name, which is also its key in `PACKS`. */
  name: 'ts' | 'repo' | 'bash' | 'go' | 'rust' | 'python' | 'terraform';
  /**
   * Files whose presence marks a directory as holding this pack's code, each
   * a file name or a glob over one (`*.tf`). The repo pack has none, since its
   * slots check the repo as a whole, and neither does bash, whose targets are
   * always declared.
   */
  markers: readonly string[];
  /**
   * The pin chain: where this pack's tools are pinned, in the order they're
   * looked up. The first source that declares a tool runs it, with no fall
   * through to the next, and `path` runs a tool nothing declared.
   */
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
  /**
   * The package path a `go.mod` `tool` directive names to declare `bin`, such
   * as `golang.org/x/tools/cmd/deadcode`, which runs as `go tool <bin>`.
   */
  goTool?: string;
  /**
   * The PyPI package that provides `bin`, such as `ruff`, which a `uv.lock`
   * lists to declare it, and which runs from the project's environment.
   */
  pypi?: string;
  /**
   * The argv the tool runs as when it isn't its own executable, its arguments
   * after: `cargo clippy` for `cargo-clippy`. Omitted, the executable itself.
   */
  run?: readonly string[];
  /**
   * The rustup component that provides the tool, such as `clippy`, which a
   * `rust-toolchain.toml` pins along with the toolchain it names.
   */
  component?: string;
  /**
   * The `[tools]` keys that declare it in a `mise.toml`, such as `shellcheck`
   * or `aqua:koalaman/shellcheck`. Omitted, the executable's own name.
   */
  mise?: readonly string[];
  /** What to tell someone whose project lacks the tool. */
  install: string;
};

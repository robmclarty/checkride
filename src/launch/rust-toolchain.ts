/**
 * The `rust-toolchain` pin source: a `rust-toolchain.toml` or `rust-toolchain`
 * file from the check's directory up to the repo root pins the toolchain, and
 * with it the rustup components, rustfmt and clippy, that run through it
 * (R6.1). rustup's `cargo` reads the file and runs the toolchain it names, so
 * the source declares only whether the file is there, and the channel it
 * names, which the summary records when it's an exact version (R6.3). Where
 * no rustup is on `PATH`, a Nix dev shell built from the file, as
 * rust-overlay and fenix build one, can stand in for it, when its toolchain
 * is the exact release the file names.
 */

import { readFileSync } from 'node:fs';
import { delimiter, dirname, join, relative } from 'node:path';

import type { NixQuery } from './nix.js';
import { nixCopy } from './nix.js';
import { findOnPath } from './path.js';
import { dirsUpTo } from './walk.js';

/** The files rustup reads a directory's toolchain from, in the order it prefers them. */
const TOOLCHAIN_FILES = ['rust-toolchain.toml', 'rust-toolchain'] as const;

/** Where a toolchain file declares the toolchain: the file, relative to the repo root, and its channel when it names one. */
export type RustToolchainDeclaration = { file: string; channel?: string };

/** The text of the file at `path`, or `null` when there's none to read. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The channel a toolchain file names: the `channel` key of a
 * `rust-toolchain.toml`'s `[toolchain]` table, or the single line of a legacy
 * `rust-toolchain` file that holds only a channel. `undefined` for a file that
 * names a path toolchain instead, or nothing it can read.
 */
export function toolchainChannel(text: string): string | undefined {
  const keyed = /^\s*channel\s*=\s*["']([^"']+)["']/m.exec(text)?.[1];
  if (keyed !== undefined) return keyed;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const only = lines.length === 1 ? lines[0] : undefined;
  return only !== undefined && /^[\w.-]+$/.test(only) ? only : undefined;
}

/** The environment whose `PATH` a spawn searches. */
type PathEnv = Readonly<Record<string, string | undefined>>;

/**
 * rustup's proxy, the one `cargo` that reads a toolchain file: the `cargo` in
 * the first directory on `env`'s `PATH` that holds `rustup` too, or `null`
 * where none holds both. rustup installs the two into one directory, as
 * `~/.cargo/bin` and mise's Rust both hold them. A `rustup` with no `cargo`
 * beside it earlier on `PATH`, as GitHub's macOS runners link one into
 * `/opt/homebrew/bin` ahead of `~/.cargo/bin`, is passed over.
 */
export function rustupCargo(env: PathEnv): string | null {
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    const here = { PATH: dir };
    const cargo = findOnPath('cargo', here);
    if (cargo !== null && findOnPath('rustup', here) !== null) return cargo;
  }
  return null;
}

/**
 * `PATH` with rustup's directory first, where another `cargo`, such as
 * Homebrew's, comes before rustup's proxy on it, so every `cargo` a spawn
 * runs, a plugin's `cargo <sub>` and a custom check's among them, is the one
 * that reads the toolchain file; nothing where the proxy comes first already,
 * or there's none.
 */
function rustupFirst(env: PathEnv): { PATH?: string } {
  const proxy = rustupCargo(env);
  const first = findOnPath('cargo', env);
  if (proxy === null || first === null || first === proxy) return {};
  return { PATH: `${dirname(proxy)}${delimiter}${env['PATH'] ?? ''}` };
}

/**
 * The variables a check spawns with where a toolchain file from `cwd` up to
 * `repo` pins the toolchain: an empty `RUSTUP_TOOLCHAIN`, which rustup reads as
 * unset, so a version an outer shell exported, as mise does for its own Rust,
 * can't override the one the file names (checked against rustup 1.29.1), and
 * rustup's directory first on `PATH` where `env`'s puts another `cargo` before
 * its proxy. Where no file pins it, none, and rustup's own choice stands. A
 * `mise.toml` that pins `rust` is the one gap: mise sets `RUSTUP_TOOLCHAIN`
 * inside the `mise exec` a check runs through, after this clears it.
 */
export function toolchainFileEnv(cwd: string, repo: string, env: PathEnv): Readonly<Record<string, string>> {
  return rustToolchainDeclaration(cwd, repo) === null ? {} : { RUSTUP_TOOLCHAIN: '', ...rustupFirst(env) };
}

/** True for a channel that names one exact release, such as `1.85.0`, which `tool_version` can record. */
export function isExactChannel(channel: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(channel);
}

/**
 * The toolchain file nearest `cwd`, up to `repo`, and the channel it names, or
 * `null` when no directory between them holds one.
 */
export function rustToolchainDeclaration(cwd: string, repo: string): RustToolchainDeclaration | null {
  for (const dir of dirsUpTo(cwd, repo)) {
    for (const name of TOOLCHAIN_FILES) {
      const text = readText(join(dir, name));
      if (text === null) continue;
      const channel = toolchainChannel(text);
      return { file: relative(repo, join(dir, name)) || name, ...(channel !== undefined ? { channel } : {}) };
    }
  }
  return null;
}

/**
 * The executables a cargo subcommand runs from `PATH` beyond `cargo` and the
 * `rustc` it compiles with: clippy's `cargo-clippy`, which finds the
 * `clippy-driver` beside it; fmt's `cargo-fmt` and the `rustfmt` it runs; and
 * the `rustdoc` that `test` runs doctests with and `doc` documents with. Any
 * other subcommand, a cargo plugin's among them, runs on those two alone.
 */
const SUBCOMMAND_EXES: ReadonlyMap<string, readonly string[]> = new Map([
  ['clippy', ['cargo-clippy']],
  ['fmt', ['cargo-fmt', 'rustfmt']],
  ['test', ['rustdoc']],
  ['doc', ['rustdoc']],
  ['rustdoc', ['rustdoc']],
]);

/**
 * A pre-release, which a Rust version names after its release, as
 * `1.85.0-beta.7` and `1.86.0-nightly` do. A stable release names none, so a
 * store version that carries one isn't the release.
 */
const PRE_RELEASE = /^(?:beta|nightly)\b/;

/** One executable a check runs, as `PATH` holds it: the copy found, `null` for none, and the Nix shell's copy it is, `null` when it isn't one. */
export type NixExe = { exe: string; found: string | null; nix: { version?: string } | null };

/**
 * How a Nix dev shell's toolchain stands against a toolchain file, for a check
 * with no rustup on `PATH` to read the file: `none` where `PATH`'s `cargo`
 * isn't a Nix shell's, so no shell's toolchain is in play; `inexact` where the
 * file names no exact release, which only rustup resolves; `off`, with each
 * executable the check runs that isn't the shell's copy of the release the
 * file names; and `ok`, with that release, where every one is.
 */
export type NixToolchain =
  | { kind: 'none' }
  | { kind: 'inexact'; declared: RustToolchainDeclaration; cargo: string }
  | { kind: 'off'; declared: RustToolchainDeclaration; release: string; off: readonly [NixExe, ...NixExe[]] }
  | { kind: 'ok'; release: string };

/**
 * The executables beyond `cargo` that `cargo <args>` runs, by its subcommand,
 * the first argument that isn't an option, as `clippy` is in `cargo clippy
 * --workspace`.
 */
function beyondCargo(args: readonly string[]): string[] {
  const subcommand = args.find((arg) => !arg.startsWith('-'));
  return ['rustc', ...((subcommand === undefined ? undefined : SUBCOMMAND_EXES.get(subcommand)) ?? [])];
}

/** `exe` as `at`'s `PATH` holds it, and whether that copy is a Nix dev shell's the repo declares. */
function nixExe(exe: string, at: NixQuery): NixExe {
  const found = findOnPath(exe, at.env);
  return { exe, found, nix: found === null ? null : nixCopy(found, at) };
}

/**
 * Whether a Nix copy is `release`'s by the version its store path names: the
 * release itself, as fenix names `rust-1.85.0`, or the release with a target
 * after it, as rust-overlay names
 * `rustfmt-preview-1.85.0-aarch64-unknown-linux-gnu`, but never with a
 * pre-release after it.
 */
function atRelease(e: NixExe, release: string): boolean {
  const version = e.nix?.version;
  if (version === undefined) return false;
  return version === release || (version.startsWith(`${release}-`) && !PRE_RELEASE.test(version.slice(release.length + 1)));
}

/**
 * How the Nix dev shell's toolchain on `at`'s `PATH` stands against
 * `declared`, for a check that runs `cargo <args>`: `cargo` and `rustc`, and
 * what its subcommand runs besides, a cargo plugin's nothing. Each counts by
 * the version its store path names, never by running it (D13).
 */
export function nixToolchain(args: readonly string[], declared: RustToolchainDeclaration, at: NixQuery): NixToolchain {
  const cargo = nixExe('cargo', at);
  if (cargo.found === null || cargo.nix === null) return { kind: 'none' };
  const release = declared.channel;
  if (release === undefined || !isExactChannel(release)) return { kind: 'inexact', declared, cargo: cargo.found };
  const rest = beyondCargo(args).map((exe) => nixExe(exe, at));
  const [first, ...more] = [cargo, ...rest].filter((e) => !atRelease(e, release));
  return first === undefined ? { kind: 'ok', release } : { kind: 'off', declared, release, off: [first, ...more] };
}

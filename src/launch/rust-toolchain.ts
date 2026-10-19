/**
 * The `rust-toolchain` pin source: a `rust-toolchain.toml` or `rust-toolchain`
 * file from the check's directory up to the repo root pins the toolchain, and
 * with it the rustup components, rustfmt and clippy, that run through it
 * (R6.1). rustup's `cargo` reads the file and runs the toolchain it names, so
 * the source declares only whether the file is there, and the channel it
 * names, which the summary records when it's an exact version (R6.3).
 */

import { readFileSync } from 'node:fs';
import { delimiter, dirname, join, relative } from 'node:path';

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
 * The `cargo` beside the first `rustup` on `env`'s `PATH`: rustup's proxy,
 * the one `cargo` that reads a toolchain file, or `null` when rustup isn't on
 * `PATH` or has no `cargo` beside it. rustup installs both into one directory,
 * as `~/.cargo/bin` and mise's Rust both hold them.
 */
export function rustupCargo(env: PathEnv): string | null {
  const rustup = findOnPath('rustup', env);
  return rustup === null ? null : findOnPath('cargo', { PATH: dirname(rustup) });
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

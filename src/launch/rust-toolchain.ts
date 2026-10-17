/**
 * The `rust-toolchain` pin source: a `rust-toolchain.toml` or `rust-toolchain`
 * file from the check's directory up to the repo root pins the toolchain, and
 * with it the rustup components, rustfmt and clippy, that run through it
 * (R6.1). rustup's `cargo` reads the file and runs the toolchain it names, so
 * the source declares only whether the file is there, and the channel it
 * names, which the summary records when it's an exact version (R6.3).
 */

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

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

/**
 * The variables a check spawns with where a toolchain file from `cwd` up to
 * `repo` pins the toolchain: an empty `RUSTUP_TOOLCHAIN`, which rustup reads as
 * unset, so a version an outer shell exported, as mise does for its own Rust,
 * can't override the one the file names (checked against rustup 1.29.1).
 * Where no file pins it, none, and rustup's own choice stands.
 */
export function toolchainFileEnv(cwd: string, repo: string): Readonly<Record<string, string>> {
  return rustToolchainDeclaration(cwd, repo) === null ? {} : { RUSTUP_TOOLCHAIN: '' };
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

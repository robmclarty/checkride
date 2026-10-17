import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { isExactChannel, rustToolchainDeclaration, toolchainChannel } from '../rust-toolchain.js';

describe('toolchainChannel', () => {
  test("reads a rust-toolchain.toml's channel", () => {
    expect(toolchainChannel('[toolchain]\nchannel = "1.85.0"\ncomponents = ["clippy", "rustfmt"]\n')).toBe('1.85.0');
    expect(toolchainChannel("[toolchain]\nchannel = 'stable'\n")).toBe('stable');
  });

  test('reads a legacy rust-toolchain file that holds only a channel', () => {
    expect(toolchainChannel('nightly-2026-09-01\n')).toBe('nightly-2026-09-01');
  });

  test('names no channel for a path toolchain or text it cannot read', () => {
    expect(toolchainChannel('[toolchain]\npath = "/opt/rust"\n')).toBeUndefined();
    expect(toolchainChannel('')).toBeUndefined();
  });
});

describe('isExactChannel', () => {
  test('is true only for a full release version', () => {
    expect(isExactChannel('1.85.0')).toBe(true);
    for (const channel of ['1.85', 'stable', 'nightly-2026-09-01', 'beta']) expect(isExactChannel(channel), channel).toBe(false);
  });
});

describe('rustToolchainDeclaration', () => {
  test('finds the file nearest the check, prefers the .toml form, and ignores one above the repo root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'checkride-rust-toolchain-'));
    const repo = join(root, 'repo');
    try {
      await mkdir(join(repo, 'crates', 'core'), { recursive: true });
      await writeFile(join(root, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.80.0"\n');
      expect(rustToolchainDeclaration(join(repo, 'crates', 'core'), repo)).toBeNull();
      await writeFile(join(repo, 'rust-toolchain'), '1.85.0\n');
      await writeFile(join(repo, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.86.0"\n');
      expect(rustToolchainDeclaration(join(repo, 'crates', 'core'), repo)).toEqual({ file: 'rust-toolchain.toml', channel: '1.86.0' });
      await writeFile(join(repo, 'crates', 'rust-toolchain'), 'stable\n');
      expect(rustToolchainDeclaration(join(repo, 'crates', 'core'), repo)).toEqual({ file: 'crates/rust-toolchain', channel: 'stable' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

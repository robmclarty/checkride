/**
 * The release of the Go toolchain a check ran on, read off the copy a `PATH`
 * holds: the `VERSION` file at its GOROOT, two directories above the file the
 * executable resolves to, in each layout a `go` is installed in.
 */

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { packToolchain } from '../index.js';
import { goRootVersion } from '../toolchain.js';

/** Run `body` in a fresh temp directory, removed afterwards. */
async function inTemp(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'checkride-toolchain-'));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A GOROOT at `root` whose `VERSION` reads `version`, with `go` and `gofmt` in its `bin`; the path of its `go`. */
async function goroot(root: string, version: string | null): Promise<string> {
  await mkdir(join(root, 'bin'), { recursive: true });
  if (version !== null) await writeFile(join(root, 'VERSION'), version);
  for (const exe of ['go', 'gofmt']) {
    await writeFile(join(root, 'bin', exe), '#!/bin/sh\n');
    await chmod(join(root, 'bin', exe), 0o755);
  }
  return join(root, 'bin', 'go');
}

describe('goRootVersion reads the release off a go install, never by running it', () => {
  test("Homebrew's libexec, through the link in its bin", () =>
    inTemp(async (dir) => {
      const go = await goroot(join(dir, 'Cellar', 'go', '1.26.1', 'libexec'), 'go1.26.1\ntime 2026-03-05T20:45:11Z\n');
      await mkdir(join(dir, 'bin'));
      await symlink(go, join(dir, 'bin', 'go'));
      expect(goRootVersion(join(dir, 'bin', 'go'))).toBe('1.26.1');
    }));

  test("mise's install directory, reached through a prefix's link, and its gofmt", () =>
    inTemp(async (dir) => {
      await goroot(join(dir, 'installs', 'go', '1.27.2'), 'go1.27.2\ntime 2026-10-02T20:28:03Z\n');
      await symlink(join(dir, 'installs', 'go', '1.27.2'), join(dir, 'installs', 'go', '1.27'));
      expect(goRootVersion(join(dir, 'installs', 'go', '1.27', 'bin', 'go'))).toBe('1.27.2');
      expect(goRootVersion(join(dir, 'installs', 'go', '1.27', 'bin', 'gofmt'))).toBe('1.27.2');
    }));

  test("a Nix store's share/go, behind the bin/go link its package puts on PATH", () =>
    inTemp(async (dir) => {
      const entry = join(dir, 'store', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-go-1.25.3');
      const go = await goroot(join(entry, 'share', 'go'), 'go1.25.3\n');
      await mkdir(join(entry, 'bin'));
      await symlink(go, join(entry, 'bin', 'go'));
      expect(goRootVersion(join(entry, 'bin', 'go'))).toBe('1.25.3');
    }));

  test('a release candidate keeps its suffix', () =>
    inTemp(async (dir) => {
      expect(goRootVersion(await goroot(join(dir, 'go'), 'go1.28rc1\n'))).toBe('1.28rc1');
    }));

  test('a mise shim, which resolves to the mise binary, beside no VERSION, names none', () =>
    inTemp(async (dir) => {
      await mkdir(join(dir, 'Cellar', 'mise', '2026.10.4', 'bin'), { recursive: true });
      await writeFile(join(dir, 'Cellar', 'mise', '2026.10.4', 'bin', 'mise'), '#!/bin/sh\n');
      await mkdir(join(dir, 'shims'));
      await symlink(join(dir, 'Cellar', 'mise', '2026.10.4', 'bin', 'mise'), join(dir, 'shims', 'go'));
      expect(goRootVersion(join(dir, 'shims', 'go'))).toBeUndefined();
    }));

  test("a VERSION that names no go release, a development build's among them, names none, and so does a missing file", () =>
    inTemp(async (dir) => {
      expect(goRootVersion(await goroot(join(dir, 'devel'), 'devel go1.28-abcdef Tue Oct 20 2026\n'))).toBeUndefined();
      expect(goRootVersion(await goroot(join(dir, 'other'), '3.12.8\n'))).toBeUndefined();
      expect(goRootVersion(await goroot(join(dir, 'none'), null))).toBeUndefined();
      expect(goRootVersion(join(dir, 'nowhere', 'bin', 'go'))).toBeUndefined();
    }));
});

describe('packToolchain', () => {
  test('the go pack runs its checks on go, and every other pack, or no pack, names none', () => {
    expect(packToolchain('go')).toBe('go');
    for (const pack of ['ts', 'repo', 'bash', 'rust', 'python', 'terraform', undefined]) expect(packToolchain(pack), pack).toBeUndefined();
  });
});

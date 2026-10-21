import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { PACKS } from '../../packs/index.js';
import type { LaunchContext } from '../index.js';
import { launchCheck, launchOnToolchain, nixCopy, pinChain } from '../index.js';
import { drvVersion } from '../nix.js';

/** A store entry's name with a hash in front, as Nix names one. */
const entry = (name: string, hash = 'a'.repeat(32)): string => `${hash}-${name}`;

describe('drvVersion', () => {
  test("reads the version as Nix's parseDrvName splits it: after the first dash not followed by a letter", () => {
    expect(drvVersion(entry('golangci-lint-2.11.4'))).toBe('2.11.4');
    expect(drvVersion(entry('go-1.25.3'))).toBe('1.25.3');
    expect(drvVersion(entry('python3-3.12.8'))).toBe('3.12.8');
    expect(drvVersion(entry('ast-grep-0.39.6'))).toBe('0.39.6');
  });

  test('an output other than out is not part of the version', () => {
    expect(drvVersion(entry('shellcheck-0.10.0-bin'))).toBe('0.10.0');
    expect(drvVersion(entry('openssl-3.4.1-dev'))).toBe('3.4.1');
  });

  test('a name with no version, as a profile has, gives none', () => {
    expect(drvVersion(entry('devenv-profile'))).toBeNull();
    expect(drvVersion(entry('hello'))).toBeNull();
  });
});

/** A scratch machine: a store, a repo and a home, each with helpers. */
type Machine = {
  store: string;
  repo: string;
  home: string;
  /** An executable at `path`, making its directories; returns `path`. */
  exe: (path: string) => Promise<string>;
  /** A symlink at `path` to `target`, making its directories; returns `path`. */
  link: (path: string, target: string) => Promise<string>;
  /** A launch context for a check at the repo root, `PATH` holding `dirs`, the scratch store named. */
  at: (dirs: readonly string[], extra?: Partial<LaunchContext>) => LaunchContext;
};

async function withMachine(body: (m: Machine) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'checkride-nix-'));
  const m: Machine = {
    store: join(root, 'store'),
    repo: join(root, 'repo'),
    home: join(root, 'home'),
    exe: async (path) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '#!/bin/sh\nexit 0\n');
      await chmod(path, 0o755);
      return path;
    },
    link: async (path, target) => {
      await mkdir(dirname(path), { recursive: true });
      await symlink(target, path);
      return path;
    },
    at: (dirs, extra = {}) => ({ cwd: m.repo, repo: m.repo, pm: 'pnpm', env: { PATH: dirs.join(delimiter), NIX_STORE_DIR: m.store }, ...extra }),
  };
  await mkdir(m.repo, { recursive: true });
  try {
    await body(m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The query `nixCopy` reads for a check at the repo root. */
const query = (m: Machine) => ({ cwd: m.repo, repo: m.repo, env: { NIX_STORE_DIR: m.store } });

describe('nixCopy', () => {
  test("a tool from a store bin on PATH, in a repo with a flake.lock, is the dev shell's, at the version its store path names", () =>
    withMachine(async (m) => {
      await writeFile(join(m.repo, 'flake.lock'), '{}');
      const found = await m.exe(join(m.store, entry('golangci-lint-2.11.4'), 'bin', 'golangci-lint'));
      expect(nixCopy(found, query(m))).toEqual({ version: '2.11.4' });
    }));

  test('through a profile in the store, as devenv puts one on PATH, the version is the package it links to', () =>
    withMachine(async (m) => {
      await writeFile(join(m.repo, 'devenv.nix'), '{ }');
      const real = await m.exe(join(m.store, entry('shellcheck-0.10.0-bin'), 'bin', 'shellcheck'));
      const found = await m.link(join(m.store, entry('devenv-profile', 'b'.repeat(32)), 'bin', 'shellcheck'), real);
      expect(nixCopy(found, query(m))).toEqual({ version: '0.10.0' });
    }));

  test('through a profile inside the repo, as devbox keeps one, it counts too', () =>
    withMachine(async (m) => {
      await writeFile(join(m.repo, 'devbox.json'), '{}');
      const real = await m.exe(join(m.store, entry('ast-grep-0.39.6'), 'bin', 'ast-grep'));
      const found = await m.link(join(m.repo, '.devbox', 'nix', 'profile', 'default', 'bin', 'ast-grep'), real);
      expect(nixCopy(found, query(m))).toEqual({ version: '0.39.6' });
    }));

  test("a user's profile links into the store too, but it's the machine's, so its copy stays unpinned", () =>
    withMachine(async (m) => {
      await writeFile(join(m.repo, 'flake.lock'), '{}');
      const real = await m.exe(join(m.store, entry('shellcheck-0.10.0-bin'), 'bin', 'shellcheck'));
      const found = await m.link(join(m.home, '.nix-profile', 'bin', 'shellcheck'), real);
      expect(nixCopy(found, query(m))).toBeNull();
    }));

  test('with no Nix file between the check and the repo root, a store copy is unpinned; one in a parent inside the repo counts', () =>
    withMachine(async (m) => {
      const found = await m.exe(join(m.store, entry('go-1.25.3'), 'bin', 'go'));
      await writeFile(join(m.repo, '..', 'flake.lock'), '{}');
      expect(nixCopy(found, query(m))).toBeNull();
      await writeFile(join(m.repo, 'shell.nix'), '{ }');
      await mkdir(join(m.repo, 'services', 'api'), { recursive: true });
      expect(nixCopy(found, { ...query(m), cwd: join(m.repo, 'services', 'api') })).toEqual({ version: '1.25.3' });
    }));

  test('a relative path, or one that resolves outside the store, is never a Nix copy', () =>
    withMachine(async (m) => {
      await writeFile(join(m.repo, 'flake.lock'), '{}');
      expect(nixCopy('bin/shellcheck', query(m))).toBeNull();
      const outside = await m.exe(join(m.home, 'bin', 'shellcheck'));
      const found = await m.link(join(m.store, entry('wrapper'), 'bin', 'shellcheck'), outside);
      expect(nixCopy(found, query(m))).toBeNull();
    }));
});

describe("launchCheck records a Nix dev shell's copy as nix", () => {
  const SHELLCHECK = ['exec', 'shellcheck', '-f', 'json1', 'run.sh'];

  test('the path step records nix and the version, and runs the copy PATH holds', () =>
    withMachine(async (m) => {
      await writeFile(join(m.repo, 'flake.nix'), '{ }');
      const found = await m.exe(join(m.store, entry('shellcheck-0.10.0-bin'), 'bin', 'shellcheck'));
      const ctx = m.at([dirname(found)], { pins: pinChain(PACKS.bash.name) });
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, ctx)).toMatchObject({ command: 'shellcheck', pin: { source: 'nix', version: '0.10.0' } });
    }));

  test('requirePins accepts a Nix copy, and still refuses one from anywhere else', () =>
    withMachine(async (m) => {
      await writeFile(join(m.repo, 'flake.nix'), '{ }');
      const found = await m.exe(join(m.store, entry('shellcheck-0.10.0-bin'), 'bin', 'shellcheck'));
      const pinned = launchCheck('lint', 'pnpm', SHELLCHECK, m.at([dirname(found)], { pins: pinChain(PACKS.bash.name), requirePins: true }));
      expect(pinned).toMatchObject({ pin: { source: 'nix' } });
      const other = await m.exe(join(m.home, 'bin', 'shellcheck'));
      const refused = launchCheck('lint', 'pnpm', SHELLCHECK, m.at([dirname(other)], { pins: pinChain(PACKS.bash.name), requirePins: true }));
      expect('refusal' in refused ? refused.refusal : '').toContain('shellcheck is not pinned');
    }));

  test('without a Nix file in the repo, the same copy runs unpinned', () =>
    withMachine(async (m) => {
      const found = await m.exe(join(m.store, entry('shellcheck-0.10.0-bin'), 'bin', 'shellcheck'));
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, m.at([dirname(found)], { pins: pinChain(PACKS.bash.name) }))).toMatchObject({ pin: { source: 'path' } });
    }));

  test('a toolchain from the store records nix too, as go does', () =>
    withMachine(async (m) => {
      await writeFile(join(m.repo, 'flake.lock'), '{}');
      await writeFile(join(m.repo, 'go.mod'), 'module example.com/x\n\ngo 1.25\n');
      const go = await m.exe(join(m.store, entry('go-1.25.3'), 'bin', 'go'));
      expect(launchCheck('types', 'go', ['build', './...'], m.at([dirname(go)], { pins: pinChain(PACKS.go.name) }))).toMatchObject({
        command: 'go',
        pin: { source: 'nix', version: '1.25.3' },
      });
    }));

  test('a tool its runner picks, as cargo picks cargo-deny, stays unpinned: the store copy may not be what runs', () =>
    withMachine(async (m) => {
      await writeFile(join(m.repo, 'flake.lock'), '{}');
      const deny = await m.exe(join(m.store, entry('cargo-deny-0.18.2'), 'bin', 'cargo-deny'));
      const cargo = await m.exe(join(m.store, entry('cargo-1.90.0'), 'bin', 'cargo'));
      const ctx = m.at([dirname(deny), dirname(cargo)], { pins: pinChain(PACKS.rust.name) });
      expect(launchCheck('security', 'pnpm', ['exec', 'cargo-deny', 'check'], ctx)).toMatchObject({ pin: { source: 'path' } });
    }));

  test('a mise.toml that pins the tool still wins over the shell', () =>
    withMachine(async (m) => {
      await writeFile(join(m.repo, 'flake.nix'), '{ }');
      await writeFile(join(m.repo, 'mise.toml'), '[tools]\nshellcheck = "0.11.0"\n');
      const found = await m.exe(join(m.store, entry('shellcheck-0.10.0-bin'), 'bin', 'shellcheck'));
      const mise = await m.exe(join(m.home, 'bin', 'mise'));
      const ctx = m.at([dirname(found), dirname(mise)], { pins: pinChain(PACKS.bash.name) });
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, ctx)).toMatchObject({ command: 'mise', pin: { source: 'mise' } });
    }));
});

/** A nixpkgs-style Go `release` in the scratch store: its `bin` directory, which a shell puts on PATH. */
async function storeGo(m: Machine, release: string): Promise<string> {
  const at = join(m.store, entry(`go-${release}`));
  const go = await m.exe(join(at, 'share', 'go', 'bin', 'go'));
  await writeFile(join(at, 'share', 'go', 'VERSION'), `go${release}\ntime 2025-10-13T16:46:39Z\n`);
  await m.link(join(at, 'bin', 'go'), go);
  return join(at, 'bin');
}

/**
 * Nixpkgs installs Go's GOROOT at `share/go` inside its store entry, with a
 * `VERSION` file there, and links `bin/go` to `share/go/bin/go`. A go check
 * in the shell records that release as the toolchain it ran on, which moves
 * when a nixpkgs bump moves the default Go, though a golangci-lint rebuilt on
 * it keeps the name it had.
 */
describe("a go check in a Nix dev shell records the store go's release", () => {
  test('go records nix with its version, and that release as the toolchain', () =>
    withMachine(async (m) => {
      await writeFile(join(m.repo, 'flake.lock'), '{}');
      const goBin = await storeGo(m, '1.25.3');
      expect(launchOnToolchain('types', 'go', ['build', './...'], m.at([goBin], { pins: pinChain(PACKS.go.name), toolchain: 'go' }))).toMatchObject({
        command: 'go',
        pin: { source: 'nix', version: '1.25.3', toolchain: { release: '1.25.3', pinned: true } },
      });
    }));

  test('golangci-lint records its own store version and the go the shell puts beside it', () =>
    withMachine(async (m) => {
      await writeFile(join(m.repo, 'flake.nix'), '{ }');
      const goBin = await storeGo(m, '1.25.3');
      const lint = await m.exe(join(m.store, entry('golangci-lint-2.11.4', 'b'.repeat(32)), 'bin', 'golangci-lint'));
      const ctx = m.at([dirname(lint), goBin], { pins: pinChain(PACKS.go.name), toolchain: 'go' });
      expect(launchOnToolchain('lint', 'pnpm', ['exec', 'golangci-lint', 'run'], ctx)).toMatchObject({
        command: 'golangci-lint',
        pin: { source: 'nix', version: '2.11.4', toolchain: { release: '1.25.3', pinned: true } },
      });
    }));
});

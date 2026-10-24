import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { PACKS } from '../../packs/index.js';
import type { Launch, LaunchContext } from '../index.js';
import { launchCheck, launchOnToolchain, nixCopy, pinChain } from '../index.js';
import { drvVersion } from '../nix.js';

/** A store entry's name with a hash in front, as Nix names one. */
const entry = (name: string, hash = 'a'.repeat(32)): string => `${hash}-${name}`;

/**
 * The store entries a dev shell built from a `rust-toolchain.toml` naming
 * `channel = "1.85.0"` put its toolchain in, as Nix 2.35.4 built them on
 * aarch64-linux (2026-10-23). rust-overlay's `fromRustupToolchainFile` puts
 * `rust-default-1.85.0/bin` on PATH, holding cargo, rustc and clippy, and
 * links rustfmt and cargo-fmt there from the component's own entry. fenix's
 * `fromToolchainFile` puts every executable in one entry.
 */
const CAPTURED = {
  overlay: { toolchain: 'fjgc2ym708yqjvkb1nhgs78hp3qq72wy-rust-default-1.85.0', fmt: '2i3cgnr4q4yj1b9cwlgyhkalw088hgr5-rustfmt-preview-1.85.0-aarch64-unknown-linux-gnu' },
  fenix: 'bpk13z58d3smaqs40w69qk4r4gqgy8yj-rust-1.85.0',
};

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

  test("reads the release off a Rust toolchain's entries, with rust-overlay's host suffix kept", () => {
    expect(drvVersion(CAPTURED.overlay.toolchain)).toBe('1.85.0');
    expect(drvVersion(CAPTURED.overlay.fmt)).toBe('1.85.0-aarch64-unknown-linux-gnu');
    expect(drvVersion(CAPTURED.fenix)).toBe('1.85.0');
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

/**
 * rust-overlay's toolchain in the scratch store under `names`: cargo, rustc,
 * rustdoc and clippy in the toolchain's entry, rustfmt and cargo-fmt linked in
 * from the component's. Returns the `bin` a shell puts on PATH.
 */
async function overlayRust(m: Machine, names: { toolchain: string; fmt: string }): Promise<string> {
  const bin = join(m.store, names.toolchain, 'bin');
  for (const exe of ['cargo', 'rustc', 'rustdoc', 'cargo-clippy', 'clippy-driver']) await m.exe(join(bin, exe));
  for (const exe of ['rustfmt', 'cargo-fmt']) await m.link(join(bin, exe), await m.exe(join(m.store, names.fmt, 'bin', exe)));
  return bin;
}

/** rust-overlay's entries for `release`, named as the captured ones are for 1.85.0. */
const overlayAt = (release: string): { toolchain: string; fmt: string } => ({
  toolchain: entry(`rust-default-${release}`),
  fmt: entry(`rustfmt-preview-${release}-aarch64-unknown-linux-gnu`, 'c'.repeat(32)),
});

/** fenix's toolchain in the scratch store, every executable in the one entry `name`. Returns its `bin`. */
async function fenixRust(m: Machine, name: string): Promise<string> {
  const bin = join(m.store, name, 'bin');
  for (const exe of ['cargo', 'rustc', 'rustdoc', 'cargo-clippy', 'clippy-driver', 'rustfmt', 'cargo-fmt']) await m.exe(join(bin, exe));
  return bin;
}

/** A repo whose flake declares its dev shell, and whose toolchain file names `channel`. */
async function nixRustRepo(m: Machine, channel: string): Promise<void> {
  await writeFile(join(m.repo, 'flake.nix'), '{ }');
  await writeFile(join(m.repo, 'rust-toolchain.toml'), `[toolchain]\nchannel = "${channel}"\ncomponents = ["clippy", "rustfmt"]\n`);
}

const CLIPPY = ['exec', 'cargo-clippy', '--workspace', '--', '-D', 'warnings'];
const FMT = ['exec', 'cargo-fmt', '--all', '--check'];
const MACHETE = ['exec', 'cargo-machete'];

/** The refusal message, or `''` where the launcher would spawn. */
const refusalOf = (launch: Launch): string => ('refusal' in launch ? launch.refusal : '');

/**
 * Only rustup reads a toolchain file, but rust-overlay and fenix build a dev
 * shell from one. With no rustup on PATH, the shell's toolchain stands in at
 * the exact release the file names, by the versions its store paths name.
 */
describe("a toolchain file without rustup runs a Nix dev shell's toolchain at the release it names", () => {
  test("rust-overlay's shell runs clippy, rustfmt and cargo itself, recorded as a run through rustup is", () =>
    withMachine(async (m) => {
      await nixRustRepo(m, '1.85.0');
      const ctx = m.at([await overlayRust(m, CAPTURED.overlay)], { pins: pinChain(PACKS.rust.name) });
      const pin = { source: 'rust-toolchain', version: '1.85.0' };
      expect(launchCheck('lint', 'pnpm', CLIPPY, ctx)).toMatchObject({ command: 'cargo', args: ['clippy', '--workspace', '--', '-D', 'warnings'], pin });
      // rustfmt resolves into rustfmt-preview-1.85.0-<host>, which is 1.85.0's.
      expect(launchCheck('format', 'pnpm', FMT, ctx)).toMatchObject({ command: 'cargo', args: ['fmt', '--all', '--check'], pin });
      expect(launchCheck('types', 'cargo', ['check'], ctx)).toMatchObject({ command: 'cargo', args: ['check'], pin });
    }));

  test("fenix's shell, every executable in one rust-<release> entry, runs them the same way", () =>
    withMachine(async (m) => {
      await nixRustRepo(m, '1.85.0');
      const ctx = m.at([await fenixRust(m, CAPTURED.fenix)], { pins: pinChain(PACKS.rust.name) });
      const checks = [['lint', 'pnpm', CLIPPY], ['format', 'pnpm', FMT], ['types', 'cargo', ['check']]] as const;
      for (const [slot, command, args] of checks) {
        expect(launchCheck(slot, command, args, ctx), slot).toMatchObject({ command: 'cargo', pin: { source: 'rust-toolchain', version: '1.85.0' } });
      }
    }));

  test("nixpkgs' own cargo and rustc count at the file's release, and a component the shell lacks fails naming it", () =>
    withMachine(async (m) => {
      await nixRustRepo(m, '1.85.0');
      const cargo = await m.exe(join(m.store, entry('cargo-1.85.0'), 'bin', 'cargo'));
      const rustc = await m.exe(join(m.store, entry('rustc-wrapper-1.85.0', 'b'.repeat(32)), 'bin', 'rustc'));
      const ctx = m.at([dirname(cargo), dirname(rustc)], { pins: pinChain(PACKS.rust.name) });
      expect(launchCheck('types', 'cargo', ['check'], ctx)).toMatchObject({ pin: { source: 'rust-toolchain', version: '1.85.0' } });
      const lint = refusalOf(launchCheck('lint', 'pnpm', CLIPPY, ctx));
      expect(lint).toContain("the `lint` slot's `cargo-clippy` runs on the toolchain `rust-toolchain.toml` pins to 1.85.0, but `cargo-clippy` isn't on PATH.");
      expect(lint).toContain('  cargo-clippy: not on PATH');
    }));

  test('a shell at another release fails naming both, rather than run it', () =>
    withMachine(async (m) => {
      await nixRustRepo(m, '1.85.0');
      const bin = await overlayRust(m, overlayAt('1.86.0'));
      const ctx = m.at([bin], { pins: pinChain(PACKS.rust.name) });
      const lint = refusalOf(launchCheck('lint', 'pnpm', CLIPPY, ctx));
      expect(lint).toContain("the `lint` slot's `cargo-clippy` runs on the toolchain `rust-toolchain.toml` pins to 1.85.0, but the Nix shell's `cargo` is 1.86.0.");
      expect(lint).toContain('  declared in: rust-toolchain.toml (channel 1.85.0)');
      for (const exe of ['cargo', 'rustc', 'cargo-clippy']) expect(lint).toContain(`  found: ${join(bin, exe)} (1.86.0)`);
      expect(refusalOf(launchCheck('format', 'pnpm', FMT, ctx))).toContain(`  found: ${join(bin, 'rustfmt')} (1.86.0-aarch64-unknown-linux-gnu)`);
    }));

  test("a toolchain whose store path names no release fails, since nothing says it's the file's", () =>
    withMachine(async (m) => {
      await nixRustRepo(m, '1.85.0');
      const bin = await fenixRust(m, entry('rust-mixed'));
      const lint = refusalOf(launchCheck('lint', 'pnpm', CLIPPY, m.at([bin], { pins: pinChain(PACKS.rust.name) })));
      expect(lint).toContain("but the Nix shell's `cargo` names no release.");
      expect(lint).toContain(`  found: ${join(bin, 'cargo')} (its store path names no release)`);
    }));

  test('a channel only rustup resolves to a release, such as stable or 1.85, fails', () =>
    withMachine(async (m) => {
      await nixRustRepo(m, 'stable');
      const bin = await overlayRust(m, CAPTURED.overlay);
      const ctx = m.at([bin], { pins: pinChain(PACKS.rust.name) });
      const lint = refusalOf(launchCheck('lint', 'pnpm', CLIPPY, ctx));
      expect(lint).toContain(
        "the `lint` slot's `cargo-clippy` runs on the toolchain `rust-toolchain.toml` pins, but without `rustup` a Nix shell's toolchain counts only where the file names an exact release.",
      );
      expect(lint).toContain('  declared in: rust-toolchain.toml (channel stable)');
      expect(lint).toContain(`  found: ${join(bin, 'cargo')}`);
      await rm(join(m.repo, 'rust-toolchain.toml'));
      await writeFile(join(m.repo, 'rust-toolchain'), '1.85\n');
      expect(refusalOf(launchCheck('types', 'cargo', ['check'], ctx))).toContain('counts only where the file names an exact release');
    }));

  test("a copy from outside the shell ahead of the shell's fails naming it", () =>
    withMachine(async (m) => {
      await nixRustRepo(m, '1.85.0');
      const own = await m.exe(join(m.home, 'bin', 'rustfmt'));
      const ctx = m.at([dirname(own), await overlayRust(m, CAPTURED.overlay)], { pins: pinChain(PACKS.rust.name) });
      const format = refusalOf(launchCheck('format', 'pnpm', FMT, ctx));
      expect(format).toContain("but the `rustfmt` on PATH isn't a Nix shell's.");
      expect(format).toContain(`  found: ${own} (not a Nix shell's)`);
      // clippy runs no rustfmt, so it still runs.
      expect(launchCheck('lint', 'pnpm', CLIPPY, ctx)).toMatchObject({ pin: { source: 'rust-toolchain', version: '1.85.0' } });
    }));

  test("a cargo that isn't a Nix shell's, or a shell the repo doesn't declare, fails for want of rustup as before", () =>
    withMachine(async (m) => {
      await nixRustRepo(m, '1.85.0');
      const before = "the `lint` slot's `cargo-clippy` is pinned by a toolchain file, but `rustup` isn't on PATH.";
      const own = await m.exe(join(m.home, 'bin', 'cargo'));
      expect(refusalOf(launchCheck('lint', 'pnpm', CLIPPY, m.at([dirname(own)], { pins: pinChain(PACKS.rust.name) })))).toContain(before);
      const bin = await overlayRust(m, CAPTURED.overlay);
      await rm(join(m.repo, 'flake.nix'));
      expect(refusalOf(launchCheck('lint', 'pnpm', CLIPPY, m.at([bin], { pins: pinChain(PACKS.rust.name) })))).toContain(before);
    }));

  test("a cargo plugin builds through the shell's cargo at the file's release, keeping its own pin, and is refused at another", () =>
    withMachine(async (m) => {
      await nixRustRepo(m, '1.85.0');
      const machete = await m.exe(join(m.store, entry('cargo-machete-0.9.1', 'e'.repeat(32)), 'bin', 'cargo-machete'));
      const at = (bin: string): LaunchContext => m.at([bin, dirname(machete)], { pins: pinChain(PACKS.rust.name) });
      expect(launchCheck('dead', 'pnpm', MACHETE, at(await overlayRust(m, CAPTURED.overlay)))).toMatchObject({
        command: 'cargo',
        args: ['machete'],
        pin: { source: 'path' },
      });
      const off = refusalOf(launchCheck('dead', 'pnpm', MACHETE, at(await overlayRust(m, overlayAt('1.86.0')))));
      expect(off).toContain("the `dead` slot's `cargo machete` runs on the toolchain `rust-toolchain.toml` pins to 1.85.0, but the Nix shell's `cargo` is 1.86.0.");
    }));

  test('rustup on PATH still reads the file itself, whatever release the shell beside it is', () =>
    withMachine(async (m) => {
      await nixRustRepo(m, '1.85.0');
      const bin = await overlayRust(m, overlayAt('1.86.0'));
      const proxy = dirname(await m.exe(join(m.home, '.cargo', 'bin', 'cargo')));
      await m.exe(join(proxy, 'rustup'));
      expect(launchCheck('lint', 'pnpm', CLIPPY, m.at([bin, proxy], { pins: pinChain(PACKS.rust.name) }))).toMatchObject({
        command: 'cargo',
        env: { PATH: [proxy, bin, proxy].join(delimiter) },
        pin: { source: 'rust-toolchain', version: '1.85.0' },
      });
    }));

  test('a check counts what its cargo subcommand runs, a custom check its own: rustdoc for test, rustfmt for fmt, cargo-clippy for clippy', () =>
    withMachine(async (m) => {
      await nixRustRepo(m, '1.85.0');
      const shell = await overlayRust(m, CAPTURED.overlay);
      // Another release's rustdoc, and a rustfmt and cargo-clippy from outside the shell, ahead of the shell's.
      const rustdoc = await m.exe(join(m.store, entry('rustc-wrapper-1.84.0', 'f'.repeat(32)), 'bin', 'rustdoc'));
      const own = dirname(await m.exe(join(m.home, 'bin', 'rustfmt')));
      await m.exe(join(own, 'cargo-clippy'));
      const ctx = m.at([dirname(rustdoc), own, shell], { pins: pinChain(PACKS.rust.name) });
      expect(refusalOf(launchCheck('test', 'cargo', ['test', '--workspace'], ctx))).toContain(
        "the `test` slot's `cargo` runs on the toolchain `rust-toolchain.toml` pins to 1.85.0, but the Nix shell's `rustdoc` is 1.84.0.",
      );
      expect(refusalOf(launchCheck('fmt-raw', 'cargo', ['fmt', '--check'], ctx))).toContain("but the `rustfmt` on PATH isn't a Nix shell's.");
      // The subcommand is the first argument that isn't an option.
      expect(refusalOf(launchCheck('clippy-raw', 'cargo', ['--locked', 'clippy'], ctx))).toContain("but the `cargo-clippy` on PATH isn't a Nix shell's.");
      // cargo check runs none of them, so it still runs.
      expect(launchCheck('types', 'cargo', ['check', '--workspace'], ctx)).toMatchObject({ pin: { source: 'rust-toolchain', version: '1.85.0' } });
    }));

  test('a pre-release of the release is not the release, and neither is a longer release', () =>
    withMachine(async (m) => {
      await nixRustRepo(m, '1.85.0');
      for (const version of ['1.85.0-beta.7', '1.85.0-nightly-2025-01-09']) {
        const bin = await fenixRust(m, entry(`rust-${version}`));
        const refusal = refusalOf(launchCheck('types', 'cargo', ['check'], m.at([bin], { pins: pinChain(PACKS.rust.name) })));
        expect(refusal, version).toContain(`but the Nix shell's \`cargo\` is ${version}.`);
      }
      await nixRustRepo(m, '1.85.1');
      const longer = await fenixRust(m, entry('rust-1.85.10'));
      expect(refusalOf(launchCheck('types', 'cargo', ['check'], m.at([longer], { pins: pinChain(PACKS.rust.name) })))).toContain("but the Nix shell's `cargo` is 1.85.10.");
    }));

  test("a component at another release than cargo's fails naming it, and a darwin host's names count as a linux host's do", () =>
    withMachine(async (m) => {
      await nixRustRepo(m, '1.85.0');
      const darwin = await overlayRust(m, { toolchain: entry('rust-default-1.85.0'), fmt: entry('rustfmt-preview-1.85.0-aarch64-apple-darwin', 'c'.repeat(32)) });
      expect(launchCheck('format', 'pnpm', FMT, m.at([darwin], { pins: pinChain(PACKS.rust.name) }))).toMatchObject({ pin: { source: 'rust-toolchain', version: '1.85.0' } });
      const mixed = await overlayRust(m, {
        toolchain: entry('rust-default-1.85.0', 'd'.repeat(32)),
        fmt: entry('rustfmt-preview-1.84.0-aarch64-unknown-linux-gnu', 'e'.repeat(32)),
      });
      const ctx = m.at([mixed], { pins: pinChain(PACKS.rust.name) });
      const format = refusalOf(launchCheck('format', 'pnpm', FMT, ctx));
      expect(format).toContain("but the Nix shell's `cargo-fmt` is 1.84.0-aarch64-unknown-linux-gnu.");
      expect(format).toContain(`  found: ${join(mixed, 'rustfmt')} (1.84.0-aarch64-unknown-linux-gnu)`);
      expect(launchCheck('lint', 'pnpm', CLIPPY, ctx)).toMatchObject({ pin: { source: 'rust-toolchain', version: '1.85.0' } });
    }));
});

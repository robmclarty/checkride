/**
 * The rust pack: Cargo packages and workspaces, checked from the directory
 * that holds a `Cargo.toml`.
 *
 * A `rust-toolchain.toml` or `rust-toolchain` at or above a target's root pins
 * the toolchain, and with it the rustfmt and clippy components, which run as
 * `cargo fmt` and `cargo clippy` through rustup's `cargo` (R6.1). Otherwise a
 * tool resolves through a `mise.toml` pin, then `PATH`. Every check of the
 * pack, a target's custom checks included, runs offline (R6.4):
 * `CARGO_NET_OFFLINE` fails a crate missing from cargo's cache, rather than
 * fetch it, so a repo runs `cargo fetch` first; `RUSTUP_AUTO_INSTALL=0` fails a
 * toolchain the file names that isn't installed, rather than install it; and
 * `CARGO_TERM_COLOR=never` keeps captured text plain. Where a toolchain file
 * pins the toolchain, the launcher also clears `RUSTUP_TOOLCHAIN`, so a
 * version an outer shell exported, as mise does for its own Rust, can't
 * override the one the file names.
 */

import type { Pack } from './types.js';

/** The detect file that says a directory holds a Cargo package or workspace. */
const CARGO_ROOT = ['Cargo.toml'];

/**
 * The lock every row takes, so one target's cargo runs never overlap: cargo
 * locks its build directory, and a run waiting on another's would spend its
 * timeout there. Two targets' runs go side by side. Targets that share one
 * `CARGO_TARGET_DIR` still serialize, on cargo's own lock, and that wait does
 * count against their timeouts.
 */
const LOCK = 'cargo:{root}';

export const RUST_PACK: Pack = {
  name: 'rust',
  markers: CARGO_ROOT,
  pins: ['rust-toolchain', 'mise', 'path'],
  env: { CARGO_NET_OFFLINE: 'true', RUSTUP_AUTO_INSTALL: '0', CARGO_TERM_COLOR: 'never' },
  adapters: [
    {
      name: 'cargo-check',
      slot: 'types',
      description: 'cargo check: Rust type checking',
      detect: CARGO_ROOT,
      command: 'cargo',
      args: ['check', '--workspace', '--all-targets', '--message-format=json'],
      outputFile: 'types.jsonl',
      lock: LOCK,
      devDeps: {},
    },
    {
      name: 'rustfmt',
      slot: 'format',
      description: 'rustfmt: Rust formatting',
      detect: CARGO_ROOT,
      command: 'pnpm',
      args: ['exec', 'cargo-fmt', '--all', '--check'],
      outputFile: null,
      fixArgs: ['exec', 'cargo-fmt', '--all'],
      lock: LOCK,
      devDeps: {},
    },
    {
      name: 'clippy',
      slot: 'lint',
      description: 'clippy: Rust lints, warnings included',
      detect: CARGO_ROOT,
      command: 'pnpm',
      args: ['exec', 'cargo-clippy', '--workspace', '--all-targets', '--message-format=json', '--', '-D', 'warnings'],
      outputFile: 'lint.jsonl',
      fixArgs: ['exec', 'cargo-clippy', '--fix', '--allow-dirty', '--allow-staged', '--workspace', '--all-targets'],
      lock: LOCK,
      devDeps: {},
    },
    {
      name: 'cargo-machete',
      slot: 'dead',
      description: 'cargo-machete: unused Rust dependencies',
      // Unused code is rustc's dead_code lint, which clippy fails under -D warnings.
      detect: [],
      detectPin: 'cargo-machete',
      command: 'pnpm',
      args: ['exec', 'cargo-machete'],
      outputFile: null,
      lock: LOCK,
      devDeps: {},
    },
    {
      name: 'nextest',
      slot: 'test',
      description: 'cargo-nextest: Rust tests',
      detect: ['.config/nextest.toml'],
      command: 'pnpm',
      args: ['exec', 'cargo-nextest', 'run', '--workspace', '--no-fail-fast'],
      outputFile: null,
      lock: LOCK,
      devDeps: {},
    },
    {
      name: 'cargo-test',
      slot: 'test',
      description: 'cargo test: Rust tests',
      detect: CARGO_ROOT,
      command: 'cargo',
      args: ['test', '--workspace', '--no-fail-fast'],
      outputFile: null,
      lock: LOCK,
      devDeps: {},
    },
    {
      name: 'cargo-doctest',
      slot: 'snippets',
      description: 'cargo test --doc: Rust doc examples',
      // nextest doesn't run doctests, so a Rust repo opts this slot in.
      detect: CARGO_ROOT,
      command: 'cargo',
      args: ['test', '--doc', '--workspace'],
      outputFile: null,
      lock: LOCK,
      devDeps: {},
    },
    {
      name: 'cargo-deny',
      slot: 'security',
      description: 'cargo-deny: advisories, licenses, bans and sources',
      detect: ['deny.toml'],
      command: 'pnpm',
      // Its JSON lines go to stderr, so they land in security.stderr.txt. It
      // fetches the advisory database, so it runs with the network.
      args: ['exec', 'cargo-deny', '--format', 'json', 'check'],
      outputFile: null,
      network: true,
      lock: LOCK,
      devDeps: {},
    },
    {
      name: 'cargo-mutants',
      slot: 'mutation',
      description: 'cargo-mutants: Rust mutation testing',
      detect: [],
      detectPin: 'cargo-mutants',
      command: 'pnpm',
      // `--output` puts its mutants.out/ in the check's artifact directory
      // rather than the source tree.
      args: ['exec', 'cargo-mutants', '--output', '{out}'],
      outputFile: null,
      // Ships uncapped (`0`), as stryker does. A real mutation run builds and
      // tests the crate once per mutant, which takes far past the 600s default
      // cap; `mutation` is opt-in and never in the definition-of-done gate the
      // cap protects, so it runs to completion rather than tripping a timeout.
      timeout: 0,
      lock: LOCK,
      devDeps: {},
    },
  ],
};

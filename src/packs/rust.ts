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

export const RUST_PACK: Pack = {
  name: 'rust',
  markers: ['Cargo.toml'],
  pins: ['rust-toolchain', 'mise', 'path'],
  env: { CARGO_NET_OFFLINE: 'true', RUSTUP_AUTO_INSTALL: '0', CARGO_TERM_COLOR: 'never' },
  adapters: [],
};

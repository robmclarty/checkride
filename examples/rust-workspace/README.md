# Rust workspace

A Cargo workspace, a library crate and a binary that uses it, checked from its
root as one rust target, `shop`.

- `rust-toolchain.toml` pins the toolchain, with clippy and rustfmt, so cargo,
  clippy and rustfmt all record `pin_source: "rust-toolchain"` at its channel.
  Only rustup reads that file, so these checks need rustup on `PATH`.
- `shop:types` runs `cargo check`, and `shop:lint` clippy with `-D warnings`,
  so a warning fails it.
- `shop:dead` runs cargo-machete, because `mise.toml` pins it, and fails on a
  dependency no crate uses.
- `shop:test` runs `cargo test`, and `shop:snippets`, which the config names
  to opt it in, runs the doctests.
- `struct` runs the Rust dialect rules in `rules/rust/`: no glob imports, and
  no glob re-exports.

Every cargo run for the target takes one lock, so they never overlap. Every
check runs offline, with `CARGO_NET_OFFLINE`, and never installs a toolchain.

```bash
pnpm install
mise install
pnpm check
```

The root `package.json` installs ast-grep and links checkride from this repo,
so `unclaimed.ignore` lists it.

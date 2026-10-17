/**
 * Every external tool the packs run, described once. An adapter names its tool
 * by `bin`; this is where that name meets the package that provides it.
 */

import type { Tool } from './types.js';

/**
 * The Go toolchain, which runs a tool a `go.mod` `tool` directive declares as
 * `go tool <bin>`. A `mise.toml` may pin it; otherwise it comes from `PATH`,
 * and the `go` line in `go.mod` sets the oldest version it accepts.
 */
export const GO_TOOLCHAIN: Tool = {
  bin: 'go',
  mise: ['go', 'core:go'],
  install: 'install Go 1.24 or later (https://go.dev/dl), or pin it with `mise use go@<version>`',
};

/**
 * cargo, the Rust toolchain's driver, which runs a rustup component a
 * `rust-toolchain.toml` pins, such as `cargo clippy`. rustup's `cargo` reads
 * that file and runs the toolchain it names.
 */
export const CARGO_TOOLCHAIN: Tool = {
  bin: 'cargo',
  component: 'cargo',
  mise: ['rust', 'core:rust'],
  install: 'install Rust with rustup (https://rustup.rs), or pin it with `mise use rust@<version>`',
};

/**
 * The executables a toolchain ships, which an adapter runs directly rather
 * than as a tool: each resolves through the toolchain's own pin, the `go` a
 * `mise.toml` declares running both `go` and `gofmt`.
 */
export const TOOLCHAINS: readonly Tool[] = [
  GO_TOOLCHAIN,
  CARGO_TOOLCHAIN,
  {
    bin: 'gofmt',
    mise: ['go', 'core:go'],
    install: 'gofmt ships with Go: install Go 1.24 or later (https://go.dev/dl), or pin it with `mise use go@<version>`',
  },
];

/** One row per tool, by executable name. */
export const TOOLS: readonly Tool[] = [
  {
    bin: 'ast-grep',
    npm: '@ast-grep/cli',
    mise: ['ast-grep', 'aqua:ast-grep/ast-grep'],
    install: 'add @ast-grep/cli to devDependencies, or pin the binary with `mise use ast-grep@<version>`',
  },
  { bin: 'attw', npm: '@arethetypeswrong/cli', install: 'add @arethetypeswrong/cli to devDependencies' },
  { bin: 'biome', npm: '@biomejs/biome', install: 'add @biomejs/biome to devDependencies' },
  {
    bin: 'cargo-clippy',
    run: ['cargo', 'clippy'],
    component: 'clippy',
    mise: ['rust', 'core:rust'],
    install: 'add the clippy component with `rustup component add clippy`, or pin Rust with it in mise.toml',
  },
  {
    bin: 'cargo-deny',
    run: ['cargo', 'deny'],
    mise: ['cargo-deny', 'aqua:EmbarkStudios/cargo-deny', 'cargo:cargo-deny'],
    install: 'pin it with `mise use cargo-deny@<version>`, or `cargo install cargo-deny`',
  },
  {
    bin: 'cargo-fmt',
    run: ['cargo', 'fmt'],
    component: 'rustfmt',
    mise: ['rust', 'core:rust'],
    install: 'add the rustfmt component with `rustup component add rustfmt`, or pin Rust with it in mise.toml',
  },
  {
    bin: 'cargo-machete',
    run: ['cargo', 'machete'],
    mise: ['ubi:bnjbvr/cargo-machete', 'cargo:cargo-machete'],
    install: 'pin it with `mise use ubi:bnjbvr/cargo-machete@<version>`, or `cargo install cargo-machete`',
  },
  {
    bin: 'cargo-mutants',
    run: ['cargo', 'mutants'],
    mise: ['ubi:sourcefrog/cargo-mutants', 'cargo:cargo-mutants'],
    install: 'pin it with `mise use ubi:sourcefrog/cargo-mutants@<version>`, or `cargo install cargo-mutants`',
  },
  {
    bin: 'cargo-nextest',
    run: ['cargo', 'nextest'],
    mise: ['aqua:nextest-rs/nextest/cargo-nextest', 'cargo:cargo-nextest'],
    install: 'pin it with `mise use aqua:nextest-rs/nextest/cargo-nextest@<version>`, or `cargo install cargo-nextest`',
  },
  { bin: 'cspell', npm: 'cspell', install: 'add cspell to devDependencies' },
  {
    bin: 'deadcode',
    goTool: 'golang.org/x/tools/cmd/deadcode',
    mise: ['go:golang.org/x/tools/cmd/deadcode'],
    install: 'declare it in go.mod with `go get -tool golang.org/x/tools/cmd/deadcode`',
  },
  { bin: 'eslint', npm: 'eslint', install: 'add eslint to devDependencies' },
  { bin: 'fallow', npm: 'fallow', install: 'add fallow to devDependencies' },
  {
    bin: 'golangci-lint',
    mise: ['golangci-lint', 'aqua:golangci/golangci-lint'],
    install: 'pin it with `mise use golangci-lint@<version>`, or install golangci-lint v2 (https://golangci-lint.run)',
  },
  {
    bin: 'govulncheck',
    goTool: 'golang.org/x/vuln/cmd/govulncheck',
    mise: ['go:golang.org/x/vuln/cmd/govulncheck'],
    install: 'declare it in go.mod with `go get -tool golang.org/x/vuln/cmd/govulncheck`',
  },
  { bin: 'jest', npm: 'jest', install: 'add jest to devDependencies' },
  { bin: 'knip', npm: 'knip', install: 'add knip to devDependencies' },
  { bin: 'markdownlint-cli2', npm: 'markdownlint-cli2', install: 'add markdownlint-cli2 to devDependencies' },
  { bin: 'oxlint', npm: 'oxlint', install: 'add oxlint to devDependencies' },
  { bin: 'prettier', npm: 'prettier', install: 'add prettier to devDependencies' },
  { bin: 'publint', npm: 'publint', install: 'add publint to devDependencies' },
  {
    bin: 'rumdl',
    mise: ['rumdl', 'aqua:rvben/rumdl'],
    install: 'pin it with `mise use rumdl@<version>`, or install rumdl (https://github.com/rvben/rumdl)',
  },
  {
    bin: 'shellcheck',
    mise: ['shellcheck', 'aqua:koalaman/shellcheck'],
    install: 'pin it with `mise use shellcheck@<version>`, or install shellcheck (https://www.shellcheck.net)',
  },
  {
    bin: 'shfmt',
    mise: ['shfmt', 'aqua:mvdan/sh'],
    install: 'pin it with `mise use shfmt@<version>`, or install shfmt (https://github.com/mvdan/sh)',
  },
  {
    bin: 'staticcheck',
    goTool: 'honnef.co/go/tools/cmd/staticcheck',
    mise: ['staticcheck', 'aqua:dominikh/go-tools/staticcheck', 'go:honnef.co/go/tools/cmd/staticcheck'],
    install: 'declare it in go.mod with `go get -tool honnef.co/go/tools/cmd/staticcheck`, or pin it with `mise use staticcheck@<version>`',
  },
  { bin: 'stryker', npm: '@stryker-mutator/core', install: 'add @stryker-mutator/core to devDependencies' },
  { bin: 'tsc', npm: 'typescript', install: 'add typescript to devDependencies' },
  {
    bin: 'typos',
    mise: ['typos', 'aqua:crate-ci/typos'],
    install: 'pin it with `mise use typos@<version>`, or install typos (https://github.com/crate-ci/typos)',
  },
  {
    bin: 'vale',
    npm: '@vvago/vale',
    mise: ['vale', 'aqua:vale-cli/vale'],
    install: 'add @vvago/vale to devDependencies, or pin the binary with `mise use vale@<version>`',
  },
  { bin: 'vitest', npm: 'vitest', install: 'add vitest to devDependencies' },
];

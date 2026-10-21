import { describe, expect, test } from 'vitest';

import { packEnv, setupHint } from '../index.js';

describe('packEnv (R6.4)', () => {
  test('a go check fails rather than download a toolchain or a module, and leaves GOFLAGS alone (D54)', () => {
    expect(packEnv('go')).toEqual({ GOTOOLCHAIN: 'local', GOPROXY: 'off' });
  });

  test('a network check keeps the variables that pin a toolchain, and drops the ones that block downloads', () => {
    expect(packEnv('go', true)).toEqual({ GOTOOLCHAIN: 'local' });
  });

  test('a rust check runs offline, never installs a toolchain, and prints plain text', () => {
    expect(packEnv('rust')).toEqual({ CARGO_NET_OFFLINE: 'true', RUSTUP_AUTO_INSTALL: '0', CARGO_TERM_COLOR: 'never' });
    expect(packEnv('rust', true)).toEqual({ RUSTUP_AUTO_INSTALL: '0', CARGO_TERM_COLOR: 'never' });
  });

  test('a python check reaches no index through pip or uv, and writes no bytecode into the checkout', () => {
    expect(packEnv('python')).toEqual({ PYTHONDONTWRITEBYTECODE: '1', PIP_NO_INDEX: '1', UV_OFFLINE: '1' });
    expect(packEnv('python', true)).toEqual({ PYTHONDONTWRITEBYTECODE: '1' });
  });

  test('a terraform check never prompts, calls home or lets a version manager download a CLI, network or not', () => {
    const env = {
      CHECKPOINT_DISABLE: '1',
      TF_IN_AUTOMATION: '1',
      TF_INPUT: '0',
      TFENV_AUTO_INSTALL: 'false',
      TOFUENV_AUTO_INSTALL: 'false',
      TRIVY_SKIP_CHECK_UPDATE: 'true',
    };
    expect(packEnv('terraform')).toEqual(env);
    expect(packEnv('terraform', true)).toEqual(env);
  });

  test('a check of a pack that sets none, or of no pack, sets none', () => {
    for (const pack of ['ts', 'repo', 'bash', undefined]) expect(packEnv(pack), String(pack)).toEqual({});
  });
});

describe('setupHint', () => {
  test("names go mod download when GOPROXY=off stopped a module lookup, in go build -json's stdout or go's stderr", () => {
    // Go 1.27.2, `go build -json ./...` with an empty module cache.
    const stdout = '{"ImportPath":"golang.org/x/text/language","Action":"build-output","Output":"main.go:6:2: module lookup disabled by GOPROXY=off\\n"}\n';
    expect(setupHint({ stdout, stderr: 'go: downloading golang.org/x/text v0.22.0\n' })).toContain('run `go mod download` first');
    expect(setupHint({ stdout: '', stderr: 'main.go:6:2: module lookup disabled by GOPROXY=off\n' })).toContain('go mod download');
  });

  test("names the toolchain to install when rustup won't install the one the repo pins (F3)", () => {
    // rustup 1.29.1, under RUSTUP_AUTO_INSTALL=0.
    const stderr = "error: toolchain '1.80.0-aarch64-apple-darwin' is not installed\nhelp: run `rustup toolchain install` to install it\n";
    expect(setupHint({ stdout: '', stderr })).toContain('run `rustup toolchain install 1.80.0-aarch64-apple-darwin` first');
  });

  test('names cargo fetch when an offline cargo misses a crate', () => {
    // cargo 1.99.0, under CARGO_NET_OFFLINE=true.
    const stderr = 'error: no matching package named `itoa` found\nnote: offline mode (via `--offline`) can sometimes cause surprising resolution failures\n';
    expect(setupHint({ stdout: '', stderr })).toContain('run `cargo fetch` first');
  });

  test("names uv sync when UV_OFFLINE stopped uv fetching a package its cache lacks", () => {
    // uv 0.13.1, `uv run pytest -q` under UV_OFFLINE=1 with an empty cache.
    const stderr = [
      'Creating virtual environment at: .venv',
      'error: Failed to download `ruff==0.14.0`',
      "  cause: Network connectivity is disabled, but the requested data wasn't found in the cache: https://files.pythonhosted.org/packages/ruff-0.14.0-py3-none-macosx_11_0_arm64.whl",
      '',
    ].join('\n');
    expect(setupHint({ stdout: '', stderr })).toContain('run `uv sync` first');
  });

  test('names oxlint-tsgolint when oxlint runs type-aware with no tsgolint to run', () => {
    // oxlint 1.87.0, `oxlint --type-aware` in a repo that never installed oxlint-tsgolint.
    const stderr = 'Failed to find tsgolint executable. You may need to add the `oxlint-tsgolint` package to your project?\n';
    const hint = setupHint({ stdout: '', stderr });
    expect(hint).toContain('need the oxlint-tsgolint package: install it, or turn type-aware linting off');
    expect(hint).toContain('`--type-aware` in the check');
  });

  test('names pnpm install when pnpm exec finds no copy of a tool the project declares', () => {
    // pnpm 11.28.5 prints it on stdout, after a stray `undefined`; older releases pad the code with spaces.
    expect(setupHint({ stdout: 'undefined\n[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "oxlint" not found\n', stderr: '' })).toBe(
      "`oxlint` isn't in node_modules/.bin, and checks never install a tool: run `pnpm install` first",
    );
    expect(setupHint({ stdout: '', stderr: ' ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "tsc" not found\n' })).toContain('`tsc` isn\'t in node_modules/.bin');
    expect(setupHint({ stdout: 'error: Command "oxlint" not found\n', stderr: '' })).toBeNull();
  });

  test('says nothing for any other failure', () => {
    expect(setupHint({ stdout: '', stderr: 'go: go.mod requires go >= 1.99 (running go 1.27.2; GOTOOLCHAIN=local)\n' })).toBeNull();
    expect(setupHint({ stdout: 'main.go:4:14: cannot use "nope" as int value\n', stderr: '' })).toBeNull();
    expect(setupHint({ stdout: '{"diagnostics":[{"message":"tsgolint rule failed"}]}', stderr: '' })).toBeNull();
  });
});

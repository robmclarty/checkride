import { describe, expect, test } from 'vitest';

import type { Adapter } from '../../adapters.js';
import { SLOTS } from '../../adapters.js';
import { PACKS, TOOLS } from '../index.js';

const ROWS: readonly Adapter[] = Object.values(PACKS).flatMap((pack) => pack.adapters);

/** The repo pack's adapters for `slot`, by name, in row order. */
const fill = (slot: string): string[] => PACKS.repo.adapters.filter((a) => a.slot === slot).map((a) => a.name);

/** The `<bin>` of a canonical `pnpm exec <bin> …` argument list, or undefined for anything else. */
const execBin = (args: readonly string[] | undefined): string | undefined => (args?.[0] === 'exec' ? args[1] : undefined);

/** Every bin a row runs: its check, and its fix when it has one. */
const binsOf = (row: Adapter): string[] =>
  row.command === 'pnpm' ? [execBin(row.args), execBin(row.fixArgs)].filter((b) => b !== undefined) : [];

describe('the ts and repo packs', () => {
  test('the ts pack is marked by package.json or tsconfig.json; the repo pack has no markers', () => {
    expect(PACKS.ts.markers).toEqual(['package.json', 'tsconfig.json']);
    expect(PACKS.repo.markers).toEqual([]);
  });

  test('ts pins its tools through the lockfile alone, and repo falls through to mise and PATH; neither sets variables', () => {
    expect(PACKS.ts.pins).toEqual(['js-lockfile']);
    expect(PACKS.repo.pins).toEqual(['js-lockfile', 'mise', 'path']);
    for (const pack of [PACKS.ts, PACKS.repo]) expect(pack.env).toEqual({});
  });

  test('the repo pack runs a Node-free alternate after each npm default, with mise ids for every binary', () => {
    expect(fill('docs')).toEqual(['markdownlint-cli2', 'rumdl']);
    expect(fill('spell')).toEqual(['cspell', 'typos']);
    for (const bin of ['ast-grep', 'vale', 'rumdl', 'typos']) {
      expect(TOOLS.find((t) => t.bin === bin)?.mise?.[0], bin).toBe(bin);
    }
  });

  test('each pack fills only slots of its own scope', () => {
    const scopeOf = new Map(SLOTS.map((s) => [s.name, s.scope]));
    for (const row of PACKS.ts.adapters) expect(scopeOf.get(row.slot), row.name).toBe('target');
    for (const row of PACKS.repo.adapters) expect(scopeOf.get(row.slot), row.name).toBe('repo');
  });
});

describe('TOOLS', () => {
  test('describes each tool once', () => {
    const bins = TOOLS.map((t) => t.bin);
    expect(new Set(bins).size).toBe(bins.length);
  });

  test('has a row for every tool a pack runs, and none that no pack runs', () => {
    const run = new Set(ROWS.flatMap(binsOf));
    expect(TOOLS.map((t) => t.bin).toSorted()).toEqual([...run].toSorted());
  });

  test('names the npm package init installs for the rows that run each tool', () => {
    for (const row of ROWS) {
      // Built-ins pin nothing: snippets runs the tsc the tsc row already installs.
      if (Object.keys(row.devDeps).length === 0) continue;
      for (const bin of binsOf(row)) {
        const npm = TOOLS.find((t) => t.bin === bin)?.npm;
        expect(npm !== undefined && npm in row.devDeps, `${row.name} runs ${bin}`).toBe(true);
      }
    }
  });
});

/** The go pack's row named `name`. */
const goRow = (name: string): Adapter | undefined => PACKS.go.adapters.find((a) => a.name === name);

/** The Go package `TOOLS` gives `bin`, for a `go.mod` `tool` directive to declare. */
const goToolOf = (bin: string): string | undefined => TOOLS.find((t) => t.bin === bin)?.goTool;

describe('the go pack (R5.5)', () => {

  test('is marked by go.mod or go.work, pins through go.mod tools, then mise, then PATH, and switches downloads off', () => {
    expect(PACKS.go.markers).toEqual(['go.mod', 'go.work']);
    expect(PACKS.go.pins).toEqual(['go-mod-tool', 'mise', 'path']);
    // GOFLAGS stays the user's own (D54).
    expect(PACKS.go.env).toEqual({ GOTOOLCHAIN: 'local', GOPROXY: 'off' });
  });

  test('fills each slot R5.5 names, golangci-lint first in lint', () => {
    expect(PACKS.go.adapters.map((a) => [a.slot, a.name])).toEqual([
      ['types', 'go-build'],
      ['format', 'gofmt'],
      ['lint', 'golangci-lint'],
      ['lint', 'staticcheck'],
      ['dead', 'deadcode'],
      ['test', 'go-test'],
      ['security', 'govulncheck'],
    ]);
    const scopeOf = new Map(SLOTS.map((s) => [s.name, s.scope]));
    for (const a of PACKS.go.adapters) expect(scopeOf.get(a.slot), a.name).toBe('target');
  });

  test('captures each tool in the form it prints', () => {
    expect(PACKS.go.adapters.map((a) => [a.name, a.outputFile])).toEqual([
      ['go-build', 'types.jsonl'],
      ['gofmt', null],
      ['golangci-lint', 'lint.json'],
      ['staticcheck', 'lint.jsonl'],
      ['deadcode', null],
      ['go-test', 'test.jsonl'],
      ['govulncheck', null],
    ]);
  });

  test('fails gofmt -l and deadcode on what they print, since both exit 0', () => {
    expect(PACKS.go.adapters.filter((a) => a.failOnOutput === true).map((a) => a.name)).toEqual(['gofmt', 'deadcode']);
  });

  test('never runs two golangci-lints at once, across every target', () => {
    expect(PACKS.go.adapters.filter((a) => a.lock !== undefined).map((a) => [a.name, a.lock])).toEqual([['golangci-lint', 'golangci-lint']]);
  });

  test('runs govulncheck alone with the network, and every other check offline', () => {
    expect(PACKS.go.adapters.filter((a) => a.network === true).map((a) => a.name)).toEqual(['govulncheck']);
  });

  test('names packages through {go-packages} everywhere but gofmt, which walks its root', () => {
    for (const a of PACKS.go.adapters) {
      expect(a.args.includes('{go-packages}'), a.name).toBe(a.name !== 'gofmt');
    }
    expect(goRow('golangci-lint')?.fixArgs).toContain('{go-packages}');
  });

  test('detects the toolchain adapters by go.mod or go.work, golangci-lint by its config, and the go tools by a pin', () => {
    for (const name of ['go-build', 'gofmt', 'go-test']) expect(goRow(name)?.detect, name).toEqual(['go.mod', 'go.work']);
    expect(goRow('golangci-lint')?.detect).toEqual(['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json']);
    for (const name of ['staticcheck', 'deadcode', 'govulncheck']) {
      expect(goRow(name)?.detect, name).toEqual([]);
      expect(goRow(name)?.detectPin, name).toBe(name);
    }
  });

  test('gives each tool a go.mod tool directive can declare its package, and golangci-lint none, since it pins as a binary', () => {
    expect(goToolOf('staticcheck')).toBe('honnef.co/go/tools/cmd/staticcheck');
    expect(goToolOf('deadcode')).toBe('golang.org/x/tools/cmd/deadcode');
    expect(goToolOf('govulncheck')).toBe('golang.org/x/vuln/cmd/govulncheck');
    expect(goToolOf('golangci-lint')).toBeUndefined();
  });
});

/** The `TOOLS` row for `bin`. */
const toolRow = (bin: string): (typeof TOOLS)[number] | undefined => TOOLS.find((t) => t.bin === bin);

describe('the rust pack (R5.6)', () => {
  test('is marked by Cargo.toml, pins through the toolchain file, then mise, then PATH, and runs offline', () => {
    expect(PACKS.rust.markers).toEqual(['Cargo.toml']);
    expect(PACKS.rust.pins).toEqual(['rust-toolchain', 'mise', 'path']);
    expect(PACKS.rust.env).toEqual({ CARGO_NET_OFFLINE: 'true', RUSTUP_AUTO_INSTALL: '0', CARGO_TERM_COLOR: 'never' });
  });

  test('fills each slot R5.6 names, nextest first in test', () => {
    expect(PACKS.rust.adapters.map((a) => [a.slot, a.name])).toEqual([
      ['types', 'cargo-check'],
      ['format', 'rustfmt'],
      ['lint', 'clippy'],
      ['dead', 'cargo-machete'],
      ['test', 'nextest'],
      ['test', 'cargo-test'],
      ['snippets', 'cargo-doctest'],
      ['security', 'cargo-deny'],
      ['mutation', 'cargo-mutants'],
    ]);
    const scopeOf = new Map(SLOTS.map((s) => [s.name, s.scope]));
    for (const a of PACKS.rust.adapters) expect(scopeOf.get(a.slot), a.name).toBe('target');
  });

  test("locks every row on its target's root, so one target's cargo runs never overlap", () => {
    for (const a of PACKS.rust.adapters) expect(a.lock, a.name).toBe('cargo:{root}');
  });

  test('captures cargo check and clippy as JSON lines, and the rest as text', () => {
    expect(PACKS.rust.adapters.filter((a) => a.outputFile !== null).map((a) => [a.name, a.outputFile])).toEqual([
      ['cargo-check', 'types.jsonl'],
      ['clippy', 'lint.jsonl'],
    ]);
  });

  test('fails clippy on warnings, and runs cargo-deny alone with the network', () => {
    expect(PACKS.rust.adapters.find((a) => a.name === 'clippy')?.args.slice(-3)).toEqual(['--', '-D', 'warnings']);
    expect(PACKS.rust.adapters.filter((a) => a.network === true).map((a) => a.name)).toEqual(['cargo-deny']);
  });

  test('runs rustfmt and clippy as toolchain components a rust-toolchain file pins, and the plugins as cargo subcommands', () => {
    expect(toolRow('cargo-fmt')).toMatchObject({ run: ['cargo', 'fmt'], component: 'rustfmt' });
    expect(toolRow('cargo-clippy')).toMatchObject({ run: ['cargo', 'clippy'], component: 'clippy' });
    for (const plugin of ['machete', 'nextest', 'deny', 'mutants']) {
      expect(toolRow(`cargo-${plugin}`)?.run, plugin).toEqual(['cargo', plugin]);
      expect(toolRow(`cargo-${plugin}`)?.component, plugin).toBeUndefined();
    }
  });
});

/** The python pack's row named `name`. */
const pythonRow = (name: string): Adapter | undefined => PACKS.python.adapters.find((a) => a.name === name);

describe('the python pack (R5.7)', () => {
  test('is marked by pyproject.toml, setup.cfg or setup.py, pins through uv.lock, then mise, then PATH, and switches downloads off', () => {
    expect(PACKS.python.markers).toEqual(['pyproject.toml', 'setup.cfg', 'setup.py']);
    expect(PACKS.python.pins).toEqual(['uv-lock', 'mise', 'path']);
    expect(PACKS.python.env).toEqual({ PYTHONDONTWRITEBYTECODE: '1', PIP_NO_INDEX: '1', UV_OFFLINE: '1' });
  });

  test('fills each slot R5.7 names, mypy first in types, and captures each tool in the form it prints', () => {
    expect(PACKS.python.adapters.map((a) => [a.slot, a.name, a.outputFile])).toEqual([
      ['lint', 'ruff', 'lint.json'],
      ['format', 'ruff-format', null],
      ['types', 'mypy', 'types.jsonl'],
      ['types', 'basedpyright', 'types.json'],
      ['test', 'pytest', null],
    ]);
    const scopeOf = new Map(SLOTS.map((s) => [s.name, s.scope]));
    for (const a of PACKS.python.adapters) expect(scopeOf.get(a.slot), a.name).toBe('target');
  });

  test('runs each tool with the flags verified at the pinned versions, ruff without the cache a read-only checkout refuses', () => {
    expect(pythonRow('ruff')?.args).toEqual(['exec', 'ruff', 'check', '--no-cache', '--output-format=json', '.']);
    expect(pythonRow('ruff')?.fixArgs).toEqual(['exec', 'ruff', 'check', '--fix', '.']);
    expect(pythonRow('ruff-format')?.args).toEqual(['exec', 'ruff', 'format', '--no-cache', '--check', '.']);
    expect(pythonRow('ruff-format')?.fixArgs).toEqual(['exec', 'ruff', 'format', '.']);
    expect(pythonRow('mypy')?.args).toEqual(['exec', 'mypy', '--output', 'json', '.']);
    expect(pythonRow('basedpyright')?.args).toEqual(['exec', 'basedpyright', '--outputjson']);
    expect(pythonRow('pytest')?.args).toEqual(['exec', 'pytest', '-q']);
  });

  test('detects each tool by its config file, its pyproject.toml table, or a pin', () => {
    const tables = (name: string) => pythonRow(name)?.detectTable?.map((t) => `${t.file} [${t.table}]`);
    for (const name of ['ruff', 'ruff-format']) {
      expect(pythonRow(name)?.detect, name).toEqual(['ruff.toml', '.ruff.toml']);
      expect(tables(name), name).toEqual(['pyproject.toml [tool.ruff]']);
      expect(pythonRow(name)?.detectPin, name).toBe('ruff');
    }
    expect(tables('mypy')).toEqual(['pyproject.toml [tool.mypy]']);
    expect(tables('basedpyright')).toEqual(['pyproject.toml [tool.basedpyright]', 'pyproject.toml [tool.pyright]']);
    expect(pythonRow('pytest')?.detect).toContain('conftest.py');
    expect(tables('pytest')).toEqual(['pyproject.toml [tool.pytest]']);
  });

  test('marks only ruff static, and runs every check offline', () => {
    expect(PACKS.python.adapters.filter((a) => a.static === true).map((a) => a.name)).toEqual(['ruff', 'ruff-format']);
    expect(PACKS.python.adapters.filter((a) => a.network === true)).toEqual([]);
  });

  test('gives every tool the PyPI package a uv.lock lists it by, and basedpyright, never the pyright wrapper', () => {
    for (const bin of ['ruff', 'mypy', 'basedpyright', 'pytest']) expect(toolRow(bin)?.pypi, bin).toBe(bin);
    expect(toolRow('pyright')).toBeUndefined();
  });
});

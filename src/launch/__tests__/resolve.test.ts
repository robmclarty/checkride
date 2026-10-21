import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { PACKS } from '../../packs/index.js';
import type { PinSourceName, Tool } from '../../packs/index.js';
import type { Launch, LaunchContext, PackageManager } from '../index.js';
import { installCommand, isReadableSource, launchCheck, launchOnToolchain, pinChain } from '../index.js';

/** An exec-form invocation of a tool no ancestor directory can plausibly hold. */
const ABSENT = ['exec', 'checkride-nonexistent-tool'];

/** The refusal message, or `null` when the launcher would spawn. */
function refusalOf(launch: Launch): string | null {
  return 'refusal' in launch ? launch.refusal : null;
}

/**
 * The pre-flight that keeps a launcher's per-user cache from deciding a slot's
 * verdict. `--no-install` stops the fetch but not the cache, so without this a
 * tool the repo never declared passes on a machine holding a stray copy and
 * fails on a clean checkout — the CI runner.
 */
describe('launchCheck refuses a tool the project never installed', () => {
  test('refuses the slot when the tool is not in the local tree', () => {
    expect(refusalOf(launchCheck('lint', 'pnpm', ABSENT, { cwd: '/repo', pm: 'npm' }))).not.toBeNull();
  });

  test('names the slot, the tool, and the PM-correct install command', () => {
    const refusal = refusalOf(launchCheck('lint', 'pnpm', ABSENT, { cwd: '/repo', pm: 'npm' })) ?? '';
    expect(refusal).toContain('`lint` slot');
    expect(refusal).toContain('checkride-nonexistent-tool');
    expect(refusal).toContain('npm install -D checkride-nonexistent-tool');
    // The raw launcher error ("npx canceled due to missing packages") named
    // none of this, which is what a consumer's CI digest used to be handed.
    expect(refusal).toContain('node_modules/.bin/checkride-nonexistent-tool');
  });

  /**
   * The executable isn't always the package: `npm install -D tsc` installs an
   * unrelated package, and `typescript` is the one that provides `tsc`.
   */
  test('installs the package that provides the tool, not the tool by name', () => {
    const refusal = refusalOf(launchCheck('types', 'pnpm', ['exec', 'tsc', '--build'], { cwd: '/repo', pm: 'bun' })) ?? '';
    expect(refusal).toContain('looked for: node_modules/.bin/tsc');
    expect(refusal).toContain('bun add -d typescript');
    expect(installCommand('npm', 'ast-grep')).toBe('npm install -D @ast-grep/cli');
    expect(installCommand('pnpm', 'stryker')).toBe('pnpm add -D @stryker-mutator/core');
  });

  test('lets the check spawn once the tool resolves', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkride-preflight-'));
    try {
      const bin = join(dir, 'node_modules', '.bin');
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, 'checkride-nonexistent-tool'), '');
      expect(launchCheck('lint', 'pnpm', ABSENT, { cwd: dir, pm: 'npm' })).toEqual({
        command: 'npx',
        args: ['--no-install', 'checkride-nonexistent-tool'],
        pin: { source: 'js-lockfile' },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * Scoped to the launchers with a cache to fall back on. `pnpm exec` and
   * `yarn` resolve from the project tree already, and Yarn PnP has no
   * `node_modules/.bin` at all — pre-flighting it would fail every slot on a
   * repo where every tool is genuinely available.
   */
  test('does not pre-flight the managers that resolve from the tree only', () => {
    for (const pm of ['pnpm', 'yarn'] satisfies PackageManager[]) {
      expect(refusalOf(launchCheck('lint', 'pnpm', ABSENT, { cwd: '/repo', pm }))).toBeNull();
    }
  });

  test('pre-flights both cache-backed launchers', () => {
    for (const pm of ['npm', 'bun'] satisfies PackageManager[]) {
      expect(refusalOf(launchCheck('lint', 'pnpm', ABSENT, { cwd: '/repo', pm }))).not.toBeNull();
    }
  });

  test('ignores invocations that have no tool to resolve', () => {
    // A custom check's own command, a PM subcommand, and a package script all
    // resolve themselves; only `pnpm exec <tool>` is pre-flighted.
    const cases: [string, string[]][] = [
      ['node', ['scripts/check-licenses.mjs']],
      ['pnpm', ['audit', '--json']],
      ['pnpm', ['run', 'build']],
    ];
    for (const [command, args] of cases) {
      expect(refusalOf(launchCheck('lint', command, args, { cwd: '/repo', pm: 'npm' }))).toBeNull();
    }
  });
});

describe('launchCheck builds the argv through the js-lockfile source', () => {
  const ctx = { cwd: '/repo' };

  test('keeps the pnpm exec prefix, adding only the deps-check override', () => {
    expect(launchCheck('lint', 'pnpm', ['exec', 'oxlint'], { ...ctx, pm: 'pnpm' })).toEqual({
      command: 'pnpm',
      args: ['--config.verify-deps-before-run=false', 'exec', 'oxlint'],
      pin: { source: 'js-lockfile' },
    });
  });

  test('swaps the launcher for the detected manager', () => {
    expect(launchCheck('build', 'pnpm', ['run', 'build'], { ...ctx, pm: 'yarn' })).toEqual({
      command: 'yarn',
      args: ['run', 'build'],
      pin: { source: 'js-lockfile' },
    });
    expect(launchCheck('lint', 'pnpm', ['exec', 'oxlint'], { ...ctx, pm: 'yarn' })).toEqual({
      command: 'yarn',
      args: ['oxlint'],
      pin: { source: 'js-lockfile' },
    });
  });

  test('spawns any other command as written, through no pin source', () => {
    expect(launchCheck('licenses', 'node', ['scripts/check-licenses.mjs'], { ...ctx, pm: 'npm' })).toEqual({
      command: 'node',
      args: ['scripts/check-licenses.mjs'],
    });
  });
});

/** Every pin chain a pack declares, by pack name. */
const CHAINS = Object.values(PACKS).map((p) => [p.name, p.pins] as const);

describe('pinChain', () => {
  test("a check with no pack, as every check in implicit mode, resolves through js-lockfile alone", () => {
    expect(pinChain(undefined)).toEqual(['js-lockfile']);
  });

  test("a check of a pack resolves through that pack's own chain", () => {
    for (const [name, pins] of CHAINS) expect(pinChain(name), name).toBe(pins);
  });

  test('every pack names only sources the launcher can read', () => {
    for (const [name, pins] of CHAINS) {
      for (const source of pins) expect(isReadableSource(source), `${name}: ${source}`).toBe(true);
    }
  });
});

/** A scratch repo: a root, a bin directory to stand in for PATH, and helpers to fill both. */
type Scratch = {
  repo: string;
  bin: string;
  /** Write `content` at `rel` under the repo, making its directories. */
  file: (rel: string, content: string) => Promise<void>;
  /** An executable named `name` on the scratch PATH, running `script` in the shell (exit 0 by default). */
  tool: (name: string, script?: string) => Promise<void>;
  /** A launch context at `rel` under the repo, with only the scratch bin on PATH. */
  at: (rel: string, extra?: Partial<LaunchContext>) => LaunchContext;
};

/** Run `body` against a fresh {@link Scratch}, removed afterwards. */
async function withScratch(body: (s: Scratch) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'checkride-pins-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  await mkdir(repo, { recursive: true });
  await mkdir(bin, { recursive: true });
  const scratch: Scratch = {
    repo,
    bin,
    file: async (rel, content) => {
      const path = join(repo, rel);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, content);
    },
    tool: async (name, script = 'exit 0') => {
      await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`);
      await chmod(join(bin, name), 0o755);
    },
    at: (rel, extra = {}) => ({ cwd: join(repo, rel), repo, pm: 'pnpm', env: { PATH: bin }, ...extra }),
  };
  try {
    await body(scratch);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The chain a Node-free pack would use: mise, then PATH (R6.1). */
const MISE_THEN_PATH = ['mise', 'path'] as const;

/** The repo pack's chain outside implicit ts mode: the package manager, then mise, then PATH. */
const FULL_CHAIN = ['js-lockfile', 'mise', 'path'] as const;

const SHELLCHECK = ['exec', 'shellcheck', '-f', 'json1', 'run.sh'];

/**
 * A mise that answers as 2026.10.4 does for a config file it hasn't trusted:
 * a first error line that names no cause, the line that does, and its hint.
 */
const UNTRUSTED_MISE = [
  'echo "mise WARN  mise version 2026.10.12 available" >&2',
  'echo "mise ERROR error parsing config file: /r/mise.toml" >&2',
  'echo "mise ERROR Config files in /r/mise.toml are not trusted." >&2',
  "echo 'Trust them with `mise trust`. See https://mise.jdx.dev/cli/trust.html for more information.' >&2",
  'exit 1',
].join('\n');

/** How each refusal for an untrusted config opens its cause. */
const UNTRUSTED_CAUSE = "but mise won't read a config file here until it's trusted.";

describe('the js-lockfile source records the version it installed', () => {
  test('reads node_modules/<package>/package.json, walking up from the check to the repo root', () =>
    withScratch(async (s) => {
      await s.file('node_modules/typescript/package.json', JSON.stringify({ version: '5.9.3' }));
      await mkdir(join(s.repo, 'apps', 'web'), { recursive: true });
      expect(launchCheck('types', 'pnpm', ['exec', 'tsc'], s.at('apps/web'))).toMatchObject({
        pin: { source: 'js-lockfile', version: '5.9.3' },
      });
    }));

  test("a target's own install wins over the root's", () =>
    withScratch(async (s) => {
      await s.file('node_modules/typescript/package.json', JSON.stringify({ version: '5.9.3' }));
      await s.file('apps/web/node_modules/typescript/package.json', JSON.stringify({ version: '5.4.0' }));
      expect(launchCheck('types', 'pnpm', ['exec', 'tsc'], s.at('apps/web'))).toMatchObject({ pin: { version: '5.4.0' } });
    }));

  test('never reads above the repo root', () =>
    withScratch(async (s) => {
      await writeFile(join(s.repo, '..', 'package.json'), '{}');
      await mkdir(join(s.repo, '..', 'node_modules', 'typescript'), { recursive: true });
      await writeFile(join(s.repo, '..', 'node_modules', 'typescript', 'package.json'), JSON.stringify({ version: '1.0.0' }));
      expect(launchCheck('types', 'pnpm', ['exec', 'tsc'], s.at('.'))).toEqual({
        command: 'pnpm',
        args: ['--config.verify-deps-before-run=false', 'exec', 'tsc'],
        pin: { source: 'js-lockfile' },
      });
    }));

  test('a tool TOOLS names no package for records no version, rather than guess one', () =>
    withScratch(async (s) => {
      await s.file('node_modules/my-linter/package.json', JSON.stringify({ version: '2.0.0' }));
      expect(launchCheck('lint', 'pnpm', ['exec', 'my-linter'], s.at('.'))).toMatchObject({ pin: { source: 'js-lockfile' } });
      expect(launchCheck('lint', 'pnpm', ['exec', 'my-linter'], s.at('.'))).not.toHaveProperty('pin.version');
    }));
});

/** A mise that runs every pinned copy and answers `which --version` by printing `answer`, as mise 2026.10.4 does for an installed pin. */
function miseResolving(answer: string): string {
  return `if [ "$1" = which ] && [ "$2" = --version ]; then printf '%s\\n' "${answer}"; fi`;
}

/**
 * mise owns version resolution, so the source never reads the version a
 * `mise.toml` names, which can be a prefix or `latest`: it records the one
 * mise printed when asked whether it can run the pinned copy.
 */
describe('the mise source records the version mise resolved (R6.3)', () => {
  test('a tool a mise.toml pins records the release `mise which --version` names, not the prefix the file gives', () =>
    withScratch(async (s) => {
      await s.file('mise.toml', '[tools]\nshellcheck = "0.11"\n');
      await s.tool('mise', miseResolving('0.11.0'));
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: MISE_THEN_PATH }))).toEqual({
        command: 'mise',
        args: ['exec', '--', 'shellcheck', '-f', 'json1', 'run.sh'],
        env: { MISE_EXEC_AUTO_INSTALL: 'false', MISE_NOT_FOUND_AUTO_INSTALL: 'false' },
        pin: { source: 'mise', version: '0.11.0' },
      });
    }));

  test('reads the last line mise prints, past a warning on stderr and a notice before it', () =>
    withScratch(async (s) => {
      await s.file('mise.toml', '[tools]\nshellcheck = "latest"\n');
      await s.tool('mise', 'echo "mise WARN  mise version 2026.10.12 available" >&2; echo "a notice"; echo "0.11.0"; echo');
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: MISE_THEN_PATH }))).toMatchObject({ pin: { source: 'mise', version: '0.11.0' } });
    }));

  test('a pin mise resolves to no release, such as system or a ref, records no version', () =>
    withScratch(async (s) => {
      await s.file('mise.toml', '[tools]\nshellcheck = "system"\n');
      for (const answer of ['system', 'ref:main', 'path:/opt/shellcheck', '']) {
        await s.tool('mise', miseResolving(answer));
        const launch = launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: MISE_THEN_PATH }));
        expect(launch, answer).toMatchObject({ command: 'mise', pin: { source: 'mise' } });
        expect(launch, answer).not.toHaveProperty('pin.version');
      }
    }));

  test('the go a mise.toml pins records the version mise resolved, and a go.mod tool it runs keeps go.mod\'s', () =>
    withScratch(async (s) => {
      await s.file('go.mod', GO_MOD_WITH_TOOL);
      await s.file('mise.toml', '[tools]\ngo = "1.27"\n');
      await s.tool('mise', miseResolving('1.27.2'));
      expect(launchCheck('vet', 'go', ['vet', './...'], s.at('.', { pins: GO_CHAIN }))).toMatchObject({
        command: 'mise',
        args: ['exec', '--', 'go', 'vet', './...'],
        pin: { source: 'mise', version: '1.27.2' },
      });
      expect(launchCheck('dead', 'pnpm', RUN_DEADCODE, s.at('.', { pins: GO_CHAIN, tools: [DEADCODE] }))).toMatchObject({
        command: 'mise',
        pin: { source: 'go-mod-tool', version: 'v0.30.0' },
      });
    }));
});

/** A `go` and `gofmt` on the scratch PATH whose GOROOT's `VERSION` names `release`, as an install of that Go release does. */
async function goOnPath(s: Scratch, release: string): Promise<void> {
  await s.tool('go');
  await s.tool('gofmt');
  await writeFile(join(s.bin, '..', 'VERSION'), `go${release}\ntime 2026-10-02T20:28:03Z\n`);
}

/**
 * A mise that answers `which --version <bin>` with the version `versions`
 * gives each bin it knows, fails for any other the way mise does, and appends
 * every question it's asked to `<bin>/mise.asked`.
 */
function miseKnowing(versions: Readonly<Record<string, string>>): string {
  return [
    'echo "$*" >> "$0.asked"',
    'if [ "$1" = which ] && [ "$2" = --version ]; then',
    '  case "$3" in',
    ...Object.entries(versions).map(([bin, version]) => `    ${bin}) echo "${version}"; exit 0 ;;`),
    '  esac',
    '  echo "mise ERROR $3 is not a mise bin" >&2',
    '  exit 1',
    'fi',
  ].join('\n');
}

/** The questions a {@link miseKnowing} mise was asked, one per line. */
async function miseAsked(s: Scratch): Promise<string[]> {
  return (await readFile(join(s.bin, 'mise.asked'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
}

const GOLANGCI = ['exec', 'golangci-lint', 'run', '--output.json.path=stdout', './...'];

/**
 * A go check records the Go release its tool ran on, as `toolchain`, found
 * the way the launch knows it best: the toolchain's own pin, the `go` a
 * `go.mod` tool runs through, mise's answer for a tool mise runs, else the
 * `VERSION` file of the `go` on `PATH`. Never by running `go`.
 */
describe('a go check records the Go release it ran on', () => {
  const GO = { pins: GO_CHAIN, toolchain: 'go' } as const;

  test('go and gofmt from PATH record the release their GOROOT names', () =>
    withScratch(async (s) => {
      await goOnPath(s, '1.26.1');
      expect(launchOnToolchain('vet', 'go', ['vet', './...'], s.at('.', GO))).toEqual({
        command: 'go',
        args: ['vet', './...'],
        env: { MISE_EXEC_AUTO_INSTALL: 'false', MISE_NOT_FOUND_AUTO_INSTALL: 'false' },
        pin: { source: 'path', toolchain: '1.26.1' },
      });
      expect(launchOnToolchain('format', 'gofmt', ['-l', '.'], s.at('.', GO))).toMatchObject({ pin: { source: 'path', toolchain: '1.26.1' } });
    }));

  test('a go mise pins records the release mise resolved, asking mise once', () =>
    withScratch(async (s) => {
      await s.file('mise.toml', '[tools]\ngo = "1.27"\n');
      await s.tool('mise', miseKnowing({ go: '1.27.2', gofmt: '1.27.2' }));
      await goOnPath(s, '1.26.1');
      expect(launchOnToolchain('vet', 'go', ['vet', './...'], s.at('.', GO))).toMatchObject({
        command: 'mise',
        pin: { source: 'mise', version: '1.27.2', toolchain: '1.27.2' },
      });
      expect(await miseAsked(s)).toEqual(['which --version go']);
    }));

  test('a go.mod tool records the go it runs through: the release mise resolved, else the one on PATH', () =>
    withScratch(async (s) => {
      await s.file('go.mod', GO_MOD_WITH_TOOL);
      await goOnPath(s, '1.26.1');
      const at = s.at('.', { ...GO, tools: [DEADCODE] });
      expect(launchOnToolchain('dead', 'pnpm', RUN_DEADCODE, at)).toMatchObject({
        command: 'go',
        pin: { source: 'go-mod-tool', version: 'v0.30.0', toolchain: '1.26.1' },
      });
      await s.file('mise.toml', '[tools]\ngo = "1.27"\n');
      await s.tool('mise', miseKnowing({ go: '1.27.2' }));
      expect(launchOnToolchain('dead', 'pnpm', RUN_DEADCODE, at)).toMatchObject({
        command: 'mise',
        pin: { source: 'go-mod-tool', version: 'v0.30.0', toolchain: '1.27.2' },
      });
      expect(await miseAsked(s)).toEqual(['which --version go']);
    }));

  test('golangci-lint from PATH records the go its PATH finds', () =>
    withScratch(async (s) => {
      await s.tool('golangci-lint');
      await goOnPath(s, '1.26.1');
      expect(launchOnToolchain('lint', 'pnpm', GOLANGCI, s.at('.', GO))).toMatchObject({
        command: 'golangci-lint',
        pin: { source: 'path', toolchain: '1.26.1' },
      });
    }));

  test('golangci-lint through mise records the go mise resolves for it, else the go on PATH', () =>
    withScratch(async (s) => {
      await s.file('mise.toml', '[tools]\ngolangci-lint = "2.14"\ngo = "1.27"\n');
      await s.tool('mise', miseKnowing({ 'golangci-lint': '2.14.0', go: '1.27.2' }));
      await goOnPath(s, '1.26.1');
      expect(launchOnToolchain('lint', 'pnpm', GOLANGCI, s.at('.', GO))).toMatchObject({
        command: 'mise',
        pin: { source: 'mise', version: '2.14.0', toolchain: '1.27.2' },
      });
      expect(await miseAsked(s)).toEqual(['which --version golangci-lint', 'which --version go']);
      await s.file('mise.toml', '[tools]\ngolangci-lint = "2.14"\n');
      await s.tool('mise', miseKnowing({ 'golangci-lint': '2.14.0' }));
      expect(launchOnToolchain('lint', 'pnpm', GOLANGCI, s.at('.', GO))).toMatchObject({
        pin: { source: 'mise', version: '2.14.0', toolchain: '1.26.1' },
      });
    }));

  test('with no go to read a release from, the check records none', () =>
    withScratch(async (s) => {
      await s.tool('golangci-lint');
      const launch = launchOnToolchain('lint', 'pnpm', GOLANGCI, s.at('.', GO));
      expect(launch).toMatchObject({ pin: { source: 'path' } });
      expect(launch).not.toHaveProperty('pin.toolchain');
    }));

  test("a launch that names no toolchain, a pack's with none or fix's, asks mise nothing more and records none", () =>
    withScratch(async (s) => {
      await s.file('mise.toml', '[tools]\ngolangci-lint = "2.14"\ngo = "1.27"\nshellcheck = "0.11"\n');
      await s.tool('mise', miseKnowing({ 'golangci-lint': '2.14.0', go: '1.27.2', shellcheck: '0.11.0' }));
      for (const launch of [
        launchCheck('lint', 'pnpm', GOLANGCI, s.at('.', { pins: GO_CHAIN })),
        launchOnToolchain('lint', 'pnpm', GOLANGCI, s.at('.', { pins: GO_CHAIN })),
        launchOnToolchain('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: MISE_THEN_PATH, toolchain: 'shellcheck' })),
      ]) {
        expect(launch).toMatchObject({ command: 'mise', pin: { source: 'mise' } });
        expect(launch).not.toHaveProperty('pin.toolchain');
      }
      expect(await miseAsked(s)).not.toContain('which --version go');
    }));

  test('a refusal, and a command spawned as written through no pin source, launch as they would', () =>
    withScratch(async (s) => {
      await goOnPath(s, '1.26.1');
      expect(launchOnToolchain('custom', 'make', ['check'], s.at('.', GO))).toEqual({ command: 'make', args: ['check'] });
      expect(refusalOf(launchOnToolchain('lint', 'pnpm', GOLANGCI, s.at('.', GO)))).toContain('which no source in its pin chain provides');
    }));
});

describe('a pin chain: the first source that declares a tool runs it (R6.2)', () => {
  test("js-lockfile declares a tool its nearest package.json depends on, ahead of mise", () =>
    withScratch(async (s) => {
      await s.file('package.json', JSON.stringify({ devDependencies: { '@vvago/vale': '3.24.0' } }));
      await s.file('mise.toml', '[tools]\nvale = "3.24.0"\n');
      await s.tool('mise');
      const launch = launchCheck('prose', 'pnpm', ['exec', 'vale', '.'], s.at('.', { pins: FULL_CHAIN }));
      expect(launch).toMatchObject({ command: 'pnpm', pin: { source: 'js-lockfile' } });
    }));

  test('mise declares a tool a mise.toml names under [tools], and runs it through mise with its installs off', () =>
    withScratch(async (s) => {
      await s.file('package.json', JSON.stringify({ devDependencies: {} }));
      await s.file('mise.toml', '[tools]\nshellcheck = "0.11.0"\n');
      await s.tool('mise');
      await s.tool('shellcheck');
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: FULL_CHAIN }))).toEqual({
        command: 'mise',
        args: ['exec', '--', 'shellcheck', '-f', 'json1', 'run.sh'],
        env: { MISE_EXEC_AUTO_INSTALL: 'false', MISE_NOT_FOUND_AUTO_INSTALL: 'false' },
        pin: { source: 'mise' },
      });
    }));

  test("the repo pack's chain runs a binary a mise.toml pins, or one on PATH, where package.json declares nothing", () =>
    withScratch(async (s) => {
      await s.file('package.json', JSON.stringify({ devDependencies: {} }));
      await s.file('mise.toml', '[tools]\n"aqua:rvben/rumdl" = "0.2.79"\n');
      await s.tool('mise');
      await s.tool('vale');
      const repo = s.at('.', { pins: pinChain('repo') });
      expect(launchCheck('docs', 'pnpm', ['exec', 'rumdl', 'check', '.'], repo)).toMatchObject({
        command: 'mise',
        args: ['exec', '--', 'rumdl', 'check', '.'],
        pin: { source: 'mise' },
      });
      expect(launchCheck('prose', 'pnpm', ['exec', 'vale', '.'], repo)).toMatchObject({ command: 'vale', args: ['.'], pin: { source: 'path' } });
    }));

  test('a check with no pack resolves the same tools through js-lockfile alone, as 0.13 did', () =>
    withScratch(async (s) => {
      await s.file('mise.toml', '[tools]\nvale = "3.24.0"\nrumdl = "0.2.79"\n');
      await s.tool('mise');
      await s.tool('vale');
      const implicit = s.at('.', { pins: pinChain(undefined) });
      expect(launchCheck('prose', 'pnpm', ['exec', 'vale', '.'], implicit)).toMatchObject({ command: 'pnpm', pin: { source: 'js-lockfile' } });
      expect(launchCheck('docs', 'pnpm', ['exec', 'rumdl', 'check', '.'], implicit)).toMatchObject({ command: 'pnpm', pin: { source: 'js-lockfile' } });
    }));

  test('a mise.toml in a parent of the check, inside the repo, declares the tool too', () =>
    withScratch(async (s) => {
      await s.file('.mise.toml', '[tools]\nshellcheck = "0.11.0"\n');
      await mkdir(join(s.repo, 'scripts'), { recursive: true });
      await s.tool('mise');
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('scripts', { pins: MISE_THEN_PATH }))).toMatchObject({ pin: { source: 'mise' } });
    }));

  test('a mise.toml above the repo root declares nothing', () =>
    withScratch(async (s) => {
      await writeFile(join(s.repo, '..', 'mise.toml'), '[tools]\nshellcheck = "0.11.0"\n');
      await s.tool('mise');
      await s.tool('shellcheck');
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: MISE_THEN_PATH }))).toMatchObject({ pin: { source: 'path' } });
    }));

  /** F11: a declared pin whose source can't run the tool fails, and never falls back to PATH. */
  test('a tool mise pins fails, naming mise, when mise is not on PATH, though PATH holds the tool', () =>
    withScratch(async (s) => {
      await s.file('mise.toml', '[tools]\nshellcheck = "0.11.0"\n');
      await s.tool('shellcheck');
      const refusal = refusalOf(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: MISE_THEN_PATH }))) ?? '';
      expect(refusal).toContain("the `lint` slot's `shellcheck` is pinned through mise, but `mise` isn't on PATH");
      expect(refusal).toContain('declared in: mise.toml ([tools] shellcheck)');
      expect(refusal).toContain("won't fall back");
      expect(refusal).toContain('install shellcheck');
    }));

  /**
   * With auto-install off, `mise exec` runs whatever is on PATH when the
   * pinned version isn't installed, so the source asks `mise which` first and
   * refuses when mise says the pinned copy isn't there.
   */
  test("a tool mise pins at a version it hasn't installed fails, naming mise's answer, rather than run a PATH copy", () =>
    withScratch(async (s) => {
      await s.file('mise.toml', '[tools]\nshellcheck = "0.0.1"\n');
      await s.tool('mise', 'echo "mise ERROR shellcheck is a mise bin however it is not currently active." >&2; exit 1');
      await s.tool('shellcheck');
      const refusal = refusalOf(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: MISE_THEN_PATH }))) ?? '';
      expect(refusal).toContain("mise can't run the copy it pins");
      expect(refusal).toContain('mise which --version shellcheck: shellcheck is a mise bin however it is not currently active.');
      expect(refusal).toContain('mise install');
    }));

  /**
   * D82: mise refuses a config with a tool option until it's trusted, and the
   * refusal says so. `mise install` would trust the file as a side effect.
   */
  test("a tool pinned in a config mise hasn't trusted fails, naming mise trust and mise's trust line", () =>
    withScratch(async (s) => {
      await s.file('mise.toml', '[tools]\nshellcheck = { version = "0.11.0" }\n');
      await s.tool('mise', UNTRUSTED_MISE);
      await s.tool('shellcheck');
      const refusal = refusalOf(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: MISE_THEN_PATH }))) ?? '';
      expect(refusal).toContain(`the \`lint\` slot's \`shellcheck\` is pinned through mise, ${UNTRUSTED_CAUSE}`);
      expect(refusal).toContain('declared in: mise.toml ([tools] shellcheck)');
      expect(refusal).toContain('mise which --version shellcheck: Config files in /r/mise.toml are not trusted.');
      expect(refusal).toContain('\n  mise trust\n');
      expect(refusal).not.toContain('error parsing config file');
      expect(refusal).not.toContain('mise install');
    }));

  test('mise is asked about the tool from the check directory, with its installs off', () =>
    withScratch(async (s) => {
      const asked = join(s.repo, 'asked');
      await s.file('mise.toml', '[tools]\nshellcheck = "0.11.0"\n');
      await mkdir(join(s.repo, 'scripts'), { recursive: true });
      await s.tool('mise', `echo "$PWD $* $MISE_EXEC_AUTO_INSTALL $MISE_NOT_FOUND_AUTO_INSTALL" > "${asked}"`);
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('scripts', { pins: MISE_THEN_PATH }))).toMatchObject({ pin: { source: 'mise' } });
      expect((await readFile(asked, 'utf8')).trim()).toBe(`${await realpath(join(s.repo, 'scripts'))} which --version shellcheck false false`);
    }));

  /** F12: a tool nothing declares runs from PATH, recorded as unpinned. */
  test('a tool nothing declares runs from PATH, and records path', () =>
    withScratch(async (s) => {
      await s.tool('shellcheck');
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: MISE_THEN_PATH }))).toEqual({
        command: 'shellcheck',
        args: ['-f', 'json1', 'run.sh'],
        env: { MISE_EXEC_AUTO_INSTALL: 'false', MISE_NOT_FOUND_AUTO_INSTALL: 'false' },
        pin: { source: 'path' },
      });
    }));

  /** F12, under requirePins. */
  test('under requirePins, a tool found only on PATH fails with the mise use hint', () =>
    withScratch(async (s) => {
      await s.tool('shellcheck');
      const refusal = refusalOf(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: MISE_THEN_PATH, requirePins: true }))) ?? '';
      expect(refusal).toContain('shellcheck is not pinned; pin it with: mise use shellcheck@<version>');
      expect(refusal).toContain(`found: ${join(s.bin, 'shellcheck')} (on PATH)`);
    }));

  test('requirePins never touches a tool a source declares', () =>
    withScratch(async (s) => {
      await s.file('mise.toml', '[tools]\nshellcheck = "0.11.0"\n');
      await s.tool('mise');
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: MISE_THEN_PATH, requirePins: true }))).toMatchObject({
        pin: { source: 'mise' },
      });
      expect(launchCheck('lint', 'pnpm', ['exec', 'oxlint'], s.at('.', { requirePins: true }))).toMatchObject({
        pin: { source: 'js-lockfile' },
      });
    }));

  test('a tool nothing declares and PATH lacks fails, naming the chain it walked and how to install it', () =>
    withScratch(async (s) => {
      const refusal = refusalOf(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: FULL_CHAIN }))) ?? '';
      expect(refusal).toContain('the `lint` slot needs `shellcheck`, which no source in its pin chain provides');
      expect(refusal).toContain('looked for: js-lockfile, then mise, then `shellcheck` on PATH');
      expect(refusal).toContain('pin it with `mise use shellcheck@<version>`, or install shellcheck (https://www.shellcheck.net)');
    }));

  test("a source the launcher can't read stops the walk, rather than pass over a pin it can't see", () =>
    withScratch(async (s) => {
      await s.tool('golangci-lint');
      // A chain from a newer checkride could name a source this one lacks.
      const pins = ['nix-flake', 'path'] as unknown as PinSourceName[];
      const launch = launchCheck('lint', 'pnpm', ['exec', 'golangci-lint', 'run'], s.at('.', { pins }));
      expect(refusalOf(launch)).toContain("through the `nix-flake` pin source, which this checkride can't read");
    }));

  test('a custom command spawns as written whatever the chain', () =>
    withScratch(async (s) => {
      expect(launchCheck('lint', 'bash', ['scripts/lint.sh'], s.at('.', { pins: MISE_THEN_PATH, requirePins: true }))).toEqual({
        command: 'bash',
        args: ['scripts/lint.sh'],
      });
    }));
});


/** The go pack's chain (R6.1). */
const GO_CHAIN = ['go-mod-tool', 'mise', 'path'] as const;

/** A Go tool row, swapped in for `TOOLS` until the go pack's adapters bring their own. */
const DEADCODE: Tool = { bin: 'deadcode', goTool: 'golang.org/x/tools/cmd/deadcode', install: 'go get -tool golang.org/x/tools/cmd/deadcode' };

const RUN_DEADCODE = ['exec', 'deadcode', '-test', './...'];

/** A module that declares deadcode as a tool and requires the module that provides it. */
const GO_MOD_WITH_TOOL = [
  'module example.com/api',
  '',
  'go 1.24',
  '',
  'tool golang.org/x/tools/cmd/deadcode',
  '',
  'require golang.org/x/tools v0.30.0 // indirect',
  '',
].join('\n');

describe('the go-mod-tool source (R6.1)', () => {
  test('a tool directive declares the tool, which runs as go tool <bin>, with the version go.mod requires', () =>
    withScratch(async (s) => {
      await s.file('api/go.mod', GO_MOD_WITH_TOOL);
      await s.tool('go');
      await s.tool('deadcode');
      expect(launchCheck('dead', 'pnpm', RUN_DEADCODE, s.at('api', { pins: GO_CHAIN, tools: [DEADCODE] }))).toEqual({
        command: 'go',
        args: ['tool', 'deadcode', '-test', './...'],
        env: { MISE_EXEC_AUTO_INSTALL: 'false', MISE_NOT_FOUND_AUTO_INSTALL: 'false' },
        pin: { source: 'go-mod-tool', version: 'v0.30.0' },
      });
    }));

  test('a tool block declares each tool it lists', () =>
    withScratch(async (s) => {
      await s.file('go.mod', 'module example.com/api\n\ngo 1.24\n\ntool (\n\thonnef.co/go/tools/cmd/staticcheck\n\tgolang.org/x/tools/cmd/deadcode // reachability\n)\n');
      await s.tool('go');
      expect(launchCheck('dead', 'pnpm', RUN_DEADCODE, s.at('.', { pins: GO_CHAIN, tools: [DEADCODE] }))).toMatchObject({
        command: 'go',
        args: ['tool', 'deadcode', '-test', './...'],
        pin: { source: 'go-mod-tool' },
      });
    }));

  test('a go.mod without the directive passes the tool on down the chain', () =>
    withScratch(async (s) => {
      await s.file('go.mod', 'module example.com/api\n\ngo 1.24\n');
      await s.tool('go');
      await s.tool('deadcode');
      expect(launchCheck('dead', 'pnpm', RUN_DEADCODE, s.at('.', { pins: GO_CHAIN, tools: [DEADCODE] }))).toMatchObject({
        command: 'deadcode',
        pin: { source: 'path' },
      });
    }));

  test('a tool TOOLS gives no goTool path is never declared by go.mod', () =>
    withScratch(async (s) => {
      await s.file('go.mod', 'module example.com/api\n\ngo 1.24\n\ntool github.com/golangci/golangci-lint/v2/cmd/golangci-lint\n');
      await s.tool('golangci-lint');
      expect(launchCheck('lint', 'pnpm', ['exec', 'golangci-lint', 'run'], s.at('.', { pins: GO_CHAIN }))).toMatchObject({
        command: 'golangci-lint',
        pin: { source: 'path' },
      });
    }));

  test('the go.mod nearest the check declares, and one above the repo root declares nothing', () =>
    withScratch(async (s) => {
      await s.file('go.mod', GO_MOD_WITH_TOOL);
      await s.file('api/go.mod', 'module example.com/api\n\ngo 1.24\n');
      await writeFile(join(s.repo, '..', 'go.mod'), GO_MOD_WITH_TOOL);
      await s.tool('go');
      await s.tool('deadcode');
      expect(launchCheck('dead', 'pnpm', RUN_DEADCODE, s.at('api', { pins: GO_CHAIN, tools: [DEADCODE] }))).toMatchObject({ pin: { source: 'path' } });
      expect(launchCheck('dead', 'pnpm', RUN_DEADCODE, s.at('.', { pins: GO_CHAIN, tools: [DEADCODE] }))).toMatchObject({ pin: { source: 'go-mod-tool' } });
    }));

  test('at a workspace root with no go.mod, a module the go.work uses declares the tool, as go tool finds it', () =>
    withScratch(async (s) => {
      await s.file('go.work', 'go 1.24\n\nuse (\n\t./cli\n\t./core\n)\n');
      await s.file('cli/go.mod', 'module example.com/t/cli\n\ngo 1.24\n');
      await s.file('core/go.mod', GO_MOD_WITH_TOOL);
      await s.tool('go');
      expect(launchCheck('dead', 'pnpm', RUN_DEADCODE, s.at('.', { pins: GO_CHAIN, tools: [DEADCODE] }))).toMatchObject({
        command: 'go',
        args: ['tool', 'deadcode', '-test', './...'],
        pin: { source: 'go-mod-tool', version: 'v0.30.0' },
      });
    }));

  test('go runs through mise when a mise.toml pins it', () =>
    withScratch(async (s) => {
      await s.file('go.mod', GO_MOD_WITH_TOOL);
      await s.file('mise.toml', '[tools]\ngo = "1.27.2"\n');
      await s.tool('mise');
      expect(launchCheck('dead', 'pnpm', RUN_DEADCODE, s.at('.', { pins: GO_CHAIN, tools: [DEADCODE] }))).toEqual({
        command: 'mise',
        args: ['exec', '--', 'go', 'tool', 'deadcode', '-test', './...'],
        env: { MISE_EXEC_AUTO_INSTALL: 'false', MISE_NOT_FOUND_AUTO_INSTALL: 'false' },
        pin: { source: 'go-mod-tool', version: 'v0.30.0' },
      });
    }));

  test('a go mise pins but mise is missing fails, and never falls back to a go on PATH', () =>
    withScratch(async (s) => {
      await s.file('go.mod', GO_MOD_WITH_TOOL);
      await s.file('mise.toml', '[tools]\ngo = "1.27.2"\n');
      await s.tool('go');
      const refusal = refusalOf(launchCheck('dead', 'pnpm', RUN_DEADCODE, s.at('.', { pins: GO_CHAIN, tools: [DEADCODE] }))) ?? '';
      expect(refusal).toContain("the `dead` slot's `go` is pinned through mise, but `mise` isn't on PATH");
      expect(refusal).toContain('declared in: mise.toml ([tools] go)');
    }));

  test('a go mise pins at a version it has not installed fails, naming mise', () =>
    withScratch(async (s) => {
      await s.file('go.mod', GO_MOD_WITH_TOOL);
      await s.file('mise.toml', '[tools]\ngo = "1.99.0"\n');
      await s.tool('mise', 'echo "mise ERROR go@1.99.0 is not installed" >&2; exit 1');
      const refusal = refusalOf(launchCheck('dead', 'pnpm', RUN_DEADCODE, s.at('.', { pins: GO_CHAIN, tools: [DEADCODE] }))) ?? '';
      expect(refusal).toContain("mise can't run the copy it pins");
      expect(refusal).toContain('mise which --version go: go@1.99.0 is not installed');
    }));

  test("a go pinned in a config mise hasn't trusted fails, naming mise trust rather than an install", () =>
    withScratch(async (s) => {
      await s.file('go.mod', GO_MOD_WITH_TOOL);
      await s.file('mise.toml', '[tools]\ngo = { version = "1.27.2" }\n');
      await s.tool('mise', UNTRUSTED_MISE);
      const refusal = refusalOf(launchCheck('dead', 'pnpm', RUN_DEADCODE, s.at('.', { pins: GO_CHAIN, tools: [DEADCODE] }))) ?? '';
      expect(refusal).toContain(`the \`dead\` slot's \`go\` is pinned through mise, ${UNTRUSTED_CAUSE}`);
      expect(refusal).toContain('mise which --version go: Config files in /r/mise.toml are not trusted.');
      expect(refusal).toContain('\n  mise trust\n');
      expect(refusal).not.toContain('mise install');
    }));

  test('a declared tool fails, naming how to install Go, when go is not on PATH', () =>
    withScratch(async (s) => {
      await s.file('go.mod', GO_MOD_WITH_TOOL);
      await s.tool('deadcode');
      const refusal = refusalOf(launchCheck('dead', 'pnpm', RUN_DEADCODE, s.at('.', { pins: GO_CHAIN, tools: [DEADCODE] }))) ?? '';
      expect(refusal).toContain('the `dead` slot needs `go` to run `deadcode`, which isn\'t on PATH');
      expect(refusal).toContain('install Go 1.24 or later');
    }));

  test('under requirePins, a declared tool runs, and so does a go from PATH', () =>
    withScratch(async (s) => {
      await s.file('go.mod', GO_MOD_WITH_TOOL);
      await s.tool('go');
      expect(launchCheck('dead', 'pnpm', RUN_DEADCODE, s.at('.', { pins: GO_CHAIN, tools: [DEADCODE], requirePins: true }))).toMatchObject({
        command: 'go',
        pin: { source: 'go-mod-tool' },
      });
    }));
});

describe("a pack's variables join every spawn its checks launch (R6.4)", () => {
  const GO_VARS = { GOTOOLCHAIN: 'local', GOPROXY: 'off' };

  test('a tool resolved through the chain carries them beneath its source\'s own', () =>
    withScratch(async (s) => {
      await s.tool('shellcheck');
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: MISE_THEN_PATH, packEnv: GO_VARS }))).toMatchObject({
        env: { GOTOOLCHAIN: 'local', GOPROXY: 'off', MISE_EXEC_AUTO_INSTALL: 'false', MISE_NOT_FOUND_AUTO_INSTALL: 'false' },
      });
    }));

  test('a command spawned as written carries them, as a target\'s custom check does', () =>
    withScratch(async (s) => {
      expect(launchCheck('types', 'make', ['check'], s.at('.', { pins: GO_CHAIN, packEnv: GO_VARS }))).toEqual({
        command: 'make',
        args: ['check'],
        env: GO_VARS,
      });
    }));

  test('a check of a pack that sets none spawns exactly as before', () =>
    withScratch(async (s) => {
      expect(launchCheck('lint', 'bash', ['scripts/lint.sh'], s.at('.', { packEnv: {} }))).toEqual({ command: 'bash', args: ['scripts/lint.sh'] });
    }));

  test('a refusal stays a refusal', () =>
    withScratch(async (s) => {
      expect(refusalOf(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: MISE_THEN_PATH, packEnv: GO_VARS })))).not.toBeNull();
    }));
});

describe("a toolchain's own executables resolve through its pin (R6.2)", () => {
  test('go runs from PATH, recorded as unpinned, when nothing pins it', () =>
    withScratch(async (s) => {
      await s.tool('go');
      expect(launchCheck('types', 'go', ['build', '-json', './...'], s.at('.', { pins: GO_CHAIN }))).toEqual({
        command: 'go',
        args: ['build', '-json', './...'],
        env: { MISE_EXEC_AUTO_INSTALL: 'false', MISE_NOT_FOUND_AUTO_INSTALL: 'false' },
        pin: { source: 'path' },
      });
    }));

  test('gofmt runs through mise when a mise.toml pins go', () =>
    withScratch(async (s) => {
      await s.file('mise.toml', '[tools]\ngo = "1.27.2"\n');
      await s.tool('mise');
      expect(launchCheck('format', 'gofmt', ['-l', '.'], s.at('.', { pins: GO_CHAIN }))).toMatchObject({
        command: 'mise',
        args: ['exec', '--', 'gofmt', '-l', '.'],
        pin: { source: 'mise' },
      });
    }));

  test('a missing toolchain fails naming how to install it', () =>
    withScratch(async (s) => {
      const refusal = refusalOf(launchCheck('types', 'go', ['build', './...'], s.at('.', { pins: GO_CHAIN }))) ?? '';
      expect(refusal).toContain('the `types` slot needs `go`, which no source in its pin chain provides');
      expect(refusal).toContain('install Go 1.24 or later');
    }));

  test('a toolchain on PATH runs even under requirePins', () =>
    withScratch(async (s) => {
      await s.tool('go');
      expect(launchCheck('types', 'go', ['build', './...'], s.at('.', { pins: GO_CHAIN, requirePins: true }))).toMatchObject({ pin: { source: 'path' } });
    }));

  test('a chain that reads no mise spawns the command as written, as every check in implicit mode does', () =>
    withScratch(async (s) => {
      expect(launchCheck('custom', 'go', ['vet', './...'], s.at('.'))).toEqual({ command: 'go', args: ['vet', './...'] });
    }));
});

/** The rust pack's chain (R6.1). */
const RUST_CHAIN = ['rust-toolchain', 'mise', 'path'] as const;

/** clippy as the rust pack's tool row describes it, swapped in for `TOOLS`. */
const CLIPPY: Tool = { bin: 'cargo-clippy', run: ['cargo', 'clippy'], component: 'clippy', mise: ['rust'], install: 'rustup component add clippy' };

/** A plugin that isn't a toolchain component. */
const MACHETE: Tool = { bin: 'cargo-machete', run: ['cargo', 'machete'], install: 'cargo install cargo-machete' };

const RUN_CLIPPY = ['exec', 'cargo-clippy', '--workspace', '--', '-D', 'warnings'];

describe('the rust-toolchain source (R6.1)', () => {
  test('a toolchain file declares clippy, which runs as cargo clippy, recording an exact channel', () =>
    withScratch(async (s) => {
      await s.file('rust-toolchain.toml', '[toolchain]\nchannel = "1.85.0"\n');
      await s.tool('cargo');
      await s.tool('rustup');
      expect(launchCheck('lint', 'pnpm', RUN_CLIPPY, s.at('.', { pins: RUST_CHAIN, tools: [CLIPPY] }))).toEqual({
        command: 'cargo',
        args: ['clippy', '--workspace', '--', '-D', 'warnings'],
        // An outer shell's RUSTUP_TOOLCHAIN can't override the file's.
        env: { RUSTUP_TOOLCHAIN: '', MISE_EXEC_AUTO_INSTALL: 'false', MISE_NOT_FOUND_AUTO_INSTALL: 'false' },
        pin: { source: 'rust-toolchain', version: '1.85.0' },
      });
    }));

  test('a legacy rust-toolchain file above the check declares it too, and a channel name records no version', () =>
    withScratch(async (s) => {
      await s.file('rust-toolchain', 'stable\n');
      await s.tool('cargo');
      await s.tool('rustup');
      expect(launchCheck('lint', 'pnpm', RUN_CLIPPY, s.at('crates/core', { pins: RUST_CHAIN, tools: [CLIPPY] }))).toMatchObject({
        command: 'cargo',
        pin: { source: 'rust-toolchain' },
      });
      const launch = launchCheck('lint', 'pnpm', RUN_CLIPPY, s.at('crates/core', { pins: RUST_CHAIN, tools: [CLIPPY] }));
      expect('pin' in launch ? launch.pin : undefined).not.toHaveProperty('version');
    }));

  test('without a toolchain file, a mise pin runs the component through mise', () =>
    withScratch(async (s) => {
      await s.file('mise.toml', '[tools]\nrust = "1.99.0"\n');
      await s.tool('mise');
      expect(launchCheck('lint', 'pnpm', RUN_CLIPPY, s.at('.', { pins: RUST_CHAIN, tools: [CLIPPY] }))).toMatchObject({
        command: 'mise',
        args: ['exec', '--', 'cargo', 'clippy', '--workspace', '--', '-D', 'warnings'],
        pin: { source: 'mise' },
      });
    }));

  test('with neither, the component runs from PATH, found by its own executable', () =>
    withScratch(async (s) => {
      await s.tool('cargo-clippy');
      expect(launchCheck('lint', 'pnpm', RUN_CLIPPY, s.at('.', { pins: RUST_CHAIN, tools: [CLIPPY] }))).toMatchObject({
        command: 'cargo',
        args: ['clippy', '--workspace', '--', '-D', 'warnings'],
        pin: { source: 'path' },
      });
    }));

  test('a declared component fails, naming the file, when rustup is not on PATH, and never runs a cargo that ignores the pin', () =>
    withScratch(async (s) => {
      await s.file('rust-toolchain.toml', '[toolchain]\nchannel = "1.85.0"\n');
      await s.tool('cargo');
      const refusal = refusalOf(launchCheck('lint', 'pnpm', RUN_CLIPPY, s.at('.', { pins: RUST_CHAIN, tools: [CLIPPY] }))) ?? '';
      expect(refusal).toContain("the `lint` slot's `cargo-clippy` is pinned by a toolchain file, but `rustup` isn't on PATH");
      expect(refusal).toContain('declared in: rust-toolchain.toml (channel 1.85.0)');
    }));

  test('a declared component fails naming how to install Rust when cargo is not on PATH', () =>
    withScratch(async (s) => {
      await s.file('rust-toolchain.toml', '[toolchain]\nchannel = "1.85.0"\n');
      await s.tool('rustup');
      const refusal = refusalOf(launchCheck('lint', 'pnpm', RUN_CLIPPY, s.at('.', { pins: RUST_CHAIN, tools: [CLIPPY] }))) ?? '';
      expect(refusal).toContain("the `lint` slot needs `cargo` to run `cargo-clippy`, which isn't on PATH");
      expect(refusal).toContain('install Rust with rustup');
    }));

  test('a toolchain file never declares a tool that is not a toolchain component', () =>
    withScratch(async (s) => {
      await s.file('rust-toolchain.toml', '[toolchain]\nchannel = "1.85.0"\n');
      await s.tool('cargo-machete');
      await s.tool('rustup');
      expect(launchCheck('dead', 'pnpm', ['exec', 'cargo-machete'], s.at('.', { pins: RUST_CHAIN, tools: [MACHETE] }))).toEqual({
        command: 'cargo',
        args: ['machete'],
        env: { RUSTUP_TOOLCHAIN: '', MISE_EXEC_AUTO_INSTALL: 'false', MISE_NOT_FOUND_AUTO_INSTALL: 'false' },
        pin: { source: 'path' },
      });
    }));

  test('a cargo plugin under a toolchain file refuses without rustup, since its cargo would ignore the file', () =>
    withScratch(async (s) => {
      await s.file('rust-toolchain.toml', '[toolchain]\nchannel = "1.85.0"\n');
      await s.tool('cargo-machete');
      await s.tool('cargo');
      const refusal = refusalOf(launchCheck('dead', 'pnpm', ['exec', 'cargo-machete'], s.at('.', { pins: RUST_CHAIN, tools: [MACHETE] }))) ?? '';
      expect(refusal).toContain("the `dead` slot's `cargo machete` builds with the toolchain `rust-toolchain.toml` pins, but `rustup` isn't on PATH to honor it");
      expect(refusal).toContain('declared in: rust-toolchain.toml (channel 1.85.0)');
      // With no toolchain file, it runs as it always has.
      await rm(join(s.repo, 'rust-toolchain.toml'));
      expect(launchCheck('dead', 'pnpm', ['exec', 'cargo-machete'], s.at('.', { pins: RUST_CHAIN, tools: [MACHETE] }))).toMatchObject({ pin: { source: 'path' } });
    }));

  test('a declared component needs the cargo beside rustup, its proxy, and fails naming it when another cargo is all there is', () =>
    withScratch(async (s) => {
      await s.file('rust-toolchain.toml', '[toolchain]\nchannel = "1.85.0"\n');
      await s.tool('rustup');
      const other = join(s.bin, '..', 'other');
      await mkdir(other);
      await writeFile(join(other, 'cargo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const at = { ...s.at('.', { pins: RUST_CHAIN, tools: [CLIPPY] }), env: { PATH: `${s.bin}${delimiter}${other}` } };
      const refusal = refusalOf(launchCheck('lint', 'pnpm', RUN_CLIPPY, at)) ?? '';
      expect(refusal).toContain(`the \`lint\` slot's \`cargo-clippy\` is pinned by a toolchain file, but no \`cargo\` sits beside \`rustup\` in ${s.bin} to read it`);
    }));

  test('passes over a rustup with no cargo beside it for the proxy later on PATH, as on a GitHub macOS runner', () =>
    withScratch(async (s) => {
      await s.file('rust-toolchain.toml', '[toolchain]\nchannel = "1.85.0"\n');
      // Homebrew's lone rustup first, then the ~/.cargo/bin rustup-init fills.
      await s.tool('rustup');
      const proxy = join(s.bin, '..', 'cargo-home');
      await mkdir(proxy);
      for (const bin of ['rustup', 'cargo']) await writeFile(join(proxy, bin), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const at = { ...s.at('.', { pins: RUST_CHAIN, tools: [CLIPPY] }), env: { PATH: `${s.bin}${delimiter}${proxy}` } };
      expect(launchCheck('lint', 'pnpm', RUN_CLIPPY, at)).toEqual({
        command: 'cargo',
        args: ['clippy', '--workspace', '--', '-D', 'warnings'],
        env: { RUSTUP_TOOLCHAIN: '', MISE_EXEC_AUTO_INSTALL: 'false', MISE_NOT_FOUND_AUTO_INSTALL: 'false' },
        pin: { source: 'rust-toolchain', version: '1.85.0' },
      });
      // Another cargo between them still puts the proxy's directory first.
      const other = join(s.bin, '..', 'other');
      await mkdir(other);
      await writeFile(join(other, 'cargo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const path = [s.bin, other, proxy].join(delimiter);
      expect(launchCheck('lint', 'pnpm', RUN_CLIPPY, { ...at, env: { PATH: path } })).toMatchObject({
        command: 'cargo',
        env: { PATH: `${proxy}${delimiter}${path}` },
        pin: { source: 'rust-toolchain' },
      });
    }));

  test('a toolchain file pins cargo itself, a rustup component like clippy', () =>
    withScratch(async (s) => {
      await s.file('rust-toolchain.toml', '[toolchain]\nchannel = "1.85.0"\n');
      await s.tool('cargo');
      await s.tool('rustup');
      expect(launchCheck('types', 'cargo', ['check'], s.at('.', { pins: RUST_CHAIN }))).toMatchObject({
        command: 'cargo',
        args: ['check'],
        pin: { source: 'rust-toolchain', version: '1.85.0' },
      });
    }));

  test('cargo itself resolves as a toolchain: through mise when a mise.toml pins rust, else from PATH', () =>
    withScratch(async (s) => {
      await s.tool('cargo');
      expect(launchCheck('types', 'cargo', ['check'], s.at('.', { pins: RUST_CHAIN }))).toMatchObject({ command: 'cargo', pin: { source: 'path' } });
      await s.file('mise.toml', '[tools]\nrust = "1.99.0"\n');
      await s.tool('mise');
      expect(launchCheck('types', 'cargo', ['check'], s.at('.', { pins: RUST_CHAIN }))).toMatchObject({
        command: 'mise',
        args: ['exec', '--', 'cargo', 'check'],
        pin: { source: 'mise' },
      });
    }));
});

describe('a toolchain file picks the toolchain over one the shell exported', () => {
  test('clears RUSTUP_TOOLCHAIN on every spawn of a chain that reads rust-toolchain, where a file pins it', () =>
    withScratch(async (s) => {
      await s.file('rust-toolchain.toml', '[toolchain]\nchannel = "1.85.0"\n');
      await s.tool('cargo');
      await s.tool('rustup');
      expect(launchCheck('types', 'cargo', ['check'], s.at('.', { pins: RUST_CHAIN }))).toMatchObject({ env: { RUSTUP_TOOLCHAIN: '' } });
      expect(launchCheck('custom', 'make', ['check'], s.at('.', { pins: RUST_CHAIN }))).toEqual({ command: 'make', args: ['check'], env: { RUSTUP_TOOLCHAIN: '' } });
    }));

  test("puts rustup's directory first on PATH where another cargo comes before its proxy, for a tool and a custom check alike", () =>
    withScratch(async (s) => {
      await s.file('rust-toolchain.toml', '[toolchain]\nchannel = "1.85.0"\n');
      const rustup = join(s.bin, '..', 'rustup-home');
      await mkdir(rustup);
      for (const bin of ['rustup', 'cargo']) await writeFile(join(rustup, bin), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await s.tool('cargo');
      const path = `${s.bin}${delimiter}${rustup}`;
      const at = { ...s.at('.', { pins: RUST_CHAIN }), env: { PATH: path } };
      const first = `${rustup}${delimiter}${path}`;
      expect(launchCheck('types', 'cargo', ['check'], at)).toMatchObject({
        command: 'cargo', args: ['check'], env: { RUSTUP_TOOLCHAIN: '', PATH: first }, pin: { source: 'rust-toolchain', version: '1.85.0' },
      });
      expect(launchCheck('custom', 'make', ['check'], at)).toEqual({ command: 'make', args: ['check'], env: { RUSTUP_TOOLCHAIN: '', PATH: first } });
      // With rustup's proxy first already, PATH is left as it is.
      const own = { ...at, env: { PATH: `${rustup}${delimiter}${s.bin}` } };
      expect(launchCheck('custom', 'make', ['check'], own)).toEqual({ command: 'make', args: ['check'], env: { RUSTUP_TOOLCHAIN: '' } });
    }));

  test("leaves it alone with no file, and in a chain that doesn't read rust-toolchain", () =>
    withScratch(async (s) => {
      await s.tool('cargo');
      expect(launchCheck('types', 'cargo', ['check'], s.at('.', { pins: RUST_CHAIN }))).not.toHaveProperty('env.RUSTUP_TOOLCHAIN');
      await s.file('rust-toolchain.toml', '[toolchain]\nchannel = "1.85.0"\n');
      expect(launchCheck('custom', 'make', ['check'], s.at('.', { pins: GO_CHAIN }))).toEqual({ command: 'make', args: ['check'] });
    }));
});

/**
 * A fake mise whose `where` knows two installed copies, `shellcheck@0.11.0`
 * and `go@1.27`, and prints the directory each is installed in, named for the
 * release a prefix resolved to, as mise 2026.10.4 does, and fails any other
 * the way mise does.
 */
const FAKE_MISE = [
  'if [ "$1" = where ]; then',
  '  case "$2" in',
  '    shellcheck@0.11.0) echo "/home/dev/.local/share/mise/installs/${2%@*}/${2#*@}"; exit 0 ;;',
  '    go@1.27) echo "/home/dev/.local/share/mise/installs/go/1.27.2"; exit 0 ;;',
  '  esac',
  '  echo "mise WARN  mise version 2026.10.12 available" >&2',
  '  echo "mise ERROR $2 not installed" >&2',
  '  exit 1',
  'fi',
].join('\n');

/** The override chain a bash target runs under `--pins`. */
const OVERRIDE_CHAIN = ['override', 'mise', 'path'] as const;

/** The python pack's chain (R6.1). */
const PYTHON_CHAIN = ['uv-lock', 'mise', 'path'] as const;

/** ruff as the python pack's tool row will describe it, swapped in for `TOOLS` until its adapters bring their own. */
const RUFF: Tool = { bin: 'ruff', pypi: 'ruff', mise: ['ruff'], install: 'add ruff to a dependency group with `uv add --dev ruff`' };

const RUN_RUFF = ['exec', 'ruff', 'check', '--output-format=json', '.'];

/**
 * A `uv.lock` as uv 0.13.1 writes one for a workspace whose root project
 * keeps ruff and pytest in its `dev` group, trimmed to the tables the source
 * reads and the ones around them: the root project's own sub-tables name
 * ruff too, in arrays, and must not count as a second listing.
 */
const UV_LOCK_WITH_RUFF = [
  'version = 1',
  'revision = 5',
  'requires-python = ">=3.12"',
  '',
  '[manifest]',
  'members = [',
  '    "a",',
  '    "demo-proj",',
  ']',
  '',
  '[[package]]',
  'name = "demo-proj"',
  'version = "0.1.0"',
  'source = { virtual = "." }',
  '',
  '[package.dev-dependencies]',
  'dev = [',
  '    { name = "pytest" },',
  '    { name = "ruff" },',
  ']',
  '',
  '[package.metadata.requires-dev]',
  'dev = [',
  '    { name = "pytest" },',
  '    { name = "ruff", specifier = "==0.14.0" },',
  ']',
  '',
  '[[package]]',
  'name = "ruff"',
  'version = "0.14.0"',
  'source = { registry = "https://pypi.org/simple" }',
  'sdist = { url = "https://files.pythonhosted.org/packages/ruff-0.14.0.tar.gz", hash = "sha256:0", size = 1 }',
  'wheels = [',
  '    { url = "https://files.pythonhosted.org/packages/ruff-0.14.0-py3-none-macosx_11_0_arm64.whl", hash = "sha256:0", size = 1 },',
  ']',
  '',
].join('\n');

/** A project environment's executable named `name`, under `venv` in the scratch repo. */
async function venvTool(s: Scratch, name: string, venv = '.venv'): Promise<void> {
  await s.file(`${venv}/bin/${name}`, '#!/bin/sh\nexit 0\n');
  await chmod(join(s.repo, venv, 'bin', name), 0o755);
}

describe('the uv-lock source (R6.1)', () => {
  test('a tool uv.lock lists runs from the .venv beside it, recording the version it locks', () =>
    withScratch(async (s) => {
      await s.file('uv.lock', UV_LOCK_WITH_RUFF);
      await venvTool(s, 'ruff');
      expect(launchCheck('lint', 'pnpm', RUN_RUFF, s.at('.', { pins: PYTHON_CHAIN, tools: [RUFF] }))).toEqual({
        command: '.venv/bin/ruff',
        args: ['check', '--output-format=json', '.'],
        pin: { source: 'uv-lock', version: '0.14.0' },
      });
    }));

  test("a workspace member runs the root's environment, where uv syncs it, named from the member's directory", () =>
    withScratch(async (s) => {
      await s.file('uv.lock', UV_LOCK_WITH_RUFF);
      await s.file('packages/a/pyproject.toml', '[project]\nname = "a"\n');
      await venvTool(s, 'ruff');
      expect(launchCheck('lint', 'pnpm', RUN_RUFF, s.at('packages/a', { pins: PYTHON_CHAIN, tools: [RUFF] }))).toMatchObject({
        command: '../../.venv/bin/ruff',
        pin: { source: 'uv-lock' },
      });
    }));

  test('UV_PROJECT_ENVIRONMENT moves the environment, a relative one named from the lock, as uv names it', () =>
    withScratch(async (s) => {
      await s.file('py/uv.lock', UV_LOCK_WITH_RUFF);
      await venvTool(s, 'ruff', 'py/envs/dev');
      const env = { PATH: s.bin, UV_PROJECT_ENVIRONMENT: 'envs/dev' };
      expect(launchCheck('lint', 'pnpm', RUN_RUFF, s.at('py', { pins: PYTHON_CHAIN, tools: [RUFF], env }))).toMatchObject({
        command: 'envs/dev/bin/ruff',
        pin: { source: 'uv-lock' },
      });
    }));

  test('an environment outside the repo is named absolutely', () =>
    withScratch(async (s) => {
      const outside = join(s.repo, '..', 'venv');
      await s.file('uv.lock', UV_LOCK_WITH_RUFF);
      await mkdir(join(outside, 'bin'), { recursive: true });
      await writeFile(join(outside, 'bin', 'ruff'), '#!/bin/sh\nexit 0\n');
      const env = { PATH: s.bin, UV_PROJECT_ENVIRONMENT: outside };
      expect(launchCheck('lint', 'pnpm', RUN_RUFF, s.at('.', { pins: PYTHON_CHAIN, tools: [RUFF], env }))).toMatchObject({
        command: join(outside, 'bin', 'ruff'),
      });
    }));

  test("a missing environment fails naming uv sync, and never falls back to a ruff on PATH (F41)", () =>
    withScratch(async (s) => {
      await s.file('uv.lock', UV_LOCK_WITH_RUFF);
      await s.tool('ruff');
      const refusal = refusalOf(launchCheck('lint', 'pnpm', RUN_RUFF, s.at('.', { pins: PYTHON_CHAIN, tools: [RUFF] }))) ?? '';
      expect(refusal).toContain("the `lint` slot's `ruff` is locked in uv.lock, but the project environment it runs from doesn't exist yet");
      expect(refusal).toContain('declared in: uv.lock (ruff 0.14.0)');
      expect(refusal).toContain('looked for: .venv/bin/ruff');
      expect(refusal).toContain('\n  uv sync\n');
      expect(refusal).not.toContain('--all-groups');
    }));

  test('an environment without the tool fails naming uv sync, and says why a sync can leave a tool out', () =>
    withScratch(async (s) => {
      await s.file('py/uv.lock', UV_LOCK_WITH_RUFF);
      await venvTool(s, 'python', 'py/.venv');
      const refusal = refusalOf(launchCheck('lint', 'pnpm', RUN_RUFF, s.at('py', { pins: PYTHON_CHAIN, tools: [RUFF] }))) ?? '';
      expect(refusal).toContain("the `lint` slot's `ruff` is locked in py/uv.lock, but the project environment it runs from has no `ruff`");
      expect(refusal).toContain('looked for: py/.venv/bin/ruff');
      expect(refusal).toContain('\n  uv sync --directory py\n');
      expect(refusal).toContain('`--group <name>`, `--all-groups` or\n`--all-packages`');
    }));

  test('a lock that does not list the tool passes it on down the chain', () =>
    withScratch(async (s) => {
      await s.file('uv.lock', UV_LOCK_WITH_RUFF.replaceAll('ruff', 'black'));
      await s.tool('ruff');
      expect(launchCheck('lint', 'pnpm', RUN_RUFF, s.at('.', { pins: PYTHON_CHAIN, tools: [RUFF] }))).toMatchObject({
        command: 'ruff',
        pin: { source: 'path' },
      });
    }));

  test('a tool TOOLS gives no PyPI package is never declared by the lock', () =>
    withScratch(async (s) => {
      await s.file('uv.lock', UV_LOCK_WITH_RUFF);
      await venvTool(s, 'ruff');
      await s.tool('ruff');
      expect(launchCheck('lint', 'pnpm', RUN_RUFF, s.at('.', { pins: PYTHON_CHAIN, tools: [{ bin: 'ruff', install: 'pip install ruff' }] }))).toMatchObject({
        command: 'ruff',
        pin: { source: 'path' },
      });
    }));

  test('the uv.lock nearest the check declares, and one above the repo root declares nothing', () =>
    withScratch(async (s) => {
      await s.file('uv.lock', UV_LOCK_WITH_RUFF);
      await s.file('py/uv.lock', UV_LOCK_WITH_RUFF.replaceAll('ruff', 'black'));
      await writeFile(join(s.repo, '..', 'uv.lock'), UV_LOCK_WITH_RUFF);
      await s.tool('ruff');
      expect(launchCheck('lint', 'pnpm', RUN_RUFF, s.at('py', { pins: PYTHON_CHAIN, tools: [RUFF] }))).toMatchObject({ pin: { source: 'path' } });
      await rm(join(s.repo, 'uv.lock'));
      await rm(join(s.repo, 'py', 'uv.lock'));
      expect(launchCheck('lint', 'pnpm', RUN_RUFF, s.at('.', { pins: PYTHON_CHAIN, tools: [RUFF] }))).toMatchObject({ pin: { source: 'path' } });
    }));

  test('under requirePins, a locked tool runs, since the lock pins it', () =>
    withScratch(async (s) => {
      await s.file('uv.lock', UV_LOCK_WITH_RUFF);
      await venvTool(s, 'ruff');
      expect(launchCheck('lint', 'pnpm', RUN_RUFF, s.at('.', { pins: PYTHON_CHAIN, tools: [RUFF], requirePins: true }))).toMatchObject({
        pin: { source: 'uv-lock' },
      });
    }));

  test("the python pack's variables join the spawn", () =>
    withScratch(async (s) => {
      await s.file('uv.lock', UV_LOCK_WITH_RUFF);
      await venvTool(s, 'ruff');
      const packEnv = PACKS.python.env;
      expect(launchCheck('lint', 'pnpm', RUN_RUFF, s.at('.', { pins: PYTHON_CHAIN, tools: [RUFF], packEnv }))).toMatchObject({
        env: { PYTHONDONTWRITEBYTECODE: '1', PIP_NO_INDEX: '1', UV_OFFLINE: '1' },
      });
    }));
});

/** The terraform pack's chain (R6.1). */
const TF_CHAIN = ['tf-version', 'mise', 'path'] as const;

/** A fake CLI whose `version -json` reports `version`, as terraform 1.9.8 and tofu 1.13.1 both do. */
const reports = (version: string): string => `[ "$1" = version ] && echo '{"terraform_version": "${version}", "platform": "darwin_arm64"}'`;

/** The variables a CLI from PATH carries, since it may be one of mise's shims. */
const MISE_OFF = { MISE_EXEC_AUTO_INSTALL: 'false', MISE_NOT_FOUND_AUTO_INSTALL: 'false' };

describe('the tf-version source (R6.1)', () => {
  test('a .terraform-version naming an exact release runs the terraform on PATH once it reports that release, and records it', () =>
    withScratch(async (s) => {
      await s.file('.terraform-version', '1.5.7\n');
      await s.file('infra/main.tf', '');
      await s.tool('terraform', reports('1.5.7'));
      expect(launchCheck('types', 'terraform', ['validate', '-json'], s.at('infra', { pins: TF_CHAIN }))).toEqual({
        command: 'terraform',
        args: ['validate', '-json'],
        env: MISE_OFF,
        pin: { source: 'tf-version', version: '1.5.7' },
      });
    }));

  test('a mismatch fails naming the release the file asks for, the one found, and how to install it', () =>
    withScratch(async (s) => {
      await s.file('.terraform-version', 'v1.5.7\n');
      await s.tool('terraform', reports('1.9.8'));
      const refusal = refusalOf(launchCheck('types', 'terraform', ['validate'], s.at('.', { pins: TF_CHAIN }))) ?? '';
      expect(refusal).toContain("the `types` slot's `terraform` is pinned by .terraform-version to 1.5.7, but the `terraform` on PATH is 1.9.8");
      expect(refusal).toContain('declared in: .terraform-version (1.5.7)');
      expect(refusal).toContain(`found: ${join(s.bin, 'terraform')} (1.9.8)`);
      expect(refusal).toContain('tfenv install 1.5.7');
    }));

  test('a CLI that cannot say its version fails, naming why, rather than run unchecked', () =>
    withScratch(async (s) => {
      await s.file('.terraform-version', '1.5.7\n');
      await s.tool('terraform', "echo \"No installed versions of terraform matched '1.5.7'\" >&2; exit 1");
      const refusal = refusalOf(launchCheck('types', 'terraform', ['validate'], s.at('.', { pins: TF_CHAIN }))) ?? '';
      expect(refusal).toContain("but the `terraform` on PATH didn't say which version it is");
      expect(refusal).toContain("terraform version -json: No installed versions of terraform matched '1.5.7'");
      await s.tool('terraform', 'echo Terraform v1.5.7');
      expect(refusalOf(launchCheck('types', 'terraform', ['validate'], s.at('.', { pins: TF_CHAIN })))).toContain('version -json printed no terraform_version');
    }));

  test('a constraint rather than a release is left to the version manager, checked by nothing and recorded as no version', () =>
    withScratch(async (s) => {
      await s.file('.terraform-version', 'latest:^1.5\n');
      // A probe would fail, so it must not run.
      await s.tool('terraform', '[ "$1" = version ] && exit 1; exit 0');
      expect(launchCheck('types', 'terraform', ['validate'], s.at('.', { pins: TF_CHAIN }))).toEqual({
        command: 'terraform',
        args: ['validate'],
        env: MISE_OFF,
        pin: { source: 'tf-version' },
      });
    }));

  test('an .opentofu-version makes terraform run as tofu, checked against what tofu reports', () =>
    withScratch(async (s) => {
      await s.file('.opentofu-version', '1.13.1\n');
      await s.file('modules/net/main.tf', '');
      await s.tool('tofu', reports('1.13.1'));
      expect(launchCheck('types', 'terraform', ['validate'], s.at('modules/net', { pins: TF_CHAIN }))).toMatchObject({
        command: 'tofu',
        args: ['validate'],
        pin: { source: 'tf-version', version: '1.13.1' },
      });
      const refusal = refusalOf(launchCheck('types', 'terraform', ['validate'], s.at('.', { pins: TF_CHAIN })));
      expect(refusal).toBeNull();
      await s.tool('tofu', reports('1.12.0'));
      expect(refusalOf(launchCheck('types', 'terraform', ['validate'], s.at('.', { pins: TF_CHAIN })))).toContain('tofuenv install 1.13.1');
    }));

  test('the version file nearest the check wins, and one directory reads .opentofu-version first', () =>
    withScratch(async (s) => {
      await s.file('.opentofu-version', '1.13.1\n');
      await s.file('legacy/.terraform-version', '1.5.7\n');
      await s.tool('terraform', reports('1.5.7'));
      await s.tool('tofu', reports('1.13.1'));
      expect(launchCheck('types', 'terraform', ['validate'], s.at('legacy', { pins: TF_CHAIN }))).toMatchObject({ command: 'terraform', pin: { version: '1.5.7' } });
      await s.file('legacy/.opentofu-version', '1.13.1\n');
      expect(launchCheck('types', 'terraform', ['validate'], s.at('legacy', { pins: TF_CHAIN }))).toMatchObject({ command: 'tofu' });
    }));

  test('a declared CLI that PATH lacks fails naming how to install it', () =>
    withScratch(async (s) => {
      await s.file('.opentofu-version', '1.13.1\n');
      const refusal = refusalOf(launchCheck('types', 'terraform', ['validate'], s.at('.', { pins: TF_CHAIN }))) ?? '';
      expect(refusal).toContain('the `types` slot needs `tofu`, which isn\'t on PATH');
      expect(refusal).toContain('install OpenTofu 1.6 or later');
    }));

  test('without a version file, a mise.toml that pins OpenTofu runs tofu through mise, and nothing at all runs terraform from PATH', () =>
    withScratch(async (s) => {
      await s.tool('terraform');
      expect(launchCheck('types', 'terraform', ['validate'], s.at('.', { pins: TF_CHAIN }))).toEqual({
        command: 'terraform',
        args: ['validate'],
        env: MISE_OFF,
        pin: { source: 'path' },
      });
      await s.file('mise.toml', '[tools]\nopentofu = "1.13.1"\n');
      await s.tool('mise');
      expect(launchCheck('types', 'terraform', ['validate'], s.at('.', { pins: TF_CHAIN }))).toMatchObject({
        command: 'mise',
        args: ['exec', '--', 'tofu', 'validate'],
        pin: { source: 'mise' },
      });
    }));

  test('a --pins file that pins OpenTofu runs that copy of tofu', () =>
    withScratch(async (s) => {
      await s.tool('mise');
      const overrides = new Map([['opentofu', '1.13.1']]);
      expect(launchCheck('types', 'terraform', ['validate'], s.at('.', { pins: ['override', ...TF_CHAIN], overrides }))).toMatchObject({
        command: 'mise',
        args: ['exec', 'opentofu@1.13.1', '--', 'tofu', 'validate'],
        pin: { source: 'override', version: '1.13.1' },
      });
    }));

  test('a version file declares only its CLI, never a tool such as tflint', () =>
    withScratch(async (s) => {
      await s.file('.terraform-version', '1.5.7\n');
      await s.tool('tflint');
      const tflint: Tool = { bin: 'tflint', mise: ['tflint'], install: 'install tflint' };
      expect(launchCheck('lint', 'pnpm', ['exec', 'tflint', '--format=json'], s.at('.', { pins: TF_CHAIN, tools: [tflint] }))).toMatchObject({
        command: 'tflint',
        pin: { source: 'path' },
      });
    }));

  test('outside the terraform pack, terraform spawns as written, a version file or not, as it did in 0.13', () =>
    withScratch(async (s) => {
      await s.file('.opentofu-version', '1.13.1\n');
      expect(launchCheck('custom', 'terraform', ['fmt', '-check'], s.at('.'))).toEqual({ command: 'terraform', args: ['fmt', '-check'] });
    }));
});

/** {@link FAKE_MISE}, keeping the `MISE_IGNORED_CONFIG_PATHS` each `mise where` saw in `<bin>/mise.ignored`. */
const RECORDING_MISE = `printf '%s' "$MISE_IGNORED_CONFIG_PATHS" > "$0.ignored"\n${FAKE_MISE}`;

/** A mise whose trust line names `config`, as 2026.10.4 names a config file it hasn't trusted. */
function untrustedMise(config: string): string {
  return UNTRUSTED_MISE.replaceAll('/r/mise.toml', config);
}

describe('the override source (R13.3)', () => {
  test('heads the chain: a tool the --pins file names runs as that version through mise, over the repo’s own pin', () =>
    withScratch(async (s) => {
      await s.file('mise.toml', '[tools]\nshellcheck = "0.10.0"\n');
      await s.tool('mise', FAKE_MISE);
      const overrides = new Map([['shellcheck', '0.11.0']]);
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: OVERRIDE_CHAIN, overrides }))).toEqual({
        command: 'mise',
        args: ['exec', 'shellcheck@0.11.0', '--', 'shellcheck', '-f', 'json1', 'run.sh'],
        env: { MISE_EXEC_AUTO_INSTALL: 'false', MISE_NOT_FOUND_AUTO_INSTALL: 'false', MISE_OFFLINE: '1', MISE_IGNORED_CONFIG_PATHS: s.repo },
        pin: { source: 'override', version: '0.11.0' },
      });
    }));

  /** D83: under --pins mise reads no config file inside the repo, for the question or the run. */
  test('asks mise where and runs mise exec with the repo root in MISE_IGNORED_CONFIG_PATHS', () =>
    withScratch(async (s) => {
      await s.tool('mise', RECORDING_MISE);
      await mkdir(join(s.repo, 'sub'));
      const at = s.at('sub', { pins: OVERRIDE_CHAIN, overrides: new Map([['shellcheck', '0.11.0']]) });
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, at)).toMatchObject({ env: { MISE_IGNORED_CONFIG_PATHS: s.repo } });
      expect(await readFile(join(s.bin, 'mise.ignored'), 'utf8')).toBe(s.repo);
    }));

  test('adds the repo root to the paths the environment already has mise ignore', () =>
    withScratch(async (s) => {
      await s.tool('mise', RECORDING_MISE);
      const env = { PATH: s.bin, MISE_IGNORED_CONFIG_PATHS: '/a:/b' };
      const at = s.at('.', { pins: OVERRIDE_CHAIN, overrides: new Map([['shellcheck', '0.11.0']]), env });
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, at)).toMatchObject({ env: { MISE_IGNORED_CONFIG_PATHS: `/a:/b:${s.repo}` } });
      expect(await readFile(join(s.bin, 'mise.ignored'), 'utf8')).toBe(`/a:/b:${s.repo}`);
    }));

  test('matches any of the tool’s mise ids, as the file spells it', () =>
    withScratch(async (s) => {
      await s.tool('mise', FAKE_MISE.replace('shellcheck@0.11.0', 'aqua:koalaman/shellcheck@0.11.0'));
      const overrides = new Map([['aqua:koalaman/shellcheck', '0.11.0']]);
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: OVERRIDE_CHAIN, overrides }))).toMatchObject({
        args: ['exec', 'aqua:koalaman/shellcheck@0.11.0', '--', 'shellcheck', '-f', 'json1', 'run.sh'],
      });
    }));

  test('a tool TOOLS doesn’t describe matches by its executable’s name', () =>
    withScratch(async (s) => {
      await s.tool('mise', FAKE_MISE.replace('shellcheck@0.11.0', 'my-linter@2.0.0'));
      const at = s.at('.', { pins: ['override', 'js-lockfile'], overrides: new Map([['my-linter', '2.0.0']]) });
      expect(launchCheck('lint', 'pnpm', ['exec', 'my-linter', '.'], at)).toMatchObject({
        command: 'mise',
        args: ['exec', 'my-linter@2.0.0', '--', 'my-linter', '.'],
        pin: { source: 'override', version: '2.0.0' },
      });
    }));

  // F38
  test('a version mise hasn’t installed fails naming the tool and the install, and nothing else runs', () =>
    withScratch(async (s) => {
      await s.tool('mise', FAKE_MISE);
      await s.tool('shellcheck');
      const launch = launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: OVERRIDE_CHAIN, overrides: new Map([['shellcheck', '0.0.1']]) }));
      expect(launch).toHaveProperty('refusal');
      const refusal = 'refusal' in launch ? launch.refusal : '';
      expect(refusal).toContain("the `lint` slot's `shellcheck` is pinned by --pins to shellcheck@0.0.1");
      expect(refusal).toContain('mise where shellcheck@0.0.1: shellcheck@0.0.1 not installed');
      expect(refusal).toContain('mise install shellcheck@0.0.1');
    }));

  /** `mise where` still reads the config files above the repo, so an untrusted one there refuses the override (D82, D83). */
  test('a config outside the repo mise hasn’t trusted fails the override naming mise trust, not the install', () =>
    withScratch(async (s) => {
      await s.tool('mise', UNTRUSTED_MISE);
      await s.tool('shellcheck');
      const launch = launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: OVERRIDE_CHAIN, overrides: new Map([['shellcheck', '0.11.0']]) }));
      const refusal = refusalOf(launch) ?? '';
      expect(refusal).toContain("the `lint` slot's `shellcheck` is pinned by --pins to shellcheck@0.11.0, but mise won't read a config file outside the repo until it's trusted.");
      expect(refusal).toContain('mise where shellcheck@0.11.0: Config files in /r/mise.toml are not trusted.');
      expect(refusal).toContain('\n  mise trust\n');
      expect(refusal).not.toContain('mise install');
    }));

  /**
   * D83: a mise that reads the repo's config despite MISE_IGNORED_CONFIG_PATHS
   * gets no `mise trust` from the refusal, which would trust a file in a repo
   * the consumer may be reviewing. mise names the real path, and a symlinked
   * temp directory still counts as the repo.
   */
  test('a config inside the repo mise hasn’t trusted fails the override naming neither mise trust nor an install', () =>
    withScratch(async (s) => {
      await s.tool('mise', untrustedMise(join(await realpath(s.repo), 'sub', 'mise.toml')));
      await s.tool('shellcheck');
      const launch = launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: OVERRIDE_CHAIN, overrides: new Map([['shellcheck', '0.11.0']]) }));
      const refusal = refusalOf(launch) ?? '';
      expect(refusal).toContain('pinned by --pins to shellcheck@0.11.0, but mise read a config file inside the repo, which --pins tells it to skip.');
      expect(refusal).toContain('upgrade mise instead');
      expect(refusal).not.toContain('mise trust');
      expect(refusal).not.toContain('mise install');
    }));

  test('an untrusted config mise names no path for is never one the refusal asks to trust', () =>
    withScratch(async (s) => {
      await s.tool('mise', UNTRUSTED_MISE.replace('Config files in /r/mise.toml are not trusted.', 'Config files are not trusted.'));
      const launch = launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: OVERRIDE_CHAIN, overrides: new Map([['shellcheck', '0.11.0']]) }));
      expect(refusalOf(launch)).not.toContain('mise trust');
    }));

  test('without mise on PATH it fails rather than run the PATH copy', () =>
    withScratch(async (s) => {
      await s.tool('shellcheck');
      const launch = launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: OVERRIDE_CHAIN, overrides: new Map([['shellcheck', '0.11.0']]) }));
      expect('refusal' in launch ? launch.refusal : '').toContain("`mise` isn't on PATH");
    }));

  test('a tool the file doesn’t name resolves as before, and the source reads nothing outside the override chain', () =>
    withScratch(async (s) => {
      await s.tool('mise', FAKE_MISE);
      const overrides = new Map([['shfmt', '3.14.1']]);
      expect(launchCheck('types', 'pnpm', ['exec', 'tsc'], s.at('.', { pins: ['override', 'js-lockfile'], overrides }))).toMatchObject({ command: 'pnpm', pin: { source: 'js-lockfile' } });
      const shellcheck = new Map([['shellcheck', '0.11.0']]);
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('.', { pins: ['js-lockfile'], overrides: shellcheck }))).toMatchObject({ command: 'pnpm' });
    }));

  test('a toolchain the file names runs that copy in any chain, and one it doesn’t runs as written', () =>
    withScratch(async (s) => {
      await s.tool('mise', FAKE_MISE);
      const at = s.at('.', { pins: ['override', 'js-lockfile'], overrides: new Map([['go', '1.27']]) });
      expect(launchCheck('vet', 'go', ['vet', './...'], at)).toMatchObject({
        command: 'mise',
        args: ['exec', 'go@1.27', '--', 'go', 'vet', './...'],
        env: { MISE_IGNORED_CONFIG_PATHS: s.repo },
        pin: { source: 'override', version: '1.27.2' },
      });
      expect(launchCheck('vet', 'go', ['vet', './...'], s.at('.', { pins: ['override', 'js-lockfile'], overrides: new Map() }))).toEqual({ command: 'go', args: ['vet', './...'] });
    }));

  test('a go.mod tool runs through the Go copy the file pins, and keeps its own pin source', () =>
    withScratch(async (s) => {
      await s.tool('mise', FAKE_MISE);
      await s.file('go.mod', 'module example.com/app\n\ngo 1.24\n\ntool honnef.co/go/tools/cmd/staticcheck\n');
      const at = s.at('.', { pins: ['override', ...pinChain('go')], overrides: new Map([['go', '1.27']]) });
      expect(launchCheck('lint', 'pnpm', ['exec', 'staticcheck', './...'], at)).toMatchObject({
        command: 'mise',
        args: ['exec', 'go@1.27', '--', 'go', 'tool', 'staticcheck', './...'],
        pin: { source: 'go-mod-tool' },
      });
    }));

  test('records the release mise where resolved the file’s version to, as doctor reports it', () =>
    withScratch(async (s) => {
      await s.tool('mise', 'if [ "$1" = where ]; then echo /home/dev/.local/share/mise/installs/shellcheck/0.11.0; fi');
      const at = s.at('.', { pins: OVERRIDE_CHAIN, overrides: new Map([['shellcheck', '0.11']]) });
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, at)).toMatchObject({
        args: ['exec', 'shellcheck@0.11', '--', 'shellcheck', '-f', 'json1', 'run.sh'],
        pin: { source: 'override', version: '0.11.0' },
      });
    }));

  test('a mise where that names no directory records the version the file gives', () =>
    withScratch(async (s) => {
      await s.tool('mise', 'exit 0');
      const at = s.at('.', { pins: OVERRIDE_CHAIN, overrides: new Map([['shellcheck', '0.11']]) });
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, at)).toMatchObject({ pin: { source: 'override', version: '0.11' } });
    }));
});

describe('under --static-only the js-lockfile source pre-flights every manager (R13.4)', () => {
  test('pnpm refuses a tool missing from node_modules/.bin, and runs one there', () =>
    withScratch(async (s) => {
      await s.file('package.json', JSON.stringify({ devDependencies: { 'markdownlint-cli2': '0.23.3' } }));
      const missing = launchCheck('docs', 'pnpm', ['exec', 'markdownlint-cli2', '**/*.md'], s.at('.', { staticOnly: true }));
      expect(refusalOf(missing)).toContain("the `docs` slot needs `markdownlint-cli2`, which is not installed in this project");
      expect(refusalOf(launchCheck('docs', 'pnpm', ['exec', 'markdownlint-cli2', '**/*.md'], s.at('.')))).toBeNull();
      await s.file('node_modules/.bin/markdownlint-cli2', '');
      expect(launchCheck('docs', 'pnpm', ['exec', 'markdownlint-cli2', '**/*.md'], s.at('.', { staticOnly: true }))).toMatchObject({ command: 'pnpm' });
    }));

  test('a Yarn PnP install, which has no node_modules/.bin, counts as installed', () =>
    withScratch(async (s) => {
      await s.file('.pnp.cjs', '');
      expect(launchCheck('docs', 'pnpm', ['exec', 'markdownlint-cli2'], s.at('.', { staticOnly: true, pm: 'yarn' }))).toMatchObject({ command: 'yarn' });
    }));
});

import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { PACKS } from '../../packs/index.js';
import type { Tool } from '../../packs/index.js';
import type { Launch, LaunchContext, PackageManager } from '../index.js';
import { installCommand, isReadableSource, launchCheck, pinChain } from '../index.js';

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
      expect(refusal).toContain('mise which shellcheck: shellcheck is a mise bin however it is not currently active.');
      expect(refusal).toContain('mise install');
    }));

  test('mise is asked about the tool from the check directory, with its installs off', () =>
    withScratch(async (s) => {
      const asked = join(s.repo, 'asked');
      await s.file('mise.toml', '[tools]\nshellcheck = "0.11.0"\n');
      await mkdir(join(s.repo, 'scripts'), { recursive: true });
      await s.tool('mise', `echo "$PWD $* $MISE_EXEC_AUTO_INSTALL $MISE_NOT_FOUND_AUTO_INSTALL" > "${asked}"`);
      expect(launchCheck('lint', 'pnpm', SHELLCHECK, s.at('scripts', { pins: MISE_THEN_PATH }))).toMatchObject({ pin: { source: 'mise' } });
      expect((await readFile(asked, 'utf8')).trim()).toBe(`${await realpath(join(s.repo, 'scripts'))} which shellcheck false false`);
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
      const launch = launchCheck('lint', 'pnpm', ['exec', 'golangci-lint', 'run'], s.at('.', { pins: ['uv-lock', 'path'] }));
      expect(refusalOf(launch)).toContain("through the `uv-lock` pin source, which this checkride can't read");
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
      expect(refusal).toContain('mise which go: go@1.99.0 is not installed');
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
      expect(refusal).toContain("the `types` slot needs `go`, which isn't on PATH");
      expect(refusal).toContain('install Go 1.24 or later');
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
      expect(launchCheck('dead', 'pnpm', ['exec', 'cargo-machete'], s.at('.', { pins: RUST_CHAIN, tools: [MACHETE] }))).toEqual({
        command: 'cargo',
        args: ['machete'],
        env: { RUSTUP_TOOLCHAIN: '', MISE_EXEC_AUTO_INSTALL: 'false', MISE_NOT_FOUND_AUTO_INSTALL: 'false' },
        pin: { source: 'path' },
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
      expect(launchCheck('types', 'cargo', ['check'], s.at('.', { pins: RUST_CHAIN }))).toMatchObject({ env: { RUSTUP_TOOLCHAIN: '' } });
      expect(launchCheck('custom', 'make', ['check'], s.at('.', { pins: RUST_CHAIN }))).toEqual({ command: 'make', args: ['check'], env: { RUSTUP_TOOLCHAIN: '' } });
    }));

  test("leaves it alone with no file, and in a chain that doesn't read rust-toolchain", () =>
    withScratch(async (s) => {
      await s.tool('cargo');
      expect(launchCheck('types', 'cargo', ['check'], s.at('.', { pins: RUST_CHAIN }))).not.toHaveProperty('env.RUSTUP_TOOLCHAIN');
      await s.file('rust-toolchain.toml', '[toolchain]\nchannel = "1.85.0"\n');
      expect(launchCheck('custom', 'make', ['check'], s.at('.', { pins: GO_CHAIN }))).toEqual({ command: 'make', args: ['check'] });
    }));
});

/**
 * Contract: multi-target runs (R8, R9, D48; docs/contract.md §summary.json).
 *
 * With `targets` declared, a target's slots run once for that target, from its
 * root, as `<target>:<slot>`, and write under `<out>/<target>/`. `{out}`
 * expands to that absolute directory, so two targets' tools never write one
 * report over the other. A run first deletes the directories of the targets
 * the previous summary listed and the config dropped, and nothing else.
 *
 * A local target (D8; docs/contract.md §Local targets) keeps the rest of
 * itself in `<root>/checkride.config.json`, which ranks where the target's
 * own `checks` rank. The second suite here locks what that file and its
 * entry may hold, how each refusal names the file, and that a `--config`
 * file and a config handed to `runChecks` compose as the repo's own does.
 *
 * A config may also `include` the files that declare more targets (D9;
 * docs/contract.md §Included config files). The third suite locks the flat
 * names, each refusal and the file it names, and the file `doctor` lists
 * beside each target.
 *
 * A command typed inside a local target, or beside an included file, finds
 * the config that claims the directory and runs from the repo's root (D33;
 * docs/contract.md §Running from inside a target). The last suite locks what
 * a run there covers, that every other command acts on the whole repo, the
 * stderr line each gives, and that without a git work tree nothing walks up.
 *
 * The real CLI runs in-process with `spawn` faked, as the invariance golden
 * does, so the real adapter rows resolve and launch while nothing is
 * installed. The fake answers every spawn with `{}` on stdout and a stderr line
 * naming the argv and working directory it was handed, and writes the report a
 * tool given `--outputFile=<path>` would write there, naming its working
 * directory. It makes no directory, so a report lands only where checkride
 * prepared one. Each case reads back where the summary says a check ran and
 * wrote.
 */

// `execFileSync` and the rest come from the mocked module, which spreads the
// real one; only `spawn`, which every check goes through, is faked.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { CliDeps } from '../../src/cli.js';
import { runCli } from '../../src/cli.js';
import { runChecks } from '../../src/index.js';

/** Prefix of the stderr line the fake spawner writes; nothing a real tool prints starts with it. */
const { MARKER } = vi.hoisted(() => ({ MARKER: 'targets-spawn: ' }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { writeFileSync } = await import('node:fs');

  /** Stand in for a child process that exits 0 at once, after writing what a tool given `--outputFile` writes. */
  function spawn(command: string, args: readonly string[], options: { cwd?: string } = {}): unknown {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { pid: undefined, stdout, stderr });
    let open = 2;
    const drained = (): void => {
      open -= 1;
      if (open === 0) child.emit('close', 0, null);
    };
    stdout.on('end', drained);
    stderr.on('end', drained);
    setImmediate(() => {
      const report = args.find((arg) => arg.startsWith('--outputFile='));
      if (report !== undefined) writeFileSync(report.slice('--outputFile='.length), JSON.stringify({ cwd: options.cwd }));
      stdout.end('{}');
      stderr.end(`${MARKER}${JSON.stringify({ argv: [command, ...args], cwd: options.cwd ?? null })}\n`);
      stdout.resume();
      stderr.resume();
    });
    return child;
  }

  return { ...actual, spawn };
});

type Check = {
  name: string;
  target?: string;
  slot?: string;
  pack?: string;
  cwd?: string;
  adapter: string | null;
  skipped?: boolean;
  argv?: string[];
  output_file: string | null;
};
type Summary = { targets?: unknown; checks: Check[] };

/** A sink that keeps what it is given, so a failed run can say why. */
function buffer(): { out: CliDeps['stdout']; text: () => string } {
  let text = '';
  return { out: { write: (chunk: string) => { text += chunk; return true; } }, text: () => text };
}

/** A custom check; the fake spawner exits it 0. */
const custom = { command: 'node', args: ['-e', ''] };

/** What the fake spawner was handed for one check, read back from the stderr file the summary's check wrote in `out`. */
async function spawned(out: string, check: Check): Promise<{ argv: string[]; cwd: string }> {
  const prefix = check.target === undefined ? '' : `${check.target}/`;
  const text = await readFile(join(out, `${prefix}${check.slot ?? check.name}.stderr.txt`), 'utf8');
  const line = text.split('\n').find((l) => l.startsWith(MARKER)) ?? '';
  return JSON.parse(line.slice(MARKER.length)) as { argv: string[]; cwd: string };
}

describe('multi-target runs', () => {
  let dir: string;
  beforeEach(async () => {
    // Real, because each check's working directory comes back as the real path (macOS's /var is /private/var).
    dir = realpathSync(await mkdtemp(join(tmpdir(), 'checkride-targets-')));
    vi.stubEnv('CHECKRIDE_OUT', undefined);
    vi.stubEnv('CHECKRIDE_CONFIG', undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  /** Write `files` under the repo, each path relative to it. */
  async function lay(files: Record<string, string>): Promise<void> {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    }
  }

  /** Write the config, run the CLI with `argv`, and read the summary from `out`. */
  async function run(config: unknown, argv: string[] = [], out = join(dir, '.check')): Promise<Summary> {
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify(config));
    const err = buffer();
    const code = await runCli(argv, { cwd: dir, stdout: buffer().out, stderr: err.out, env: {} });
    expect(code, err.text()).toBe(0);
    return JSON.parse(await readFile(join(out, 'summary.json'), 'utf8')) as Summary;
  }

  /** The `--out` folder the R9 cases share. */
  const outFolder = (): string => join(dir, 'out');

  /**
   * Every repo here is a workspace whose root `package.json` sits above its ts
   * targets, which `unclaimed` reports unless the config leaves it out.
   */
  const workspaceRoot = { ignore: ['package.json'] };

  const twoTargets = {
    targets: { web: { lang: 'ts', root: 'apps/web' }, api: { lang: 'ts', root: 'apps/api' } },
    checks: { links: false },
    unclaimed: workspaceRoot,
  };

  test('two ts targets each run vitest from their own root, and each report lands where the summary says', async () => {
    await lay({ 'package.json': '{"name":"repo"}', 'apps/web/vitest.config.ts': '', 'apps/api/vitest.config.ts': '' });
    const summary = await run(twoTargets, ['--only', 'test']);
    const ran = summary.checks.filter((c) => c.skipped !== true);
    expect(ran.map((c) => c.name)).toEqual(['web:test', 'api:test']);
    const out = join(dir, '.check');
    for (const check of ran) {
      const root = join(dir, 'apps', check.target ?? '');
      expect(check).toMatchObject({ adapter: 'vitest', slot: 'test', pack: 'ts', cwd: `apps/${check.target}` });
      // The summary's argv names the report, and the tool ran from the target's root.
      const flag = check.argv?.find((arg) => arg.startsWith('--outputFile=')) ?? '';
      expect(flag).toBe(`--outputFile=${join(out, check.target ?? '', 'test.json')}`);
      expect(await spawned(out, check)).toMatchObject({ cwd: root });
      expect(JSON.parse(await readFile(flag.slice('--outputFile='.length), 'utf8'))).toEqual({ cwd: root });
    }
  });

  test("a target's JSON artifact is named <target>/<file>, and that file exists", async () => {
    await lay({ 'package.json': '{"name":"repo"}', 'apps/web/.oxlintrc.json': '{}', 'apps/api/.oxlintrc.json': '{}' });
    const summary = await run(twoTargets, ['--only', 'web:lint']);
    const lint = summary.checks.find((c) => c.name === 'web:lint');
    expect(lint).toMatchObject({ adapter: 'oxlint', output_file: 'web/lint.json' });
    expect(existsSync(join(dir, '.check', 'web', 'lint.json'))).toBe(true);
    // The narrowed-away twin rides as a skipped row that still says whose it is.
    expect(summary.checks.find((c) => c.name === 'api:lint')).toMatchObject({ skipped: true, target: 'api', cwd: 'apps/api' });
  });

  test('checks follow the catalogue, scope, target order, then custom checks (R8.4)', async () => {
    await lay({ 'package.json': '{"name":"repo"}', 'apps/web/.oxlintrc.json': '{}', 'apps/api/.oxlintrc.json': '{}' });
    const summary = await run({
      targets: { web: { lang: 'ts', root: 'apps/web', checks: { probe: custom } }, api: { lang: 'ts', root: 'apps/api' } },
      packs: { ts: { checks: { e2e: custom } } },
      checks: { licenses: custom },
      unclaimed: workspaceRoot,
    });
    expect(summary.checks.map((c) => c.name)).toEqual([
      'web:types', 'api:types', 'web:lint', 'api:lint', 'struct', 'web:dead', 'api:dead', 'web:test', 'api:test',
      'docs', 'links', 'spell', 'unclaimed', 'licenses', 'web:e2e', 'web:probe', 'api:e2e',
    ]);
    expect(summary.targets).toEqual([{ name: 'web', pack: 'ts', root: 'apps/web' }, { name: 'api', pack: 'ts', root: 'apps/api' }]);
  });

  test("a repo-scope check's {out} is the absolute output directory, and it runs from the repo root", async () => {
    await lay({ 'package.json': '{"name":"repo"}', 'apps/web/.keep': '', 'apps/api/.keep': '' });
    const config = { ...twoTargets, checks: { links: false, report: { command: 'node', args: ['{out}/report.txt'] } } };
    const summary = await run(config, ['--only', 'report']);
    const report = summary.checks.find((c) => c.name === 'report');
    expect(report).toMatchObject({ slot: 'report', pack: 'repo', argv: ['node', join(dir, '.check', 'report.txt')] });
    expect(report).not.toHaveProperty('target');
    expect(await spawned(join(dir, '.check'), report as Check)).toMatchObject({ cwd: dir });
  });

  test("a target's scratch files sit under its own root's .check/", async () => {
    await lay({
      'package.json': '{"name":"repo"}',
      'apps/web/package.json': '{"name":"web"}',
      'apps/web/tsconfig.json': '{}',
      'apps/web/src/index.ts': 'export const x = 1;\n',
      'apps/web/README.md': '# web\n\n<!-- snippet: check -->\n```ts\nconst y = 1;\n```\n',
    });
    const summary = await run(
      { targets: { web: { lang: 'ts', root: 'apps/web', checks: { snippets: 'snippets' } } }, checks: { links: false } },
      ['--only', 'web:snippets'],
    );
    expect(summary.checks.find((c) => c.name === 'web:snippets')).toMatchObject({ output_file: 'web/snippets.json' });
    expect(existsSync(join(dir, 'apps', 'web', '.check', 'doc-snippets', 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(dir, '.check', 'doc-snippets'))).toBe(false);
  });

  describe('deleting the directories of dropped targets (R9)', () => {
    const withOld = {
      targets: {
        web: { lang: 'ts', root: 'apps/web', checks: { probe: custom } },
        old: { lang: 'ts', root: 'apps/old', checks: { probe: custom } },
      },
      checks: { links: false },
      unclaimed: workspaceRoot,
    };
    const webOnly = { targets: { web: withOld.targets.web }, checks: { links: false }, unclaimed: workspaceRoot };

    beforeEach(async () => {
      await lay({ 'package.json': '{"name":"repo"}', 'apps/web/.keep': '', 'apps/old/.keep': '' });
    });

    test('a run deletes the directory of a target the config dropped, and leaves an unrelated folder in --out alone', async () => {
      await run(withOld, ['--out', 'out'], outFolder());
      expect(existsSync(join(outFolder(), 'old', 'probe.stdout.txt'))).toBe(true);
      // Things in the folder checkride didn't write: a folder of notes, and one
      // named like a target that no summary ever listed.
      await lay({ 'out/notes/keep.md': 'mine\n', 'out/api/keep.md': 'mine too\n' });

      const summary = await run(webOnly, ['--out', 'out'], outFolder());
      expect(summary.targets).toEqual([{ name: 'web', pack: 'ts', root: 'apps/web' }]);
      expect(existsSync(join(outFolder(), 'old'))).toBe(false);
      expect(existsSync(join(outFolder(), 'web', 'probe.stdout.txt'))).toBe(true);
      expect(await readFile(join(outFolder(), 'notes', 'keep.md'), 'utf8')).toBe('mine\n');
      expect(await readFile(join(outFolder(), 'api', 'keep.md'), 'utf8')).toBe('mine too\n');
    });

    test('a folder already under --out that a target wrote into keeps its own files when the target is dropped (D57)', async () => {
      // The user's folder happens to share its name with a target added later.
      await lay({ 'out/old/mine.md': 'mine\n' });
      await run(withOld, ['--out', 'out'], outFolder());
      expect(existsSync(join(outFolder(), 'old', 'probe.stdout.txt'))).toBe(true);

      await run(webOnly, ['--out', 'out'], outFolder());
      expect(await readFile(join(outFolder(), 'old', 'mine.md'), 'utf8')).toBe('mine\n');
      expect(existsSync(join(outFolder(), 'old', 'probe.stdout.txt'))).toBe(false);
      expect(existsSync(join(outFolder(), 'old', 'probe.stderr.txt'))).toBe(false);
    });

    test('dropping targets altogether clears what they left', async () => {
      await run(withOld, ['--out', 'out'], outFolder());
      await run({ checks: { links: false, probe: custom } }, ['--out', 'out'], outFolder());
      expect(existsSync(join(outFolder(), 'web'))).toBe(false);
      expect(existsSync(join(outFolder(), 'old'))).toBe(false);
      expect(existsSync(join(outFolder(), 'probe.stdout.txt'))).toBe(true);
    });

    test("a dropped target's directory that holds its own root is never deleted", async () => {
      // An output directory pointed at the targets' parent puts `<out>/old` on
      // `apps/old` itself, which a prune must not take with it.
      await run(withOld, ['--out', 'apps'], join(dir, 'apps'));
      await run(webOnly, ['--out', 'apps'], join(dir, 'apps'));
      expect(existsSync(join(dir, 'apps', 'old', '.keep'))).toBe(true);
    });
  });
});

/** The names of the checks a summary says ran. */
const ran = (summary: Summary | null): string[] => (summary?.checks ?? []).filter((c) => c.skipped !== true).map((c) => c.name);

/** The argv a summary recorded for the check named `name`. */
const argvOf = (summary: Summary | null, name: string): string[] | undefined => summary?.checks.find((c) => c.name === name)?.argv;

/** A custom check whose argv carries `word`, so a summary shows which file's entry ran. */
const say = (word: string): typeof custom => ({ command: 'node', args: ['-e', word] });

describe('local targets', () => {
  let dir: string;
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(join(tmpdir(), 'checkride-local-targets-')));
    vi.stubEnv('CHECKRIDE_OUT', undefined);
    vi.stubEnv('CHECKRIDE_CONFIG', undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  /** Write `files` under the repo, each a JSON value, or text as it is, at a path relative to it. */
  async function lay(files: Record<string, unknown>): Promise<void> {
    for (const [path, value] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), typeof value === 'string' ? value : JSON.stringify(value));
    }
  }

  /** Run the CLI with `argv` in the repo: its exit code, what it wrote to stderr, and the summary when it wrote one. */
  async function cli(argv: string[] = []): Promise<{ code: number; stderr: string; summary: Summary | null }> {
    const err = buffer();
    const code = await runCli(argv, { cwd: dir, stdout: buffer().out, stderr: err.out, env: {} });
    const file = join(dir, '.check', 'summary.json');
    return { code, stderr: err.text(), summary: existsSync(file) ? (JSON.parse(await readFile(file, 'utf8')) as Summary) : null };
  }

  /** Run the CLI, expecting the config error `reason`, and nothing run. */
  async function refused(reason: string): Promise<void> {
    const { code, stderr, summary } = await cli();
    expect(code, stderr).toBe(2);
    expect(stderr).toContain(`invalid checkride.config.json: ${reason}`);
    expect(summary).toBeNull();
  }

  const web = { root: 'web', local: true };
  const off = { links: false, unclaimed: false } as const;

  test("the local file's checks rank above packs.<pack>.checks and the top level, and the summary shows an ordinary target", async () => {
    await lay({
      'checkride.config.json': {
        targets: { web, api: { lang: 'ts', root: 'api' } },
        packs: { ts: { checks: { lint: 'eslint', probe: say('pack') } } },
        checks: { ...off, lint: { timeout: 30 } },
      },
      'web/checkride.config.json': { lang: 'ts', checks: { lint: 'oxlint', probe: say('local'), own: say('own') } },
      'api/.keep': '',
    });
    const { code, stderr, summary } = await cli(['--only', 'lint,probe,own']);
    expect(code, stderr).toBe(0);
    expect(summary?.targets).toEqual([{ name: 'web', pack: 'ts', root: 'web' }, { name: 'api', pack: 'ts', root: 'api' }]);
    expect(ran(summary)).toEqual(['web:lint', 'api:lint', 'web:probe', 'web:own', 'api:probe']);
    // The local file's pick beats the pack block's, which still fills the other target.
    expect(summary?.checks.find((c) => c.name === 'web:lint')).toMatchObject({ adapter: 'oxlint', target: 'web', cwd: 'web', pack: 'ts' });
    expect(summary?.checks.find((c) => c.name === 'api:lint')).toMatchObject({ adapter: 'eslint' });
    expect(argvOf(summary, 'web:probe')).toEqual(['node', '-e', 'local']);
    expect(argvOf(summary, 'api:probe')).toEqual(['node', '-e', 'pack']);
  });

  describe('each refusal is exit 2, names the file, and runs nothing', () => {
    test.each(['targets', 'schemas', 'unclaimed', 'packs', 'gate', 'changedBase', 'requirePins'])('%s in the local file', async (key) => {
      await lay({ 'checkride.config.json': { targets: { web } }, 'web/checkride.config.json': { lang: 'ts', [key]: {} } });
      await refused(`web/checkride.config.json sets ${key}, which belongs to the whole repo: a local target's file holds lang, checks, include, exclude, timeout and extends, so set ${key} in the repo's own config`);
    });

    test.each(['lang', 'checks', 'include', 'exclude', 'timeout', 'extends'])('%s in the entry beside local: true', async (key) => {
      await lay({ 'checkride.config.json': { targets: { web: { ...web, [key]: 'ts' } } }, 'web/checkride.config.json': { lang: 'ts' } });
      await refused(`targets.web sets ${key} beside local: true, and a local target's entry holds only root, local, note: move ${key} to web/checkride.config.json`);
    });

    test('a missing local file', async () => {
      await lay({ 'checkride.config.json': { targets: { web } }, 'web/.keep': '' });
      await refused('targets.web is local, and its file web/checkride.config.json is missing: a local target keeps its lang and its checks there');
    });

    test('two local targets at one root', async () => {
      await lay({ 'checkride.config.json': { targets: { web, site: { root: 'web', local: true } } }, 'web/checkride.config.json': { lang: 'ts' } });
      await refused("local targets 'web' and 'site' share the root 'web', and a root holds one local file, web/checkride.config.json, with one lang");
    });

    test("a local target at the declaring file's own directory", async () => {
      await lay({ 'checkride.config.json': { targets: { all: { root: '.', local: true } } } });
      await refused('targets.all is local at the root, where its file would be checkride.config.json, the file that declares it: give it a directory of its own, or drop local');
    });

    test('a rule the local file breaks as a target', async () => {
      await lay({ 'checkride.config.json': { targets: { web } }, 'web/checkride.config.json': { lang: 'ts', checks: { spell: false } } });
      const { code, stderr } = await cli();
      expect(code).toBe(2);
      expect(stderr).toMatch(/invalid checkride\.config\.json: targets\.web\.checks\.spell configures spell, a repo-scope slot .* \(in web\/checkride\.config\.json\)/);
    });
  });

  test('a key from a preset the local file extends is dropped with a warning naming the preset, and the run goes on', async () => {
    await lay({
      'checkride.config.json': { targets: { web }, checks: off },
      'presets/team.json': { requirePins: true, checks: { spell: false, probe: say('preset') } },
      'web/checkride.config.json': { extends: '../presets/team.json', lang: 'ts' },
    });
    const { code, stderr, summary } = await cli(['--only', 'probe']);
    expect(code, stderr).toBe(0);
    const warnings = stderr.split('\n').filter((line) => line.includes('team.json'));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^checkride: \S*team\.json has a top-level key "requirePins", which web\/checkride\.config\.json, a local target's file, doesn't read \(it reads lang, checks, include, exclude, timeout and extends\)$/);
    expect(warnings[1]).toMatch(/^checkride: \S*team\.json configures spell, a repo-scope slot, which web\/checkride\.config\.json, a local target's file, doesn't read/);
    // What the local file may hold came through; the repo's own spell slot is as the root config left it.
    expect(argvOf(summary, 'web:probe')).toEqual(['node', '-e', 'preset']);
    expect(summary?.checks.find((c) => c.name === 'spell')).toBeDefined();
  });

  test('a --config file declares a local target, read at <cwd>/<root>/', async () => {
    const outside = realpathSync(await mkdtemp(join(tmpdir(), 'checkride-local-named-')));
    try {
      await writeFile(join(outside, 'named.json'), JSON.stringify({ targets: { web }, checks: off }));
      await lay({ 'web/checkride.config.json': { lang: 'ts', checks: { probe: say('named') } } });
      const { code, stderr, summary } = await cli(['--config', join(outside, 'named.json'), '--only', 'probe']);
      expect(code, stderr).toBe(0);
      expect(argvOf(summary, 'web:probe')).toEqual(['node', '-e', 'named']);
      // A refusal names the config that declared the target, and the local file.
      await lay({ 'web/checkride.config.json': { lang: 'ts', schemas: [] } });
      const refusedRun = await cli(['--config', join(outside, 'named.json')]);
      expect(refusedRun.code).toBe(2);
      expect(refusedRun.stderr).toContain(`invalid ${join(outside, 'named.json')}: web/checkride.config.json sets schemas`);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('a config handed to runChecks declares a local target, composed as the repo\'s own is', async () => {
    await lay({ 'web/checkride.config.json': { lang: 'ts', checks: { probe: say('handed') } } });
    const err = buffer();
    const result = await runChecks({ cwd: dir, config: { targets: { web: { root: 'web', local: true } }, checks: off }, only: ['probe'], stdout: buffer().out, stderr: err.out });
    expect(result.exitCode, err.text()).toBe(0);
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as Summary;
    expect(summary.targets).toEqual([{ name: 'web', pack: 'ts', root: 'web' }]);
    expect(argvOf(summary, 'web:probe')).toEqual(['node', '-e', 'handed']);
    // And held to the same refusals, as the error a caller catches.
    await lay({ 'web/checkride.config.json': { lang: 'ts', gate: {} } });
    await expect(runChecks({ cwd: dir, config: { targets: { web: { root: 'web', local: true } } }, stdout: buffer().out, stderr: buffer().out })).rejects.toThrow(
      'invalid checkride.config.json: web/checkride.config.json sets gate, which belongs to the whole repo',
    );
  });

  describe('the containment rule on a path a local target names', () => {
    let outside: string;
    beforeEach(async () => {
      outside = realpathSync(await mkdtemp(join(tmpdir(), 'checkride-local-outside-')));
      await writeFile(join(outside, 'checkride.config.json'), JSON.stringify({ lang: 'ts', checks: { stolen: say('outside') } }));
      await writeFile(join(outside, 'preset.json'), JSON.stringify({ checks: { stolen: say('outside') } }));
      await lay({ 'checkride.config.json': { targets: { web }, checks: off } });
    });
    afterEach(async () => {
      await rm(outside, { recursive: true, force: true });
    });

    test('a local file that links out of the repo is exit 2, and never read', async () => {
      await mkdir(join(dir, 'web'));
      await symlink(join(outside, 'checkride.config.json'), join(dir, 'web', 'checkride.config.json'));
      const { code, stderr, summary } = await cli();
      expect(code).toBe(2);
      expect(stderr).toContain('invalid checkride.config.json: targets.web is local, and its file web/checkride.config.json resolves outside the repository, where checkride reads no config');
      expect(summary).toBeNull();
    });

    test('a preset the local file names by a path out of the repo is exit 2', async () => {
      await lay({ 'web/checkride.config.json': { extends: join(outside, 'preset.json'), lang: 'ts' } });
      const { code, stderr, summary } = await cli();
      expect(code).toBe(2);
      expect(stderr).toContain(`extends "${join(outside, 'preset.json')}" (in web/checkride.config.json) resolves outside the repository, where a local target's file reads nothing`);
      expect(summary).toBeNull();
    });

    test('a link that stays inside the repo is read', async () => {
      await lay({ 'shared/web.json': { lang: 'ts', checks: { probe: say('inside') } }, 'web/.keep': '' });
      await symlink(join(dir, 'shared', 'web.json'), join(dir, 'web', 'checkride.config.json'));
      const { code, stderr, summary } = await cli(['--only', 'probe']);
      expect(code, stderr).toBe(0);
      expect(argvOf(summary, 'web:probe')).toEqual(['node', '-e', 'inside']);
    });
  });
});

describe('included config files', () => {
  let dir: string;
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(join(tmpdir(), 'checkride-included-')));
    vi.stubEnv('CHECKRIDE_OUT', undefined);
    vi.stubEnv('CHECKRIDE_CONFIG', undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  /** Write `files` under the repo, each a JSON value, or text as it is, at a path relative to it. */
  async function lay(files: Record<string, unknown>): Promise<void> {
    for (const [path, value] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), typeof value === 'string' ? value : JSON.stringify(value));
    }
  }

  /** Run the CLI with `argv` in the repo: its exit code, both streams, and the summary when it wrote one. */
  async function cli(argv: string[] = []): Promise<{ code: number; stdout: string; stderr: string; summary: Summary | null }> {
    const out = buffer();
    const err = buffer();
    const code = await runCli(argv, { cwd: dir, stdout: out.out, stderr: err.out, env: {} });
    const file = join(dir, '.check', 'summary.json');
    return { code, stdout: out.text(), stderr: err.text(), summary: existsSync(file) ? (JSON.parse(await readFile(file, 'utf8')) as Summary) : null };
  }

  /** Run the CLI, expecting the config error `reason`, and nothing run. */
  async function refused(reason: string, argv: string[] = []): Promise<void> {
    const { code, stderr, summary } = await cli(argv);
    expect(code, stderr).toBe(2);
    expect(stderr).toContain(reason);
    expect(summary).toBeNull();
  }

  const off = { links: false, unclaimed: false } as const;

  /** A root config that includes `services`, whose file declares a go target and a local one. */
  const repo = {
    'checkride.config.json': { include: ['services'], targets: { web: { lang: 'ts', root: 'web' } }, checks: off, packs: { go: { checks: { probe: say('pack') } } } },
    'services/checkride.config.json': { targets: { api: { lang: 'go', root: 'api' }, billing: { root: 'billing', local: true } } },
    'services/billing/checkride.config.json': { lang: 'go', checks: { probe: say('local') } },
    'services/api/.keep': '',
    'web/.keep': '',
  };

  test("an included file's targets run under flat names, from roots relative to the file", async () => {
    await lay(repo);
    const { code, stderr, summary } = await cli(['--only', 'probe']);
    expect(code, stderr).toBe(0);
    expect(summary?.targets).toEqual([
      { name: 'web', pack: 'ts', root: 'web' },
      { name: 'api', pack: 'go', root: 'services/api' },
      { name: 'billing', pack: 'go', root: 'services/billing' },
    ]);
    expect(ran(summary)).toEqual(['api:probe', 'billing:probe']);
    expect(summary?.checks.find((c) => c.name === 'api:probe')).toMatchObject({ target: 'api', cwd: 'services/api', output_file: null });
    expect(argvOf(summary, 'api:probe')).toEqual(['node', '-e', 'pack']);
    expect(argvOf(summary, 'billing:probe')).toEqual(['node', '-e', 'local']);
    // The artifacts sit under the flat name, never a path-shaped one.
    expect(existsSync(join(dir, '.check', 'api', 'probe.stdout.txt'))).toBe(true);
    // And --only takes the flat name.
    expect(ran((await cli(['--only', 'billing'])).summary)).toEqual(['billing:probe']);
  });

  test('a name declared in two files is exit 2 naming both', async () => {
    await lay({ ...repo, 'checkride.config.json': { include: ['services'], targets: { api: { lang: 'ts', root: 'web' } } } });
    await refused("invalid checkride.config.json: target 'api' is declared twice, in checkride.config.json and in services/checkride.config.json: target names are one flat set across every included file");
  });

  test('a cycle is exit 2 naming the chain', async () => {
    await lay({ 'checkride.config.json': { include: ['services'] }, 'services/checkride.config.json': { include: ['api'] }, 'services/api/checkride.config.json': { include: ['.'] } });
    await refused('invalid checkride.config.json: circular include: checkride.config.json -> services/checkride.config.json -> services/api/checkride.config.json -> services/api/checkride.config.json');
  });

  test.each(['checks', 'packs', 'schemas', 'unclaimed', 'gate', 'changedBase', 'requirePins', 'timeout', 'extends'])('%s in an included file is exit 2 naming the file', async (key) => {
    await lay({ ...repo, 'services/checkride.config.json': { targets: { api: { lang: 'go', root: 'api' } }, [key]: {} } });
    await refused(`invalid checkride.config.json: services/checkride.config.json sets ${key}, which an included file can't hold: it holds targets, include, note and $schema, and ${key} belongs to the repo's own config`);
  });

  test('a missing included file, and one that links out of the repo, are exit 2', async () => {
    await lay({ 'checkride.config.json': { include: ['services'] }, 'web/.keep': '' });
    await refused('invalid checkride.config.json: checkride.config.json includes services/checkride.config.json, which is missing');
    const outside = realpathSync(await mkdtemp(join(tmpdir(), 'checkride-included-outside-')));
    try {
      await writeFile(join(outside, 'checkride.config.json'), JSON.stringify({ targets: { stolen: { lang: 'ts', root: '.' } } }));
      await symlink(outside, join(dir, 'services'));
      await refused('invalid checkride.config.json: checkride.config.json includes services/checkride.config.json, which resolves outside the repository, where checkride reads no config');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('include in a --config file is exit 2', async () => {
    await lay(repo);
    const outside = realpathSync(await mkdtemp(join(tmpdir(), 'checkride-included-named-')));
    try {
      await writeFile(join(outside, 'named.json'), JSON.stringify({ include: ['services'] }));
      await refused(
        `invalid ${join(outside, 'named.json')}: a config named by --config or CHECKRIDE_CONFIG can't include: an included file's roots are relative to a file inside the repo, and this one can sit outside it`,
        ['--config', join(outside, 'named.json')],
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('doctor lists each target with the file that declares it, and a repo with no include keeps its three columns', async () => {
    await lay(repo);
    const report = JSON.parse((await cli(['doctor', '--json'])).stdout) as { targets: unknown };
    expect(report.targets).toEqual([
      { name: 'web', pack: 'ts', root: 'web', file: 'checkride.config.json' },
      { name: 'api', pack: 'go', root: 'services/api', file: 'services/checkride.config.json' },
      { name: 'billing', pack: 'go', root: 'services/billing', file: 'services/checkride.config.json' },
    ]);
    expect((await cli(['doctor'])).stdout).toContain(
      ['  TARGETS', '    web      ts  web               checkride.config.json', '    api      go  services/api      services/checkride.config.json', '    billing  go  services/billing  services/checkride.config.json', ''].join('\n'),
    );
    await lay({ 'checkride.config.json': { targets: { web: { lang: 'ts', root: 'web' } }, checks: off } });
    const plain = JSON.parse((await cli(['doctor', '--json'])).stdout) as { targets: unknown };
    expect(plain.targets).toEqual([{ name: 'web', pack: 'ts', root: 'web' }]);
  });
});

/** A summary's entries for the checks of `target`, without what differs run to run: how long each took. */
const entriesOf = (summary: Summary | null, target: string): unknown[] =>
  (summary?.checks ?? []).filter((c) => c.target === target).map((c) => ({ ...c, duration_ms: 0 }));

describe('running from inside a target', () => {
  let dir: string;
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(join(tmpdir(), 'checkride-inside-')));
    vi.stubEnv('CHECKRIDE_OUT', undefined);
    vi.stubEnv('CHECKRIDE_CONFIG', undefined);
    vi.stubEnv('CHECKRIDE_SUITE', undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  /** Write `files` under the repo, each a JSON value, or text as it is, at a path relative to it. */
  async function lay(files: Record<string, unknown>): Promise<void> {
    for (const [path, value] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), typeof value === 'string' ? value : JSON.stringify(value));
    }
  }

  /** Run the CLI with `argv` from `from`, a directory relative to the repo: its exit code and both streams. */
  async function cliFrom(from: string, argv: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
    const out = buffer();
    const err = buffer();
    const code = await runCli(argv, { cwd: join(dir, from), stdout: out.out, stderr: err.out, env: {} });
    return { code, stdout: out.text(), stderr: err.text() };
  }

  /** The summary in the output directory of `at`, a directory relative to the repo, or `null` when it holds none. */
  async function summaryAt(at: string): Promise<Summary | null> {
    const file = join(dir, at, '.check', 'summary.json');
    return existsSync(file) ? (JSON.parse(await readFile(file, 'utf8')) as Summary) : null;
  }

  /** The line a command writes when it found the config above `from`, running `how`. */
  const found = (from: string, how: string): string =>
    `checkride: found ${join(...from.split('/').map(() => '..'), 'checkride.config.json')}, which claims this directory: ${how}, from ${dir}\n`;

  /** A repo with a local target, an included file that declares two more, and a repo-scope custom check. */
  const repo = {
    'checkride.config.json': {
      include: ['services'],
      targets: { web: { root: 'web', local: true } },
      checks: { links: false, unclaimed: false, licenses: say('repo') },
    },
    'web/checkride.config.json': { lang: 'ts', checks: { probe: say('web'), unit: say('unit') } },
    'web/src/.keep': '',
    'services/checkride.config.json': { targets: { api: { lang: 'go', root: 'api', checks: { probe: say('api') } }, billing: { root: 'billing', local: true } } },
    'services/api/.keep': '',
    'services/billing/checkride.config.json': { lang: 'go', checks: { probe: say('billing') } },
  };

  describe('in a git work tree', () => {
    beforeEach(async () => {
      await lay(repo);
      execFileSync('git', ['init', '-q'], { cwd: dir });
    });

    test.each(['web', 'web/src'])("a run from %s writes the same web: entries as --only web from the root, into the root's .check/", async (from) => {
      expect((await cliFrom('.', ['--only', 'web'])).code).toBe(0);
      const fromRoot = await summaryAt('.');
      expect(ran(fromRoot)).toEqual(['web:probe', 'web:unit']);
      await rm(join(dir, '.check'), { recursive: true });

      const inside = await cliFrom(from);
      expect(inside.code, inside.stderr).toBe(0);
      expect(inside.stderr).toContain(found(from, 'running as --only web'));
      const fromInside = await summaryAt('.');
      expect(entriesOf(fromInside, 'web')).toEqual(entriesOf(fromRoot, 'web'));
      expect(fromInside?.checks.map((c) => c.name)).toEqual(fromRoot?.checks.map((c) => c.name));
      expect(ran(fromInside)).toEqual(['web:probe', 'web:unit']);
      // Nothing is written where the command was typed.
      expect(await summaryAt(from)).toBeNull();
      expect(existsSync(join(dir, '.check', 'web', 'probe.stdout.txt'))).toBe(true);
    });

    test('a run from services/ covers every target its included file declares', async () => {
      const { code, stderr } = await cliFrom('services');
      expect(code, stderr).toBe(0);
      expect(stderr).toContain(found('services', 'running as --only api,billing'));
      expect(ran(await summaryAt('.'))).toEqual(['api:probe', 'billing:probe']);
      expect(await summaryAt('services')).toBeNull();
    });

    test('the run reads its own --only inside the directory, and refuses a token that selects nothing there', async () => {
      const narrowed = await cliFrom('web', ['--only', 'unit']);
      expect(narrowed.code, narrowed.stderr).toBe(0);
      expect(narrowed.stderr).toContain(found('web', 'running as --only web:unit'));
      expect(ran(await summaryAt('.'))).toEqual(['web:unit']);

      const outside = await cliFrom('web', ['--only', 'api']);
      expect(outside.code).toBe(2);
      expect(outside.stderr).toContain(`--only api selects nothing in web, the targets this directory holds: run it from ${dir} for the rest of the repo`);
      const repoScope = await cliFrom('web', ['--only', 'licenses']);
      expect(repoScope.code).toBe(2);
    });

    test('a directory no config claims is read as it always was', async () => {
      const { code, stderr } = await cliFrom('services/api');
      expect(code, stderr).toBe(0);
      expect(stderr).not.toContain('found');
      expect(await summaryAt('services/api')).not.toBeNull();
      expect(await summaryAt('.')).toBeNull();
    });

    test('doctor from web/ reports the whole repo', async () => {
      const { stdout, stderr } = await cliFrom('web', ['doctor', '--json']);
      expect(stderr).toContain(found('web', 'running doctor for the whole repo'));
      expect((JSON.parse(stdout) as { targets: { name: string }[] }).targets.map((t) => t.name)).toEqual(['web', 'api', 'billing']);
    });

    test("baseline from web/ captures the whole repo into the root's baseline file", async () => {
      const { code, stderr } = await cliFrom('web', ['baseline']);
      expect(code, stderr).toBe(0);
      expect(stderr).toContain(found('web', 'running baseline for the whole repo'));
      expect(existsSync(join(dir, 'checkride.baseline.json'))).toBe(true);
      expect(existsSync(join(dir, 'web', 'checkride.baseline.json'))).toBe(false);
      // The capture covered every target, not web's alone.
      expect((await summaryAt('.'))?.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['web:probe', 'api:probe', 'billing:probe', 'licenses']));
    });

    test('fix from web/ runs over the whole repo', async () => {
      const { code, stderr } = await cliFrom('web/src', ['fix']);
      expect(code, stderr).toBe(0);
      expect(stderr).toContain(found('web/src', 'running fix for the whole repo'));
    });

    test('recover and baseline diff from web/ read the root baseline', async () => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first'], { cwd: dir });
      const recover = await cliFrom('web', ['recover', '--dry-run']);
      expect(recover.stderr).toContain(found('web', 'running recover for the whole repo'));
      const diff = await cliFrom('web', ['baseline', 'diff', 'HEAD', '--json']);
      expect(diff.code, diff.stderr).toBe(0);
      expect(diff.stderr).toContain(found('web', 'running baseline diff for the whole repo'));
    });

    test("the gate from web/ gates the whole repo, from its root", async () => {
      await lay({ '.check/.dirty': '' });
      const { code, stdout, stderr } = await cliFrom('web', ['gate', '--if-dirty']);
      expect(code, stderr).toBe(0);
      expect(stderr).toContain(found('web', 'running the gate for the whole repo'));
      // The marker it read is the root's, the check it spawned ran there, unnarrowed, and its green cleared the marker.
      expect(stderr).toContain(`${MARKER}${JSON.stringify({ argv: ['checkride', '--strict', '--digest'], cwd: dir })}`);
      expect(stdout).toContain('checkride green');
      expect(existsSync(join(dir, '.check', '.dirty'))).toBe(false);
    });

    test('a named config is read where the command was typed, and nothing walks up', async () => {
      await lay({ 'web/named.json': { checks: { links: false, here: say('here') } } });
      const { code, stderr } = await cliFrom('web', ['--config', 'named.json']);
      expect(code, stderr).toBe(0);
      expect(stderr).not.toContain('found');
      expect(ran(await summaryAt('web'))).toEqual(['here']);
    });

    test('a broken config above is exit 2, naming it, in place of a second verdict from the directory alone', async () => {
      await lay({ 'web/checkride.config.json': { lang: 'ts', schemas: [] } });
      const { code, stderr } = await cliFrom('web');
      expect(code).toBe(2);
      expect(stderr).toContain('invalid checkride.config.json: web/checkride.config.json sets schemas');
      expect(stderr).toContain(`(in ${join(dir, 'checkride.config.json')}, the config above this directory)`);
      expect(await summaryAt('web')).toBeNull();
    });
  });

  test('outside any git work tree, a directory is read as it is today', async () => {
    await lay(repo);
    const { code, stderr } = await cliFrom('web', ['--only', 'probe']);
    expect(code, stderr).toBe(0);
    expect(stderr).not.toContain('found');
    // web's local file is read as a config of its own: its probe runs bare, and the artifacts land beside it.
    expect(ran(await summaryAt('web'))).toEqual(['probe']);
    expect(await summaryAt('.')).toBeNull();
  });
});

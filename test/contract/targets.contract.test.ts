/**
 * Contract: multi-target runs (R8, R9, D48; docs/contract.md §summary.json).
 *
 * With `targets` declared, a target's slots run once for that target, from its
 * root, as `<target>:<slot>`, and write under `<out>/<target>/`. `{out}`
 * expands to that absolute directory, so two targets' tools never write one
 * report over the other. A run first deletes the directories of the targets
 * the previous summary listed and the config dropped, and nothing else.
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
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { CliDeps } from '../../src/cli.js';
import { runCli } from '../../src/cli.js';

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

  const twoTargets = {
    targets: { web: { lang: 'ts', root: 'apps/web' }, api: { lang: 'ts', root: 'apps/api' } },
    checks: { links: false },
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
    });
    expect(summary.checks.map((c) => c.name)).toEqual([
      'web:types', 'api:types', 'web:lint', 'api:lint', 'struct', 'web:dead', 'api:dead', 'web:test', 'api:test',
      'docs', 'links', 'spell', 'licenses', 'web:e2e', 'web:probe', 'api:e2e',
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
    };
    const webOnly = { targets: { web: withOld.targets.web }, checks: { links: false } };

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

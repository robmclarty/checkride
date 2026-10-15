/**
 * Contract: the `.check/summary.json` shape (docs/contract.md §summary.json).
 *
 * Every run's summary must validate against the published schema
 * (`schema/checkride.summary.schema.json`) exactly — `additionalProperties` is
 * false, so adding a field without updating the schema (and the contract doc)
 * fails this build. That is the additive-only discipline made mechanical:
 * fields are added in lockstep with the schema, never renamed, removed, or
 * retyped without a `schema_version` bump.
 *
 * The contract doc's field tables are held to the same schema: each must name
 * exactly the properties of the object it describes, and say "always" for
 * exactly its required ones. A field added to the schema without a row in the
 * doc, or a row left behind for a field the schema dropped, fails here.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv } from 'ajv';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { SCHEMA_VERSION } from '../../src/adapters.js';
import { runCli } from '../../src/cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, '..', '..', 'schema', 'checkride.summary.schema.json');
const contractPath = join(here, '..', '..', 'docs', 'contract.md');

type ObjectSchema = { properties: Record<string, unknown>; required: string[] };
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as ObjectSchema & {
  definitions: Record<'check' | 'run' | 'git' | 'base', ObjectSchema>;
};

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);

function sink(): { write: (text: string) => boolean } {
  return { write: () => true };
}

/**
 * The rows of the contract doc's field table that follows `lead`: every
 * backticked name in a row's first cell, with that row's last cell (the
 * presence rule).
 */
function fieldTable(lead: string): { name: string; presence: string }[] {
  const doc = readFileSync(contractPath, 'utf8');
  const at = doc.indexOf(lead);
  expect(at, `no "${lead}" table in docs/contract.md`).toBeGreaterThan(-1);
  const lines = doc.slice(at).split('\n');
  const header = lines.findIndex((l) => l.startsWith('|'));
  const end = lines.findIndex((l, i) => i > header && !l.startsWith('|'));
  // Skip the header row and its `| --- |` separator.
  return lines.slice(header + 2, end === -1 ? undefined : end).flatMap((row) => {
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
    const presence = cells.at(-1) ?? '';
    return [...(cells[0] ?? '').matchAll(/`([^`]+)`/g)].map((m) => ({ name: m[1] ?? '', presence }));
  });
}

/** A custom check that does nothing for `ms`, on the given wave. */
function sleeper(ms: number, order = 1): Record<string, unknown> {
  return { command: 'node', args: ['-e', `setTimeout(() => {}, ${ms})`], order };
}

/** A custom check that exits with `code`. */
function exits(code: number, order = 1): Record<string, unknown> {
  return { command: 'node', args: ['-e', `process.exit(${code})`], order };
}

/** Run git in `dir` as a fixed identity with signing off, so a commit works on any machine; its trimmed stdout. */
function git(dir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=contract', '-c', 'user.email=contract@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
}

describe('docs/contract.md lists every summary field', () => {
  const tables = [
    ['top-level', '**Top-level fields.**', schema],
    ['run', '**`run` fields.**', schema.definitions.run],
    ['git', '**`git` fields.**', schema.definitions.git],
    ['git.base', '**`git.base` fields.**', schema.definitions.base],
    ['per-check', '**Per-check fields.**', schema.definitions.check],
  ] as const;

  for (const [label, lead, object] of tables) {
    test(`the ${label} table names exactly the schema's properties`, () => {
      const documented = fieldTable(lead).map((f) => f.name);
      expect(documented.toSorted()).toEqual(Object.keys(object.properties).toSorted());
    });

    test(`the ${label} table says "always" for exactly the schema's required fields`, () => {
      const always = fieldTable(lead).filter((f) => f.presence.startsWith('always')).map((f) => f.name);
      expect(always.toSorted()).toEqual(object.required.toSorted());
    });
  }
});

describe('summary.json shape', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-summary-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** Run with `env` alone as the environment checkride reads, so an exported `CHECKRIDE_*` can't leak in. */
  async function runAndValidate(argv: string[], env: Record<string, string> = {}): Promise<Record<string, unknown>> {
    await runCli(argv, { cwd: dir, stdout: sink(), stderr: sink(), env });
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as Record<string, unknown>;
    const valid = validate(summary);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
    return summary;
  }

  test('a green run with executed, skipped, and custom checks validates', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: {
        probe: { command: 'node', args: ['-e', 'process.exit(0)'] },
      },
    }));
    // The default run here executes `links` (built-in) + `probe`, and records
    // every undetected catalogue slot as skipped — all three entry kinds.
    const summary = await runAndValidate([]);
    expect(summary['schema_version']).toBe(SCHEMA_VERSION);
    expect(summary['checks_run']).toBe(2);
  });

  test('a failing run validates', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: {
        links: false,
        probe: { command: 'node', args: ['-e', 'process.exit(1)'] },
      },
    }));
    const summary = await runAndValidate([]);
    expect(summary['ok']).toBe(false);
  });

  /**
   * Contract: `origin` is present exactly when `adapter` isn't null, and
   * `detected_by` exactly when `origin` is `detected` (S21).
   */
  test('each check records why it runs, and a check with no adapter records nothing', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, '.markdownlint-cli2.jsonc'), '{}');
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: {
        struct: { command: 'node', args: ['-e', 'process.exit(0)'] },
        probe: { command: 'node', args: ['-e', 'process.exit(0)'] },
      },
    }));
    // Every slot but these sits out unresolved; docs is detected and left out by
    // --skip, so it never needs its tool installed.
    const summary = await runAndValidate(['--skip', 'docs']);
    const checks = summary['checks'] as { name: string; adapter: string | null; origin?: string; detected_by?: string }[];
    const byName = new Map(checks.map((c) => [c.name, c]));
    expect(byName.get('struct')).toMatchObject({ origin: 'config' });
    expect(byName.get('probe')).toMatchObject({ origin: 'custom' });
    expect(byName.get('links')).toMatchObject({ origin: 'built-in' });
    expect(byName.get('docs')).toMatchObject({ skipped: true, origin: 'detected', detected_by: '.markdownlint-cli2.jsonc' });
    for (const c of checks) {
      expect(c.origin !== undefined, c.name).toBe(c.adapter !== null);
      expect(c.detected_by !== undefined, c.name).toBe(c.origin === 'detected');
    }
  });

  /**
   * Contract: `argv` is present exactly when the check spawned its own tool,
   * as spawned, and absent on built-ins and on every skipped entry, a custom
   * check that skipped itself included (R8.2).
   */
  test('a check that spawned its tool records its argv, and built-ins and skipped checks record none', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: {
        probe: { command: 'node', args: ['-e', 'process.exit(0)', 'two words'] },
        licenses: { command: 'node', args: ['-e', 'process.exit(77)'], skipExitCode: 77 },
      },
    }));
    const summary = await runAndValidate([]);
    const checks = summary['checks'] as { name: string; skipped?: boolean; argv?: string[] }[];
    const byName = new Map(checks.map((c) => [c.name, c]));
    expect(byName.get('probe')?.argv).toEqual(['node', '-e', 'process.exit(0)', 'two words']);
    expect(byName.get('links')).not.toHaveProperty('argv');
    expect(byName.get('licenses')).toMatchObject({ skipped: true });
    for (const c of checks.filter((check) => check.skipped === true)) expect(c, c.name).not.toHaveProperty('argv');
  });

  test('argv is the spawned form, after package-manager translation', async () => {
    // The build adapter's canonical `pnpm run build` spawns as `npm run build`
    // in a repo whose lockfile says npm.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract', scripts: { build: 'node -e ""' } }));
    await writeFile(join(dir, 'package-lock.json'), '{}');
    const summary = await runAndValidate(['--only', 'build']);
    const build = (summary['checks'] as { name: string; argv?: string[] }[]).find((c) => c.name === 'build');
    expect(build).toMatchObject({ ok: true, argv: ['npm', 'run', 'build'] });
  }, 30_000);

  test('a vacuous (zero-run) summary validates and says so', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ checks: { links: false } }));
    const summary = await runAndValidate([]);
    expect(summary).toMatchObject({ ok: true, checks_run: 0 });
  });

  /**
   * Contract: `run` records each selection flag the run was given and nothing
   * for one it wasn't, with `partial` true when one narrowed the run (R8.1).
   * The orchestrator suite holds `partial` equal to the ratchet's own test.
   */
  test.each([
    { argv: [], run: { partial: false } },
    { argv: ['--only', 'probe'], run: { partial: true, only: ['probe'] } },
    { argv: ['--skip', 'links'], run: { partial: true, skip: ['links'] } },
    { argv: ['--include', 'format'], run: { partial: false, include: ['format'] } },
    { argv: ['--changed'], run: { partial: true, changed: true } },
  ])('a run given $argv records run as $run, and no git outside a work tree', async ({ argv, run }) => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ checks: { probe: exits(0) } }));
    const summary = await runAndValidate(argv);
    expect(summary['run']).toEqual(run);
    expect(summary['git']).toBeUndefined();
  });

  test('run records the config file the flag or the variable named, as an absolute path', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'ci.json'), JSON.stringify({ checks: { probe: exits(0) } }));
    const config = join(dir, 'ci.json');
    expect((await runAndValidate(['--config', 'ci.json']))['run']).toEqual({ partial: false, config });
    expect((await runAndValidate([], { CHECKRIDE_CONFIG: 'ci.json' }))['run']).toEqual({ partial: false, config });
  });

  test('a --bail run is partial when it stops at a failure, and whole when nothing fails', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    const config = join(dir, 'checkride.config.json');
    await writeFile(config, JSON.stringify({ checks: { links: false, first: exits(1, 1), second: exits(0, 2) } }));
    expect((await runAndValidate(['--bail']))['run']).toEqual({ partial: true });
    await writeFile(config, JSON.stringify({ checks: { links: false, first: exits(0, 1), second: exits(0, 2) } }));
    expect((await runAndValidate(['--bail']))['run']).toEqual({ partial: false });
  });

  /** A repo with one commit, `.check/` ignored as `init` writes it; its head sha. */
  async function committedRepo(): Promise<string> {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ checks: { links: false, probe: exits(0) } }));
    await writeFile(join(dir, '.gitignore'), '.check/\n');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--no-verify', '-m', 'contract');
    return git(dir, 'rev-parse', 'HEAD');
  }

  /** Contract: a run in a git work tree records the commit it read and whether the tree held changes (R8.1). */
  test('a run in a git work tree records its head, and dirty once the tree holds a change', async () => {
    const head = await committedRepo();
    expect((await runAndValidate([]))['git']).toEqual({ head, dirty: false });
    await writeFile(join(dir, 'new.ts'), 'export const x = 1;\n');
    expect((await runAndValidate([]))['git']).toEqual({ head, dirty: true });
  });

  test('under --changed, git records the base the run measured from', async () => {
    const head = await committedRepo();
    const summary = await runAndValidate(['--changed', '--base', 'HEAD']);
    expect(summary['git']).toEqual({ head, dirty: false, base: { ref: 'HEAD', sha: head } });
  });

  test('a bare repository has no work tree, so it records no git, even when --changed resolves a base', async () => {
    await committedRepo();
    git(dir, 'clone', '-q', '--bare', '.', 'bare.git');
    const bare = join(dir, 'bare.git');
    await runCli(['--changed', '--base', 'HEAD'], { cwd: bare, stdout: sink(), stderr: sink(), env: {} });
    const summary = JSON.parse(await readFile(join(bare, '.check', 'summary.json'), 'utf8')) as Record<string, unknown>;
    expect(validate(summary)).toBe(true);
    expect(summary['run']).toEqual({ partial: true, changed: true });
    expect(summary['git']).toBeUndefined();
  });

  test('a repository with no commit yet records no git', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ checks: { probe: exits(0) } }));
    git(dir, 'init', '-q', '-b', 'main');
    const summary = await runAndValidate([]);
    expect(summary['run']).toEqual({ partial: false });
    expect(summary['git']).toBeUndefined();
  });

  test('the schema version constant is 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  /**
   * Contract: `total_duration_ms` is the run's **wall-clock** span, not the sum
   * of the per-check durations. Consumers derive the run's start from it
   * (`timestamp - total_duration_ms`) to judge whether a `.check/` artifact
   * belongs to this run — checkride's own readers included, in
   * `src/artifacts/freshness.ts`. Under sum semantics that window opens far too
   * early and stale artifacts read as fresh.
   *
   * ajv can only validate the *shape*, so nothing caught the published schema
   * describing this field as a sum for several releases while the code and
   * docs/contract.md said wall-clock. This pins the semantics: revert to a sum
   * and the description is no longer the only thing that has to change.
   */
  test('total_duration_ms is wall-clock, not the sum of per-check durations', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    // Three sleepers in one wave. Run concurrently the wall-clock is ~one
    // sleep; summed it is ~three.
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: { links: false, a: sleeper(600), b: sleeper(600), c: sleeper(600) },
    }));

    await runCli(['--concurrency', '3'], { cwd: dir, stdout: sink(), stderr: sink() });
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as {
      total_duration_ms: number;
      checks: { name: string; duration_ms: number; skipped?: boolean }[];
    };

    const ran = summary.checks.filter((c) => c.skipped !== true);
    const summed = ran.reduce((n, c) => n + c.duration_ms, 0);
    expect(ran).toHaveLength(3);
    expect(summed).toBeGreaterThan(1500); // the three really did sleep
    expect(summary.total_duration_ms).toBeLessThan(summed);
  }, 30_000);

  test('total_duration_ms equals the summed durations when execution is sequential', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: { links: false, a: sleeper(150, 1), b: sleeper(150, 2) },
    }));
    await runCli(['--concurrency', '1'], { cwd: dir, stdout: sink(), stderr: sink() });
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as {
      total_duration_ms: number;
      checks: { duration_ms: number; skipped?: boolean }[];
    };
    const summed = summary.checks
      .filter((c) => c.skipped !== true)
      .reduce((n, c) => n + c.duration_ms, 0);
    // Equal but for the scheduling overhead between the two waves.
    expect(summary.total_duration_ms).toBeGreaterThanOrEqual(summed);
    expect(summary.total_duration_ms - summed).toBeLessThan(250);
  }, 30_000);
});

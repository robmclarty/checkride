/**
 * `doctor`'s row for the `schema` slot: not configured, ready with the
 * versions a run would load, or which library is missing with the command
 * that installs it; and in the standalone binary, ready with the bundled
 * versions.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { clearBundledLibraries, installLibraries, registerBundledLibraries, stubLibrary } from '../../../test/helpers/schema-libraries.js';
import { fakeSea } from '../../../test/helpers/sea.js';
import { ADAPTERS, SLOTS } from '../../adapters.js';
import { runCli } from '../../cli.js';
import type { CheckrideConfig } from '../../config.js';
import type { DoctorCheck, DoctorEnv } from '../../doctor.js';
import { runDoctor } from '../../doctor.js';
import { suiteNamed } from '../../suite.js';
import { probeSchemaLibraries } from '../probe.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'checkride-schema-doctor-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  clearBundledLibraries();
  await rm(dir, { recursive: true, force: true });
});

const sink = (): { write: (text: string) => boolean } => ({ write: () => true });

/** An environment in which everything but the slot's libraries is as a run needs it. */
function env(over: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    which: (cmd: string) => Promise.resolve(`/usr/bin/${cmd}`),
    version: () => Promise.resolve('99.9.9'),
    binPath: () => Promise.resolve(null),
    exists: () => true,
    readText: () => '{"schema_version":1,"slots":{}}',
    canWrite: () => Promise.resolve(true),
    readEngines: () => ({ node: '>=22.18.0', pnpm: '>=9.0.0' }),
    platform: () => ({ os: 'linux', arch: 'x64' }),
    packageManager: () => 'npm',
    miseWhere: () => Promise.resolve({ ok: true, stdout: '' }),
    launch: (_slot: string, command: string, args: readonly string[]) => ({ command, args: [...args] }),
    ...over,
  };
}

const RULES = [{ files: ['skills/*/SKILL.md'], schema: 'checkride:agent-skill' }, { files: ['data/*.json'], schema: 's.json' }];

/** The slot's row of a `doctor` report on `config`. */
async function row(config: CheckrideConfig | null, over: Partial<DoctorEnv> = {}): Promise<DoctorCheck | undefined> {
  const { report } = await runDoctor({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config, env: env(over), stdout: sink(), json: true });
  return report.checks.find((c) => c.slot === 'schema');
}

describe("doctor's schema row", () => {
  test('not configured: a repo with no rules is told what switches it on, and nothing fails for it', async () => {
    for (const config of [null, {}, { schemas: [] }]) {
      expect(await row(config)).toMatchObject({
        name: 'schema',
        category: 'tool',
        required: false,
        status: 'n/a',
        enablement: 'unavailable',
        found: 'not configured',
        hint: 'It runs only when checkride.config.json declares schemas.',
      });
    }
  });

  test('ready: the versions of the libraries its rules need, from the repo', async () => {
    await installLibraries(dir, ['ajv']);
    await stubLibrary(dir, 'yaml', '2.4.0');
    const found = await row({ schemas: RULES });
    expect(found).toMatchObject({ name: 'schema (schema)', required: true, status: 'ok', enablement: 'default', expected: 'ajv 8.x, yaml 2.x', hint: null, origin: 'built-in' });
    expect(found?.found).toMatch(/^ajv 8\.\d+\.\d+, yaml 2\.4\.0$/);
  });

  test('missing: which library, and the install command under the repo\'s package manager', async () => {
    await installLibraries(dir, ['ajv']);
    expect(await row({ schemas: RULES })).toMatchObject({
      required: true,
      status: 'missing',
      found: null,
      expected: 'ajv 8.x, yaml 2.x',
      hint: 'the `schema` slot needs `yaml`, which is not installed in this project: run `npm install -D yaml@^2`.',
    });
  });

  test('a missing library fails the report, since the default run would fail on it', async () => {
    const { ok, exitCode } = await runDoctor({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: { schemas: RULES }, env: env(), stdout: sink(), json: true });
    expect({ ok, exitCode }).toEqual({ ok: false, exitCode: 1 });
  });

  test('a json-only config asks for ajv alone', async () => {
    await installLibraries(dir, ['ajv']);
    expect(await row({ schemas: [{ files: ['data/*.json'], schema: 's.json' }] })).toMatchObject({ status: 'ok', expected: 'ajv 8.x' });
  });

  test('an opt-in schema with a missing library is shown, and fails nothing', async () => {
    const found = await row({ schemas: RULES, checks: { schema: { optIn: true } } });
    expect(found).toMatchObject({ required: false, status: 'missing', enablement: 'opt-in' });
    expect(found?.hint).toContain('--include schema');
  });

  test('switched off in the config, it reads as any disabled slot does', async () => {
    expect(await row({ schemas: RULES, checks: { schema: false } })).toMatchObject({ status: 'n/a', enablement: 'disabled' });
  });

  test("in a Yarn Plug'n'Play repo the row says what the run says: node_modules is where it reads, and PnP writes none", async () => {
    await writeFile(join(dir, '.pnp.cjs'), '');
    const found = await row({ schemas: RULES }, { packageManager: () => 'yarn' });
    expect(found).toMatchObject({ status: 'missing', found: null });
    expect(found?.hint).toBe(
      "the `schema` slot reads `ajv` and `yaml` from node_modules, which Yarn Plug'n'Play doesn't write: run the standalone checkride binary, which bundles them, or set `nodeLinker: node-modules` in .yarnrc.yml.",
    );
  });

  test('under --static-only a missing library is the skip the run gives, word for word, and fails nothing', async () => {
    const config = { schemas: RULES, checks: { links: false as const } };
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify(config));
    const { report } = await runDoctor({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config, env: env(), stdout: sink(), json: true, staticOnly: true });
    const found = report.checks.find((c) => c.slot === 'schema');
    const skip = 'static-only: needs an install (the `schema` slot needs `ajv` and `yaml`, which are not installed in this project: run `npm install -D ajv@^8 yaml@^2`)';
    expect(found).toMatchObject({ status: 'n/a', required: false, skip });

    // The run of the same repo, under the same flag.
    await writeFile(join(dir, 'package-lock.json'), '{}');
    const code = await runCli(['--static-only', '--only', 'schema'], { cwd: dir, stdout: sink(), stderr: sink(), env: {} });
    expect(code).toBe(0);
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as { checks: { name: string; reason?: string }[] };
    expect(summary.checks.find((c) => c.name === 'schema')?.reason).toBe(skip);
  });

  test('under --static-only with the libraries there, the row is ready as in any run', async () => {
    await installLibraries(dir, ['ajv', 'yaml']);
    const { report } = await runDoctor({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: { schemas: RULES }, env: env(), stdout: sink(), json: true, staticOnly: true });
    expect(report.checks.find((c) => c.slot === 'schema')).toMatchObject({ status: 'ok' });
  });

  test("a named suite's row follows the suite's own rules, and a suite without any has no row", async () => {
    await installLibraries(dir, ['ajv']);
    await writeFile(join(dir, 'checkride.evals.config.json'), '{}');
    const of = async (config: CheckrideConfig): Promise<DoctorCheck | undefined> => {
      const { report } = await runDoctor({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config, suite: suiteNamed('evals'), env: env(), stdout: sink(), json: true });
      return report.checks.find((c) => c.slot === 'schema');
    };
    expect(await of({ schemas: [{ files: ['labels/*.json'], schema: 's.json' }] })).toMatchObject({ status: 'ok', expected: 'ajv 8.x' });
    expect(await of({ checks: { probe: { command: 'node' } } })).toBeUndefined();
  });

  test('the table names the row like any other', async () => {
    await installLibraries(dir, ['ajv']);
    let text = '';
    await runDoctor({ cwd: dir, slots: SLOTS, adapters: ADAPTERS, config: { schemas: [{ files: ['a.json'], schema: 's.json' }] }, env: env(), stdout: { write: (t) => { text += t; return true; } } });
    expect(text).toMatch(/✔ schema\s+schema\s+default\s+installed\s+\[built-in\]/);
  });
});

describe('in the standalone binary', () => {
  beforeEach(async () => {
    fakeSea();
    await registerBundledLibraries();
  });

  test('ready with the bundled versions, in a repo with nothing installed', async () => {
    const found = await row({ schemas: [...RULES, { files: ['c.jsonc'], schema: 's.json' }] });
    expect(found).toMatchObject({ status: 'ok', required: true, hint: null });
    expect(found?.found).toMatch(/^bundled: ajv 8\.\d+\.\d+, yaml 2\.\d+\.\d+, jsonc-parser 3\.\d+\.\d+$/);
  });
});

describe('probeSchemaLibraries', () => {
  test('asks for the libraries of the rules it is given, through the lookup it is handed', () => {
    const asked: string[] = [];
    const probe = probeSchemaLibraries(RULES, { repo: '/repo', pm: 'pnpm' }, (rules, repo) => {
      asked.push(`${rules.length} rules in ${repo}`);
      return [{ name: 'ajv', version: '8.1.0', problem: null }, { name: 'yaml', version: '1.10.2', problem: 'unsupported' }];
    });
    expect(asked).toEqual(['2 rules in /repo']);
    expect(probe).toEqual({
      status: 'missing',
      found: null,
      expected: 'ajv 8.x, yaml 2.x',
      hint: 'the `schema` slot needs `yaml` 2 (this project installs 1.10.2): run `pnpm add -D yaml@^2`.',
    });
  });
});

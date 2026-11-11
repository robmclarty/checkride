/**
 * The standalone binary's differences (R14.1), in config and doctor, each asked
 * through `../channel.js`: `node:sea` is faked to say this process is the binary, so
 * these run the same code the binary runs without building one. The built
 * binary itself is exercised by `test/e2e/binary.e2e.test.ts`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { fakeSea } from '../../test/helpers/sea.js';
import { loadConfig } from '../config.js';
import type { DoctorEnv } from '../doctor.js';
import { runDoctor } from '../doctor.js';

let sea: ReturnType<typeof fakeSea>;
let dir: string;

beforeEach(async () => {
  sea = fakeSea();
  dir = await mkdtemp(join(tmpdir(), 'checkride-binary-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function write(file: string, config: unknown): Promise<void> {
  await writeFile(join(dir, file), JSON.stringify(config));
}

describe('extends in the binary', () => {
  test('a package preset is refused, naming the npm distribution', async () => {
    await write('checkride.config.json', { extends: '@acme/preset' });
    expect(() => loadConfig(dir)).toThrow(
      'invalid checkride.config.json: package presets need the npm distribution; use a file path: extends "@acme/preset" (in checkride.config.json)',
    );
  });

  test('a bare name is a package too, and the error names a suite’s own config file', async () => {
    await write('checkride.evals.config.json', { extends: ['./base.json', 'acme-preset'] });
    await write('base.json', { timeout: 5 });
    expect(() => loadConfig(dir, undefined, 'checkride.evals.config.json')).toThrow(
      'invalid checkride.evals.config.json: package presets need the npm distribution; use a file path: extends "acme-preset" (in checkride.evals.config.json)',
    );
  });

  test('a package preset three files down a chain is named with the file that holds it', async () => {
    await write('checkride.config.json', { extends: './org.json' });
    await write('org.json', { extends: './team.json' });
    await write('team.json', { extends: '@acme/preset' });
    expect(() => loadConfig(dir)).toThrow(
      /^invalid checkride\.config\.json: package presets need the npm distribution; use a file path: extends "@acme\/preset" \(in \S*team\.json\)$/,
    );
  });

  test('file paths resolve as they do from npm: relative, parent-relative and absolute', async () => {
    await write('checkride.config.json', { extends: ['./base.json', join(dir, 'abs.json')], timeout: 7 });
    await write('base.json', { checks: { hello: { command: 'echo' } } });
    await write('abs.json', { checks: { bye: { command: 'echo' } } });
    const config = loadConfig(dir);
    expect(config?.timeout).toBe(7);
    expect(Object.keys(config?.checks ?? {})).toEqual(['hello', 'bye']);
  });

  test('npm resolves a package preset as it always has, and fails on the missing package, not the channel', async () => {
    sea.binary = false;
    await write('checkride.config.json', { extends: '@acme/preset' });
    expect(() => loadConfig(dir)).toThrow(/cannot resolve extends "@acme\/preset"/);
  });
});

function fakeEnv(over: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    which: (cmd: string) => Promise.resolve(`/usr/bin/${cmd}`),
    version: () => Promise.resolve('99.9.9'),
    binPath: () => Promise.resolve(null),
    exists: () => false,
    readText: () => null,
    canWrite: () => Promise.resolve(true),
    readEngines: () => ({}),
    platform: () => ({ os: 'linux', arch: 'x64' }),
    packageManager: () => 'pnpm',
    miseWhere: () => Promise.resolve({ ok: true, stdout: '' }),
    launch: (_slot: string, command: string, args: readonly string[]) => ({ command, args: [...args] }),
    ...over,
  };
}

function sink(): { write: (s: string) => boolean; text: () => string } {
  let buffer = '';
  return { write: (s) => { buffer += s; return true; }, text: () => buffer };
}

async function doctor(env: DoctorEnv, json = false): Promise<{ text: string; result: Awaited<ReturnType<typeof runDoctor>> }> {
  const stdout = sink();
  const result = await runDoctor({ cwd: dir, slots: [], adapters: [], config: null, env, stdout, json });
  return { text: stdout.text(), result };
}

describe('doctor’s channel', () => {
  test('the binary names itself and the Node it embeds, in the table and the report', async () => {
    const { text, result } = await doctor(fakeEnv());
    expect(text).toContain(`  package manager: pnpm (detected)\n  channel: binary (embedded Node ${process.versions.node})\n`);
    expect(result.report.channel).toBe('binary');
    expect(result.report.embeddedNode).toBe(process.versions.node);
  });

  test('npm names itself and no embedded Node', async () => {
    sea.binary = false;
    const { text, result } = await doctor(fakeEnv(), true);
    const report: Record<string, unknown> = JSON.parse(text);
    expect(report['channel']).toBe('npm');
    expect('embeddedNode' in report).toBe(false);
    expect(result.report.channel).toBe('npm');
    const table = await doctor(fakeEnv());
    expect(table.text).toContain('  package manager: pnpm (detected)\n  channel: npm\n');
  });

  test('the binary fails nothing for a PATH without node: it runs on its own', async () => {
    const missing = fakeEnv({ which: (cmd: string) => Promise.resolve(cmd === 'node' ? null : `/usr/bin/${cmd}`) });
    const { result } = await doctor(missing);
    expect(result.report.checks.find((c) => c.name === 'node')).toEqual({
      name: 'node', category: 'env', required: false, status: 'n/a',
      found: `not on PATH (checkride embeds Node ${process.versions.node})`, expected: null, hint: null,
    });
    expect(result.exitCode).toBe(0);
  });

  test('the binary still holds a node that is on PATH to the repo’s engines', async () => {
    const { result } = await doctor(fakeEnv({ version: () => Promise.resolve('18.0.0') }));
    expect(result.report.checks.find((c) => c.name === 'node')).toMatchObject({ required: true, status: 'outdated', found: '18.0.0' });
  });

  test('npm still fails for a PATH without node', async () => {
    sea.binary = false;
    const missing = fakeEnv({ which: (cmd: string) => Promise.resolve(cmd === 'node' ? null : `/usr/bin/${cmd}`) });
    const { result } = await doctor(missing);
    expect(result.report.checks.find((c) => c.name === 'node')).toMatchObject({ required: true, status: 'missing' });
    expect(result.exitCode).toBe(1);
  });
});

/** An environment that counts each `which`, over a repo that pins Node 22.22.3 and has no install of it. */
function counting(node: string | null): { env: DoctorEnv; asked: () => number } {
  let asked = 0;
  const env = fakeEnv({
    which: (cmd: string) => {
      if (cmd === 'node') asked += 1;
      return Promise.resolve(cmd === 'node' && node === null ? null : `/usr/bin/${cmd}`);
    },
    version: (cmd: string) => Promise.resolve(cmd === 'node' ? `v${node}` : '99.9.9'),
    readEngines: () => ({ node: '>=22.18.0' }),
  });
  return { env, asked: () => asked };
}

/** The hint on doctor's `harness` row, in a repo with no package.json and no pin. */
async function harnessHint(): Promise<string> {
  return (await doctor(fakeEnv())).result.report.checks.find((c) => c.name === 'harness')?.hint ?? '';
}

describe('doctor in the binary: one node lookup, and the repo’s Node is PATH’s', () => {

  beforeEach(async () => {
    await writeFile(join(dir, '.nvmrc'), '22.22.3\n');
  });

  test('node is looked up once when PATH holds it, and the pin hint names PATH’s version, never the embedded one', async () => {
    const { env, asked } = counting('24.15.0');
    const { result } = await doctor(env);
    expect(asked()).toBe(1);
    expect(result.report.checks.find((c) => c.name === 'node')).toMatchObject({ required: true, status: 'ok', found: '24.15.0' });
    const hint = result.report.checks.find((c) => c.name === 'node pin')?.hint ?? '';
    expect(hint).toContain("not this shell's (24.15.0)");
  });

  test('node is looked up once when PATH holds none, and the pin hint claims no Node', async () => {
    const { env, asked } = counting(null);
    const { result } = await doctor(env);
    expect(asked()).toBe(1);
    expect(result.report.checks.find((c) => c.name === 'node')).toMatchObject({ required: false, status: 'n/a' });
    const hint = result.report.checks.find((c) => c.name === 'node pin')?.hint ?? '';
    expect(hint).toContain("not this shell's (which has none on PATH)");
    expect(hint).not.toContain(process.versions.node);
  });

  test('the harness row recommends the pin that installs a binary, and npm’s recommends npm’s', async () => {
    expect(await harnessHint()).toContain('Pin it with `mise use github:robmclarty/checkride@<version>`');
    expect(await harnessHint()).not.toContain('npm:checkride');
    sea.binary = false;
    expect(await harnessHint()).toContain("Pin it with `mise use 'npm:checkride[allow_low_downloads=true]@<version>'`");
  });
});

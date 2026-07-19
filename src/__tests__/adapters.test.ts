import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ADAPTERS, SCHEMA_VERSION, SLOTS } from '../adapters.js';
import type { Adapter } from '../adapters.js';
import type { Out } from '../orchestrator.js';
import { runChecks } from '../orchestrator.js';

/** Discards output — the run's own stdout/stderr aren't under test here. */
const sink = (): Out => ({ write: () => true });

// A command that outlives a short config-level cap. Under the cap it is killed
// (exit -1); an adapter `timeout: 0` overrides the cap so it runs to completion.
const sleeper = (over: Partial<Adapter>): Adapter => ({
  name: 'sleep', slot: 'sleep', description: 'sleep', detect: [], outputFile: null, devDeps: {},
  command: 'node', args: ['-e', 'setTimeout(() => process.exit(0), 600)'], ...over,
});

describe('registry invariants', () => {
  test('schema version is 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  test('every adapter targets a catalogue slot', () => {
    const slotNames = new Set(SLOTS.map((s) => s.name));
    for (const adapter of ADAPTERS) {
      expect(slotNames.has(adapter.slot)).toBe(true);
    }
  });

  test('the first adapter for each slot is the blessed default', () => {
    const blessed: Record<string, string> = {
      types: 'tsc', format: 'prettier', lint: 'oxlint', struct: 'ast-grep', dead: 'fallow',
      dupes: 'fallow', health: 'fallow', test: 'vitest',
      docs: 'markdownlint-cli2', links: 'links', spell: 'cspell', mutation: 'stryker', security: 'pnpm-audit',
      build: 'build', publint: 'publint', attw: 'attw', pack: 'pack', smoke: 'smoke', snippets: 'snippets',
    };
    for (const slot of SLOTS) {
      const first = ADAPTERS.find((a) => a.slot === slot.name);
      expect(first?.name).toBe(blessed[slot.name]);
    }
  });

  test('alternates are wired after the blessed default for swappable slots', () => {
    const names = (slot: string): string[] => ADAPTERS.filter((a) => a.slot === slot).map((a) => a.name);
    expect(names('format')).toEqual(['prettier', 'biome-format']);
    expect(names('lint')).toEqual(['oxlint', 'biome', 'eslint']);
    expect(names('dead')).toEqual(['fallow', 'knip']);
    expect(names('test')).toEqual(['vitest', 'jest']);
  });

  test('the three fallow analyses fill dead/dupes/health, each checkride-gated', () => {
    const fallow = ADAPTERS.filter((a) => a.name === 'fallow');
    expect(fallow.map((a) => a.slot)).toEqual(['dead', 'dupes', 'health']);
    for (const a of fallow) {
      expect(a.gate).toBe('fallow');
      expect(a.detect).toEqual(['fallow.toml']);
      expect(a.args).toContain('--format');
      expect(a.devDeps).toEqual({ fallow: '3.5.0' });
    }
    // dupes/health are opt-in so adopting checkride never fails a repo on
    // duplication/complexity it never signed up for.
    for (const name of ['dupes', 'health']) {
      expect(SLOTS.find((s) => s.name === name)?.optIn).toBe(true);
    }
  });

  test('format is an opt-in slot positioned before lint', () => {
    const names = SLOTS.map((s) => s.name);
    expect(SLOTS.find((s) => s.name === 'format')?.optIn).toBe(true);
    expect(names.indexOf('format')).toBeLessThan(names.indexOf('lint'));
  });

  test('opt-in slots are format + fallow dupes/health + the trailing build/mutation/security/publint/attw/pack/smoke/snippets', () => {
    expect(SLOTS.filter((s) => s.optIn).map((s) => s.name)).toEqual([
      'format', 'dupes', 'health', 'mutation', 'security', 'build', 'publint', 'attw', 'pack', 'smoke', 'snippets',
    ]);
    expect(SLOTS.slice(-5).map((s) => s.name)).toEqual(['publint', 'attw', 'pack', 'smoke', 'snippets']);
  });

  test('the library-publishing slots are opt-in with JSON-capturing attw', () => {
    for (const name of ['publint', 'attw']) {
      expect(SLOTS.find((s) => s.name === name)?.optIn).toBe(true);
    }
    const attw = ADAPTERS.find((a) => a.name === 'attw');
    expect(attw?.slot).toBe('attw');
    expect(attw?.args).toEqual(['exec', 'attw', '--pack', '.', '--format', 'json']);
    expect(attw?.outputFile).toBe('attw.json');
    const publint = ADAPTERS.find((a) => a.name === 'publint');
    expect(publint?.slot).toBe('publint');
    expect(publint?.args).toEqual(['exec', 'publint']);
  });

  test('the blessed format adapter wires a prettier --check with a --write fix', () => {
    const prettier = ADAPTERS.find((a) => a.name === 'prettier');
    expect(prettier?.slot).toBe('format');
    expect(prettier?.detect).toContain('.prettierrc.json');
    expect(prettier?.args).toEqual(['exec', 'prettier', '--check', '.']);
    expect(prettier?.fixArgs).toEqual(['exec', 'prettier', '--write', '.']);
  });

  test('links, pack, smoke, and the two snippets adapters are the built-ins', () => {
    const builtins = ADAPTERS.filter((a) => a.builtin);
    expect(builtins.map((a) => a.name)).toEqual(['links', 'pack', 'smoke', 'snippets', 'snippets-dist']);
  });

  test('the smoke slot is an opt-in wave-20 built-in on a node liveness probe (D9)', () => {
    expect(SLOTS.find((s) => s.name === 'smoke')?.optIn).toBe(true);
    expect(SLOTS.find((s) => s.name === 'smoke')?.order).toBe(20);
    const smoke = ADAPTERS.find((a) => a.name === 'smoke');
    expect(smoke?.slot).toBe('smoke');
    expect(smoke?.builtin).toBe('smoke');
    expect(smoke?.outputFile).toBe('smoke.json');
    expect(smoke?.devDeps).toEqual({});
    // Spawns a plain `node` (PM-agnostic, available everywhere) like `links`.
    expect(smoke?.command).toBe('node');
  });

  test('the pack slot is an opt-in wave-20 built-in on the npm/pnpm pack dry-run (D10)', () => {
    expect(SLOTS.find((s) => s.name === 'pack')?.optIn).toBe(true);
    expect(SLOTS.find((s) => s.name === 'pack')?.order).toBe(20);
    const pack = ADAPTERS.find((a) => a.name === 'pack');
    expect(pack?.slot).toBe('pack');
    expect(pack?.builtin).toBe('pack');
    expect(pack?.outputFile).toBe('pack.json');
    expect(pack?.devDeps).toEqual({});
    // The availability signature (`isAvailableUnder` reads command + args[0]).
    expect(pack?.command).toBe('pnpm');
    expect(pack?.args[0]).toBe('pack');
  });

  test('D4 wave defaults: mutation runs single, build wave 10, publint/attw/pack/smoke share wave 20, the rest default to any', () => {
    const orderOf = (name: string) => SLOTS.find((s) => s.name === name)?.order;
    expect(orderOf('mutation')).toBe('single');
    expect(orderOf('build')).toBe(10);
    expect(orderOf('publint')).toBe(20);
    expect(orderOf('attw')).toBe(20);
    expect(orderOf('pack')).toBe(20);
    expect(orderOf('smoke')).toBe(20);
    // The snippets slot itself stays 'any' (D4) — snippets-dist's wave 20 is an
    // adapter-level override, not a slot default (D12).
    expect(orderOf('snippets')).toBeUndefined();
    // Every other catalogue slot omits `order`, i.e. defers to the 'any' default.
    const carriesOrder = new Set(['mutation', 'build', 'publint', 'attw', 'pack', 'smoke']);
    for (const slot of SLOTS) {
      if (!carriesOrder.has(slot.name)) expect(slot.order).toBeUndefined();
    }
  });

  test('snippets ships two adapters on one slot; only snippets-dist pins an adapter-level order (D12)', () => {
    const snippetAdapters = ADAPTERS.filter((a) => a.slot === 'snippets');
    expect(snippetAdapters.map((a) => a.name)).toEqual(['snippets', 'snippets-dist']);
    expect(snippetAdapters.find((a) => a.name === 'snippets')?.order).toBeUndefined();
    expect(snippetAdapters.find((a) => a.name === 'snippets-dist')?.order).toBe(20);
    // Every other adapter still carries no order override.
    for (const adapter of ADAPTERS) {
      if (adapter.name !== 'snippets-dist') expect(adapter.order).toBeUndefined();
    }
  });

  test('the build slot spawns the consumer build script, detected via scripts.build (D13/D18)', () => {
    expect(SLOTS.find((s) => s.name === 'build')?.optIn).toBe(true);
    const build = ADAPTERS.find((a) => a.name === 'build');
    expect(build?.slot).toBe('build');
    expect(build?.command).toBe('pnpm');
    expect(build?.args).toEqual(['run', 'build']);
    expect(build?.detect).toEqual([]);
    expect(build?.detectScript).toBe('build');
    expect(build?.devDeps).toEqual({});
  });

  test('detectDeps is populated only on the configless-capable adapters (D18)', () => {
    const withDeps = ADAPTERS.filter((a) => a.detectDeps !== undefined).map((a) => a.name);
    expect(withDeps).toEqual(['prettier', 'oxlint', 'knip', 'vitest', 'cspell']);
    for (const name of withDeps) {
      // Each names its own package as the dependency signal.
      expect(ADAPTERS.find((a) => a.name === name)?.detectDeps).toEqual([name]);
    }
  });

  test('the stryker adapter ships uncapped (timeout: 0) — the one catalogue default (D4)', () => {
    expect(ADAPTERS.find((a) => a.name === 'stryker')?.timeout).toBe(0);
    // No other adapter pins a timeout; the rest defer to the config/600s default.
    for (const adapter of ADAPTERS) {
      if (adapter.name !== 'stryker') expect(adapter.timeout).toBeUndefined();
    }
  });
});

describe('adapter timeout: 0 runs uncapped', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-timeout-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('an adapter timeout of 0 beats and disables a shorter config cap', async () => {
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'sleep' }], adapters: [sleeper({ timeout: 0 })],
      config: { timeout: 0.2 }, json: true, stdout: sink(), stderr: sink(),
    });
    expect(result.summary.checks[0]).toMatchObject({ ok: true, exit_code: 0 });
  }, 15_000);

  test('the same command IS killed when it inherits the short config cap (control)', async () => {
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'sleep' }], adapters: [sleeper({})],
      config: { timeout: 0.2 }, json: true, stdout: sink(), stderr: sink(),
    });
    expect(result.summary.checks[0]).toMatchObject({ ok: false, exit_code: -1 });
  }, 15_000);
});

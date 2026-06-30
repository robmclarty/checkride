import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ADAPTERS, SLOTS } from '../adapters.js';
import type { CheckrideConfig, CustomCheck, SlotConfig, UseConfig } from '../config.js';
import { loadConfig, resolveChecks } from '../config.js';

const never = (): boolean => false;
const present = (...files: string[]) => (f: string): boolean => files.includes(f);

function resolveSlot(
  slotName: string,
  config: CheckrideConfig | null,
  fileExists: (f: string) => boolean,
) {
  const slots = SLOTS.filter((s) => s.name === slotName);
  const [resolved] = resolveChecks({ slots, adapters: ADAPTERS, config, fileExists });
  if (!resolved) throw new Error(`no resolution for ${slotName}`);
  return resolved;
}

describe('detection (no config)', () => {
  test('picks the blessed adapter when its config file is present', () => {
    const r = resolveSlot('lint', null, present('.oxlintrc.json'));
    expect(r.adapter?.name).toBe('oxlint');
    expect(r.skip).toBeNull();
  });

  test('skips a slot with no detectable tool', () => {
    const r = resolveSlot('lint', null, never);
    expect(r.adapter).toBeNull();
    expect(r.skip).toBe('no tool detected for slot');
  });

  test('a built-in (empty detect) is always available', () => {
    const r = resolveSlot('links', null, never);
    expect(r.adapter?.name).toBe('links');
  });

  test('propagates opt-in from the slot catalogue', () => {
    const r = resolveSlot('mutation', null, never);
    expect(r.optIn).toBe(true);
    expect(r.skip).toBe('no tool detected for slot');
  });
});

describe('config resolution', () => {
  test('false disables the slot even when a tool is present', () => {
    const r = resolveSlot('lint', { checks: { lint: false } }, present('.oxlintrc.json'));
    expect(r.skip).toBe('disabled in checkride.config.json');
  });

  test('a string selects an adapter, beating detection', () => {
    const r = resolveSlot('lint', { checks: { lint: 'oxlint' } }, never);
    expect(r.adapter?.name).toBe('oxlint');
  });

  test('an unknown adapter name is skipped with a reason', () => {
    const r = resolveSlot('lint', { checks: { lint: 'no-such-linter' } }, never);
    expect(r.adapter).toBeNull();
    expect(r.skip).toContain("'no-such-linter' is not in the registry");
  });

  test('{ use } applies overrides on top of the adapter', () => {
    const r = resolveSlot(
      'test',
      { checks: { test: { use: 'vitest', changedArgs: ['--changed', 'main'] } } },
      never,
    );
    expect(r.adapter?.name).toBe('vitest');
    expect(r.adapter?.changedArgs).toEqual(['--changed', 'main']);
  });

  test('{ use } overrides exactly the provided fields, keeping the rest', () => {
    const full = resolveSlot(
      'test',
      {
        checks: {
          test: {
            use: 'vitest',
            command: 'bun', args: ['x'], outputFile: 'o.json',
            changedArgs: ['c'], fixArgs: ['f'], description: 'D',
          },
        },
      },
      never,
    );
    expect(full.adapter).toMatchObject({
      command: 'bun', args: ['x'], outputFile: 'o.json',
      changedArgs: ['c'], fixArgs: ['f'], description: 'D',
    });

    const partial = resolveSlot('test', { checks: { test: { use: 'vitest' } } }, never);
    expect(partial.adapter?.command).toBe('pnpm');
    expect(partial.adapter?.description).toBe('Vitest tests with coverage');
    expect(partial.adapter?.args).toContain('vitest');
  });

  test('{ use } carries a timeout override onto the adapter', () => {
    const r = resolveSlot('test', { checks: { test: { use: 'vitest', timeout: 30 } } }, never);
    expect(r.adapter?.timeout).toBe(30);
  });

  test('a custom check carries its timeout', () => {
    const r = resolveSlot('lint', { checks: { lint: { command: 'node', args: ['x'], timeout: 5 } } }, never);
    expect(r.adapter?.timeout).toBe(5);
  });

  test('{ command } custom check fills defaults and respects overrides', () => {
    const withDefaults = resolveSlot('lint', { checks: { lint: { command: 'node', args: ['x.mjs'] } } }, never);
    expect(withDefaults.adapter).toMatchObject({
      command: 'node', name: 'custom:lint', description: 'Custom lint check', args: ['x.mjs'], outputFile: null,
    });
    expect(withDefaults.adapter?.changedArgs).toBeUndefined();

    const over = resolveSlot(
      'lint',
      {
        checks: {
          lint: {
            command: 'node', name: 'lic', description: 'D',
            args: ['a'], outputFile: 'o.json', changedArgs: ['c'], fixArgs: ['f'],
          },
        },
      },
      never,
    );
    expect(over.adapter).toMatchObject({
      name: 'lic', description: 'D', args: ['a'], outputFile: 'o.json', changedArgs: ['c'], fixArgs: ['f'],
    });
  });

  test('exposes the config type surface', () => {
    const disabled: SlotConfig = false;
    const custom: CustomCheck = { command: 'node', args: ['check-licenses.mjs'] };
    const use: UseConfig = { use: 'vitest', changedArgs: ['--changed', 'main'] };
    expect([disabled, custom.command, use.use]).toEqual([false, 'node', 'vitest']);
  });

  test('a custom check on a non-catalogue name is appended', () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: { checks: { licenses: { command: 'node', args: ['check-licenses.mjs'] } } },
      fileExists: never,
    });
    const licenses = resolved.find((r) => r.slot === 'licenses');
    expect(licenses?.adapter?.command).toBe('node');
    expect(licenses?.optIn).toBe(false);
  });

  test('a custom check defaults to running after the catalogue', () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: { checks: { licenses: { command: 'node', args: ['x.mjs'] } } },
      fileExists: never,
    });
    expect(resolved.at(-1)?.slot).toBe('licenses');
  });

  test('order:first runs a custom check ahead of every catalogue slot', () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: { checks: { format: { command: 'biome', args: ['format', '--write'], order: 'first' } } },
      fileExists: never,
    });
    expect(resolved[0]?.slot).toBe('format');
    expect(resolved.findIndex((r) => r.slot === 'format'))
      .toBeLessThan(resolved.findIndex((r) => r.slot === SLOTS[0]?.name));
  });

  test('order:first leads and order:last (default) trails, around the catalogue', () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: {
        checks: {
          format: { command: 'biome', args: ['format', '--write'], order: 'first' },
          licenses: { command: 'node', args: ['x.mjs'] },
        },
      },
      fileExists: never,
    });
    const names = resolved.map((r) => r.slot);
    expect(names[0]).toBe('format');
    expect(names.at(-1)).toBe('licenses');
  });

  test('custom checks preserve config key order within a group', () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: {
        checks: {
          format: { command: 'a', order: 'first' },
          notice: { command: 'b', order: 'first' },
        },
      },
      fileExists: never,
    });
    const firsts = resolved.slice(0, 2).map((r) => r.slot);
    expect(firsts).toEqual(['format', 'notice']);
  });
});

describe('loadConfig', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-cfg-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('returns null when no config file exists', () => {
    expect(loadConfig(dir)).toBeNull();
  });

  test('reads and parses checkride.config.json', async () => {
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ checks: { spell: false } }));
    expect(loadConfig(dir)).toEqual({ checks: { spell: false } });
  });

  test('throws a friendly error on malformed JSON', async () => {
    await writeFile(join(dir, 'checkride.config.json'), '{ not valid json');
    expect(() => loadConfig(dir)).toThrow('invalid checkride.config.json');
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ADAPTERS, SLOTS } from '../adapters/index.js';
import type { CheckrideConfig, CustomCheck, SlotConfig, UseConfig } from './index.js';
import { loadConfig, resolveChecks } from './index.js';

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
    const r = resolveSlot('lint', { checks: { lint: 'biome' } }, never);
    expect(r.adapter).toBeNull();
    expect(r.skip).toContain("'biome' is not in the registry");
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

  test('{ command } is a custom check needing no adapter', () => {
    const r = resolveSlot('lint', { checks: { lint: { command: 'node', args: ['x.mjs'] } } }, never);
    expect(r.adapter?.command).toBe('node');
    expect(r.adapter?.name).toBe('custom:lint');
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
});

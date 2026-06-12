import { describe, expect, test } from 'vitest';

import { ADAPTERS, SCHEMA_VERSION, SLOTS } from './index.js';

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
      types: 'tsc', lint: 'oxlint', struct: 'ast-grep', dead: 'fallow', test: 'vitest',
      docs: 'markdownlint-cli2', links: 'links', spell: 'cspell', mutation: 'stryker', security: 'pnpm-audit',
    };
    for (const slot of SLOTS) {
      const first = ADAPTERS.find((a) => a.slot === slot.name);
      expect(first?.name).toBe(blessed[slot.name]);
    }
  });

  test('alternates are wired after the blessed default for swappable slots', () => {
    const names = (slot: string): string[] => ADAPTERS.filter((a) => a.slot === slot).map((a) => a.name);
    expect(names('lint')).toEqual(['oxlint', 'biome', 'eslint']);
    expect(names('dead')).toEqual(['fallow', 'knip']);
    expect(names('test')).toEqual(['vitest', 'jest']);
  });

  test('the two opt-in slots come last', () => {
    expect(SLOTS.filter((s) => s.optIn).map((s) => s.name)).toEqual(['mutation', 'security']);
  });

  test('the links adapter is the only built-in', () => {
    const builtins = ADAPTERS.filter((a) => a.builtin);
    expect(builtins.map((a) => a.name)).toEqual(['links']);
  });
});

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

  test('exactly one blessed default per catalogue slot', () => {
    for (const slot of SLOTS) {
      const forSlot = ADAPTERS.filter((a) => a.slot === slot.name);
      expect(forSlot).toHaveLength(1);
    }
  });

  test('the two opt-in slots come last', () => {
    expect(SLOTS.filter((s) => s.optIn).map((s) => s.name)).toEqual(['mutation', 'security']);
  });

  test('the links adapter is the only built-in', () => {
    const builtins = ADAPTERS.filter((a) => a.builtin);
    expect(builtins.map((a) => a.name)).toEqual(['links']);
  });
});

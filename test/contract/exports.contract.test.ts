/**
 * Contract: the programmatic surface (docs/contract.md §Programmatic surface).
 *
 * Everything exported from the package root is public and semver-bound;
 * everything else is internal by definition. This test locks the export list
 * exactly: removing or renaming one is a breaking change (major-version
 * decision + a "Contract" CHANGELOG entry), and adding one means adding it
 * here and to the contract doc in the same commit.
 */

import { describe, expect, test } from 'vitest';

import * as api from '../../src/index.js';

/** The frozen value-export list (types are checked by the compiler, not here). */
const PUBLIC_EXPORTS = [
  'ADAPTERS',
  'DEFAULT_TIMEOUT_SECONDS',
  'PACKS',
  'SCHEMA_VERSION',
  'SLOTS',
  'TOOLS',
  'loadConfig',
  'resolveChecks',
  'runChecks',
  'runDoctor',
  'runFix',
  'runInit',
  'selectChecks',
];

/** The catalogue position of the slot an adapter fills. */
const slotIndex = (a: api.Adapter): number => api.SLOTS.findIndex((s) => s.name === a.slot);

describe('programmatic surface', () => {
  test('the package root exports exactly the promised names', () => {
    expect(Object.keys(api).toSorted()).toEqual(PUBLIC_EXPORTS);
  });

  test('contract constants hold their promised values', () => {
    expect(api.SCHEMA_VERSION).toBe(1);
    expect(api.DEFAULT_TIMEOUT_SECONDS).toBe(600);
  });
});

describe('the registry exports', () => {
  test('are plain data: each survives a JSON round trip unchanged', () => {
    for (const value of [api.SLOTS, api.ADAPTERS, api.PACKS, api.TOOLS]) {
      expect(JSON.parse(JSON.stringify(value))).toStrictEqual(value);
    }
  });

  test('PACKS keys each pack by its own name', () => {
    expect(Object.keys(api.PACKS).length).toBeGreaterThan(0);
    for (const [key, pack] of Object.entries(api.PACKS)) {
      expect(pack.name).toBe(key);
    }
  });

  test('ADAPTERS is the ts and repo packs\' rows, grouped by slot in SLOTS order', () => {
    const rows = [...api.PACKS.ts.adapters, ...api.PACKS.repo.adapters];
    // Every row exactly once, and nothing else.
    expect(api.ADAPTERS).toHaveLength(rows.length);
    for (const row of rows) {
      expect(api.ADAPTERS.filter((a) => a === row)).toHaveLength(1);
    }
    // Slot by slot in catalogue order, each slot's rows in their pack's order.
    for (const slot of api.SLOTS) {
      const inRegistry = api.ADAPTERS.filter((a) => a.slot === slot.name);
      expect(inRegistry).toEqual(rows.filter((a) => a.slot === slot.name));
    }
    const positions = api.ADAPTERS.map(slotIndex);
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
  });

  test('every slot declares its scope, and the repo pack fills exactly the repo-scope slots', () => {
    const repoSlots = new Set(api.PACKS.repo.adapters.map((a) => a.slot));
    for (const slot of api.SLOTS) {
      expect(slot.scope, `${slot.name} declares no scope`).toBe(repoSlots.has(slot.name) ? 'repo' : 'target');
    }
  });
});

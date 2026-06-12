import { describe, expect, test } from 'vitest';

import { ADAPTERS, runChecks, runDoctor, runFix, runInit, SCHEMA_VERSION, SLOTS } from '../index.js';

describe('public API', () => {
  test('exposes the report schema version', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  test('exposes the slot catalogue and adapter registry', () => {
    expect(SLOTS.length).toBeGreaterThan(0);
    expect(ADAPTERS.length).toBeGreaterThanOrEqual(SLOTS.length);
  });

  test('exposes the command entry points', () => {
    for (const fn of [runChecks, runFix, runDoctor, runInit]) {
      expect(typeof fn).toBe('function');
    }
  });
});

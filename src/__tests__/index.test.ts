import { describe, expect, test } from 'vitest';

import { runChecks, runDoctor } from '../index.js';

describe('public API', () => {
  test('exposes the run and the doctor', () => {
    for (const fn of [runChecks, runDoctor]) {
      expect(typeof fn).toBe('function');
    }
  });
});

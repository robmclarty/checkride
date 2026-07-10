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
  'SCHEMA_VERSION',
  'SLOTS',
  'loadConfig',
  'resolveChecks',
  'runChecks',
  'runDoctor',
  'runFix',
  'runInit',
  'selectChecks',
];

describe('programmatic surface', () => {
  test('the package root exports exactly the promised names', () => {
    expect(Object.keys(api).toSorted()).toEqual(PUBLIC_EXPORTS);
  });

  test('contract constants hold their promised values', () => {
    expect(api.SCHEMA_VERSION).toBe(1);
    expect(api.DEFAULT_TIMEOUT_SECONDS).toBe(600);
  });
});

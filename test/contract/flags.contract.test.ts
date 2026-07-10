/**
 * Contract: the CLI command and run-flag set (docs/contract.md §CLI).
 *
 * The promised run flags parse today and keep parsing; new flags are additive.
 * Removing or repurposing one is a breaking change (major-version decision +
 * a "Contract" CHANGELOG entry).
 */

import { describe, expect, test } from 'vitest';

import { parseCliArgs } from '../../src/cli.js';

const BOOLEAN_FLAGS = ['bail', 'json', 'all', 'changed', 'digest', 'strict'] as const;
const LIST_FLAGS = ['only', 'skip', 'include'] as const;

describe('CLI run flags', () => {
  test('every promised boolean flag parses', () => {
    for (const flag of BOOLEAN_FLAGS) {
      expect(parseCliArgs([`--${flag}`]).flags[flag]).toBe(true);
    }
  });

  test('every promised list flag parses to a string array', () => {
    for (const flag of LIST_FLAGS) {
      expect(parseCliArgs([`--${flag}`, 'a,b']).flags[flag]).toEqual(['a', 'b']);
    }
  });

  test('the promised commands are recognized', () => {
    for (const command of ['run', 'init', 'doctor', 'fix', 'baseline', 'agent-setup']) {
      expect(parseCliArgs([command]).command).toBe(command);
    }
  });

  test('an unknown run flag is rejected (usage error, exit 2 at the CLI)', () => {
    expect(() => parseCliArgs(['--no-such-flag'])).toThrow();
  });
});

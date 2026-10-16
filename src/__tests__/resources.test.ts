import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { readResource } from '../resources.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('readResource', () => {
  test('reads each bundled root from the package root', () => {
    for (const rel of [
      'templates/ts/shared/oxlintrc.json',
      'templates/repo/shared/sgconfig.yml',
      'schema/checkride.config.schema.json',
      'skills/check/SKILL.md',
    ]) {
      expect(readResource(rel), rel).toBe(readFileSync(join(ROOT, rel), 'utf8'));
    }
  });

  test('throws for a file the package does not carry', () => {
    expect(() => readResource('templates/ts/shared/missing.json')).toThrow(/ENOENT/);
  });
});

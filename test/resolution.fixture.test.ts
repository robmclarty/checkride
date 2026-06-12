import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { ADAPTERS, SLOTS } from '../src/adapters/index.js';
import { resolveChecks } from '../src/config/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');

function resolveSlotAt(slotName: string, cwd: string) {
  const slots = SLOTS.filter((s) => s.name === slotName);
  return resolveChecks({ slots, adapters: ADAPTERS, config: null, cwd })[0];
}

describe('fixture: existing-biome', () => {
  test('a repo with biome.json (no oxlint config) resolves lint -> biome', () => {
    const lint = resolveSlotAt('lint', join(fixtures, 'existing-biome'));
    expect(lint?.adapter?.name).toBe('biome');
    expect(lint?.skip).toBeNull();
  });
});

describe('config overrides detection', () => {
  test('"dead": "knip" beats a present fallow.toml', () => {
    const deadSlot = SLOTS.filter((s) => s.name === 'dead');
    const [dead] = resolveChecks({
      slots: deadSlot,
      adapters: ADAPTERS,
      config: { checks: { dead: 'knip' } },
      fileExists: (f) => f === 'fallow.toml',
    });
    expect(dead?.adapter?.name).toBe('knip');
  });
});

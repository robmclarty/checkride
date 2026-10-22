/**
 * The naming rule discovery and `unclaimed` share (#18), at its edges: a
 * name a slug would strip to the one that collided, and one the length
 * limit (V1) would cut.
 */

import { describe, expect, test } from 'vitest';

import { nameTargets } from '../names.js';

describe('nameTargets', () => {
  test('roots whose distinguishing segments start with a digit keep them, after the pack’s name, in either order', () => {
    const years = [
      { lang: 'terraform', root: '2024/infra', base: 'infra' },
      { lang: 'terraform', root: '2025/infra', base: 'infra' },
    ];
    expect(nameTargets(years, new Set())).toEqual(['terraform-2024-infra', 'terraform-2025-infra']);
    expect(nameTargets(years.toReversed(), new Set())).toEqual(['terraform-2025-infra', 'terraform-2024-infra']);
    expect(nameTargets([{ lang: 'terraform', root: '2024/infra', base: 'infra' }, { lang: 'terraform', root: 'x/infra', base: 'infra' }], new Set())).toEqual([
      'terraform-2024-infra',
      'x-infra',
    ]);
  });

  test('a long name keeps its pack’s name whole when it falls back to it, and never the name that collided', () => {
    const base = 'payments-reconciliation-service';
    const named = nameTargets([{ lang: 'terraform', root: base, base }, { lang: 'go', root: base, base }], new Set([base]));
    expect(named).toEqual(['terraform', 'go']);
    const slot = nameTargets([{ lang: 'terraform', root: base, base }], new Set([base]));
    expect(slot).toEqual(['payments-reconciliatio-terraform']);
    expect(slot[0]?.length).toBeLessThanOrEqual(32);
  });
});

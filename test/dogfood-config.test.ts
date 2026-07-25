/**
 * Guards on this repo's own `checkride.config.json`.
 *
 * Dogfooding only proves something while the dogfood config still matches what
 * the package ships. Where this repo overrides an adapter — currently once —
 * the override duplicates that adapter's argv, and a later change to the
 * registry would leave the duplicate silently stale: `pnpm check` would keep
 * passing while no longer exercising the shipped defaults. These tests turn
 * that silence into a failure.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { ADAPTERS } from '../src/adapters.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

type CheckEntry = { use?: string; args?: readonly string[] };
const config = JSON.parse(readFileSync(join(ROOT, 'checkride.config.json'), 'utf8')) as {
  checks: Record<string, CheckEntry | string | boolean>;
};

describe("this repo's checkride.config.json", () => {
  /**
   * Why the override exists: oxlint's nested-config discovery makes an
   * `.oxlintrc.json` anywhere under the tree govern its own subtree, which
   * silently voids the root config's `ignorePatterns` there. Every example
   * under `examples/` needs its own oxlint config to be genuinely standalone
   * (without one it inherits *this* config, which is a different bug), so the
   * root run has to opt out of that discovery or it lints the deliberately
   * broken example sources. See examples/README.md.
   */
  test('the lint override is the shipped oxlint argv plus --disable-nested-config', () => {
    const oxlint = ADAPTERS.find((adapter) => adapter.name === 'oxlint');
    expect(oxlint, 'the oxlint adapter has been renamed or removed').toBeDefined();

    const lint = config.checks['lint'];
    expect(typeof lint, 'lint must stay an object override').toBe('object');
    const args = (lint as CheckEntry).args;

    expect(args).toEqual([...(oxlint?.args ?? []), '--disable-nested-config']);
  });
});

/**
 * Resolution in multi-target mode (D10): with `targets` declared, a
 * repo-scope slot resolves once at the repo root, and a target-scope slot once
 * for each target that has it, from the target's entry, then its pack's, then
 * the top level's, then detection at the target's root. Each case injects
 * `fileExists`, which answers for paths relative to the repo root.
 */

import { describe, expect, test } from 'vitest';

import { ADAPTERS, SLOTS } from '../adapters.js';
import type { CheckrideConfig, ResolvedCheck } from '../config.js';
import { resolveChecks } from '../config.js';
import { checkName } from '../targets/index.js';

const NO_MANIFEST = { scripts: new Set<string>(), deps: new Set<string>() };
const present = (...files: string[]) => (f: string): boolean => files.includes(f);

const web = { lang: 'ts', root: 'apps/web' } as const;
const api = { lang: 'ts', root: 'apps/api' } as const;

/** Resolve `config` against the catalogue, keyed by each check's name. */
function resolve(config: CheckrideConfig, fileExists: (f: string) => boolean = present()): Map<string, ResolvedCheck> {
  const checks = resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, fileExists, manifest: NO_MANIFEST });
  return new Map(checks.map((c) => [checkName(c), c]));
}

/** The one check named `name`, or a failure naming what resolved instead. */
function check(checks: Map<string, ResolvedCheck>, name: string): ResolvedCheck {
  const found = checks.get(name);
  if (found === undefined) throw new Error(`no check ${name}; resolved ${[...checks.keys()].join(', ')}`);
  return found;
}

describe('targets resolve their own slots (D10)', () => {
  test("each target gets its pack's target-scope slots as <target>:<slot>, with its root and pack", () => {
    const checks = resolve({ targets: { web, api } }, present('apps/web/.oxlintrc.json', 'apps/api/vitest.config.ts'));
    expect(check(checks, 'web:lint')).toMatchObject({
      slot: 'lint',
      target: 'web',
      root: 'apps/web',
      pack: 'ts',
      adapter: { name: 'oxlint' },
      origin: 'detected',
      detectedBy: '.oxlintrc.json',
    });
    expect(check(checks, 'api:lint')).toMatchObject({ target: 'api', adapter: null, skip: 'no tool detected for slot' });
    expect(check(checks, 'api:test')).toMatchObject({ target: 'api', adapter: { name: 'vitest' } });
    expect(checks.has('lint')).toBe(false);
  });

  test("detection reads the target's root, not the repo root", () => {
    const checks = resolve({ targets: { web } }, present('.oxlintrc.json', 'vitest.config.ts'));
    expect(check(checks, 'web:lint').adapter).toBeNull();
    expect(check(checks, 'web:test').adapter).toBeNull();
  });

  test('a repo-scope slot resolves once, at the repo root, as the repo pack', () => {
    const checks = resolve({ targets: { web } }, present('.markdownlint-cli2.jsonc', 'apps/web/.markdownlint-cli2.jsonc'));
    expect(check(checks, 'docs')).toMatchObject({ slot: 'docs', pack: 'repo', adapter: { name: 'markdownlint-cli2' } });
    expect(check(checks, 'docs')).not.toHaveProperty('target');
    expect(checks.has('web:docs')).toBe(false);
  });

  test("the target's entry beats its pack's, which beats detection", () => {
    const checks = resolve(
      { targets: { web: { ...web, checks: { lint: 'biome' } }, api }, packs: { ts: { checks: { lint: 'eslint' } } } },
      present('apps/web/.oxlintrc.json', 'apps/api/.oxlintrc.json'),
    );
    expect(check(checks, 'web:lint')).toMatchObject({ adapter: { name: 'biome' }, origin: 'config' });
    expect(check(checks, 'api:lint')).toMatchObject({ adapter: { name: 'eslint' }, origin: 'config' });
  });

  test("a top-level false switches the slot off in every target, and a target's entry switches it back on", () => {
    const checks = resolve(
      { targets: { web: { ...web, checks: { lint: 'oxlint' } }, api }, checks: { lint: false } },
      present('apps/api/.oxlintrc.json'),
    );
    expect(check(checks, 'web:lint')).toMatchObject({ adapter: { name: 'oxlint' }, skip: null });
    expect(check(checks, 'api:lint')).toMatchObject({ adapter: null, skip: 'disabled in checkride.config.json' });
  });

  test('a false in a higher layer beats a pick below it', () => {
    const checks = resolve({ targets: { web: { ...web, checks: { test: false } }, api }, packs: { ts: { checks: { test: 'vitest' } } } });
    expect(check(checks, 'web:test').skip).toBe('disabled in checkride.config.json');
    expect(check(checks, 'api:test').adapter?.name).toBe('vitest');
  });

  test('each tuning key comes from the highest layer that sets it, over the layer that picked the tool', () => {
    const checks = resolve({
      targets: { web: { ...web, checks: { test: { order: 5 } } }, api },
      packs: { ts: { checks: { test: { use: 'vitest', timeout: 300 } } } },
      checks: { test: { timeout: 900, optIn: true } },
    });
    expect(check(checks, 'web:test')).toMatchObject({ adapter: { name: 'vitest', timeout: 300, order: 5 }, order: 5, optIn: true });
    expect(check(checks, 'api:test')).toMatchObject({ adapter: { name: 'vitest', timeout: 300 }, order: 'any', optIn: true });
  });

  test("a top-level tuning entry reaches the tool detection picked in every target that has it", () => {
    const checks = resolve(
      { targets: { web, api }, checks: { lint: { timeout: 42, order: 'first' } } },
      present('apps/web/.oxlintrc.json', 'apps/api/.oxlintrc.json'),
    );
    for (const name of ['web:lint', 'api:lint']) {
      expect(check(checks, name)).toMatchObject({ adapter: { name: 'oxlint', timeout: 42 }, order: 'first', origin: 'detected' });
    }
  });

  test('a string pick under a tuning layer runs the tool it names with that tuning', () => {
    const checks = resolve({ targets: { web: { ...web, checks: { lint: { timeout: 9 } } } }, packs: { ts: { checks: { lint: 'oxlint' } } } });
    expect(check(checks, 'web:lint')).toMatchObject({ adapter: { name: 'oxlint', timeout: 9 }, origin: 'config' });
  });

  test('every layer is validated, the ones a higher layer beat included', () => {
    const config = { targets: { web: { ...web, checks: { lint: 'oxlint' } } }, checks: { lint: { order: 'soon' } } };
    expect(() => resolve(config as unknown as CheckrideConfig)).toThrow(/'lint' order must be a finite number or one of/);
  });

  test("a target has no check for a slot its pack doesn't fill, unless its own block or its pack's names one", () => {
    const slots = [...SLOTS, { name: 'fake', scope: 'target' as const }];
    const run = (config: CheckrideConfig): string[] =>
      resolveChecks({ slots, adapters: ADAPTERS, config, fileExists: present(), manifest: NO_MANIFEST }).map(checkName);
    expect(run({ targets: { web, api }, checks: { fake: { timeout: 1 } } })).not.toContain('web:fake');
    const named = run({ targets: { web: { ...web, checks: { fake: { command: 'node' } } }, api } });
    expect(named).toContain('web:fake');
    expect(named).not.toContain('api:fake');
  });
});

describe("targets' custom checks", () => {
  test("a pack's custom check runs in every target of the pack, and a target's own entry beats it", () => {
    const checks = resolve({
      targets: { web: { ...web, checks: { e2e: { command: 'web-e2e' } } }, api },
      packs: { ts: { checks: { e2e: { command: 'pack-e2e' } } } },
      checks: { licenses: { command: 'licenses' } },
    });
    expect(check(checks, 'web:e2e')).toMatchObject({ target: 'web', root: 'apps/web', pack: 'ts', origin: 'custom', adapter: { command: 'web-e2e' } });
    expect(check(checks, 'api:e2e')).toMatchObject({ target: 'api', adapter: { command: 'pack-e2e' } });
    expect(check(checks, 'licenses')).toMatchObject({ pack: 'repo', adapter: { command: 'licenses' } });
    expect(check(checks, 'licenses')).not.toHaveProperty('target');
  });

  test("a target's false drops its pack's custom check for that target alone", () => {
    const checks = resolve({ targets: { web: { ...web, checks: { e2e: false } }, api }, packs: { ts: { checks: { e2e: { command: 'node' } } } } });
    expect(checks.has('web:e2e')).toBe(false);
    expect(checks.has('api:e2e')).toBe(true);
  });

  test("a custom check's detect gate reads its target's root", () => {
    const config: CheckrideConfig = { targets: { web: { ...web, checks: { e2e: { command: 'node', detect: ['e2e.config.ts'] } } } } };
    expect(check(resolve(config, present('apps/web/e2e.config.ts')), 'web:e2e').skip).toBeNull();
    expect(check(resolve(config, present('e2e.config.ts')), 'web:e2e').skip).toBe('no detect file present');
  });
});

describe('the order checks resolve in (R8.4)', () => {
  test('catalogue position, then target order within a slot, then the top-level custom checks, then each target’s', () => {
    const config: CheckrideConfig = {
      targets: { web: { ...web, checks: { probe: { command: 'node' } } }, api },
      packs: { ts: { checks: { e2e: { command: 'node' } } } },
      checks: { licenses: { command: 'node' } },
    };
    const names = resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, fileExists: present(), manifest: NO_MANIFEST }).map(checkName);
    expect(names.slice(0, 5)).toEqual(['web:types', 'api:types', 'web:format', 'api:format', 'web:lint']);
    expect(names.indexOf('struct')).toBe(names.indexOf('api:lint') + 1);
    // The custom checks close the main group, after its last catalogue slot;
    // the slots on later waves (build, publint, mutation) follow them.
    const customs = ['licenses', 'web:e2e', 'web:probe', 'api:e2e'];
    const at = names.indexOf('licenses');
    expect(at).toBe(names.indexOf('api:snippets') + 1);
    expect(names.slice(at, at + customs.length)).toEqual(customs);
  });

  test("an order on one target's check moves it alone, and the group sort still leads", () => {
    const config: CheckrideConfig = { targets: { web, api: { ...api, checks: { lint: { order: 'first' } } } } };
    const fileExists = present('apps/web/.oxlintrc.json', 'apps/api/.oxlintrc.json');
    const names = resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, fileExists, manifest: NO_MANIFEST }).map(checkName);
    expect(names[0]).toBe('api:lint');
    expect(names.indexOf('web:lint')).toBeGreaterThan(names.indexOf('web:types'));
  });
});

describe('a tuning-only entry in a repo without targets', () => {
  test('its timeout and order reach the tool detection picked', () => {
    const [lint] = resolveChecks({
      slots: SLOTS.filter((s) => s.name === 'lint'),
      adapters: ADAPTERS,
      config: { checks: { lint: { timeout: 7, order: 2 } } },
      fileExists: present('.oxlintrc.json'),
      manifest: NO_MANIFEST,
    });
    expect(lint).toMatchObject({ adapter: { name: 'oxlint', timeout: 7, order: 2 }, order: 2, origin: 'detected' });
  });
});

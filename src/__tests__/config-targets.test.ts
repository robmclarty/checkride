/**
 * Resolution in multi-target mode (D10): with `targets` declared, a
 * repo-scope slot resolves once at the repo root, and a target-scope slot once
 * for each target that has it, from the target's entry, then its pack's, then
 * the top level's, then detection at the target's root. Without `targets`, a
 * root that marks a pack other than ts resolves the same way, as one target
 * of that pack (R2.1, D66). Each case injects `fileExists`, which answers for
 * paths relative to the repo root.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ADAPTERS, SLOTS } from '../adapters.js';
import type { CheckrideConfig, ResolvedCheck } from '../config.js';
import { resolveChecks } from '../config.js';
import { checkName, implicitPack } from '../targets/index.js';

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
    // The custom checks close the main group, after its last catalogue slot,
    // unclaimed; the slots on later waves (build, publint, mutation) follow them.
    const customs = ['licenses', 'web:e2e', 'web:probe', 'api:e2e'];
    const at = names.indexOf('licenses');
    expect(names.indexOf('unclaimed')).toBe(names.indexOf('api:snippets') + 1);
    expect(at).toBe(names.indexOf('unclaimed') + 1);
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

describe('a bash target detects its tools by config file or by pin', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'checkride-detect-pin-'));
    await mkdir(join(repo, 'scripts'));
  });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  const scripts = { lang: 'bash', root: 'scripts' } as const;
  const resolveAt = (config: CheckrideConfig): Map<string, ResolvedCheck> =>
    new Map(resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, cwd: repo }).map((c) => [checkName(c), c]));

  test('with neither a .shellcheckrc nor a pin, nothing fills lint or format', () => {
    const checks = resolveAt({ targets: { scripts } });
    expect(check(checks, 'scripts:lint')).toMatchObject({ adapter: null, skip: 'no tool detected for slot', pack: 'bash' });
    expect(check(checks, 'scripts:format')).toMatchObject({ adapter: null, optIn: true });
    expect(checks.has('scripts:types')).toBe(false);
  });

  test(".shellcheckrc at the target's root detects shellcheck", async () => {
    await writeFile(join(repo, 'scripts', '.shellcheckrc'), 'disable=SC1091\n');
    expect(check(resolveAt({ targets: { scripts } }), 'scripts:lint')).toMatchObject({
      adapter: { name: 'shellcheck' },
      origin: 'detected',
      detectedBy: '.shellcheckrc',
    });
  });

  test('a mise.toml from the target root up to the repo root detects each tool it pins, by any of its ids', async () => {
    await writeFile(join(repo, 'mise.toml'), '[tools]\n"aqua:koalaman/shellcheck" = "0.11.0"\nshfmt = "3.14.1"\n');
    const checks = resolveAt({ targets: { scripts } });
    expect(check(checks, 'scripts:lint')).toMatchObject({
      adapter: { name: 'shellcheck' },
      origin: 'detected',
      detectedBy: 'mise.toml: aqua:koalaman/shellcheck',
    });
    expect(check(checks, 'scripts:format')).toMatchObject({ adapter: { name: 'shfmt' }, optIn: true, detectedBy: 'mise.toml: shfmt' });
  });

  test('a pin for one tool detects only that tool', async () => {
    await writeFile(join(repo, 'scripts', 'mise.toml'), '[tools]\nshfmt = "3.14.1"\n');
    const checks = resolveAt({ targets: { scripts } });
    expect(check(checks, 'scripts:lint').adapter).toBeNull();
    expect(check(checks, 'scripts:format')).toMatchObject({ adapter: { name: 'shfmt' }, detectedBy: 'scripts/mise.toml: shfmt' });
  });

  test('a mise.toml above the repo root pins nothing in it', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'checkride-detect-pin-outer-'));
    try {
      await writeFile(join(outer, 'mise.toml'), '[tools]\nshellcheck = "0.11.0"\n');
      await mkdir(join(outer, 'repo', 'scripts'), { recursive: true });
      const checks = resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config: { targets: { scripts } }, cwd: join(outer, 'repo') });
      expect(checks.find((c) => checkName(c) === 'scripts:lint')?.adapter).toBeNull();
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  test('a detection that injects its own files reads no pins off disk', () => {
    const checks = resolve({ targets: { scripts } }, present('scripts/.shellcheckrc'));
    expect(check(checks, 'scripts:lint')).toMatchObject({ adapter: { name: 'shellcheck' }, detectedBy: '.shellcheckrc' });
    expect(check(checks, 'scripts:format').adapter).toBeNull();
  });
});

/** Resolve the catalogue with `config` (none by default), keyed by each check's name. */
const repoSlots = (fileExists: (f: string) => boolean, config: CheckrideConfig | null = null): Map<string, ResolvedCheck> =>
  new Map(resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, fileExists, manifest: NO_MANIFEST }).map((c) => [checkName(c), c]));

describe("the repo pack's Node-free alternates", () => {
  test('rumdl fills docs from its own config, and typos fills spell from its own', () => {
    const checks = repoSlots(present('.rumdl.toml', '_typos.toml'));
    expect(check(checks, 'docs')).toMatchObject({ adapter: { name: 'rumdl', outputFile: 'docs.json' }, detectedBy: '.rumdl.toml' });
    expect(check(checks, 'spell')).toMatchObject({ adapter: { name: 'typos' }, detectedBy: '_typos.toml' });
  });

  test('the npm default still wins where both configs sit', () => {
    const checks = repoSlots(present('.markdownlint-cli2.jsonc', 'rumdl.toml', 'cspell.json', 'typos.toml'));
    expect(check(checks, 'docs').adapter?.name).toBe('markdownlint-cli2');
    expect(check(checks, 'spell').adapter?.name).toBe('cspell');
  });

  test('in multi-target mode they resolve once, at the repo root, as the repo pack', () => {
    const checks = repoSlots(present('.typos.toml', 'apps/web/rumdl.toml'), { targets: { web } });
    expect(check(checks, 'spell')).toMatchObject({ pack: 'repo', adapter: { name: 'typos' } });
    expect(check(checks, 'docs').adapter).toBeNull();
  });
});

describe('the implicit pack follows R2.1 among the packs that ship', () => {
  test.each([
    { files: ['package.json'], pack: 'ts' },
    { files: ['tsconfig.json'], pack: 'ts' },
    { files: ['go.mod'], pack: 'go' },
    { files: ['go.work'], pack: 'go' },
    { files: ['Cargo.toml'], pack: 'rust' },
    { files: ['go.mod', 'package.json'], pack: 'ts' },
    { files: ['Cargo.toml', 'tsconfig.json'], pack: 'ts' },
    { files: ['Cargo.toml', 'go.mod'], pack: 'go' },
    { files: ['pyproject.toml'], pack: 'ts' },
    { files: [], pack: 'ts' },
  ])('a root holding $files is checked as $pack', ({ files, pack }) => {
    expect(implicitPack(present(...files))).toBe(pack);
  });
});

describe('a repo without targets at a Go or Rust root is one target of that pack (D66)', () => {
  test('a go.mod root runs the go pack’s checks under their bare slot names, each with its pack and no target', () => {
    const checks = repoSlots(present('go.mod', '.golangci.yml'));
    expect(check(checks, 'types')).toMatchObject({ slot: 'types', pack: 'go', adapter: { name: 'go-build' }, origin: 'detected', detectedBy: 'go.mod' });
    expect(check(checks, 'lint')).toMatchObject({ pack: 'go', adapter: { name: 'golangci-lint' } });
    expect(check(checks, 'test')).toMatchObject({ pack: 'go', adapter: { name: 'go-test' } });
    expect(check(checks, 'links')).toMatchObject({ pack: 'repo', adapter: { name: 'links' } });
    for (const c of checks.values()) {
      expect(c, c.slot).not.toHaveProperty('target');
      expect(c, c.slot).not.toHaveProperty('root');
      expect(c.pack, c.slot).toBeDefined();
    }
    // A slot the go pack doesn't fill has no check, as in a declared go target.
    for (const slot of ['build', 'publint', 'snippets']) expect(checks.has(slot), slot).toBe(false);
  });

  test('a Cargo.toml root runs the rust pack’s checks', () => {
    const checks = repoSlots(present('Cargo.toml'));
    expect(check(checks, 'types')).toMatchObject({ pack: 'rust', adapter: { name: 'cargo-check' } });
    expect(checks.has('rust:types')).toBe(false);
  });

  test('a top-level entry is the implicit target’s own, over the pack block, and custom checks keep bare names', () => {
    const checks = repoSlots(present('go.mod'), {
      checks: { lint: 'staticcheck', test: 'go-test', licenses: { command: 'true' } },
      packs: { go: { checks: { test: false, dead: false, generate: { command: 'go', args: ['generate', './...'] } } } },
    });
    expect(check(checks, 'lint')).toMatchObject({ pack: 'go', adapter: { name: 'staticcheck' }, origin: 'config' });
    expect(check(checks, 'test')).toMatchObject({ adapter: { name: 'go-test' }, origin: 'config' });
    expect(check(checks, 'dead')).toMatchObject({ adapter: null, skip: 'disabled in checkride.config.json' });
    expect(check(checks, 'licenses')).toMatchObject({ pack: 'repo', origin: 'custom' });
    expect(check(checks, 'generate')).toMatchObject({ pack: 'go', origin: 'custom' });
  });

  test('a custom check both blocks name runs once, from the top level over the pack block', () => {
    const checks = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: { checks: { gen: { timeout: 5 } }, packs: { go: { checks: { gen: { command: 'go', args: ['generate'] } } } } },
      fileExists: present('go.mod'),
      manifest: NO_MANIFEST,
    });
    const gens = checks.filter((c) => c.slot === 'gen');
    expect(gens).toHaveLength(1);
    expect(gens[0]).toMatchObject({ pack: 'repo', adapter: { command: 'go', timeout: 5 } });
  });

  test('unclaimed, when an entry picks it, claims the markers of the implicit pack', () => {
    const checks = repoSlots(present('go.mod'), { checks: { unclaimed: 'unclaimed' } });
    expect(check(checks, 'unclaimed').adapter?.options?.unclaimed?.targets).toEqual([{ name: '', pack: 'go', root: '.' }]);
  });

  test('a package.json beside a go.mod keeps 0.13’s resolution: no check carries a pack', () => {
    const checks = repoSlots(present('package.json', 'go.mod', '.oxlintrc.json'));
    expect(check(checks, 'lint').adapter?.name).toBe('oxlint');
    expect(check(checks, 'build')).toBeDefined();
    for (const c of checks.values()) expect(c, c.slot).not.toHaveProperty('pack');
  });
});

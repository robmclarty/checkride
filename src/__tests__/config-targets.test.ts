/**
 * Resolution in multi-target mode (D10): with `targets` declared, a
 * repo-scope slot resolves once at the repo root, and a target-scope slot once
 * for each target that has it, from the target's entry, then its pack's, then
 * the top level's, then detection at the target's root. Without `targets`, a
 * root that marks a pack other than ts resolves the same way, as one target
 * of that pack (R2.1, D66). Each case injects `fileExists`, which answers for
 * paths relative to the repo root.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ADAPTERS, SLOTS } from '../adapters.js';
import type { CheckrideConfig, ResolvedCheck } from '../config.js';
import { composedConfig, declaringFiles, loadConfig, loadConfigFile, resolveChecks } from '../config.js';
import { suiteNamed } from '../suite.js';
import { chainCanRun } from '../launch/index.js';
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
    // The custom checks close the main group, after its last catalogue slots,
    // unclaimed and schema; the slots on later waves (build, publint, mutation) follow them.
    const customs = ['licenses', 'web:e2e', 'web:probe', 'api:e2e'];
    const at = names.indexOf('licenses');
    expect(names.indexOf('unclaimed')).toBe(names.indexOf('api:snippets') + 1);
    expect(names.indexOf('schema')).toBe(names.indexOf('unclaimed') + 1);
    expect(at).toBe(names.indexOf('schema') + 1);
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

describe('a python target detects its tools by config file, pyproject.toml table or pin (R5.7)', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'checkride-detect-py-'));
    await mkdir(join(repo, 'py'));
  });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  const py = { lang: 'python', root: 'py' } as const;
  const put = (rel: string, text: string): Promise<void> => writeFile(join(repo, 'py', rel), text);
  const resolveAt = (config: CheckrideConfig = { targets: { py } }): Map<string, ResolvedCheck> =>
    new Map(resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, cwd: repo }).map((c) => [checkName(c), c]));

  test('a bare pyproject.toml detects nothing, and the pack fills only the slots R5.7 names', async () => {
    await put('pyproject.toml', '[project]\nname = "x"\n');
    const checks = resolveAt();
    for (const slot of ['lint', 'types', 'test']) expect(check(checks, `py:${slot}`), slot).toMatchObject({ adapter: null, pack: 'python' });
    expect(check(checks, 'py:format')).toMatchObject({ adapter: null, optIn: true });
    for (const slot of ['dead', 'build', 'mutation']) expect(checks.has(`py:${slot}`), slot).toBe(false);
  });

  test('a [tool.*] table detects its tool, a sub-table or an array of tables included, and names the header it found', async () => {
    await put('pyproject.toml', [
      '[project]', 'name = "x"', '',
      '[tool.ruff.lint]  # no [tool.ruff] of its own', 'select = ["F"]', '',
      '[[ tool.mypy.overrides ]]', 'module = "x"', '',
      '[tool.pytest.ini_options]', 'addopts = "-q"', '',
    ].join('\n'));
    const checks = resolveAt();
    expect(check(checks, 'py:lint')).toMatchObject({ adapter: { name: 'ruff' }, origin: 'detected', detectedBy: 'pyproject.toml: [tool.ruff.lint]' });
    expect(check(checks, 'py:format')).toMatchObject({ adapter: { name: 'ruff-format' }, optIn: true, detectedBy: 'pyproject.toml: [tool.ruff.lint]' });
    expect(check(checks, 'py:types')).toMatchObject({ adapter: { name: 'mypy' }, detectedBy: 'pyproject.toml: [[tool.mypy.overrides]]' });
    expect(check(checks, 'py:test')).toMatchObject({ adapter: { name: 'pytest' }, detectedBy: 'pyproject.toml: [tool.pytest.ini_options]' });
  });

  test('a table only named like one, or commented out, detects nothing', async () => {
    await put('pyproject.toml', '[tool.ruffle]\nx = 1\n# [tool.mypy]\n[tool]\nmypy = 1\nkey = "[tool.pytest]"\n');
    const checks = resolveAt();
    for (const slot of ['lint', 'types', 'test']) expect(check(checks, `py:${slot}`).adapter, slot).toBeNull();
  });

  test('basedpyright takes types from its own config or a [tool.pyright] table, and mypy still wins where both are configured', async () => {
    await put('pyproject.toml', '[tool.pyright]\ntypeCheckingMode = "standard"\n');
    expect(check(resolveAt(), 'py:types')).toMatchObject({ adapter: { name: 'basedpyright', outputFile: 'types.json' }, detectedBy: 'pyproject.toml: [tool.pyright]' });
    await put('mypy.ini', '[mypy]\n');
    expect(check(resolveAt(), 'py:types')).toMatchObject({ adapter: { name: 'mypy' }, detectedBy: 'mypy.ini' });
  });

  test('a config file of its own detects a tool before a table does, and conftest.py detects pytest', async () => {
    await put('pyproject.toml', '[tool.ruff]\n');
    await put('.ruff.toml', '');
    await put('conftest.py', '');
    const checks = resolveAt();
    expect(check(checks, 'py:lint')).toMatchObject({ adapter: { name: 'ruff' }, detectedBy: '.ruff.toml' });
    expect(check(checks, 'py:test')).toMatchObject({ adapter: { name: 'pytest' }, detectedBy: 'conftest.py' });
  });

  test('a uv.lock that lists a tool detects it by pin', async () => {
    await put('pyproject.toml', '[project]\nname = "x"\n');
    await put('uv.lock', 'version = 1\n\n[[package]]\nname = "pytest"\nversion = "9.1.1"\n\n[[package]]\nname = "ruff"\nversion = "0.17.1"\n');
    const checks = resolveAt();
    expect(check(checks, 'py:lint')).toMatchObject({ adapter: { name: 'ruff' }, detectedBy: 'py/uv.lock: ruff' });
    expect(check(checks, 'py:test')).toMatchObject({ adapter: { name: 'pytest' }, detectedBy: 'py/uv.lock: pytest' });
    expect(check(checks, 'py:types').adapter).toBeNull();
  });

  test('a repo without targets at a pyproject.toml root runs the python pack under bare slot names', async () => {
    await writeFile(join(repo, 'pyproject.toml'), '[tool.ruff]\n[tool.mypy]\n');
    const checks = new Map(resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config: null, cwd: repo }).map((c) => [checkName(c), c]));
    expect(check(checks, 'lint')).toMatchObject({ pack: 'python', adapter: { name: 'ruff' }, detectedBy: 'pyproject.toml: [tool.ruff]' });
    expect(check(checks, 'types')).toMatchObject({ pack: 'python', adapter: { name: 'mypy' } });
  });

  test('a detection that injects its own files reads no table off disk', () => {
    const checks = resolve({ targets: { py } }, present('py/pyproject.toml'));
    expect(check(checks, 'py:lint').adapter).toBeNull();
  });
});

describe('a terraform target formats everywhere and validates only a root module (R5.8)', () => {
  const infra = { lang: 'terraform', root: 'infra' } as const;
  const modules = { lang: 'terraform', root: 'modules' } as const;
  const rootModule = present('infra/main.tf', 'infra/.terraform.lock.hcl', 'infra/.tflint.hcl', 'modules/vpc/main.tf');

  test('a root module’s lock file detects validate, and .tflint.hcl detects tflint; format and security wait to be opted in', () => {
    const checks = resolve({ targets: { infra } }, rootModule);
    expect(check(checks, 'infra:types')).toMatchObject({ pack: 'terraform', adapter: { name: 'terraform-validate' }, origin: 'detected', detectedBy: '.terraform.lock.hcl' });
    expect(check(checks, 'infra:lint')).toMatchObject({ adapter: { name: 'tflint', outputFile: 'lint.json' }, detectedBy: '.tflint.hcl' });
    expect(check(checks, 'infra:format')).toMatchObject({ adapter: { name: 'terraform-fmt' }, optIn: true, origin: 'built-in' });
    expect(check(checks, 'infra:security')).toMatchObject({ adapter: null, optIn: true });
    for (const slot of ['dead', 'test', 'build']) expect(checks.has(`infra:${slot}`), slot).toBe(false);
  });

  test('without a lock file, types stands down naming the root module it isn’t, however the slot was chosen', () => {
    const reason = 'no .terraform.lock.hcl marks a root module here';
    expect(check(resolve({ targets: { modules } }, rootModule), 'modules:types')).toMatchObject({ adapter: null, skip: reason });
    const named = resolve({ targets: { modules: { ...modules, checks: { types: 'terraform-validate' } } } }, rootModule);
    expect(check(named, 'modules:types')).toMatchObject({ adapter: null, skip: reason });
    const preset = resolve({ targets: { infra, modules }, packs: { terraform: { checks: { types: 'terraform-validate' } } } }, rootModule);
    expect(check(preset, 'modules:types')).toMatchObject({ adapter: null, skip: reason });
    expect(check(preset, 'infra:types')).toMatchObject({ adapter: { name: 'terraform-validate' }, origin: 'config' });
    expect(check(preset, 'modules:lint').adapter).toBeNull();
  });

  test('a repo without targets at a root module runs the terraform pack under bare slot names', () => {
    const checks = repoSlots(present('main.tf', '.terraform.lock.hcl'));
    expect(check(checks, 'types')).toMatchObject({ pack: 'terraform', adapter: { name: 'terraform-validate' } });
    expect(check(checks, 'format')).toMatchObject({ pack: 'terraform', adapter: { name: 'terraform-fmt' } });
  });
});

describe('an odin target runs the compiler in every slot the pack fills, with nothing to detect', () => {
  const game = { lang: 'odin', root: 'src' } as const;

  test('types, lint, dead and test are each the compiler, on with no config file, and no other slot is filled', () => {
    const checks = resolve({ targets: { game } });
    expect([...checks.keys()].filter((name) => name.startsWith('game:'))).toEqual(['game:types', 'game:lint', 'game:dead', 'game:test']);
    for (const [slot, adapter] of [['types', 'odin-check'], ['lint', 'odin-vet'], ['dead', 'odin-unused'], ['test', 'odin-test']]) {
      expect(check(checks, `game:${slot}`), slot).toMatchObject({ pack: 'odin', root: 'src', adapter: { name: adapter }, skip: null });
    }
    expect(check(checks, 'game:lint').detectedBy).toBeUndefined();
  });

  test('a pack-wide override restates the vet row’s args, keeping its name for the parser', () => {
    const args = ['check', '.', '-no-entry-point', '-json-errors', '-vet', '-vet-tabs', '-disallow-do'];
    const checks = resolve({ targets: { game }, packs: { odin: { checks: { lint: { use: 'odin-vet', args } } } } });
    expect(check(checks, 'game:lint')).toMatchObject({ adapter: { name: 'odin-vet', args }, origin: 'config' });
  });

  test('a repo without targets at a .odin root runs the odin pack under bare slot names', () => {
    const checks = repoSlots(present('*.odin'));
    expect(check(checks, 'types')).toMatchObject({ pack: 'odin', adapter: { name: 'odin-check' } });
    expect(check(checks, 'dead')).toMatchObject({ pack: 'odin', adapter: { name: 'odin-unused' } });
    expect(checks.has('format')).toBe(false);
  });
});

/** Resolve the catalogue with `config` (none by default), keyed by each check's name. */
const repoSlots =(fileExists: (f: string) => boolean, config: CheckrideConfig | null = null): Map<string, ResolvedCheck> =>
  new Map(resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, fileExists, manifest: NO_MANIFEST }).map((c) => [checkName(c), c]));

/** What each check resolved to, in order: its name, its adapter, and why it skipped. */
function shape(checks: Map<string, ResolvedCheck>): (string | null)[][] {
  return [...checks.values()].map((c) => [checkName(c), c.adapter?.name ?? null, c.skip]);
}

/** Resolve the catalogue at a root holding `files`, under a defaults layer that names typos for spell. */
function withDefaults(files: string[]): Map<string, ResolvedCheck> {
  const checks = resolveChecks({
    slots: SLOTS, adapters: ADAPTERS, config: null, defaults: { checks: { spell: 'typos' } }, fileExists: present(...files), manifest: NO_MANIFEST,
  });
  return new Map(checks.map((c) => [checkName(c), c]));
}

describe("the repo pack's Node-free alternates", () => {
  test('at a go root, rumdl fills docs from its own config, and typos fills spell from its own', () => {
    const checks = repoSlots(present('go.mod', '.rumdl.toml', '_typos.toml'));
    expect(check(checks, 'docs')).toMatchObject({ adapter: { name: 'rumdl', outputFile: 'docs.json' }, detectedBy: '.rumdl.toml' });
    expect(check(checks, 'spell')).toMatchObject({ adapter: { name: 'typos' }, detectedBy: '_typos.toml' });
  });

  // A ts root's checks resolve through its package manager alone, which can't
  // install either tool, so detecting one would only trade a skip for a refusal.
  test('a ts root resolves identical checks with and without _typos.toml and .rumdl.toml (C2)', () => {
    for (const markers of [[], ['package.json'], ['tsconfig.json']]) {
      expect(shape(repoSlots(present(...markers, '_typos.toml', '.rumdl.toml'))), String(markers)).toEqual(shape(repoSlots(present(...markers))));
    }
  });

  test('an explicit typos or rumdl entry still resolves at a ts root', () => {
    const checks = repoSlots(present('package.json'), { checks: { spell: 'typos', docs: 'rumdl' } });
    expect(check(checks, 'spell')).toMatchObject({ adapter: { name: 'typos' }, origin: 'config' });
    expect(check(checks, 'docs')).toMatchObject({ adapter: { name: 'rumdl' }, origin: 'config' });
  });

  test('a ts root admits every ADAPTERS row but rumdl and typos, and the repo pack admits them all', () => {
    expect(ADAPTERS.filter((a) => !chainCanRun(undefined, a)).map((a) => a.name)).toEqual(['rumdl', 'typos']);
    expect(ADAPTERS.filter((a) => !chainCanRun('repo', a))).toEqual([]);
  });

  test("the defaults layer can't plant typos at a ts root, but fills it at a go root", () => {
    expect(check(withDefaults(['package.json']), 'spell').adapter).toBeNull();
    expect(check(withDefaults(['go.mod']), 'spell')).toMatchObject({ adapter: { name: 'typos' }, origin: 'defaults' });
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
    { files: ['pyproject.toml'], pack: 'python' },
    { files: ['setup.py'], pack: 'python' },
    { files: ['pyproject.toml', 'go.mod'], pack: 'go' },
    { files: ['.terraform.lock.hcl'], pack: 'terraform' },
    { files: ['.terraform.lock.hcl', 'pyproject.toml'], pack: 'python' },
    { files: ['*.odin'], pack: 'odin' },
    { files: ['*.odin', '.terraform.lock.hcl'], pack: 'terraform' },
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

/** The config error a broken repo config raises, for `reason`. */
const invalid = (reason: string): string => `invalid checkride.config.json: ${reason}`;

describe('a local target keeps the rest of itself in the file at its root (D8)', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'checkride-local-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  /** Write `files` under the repo, each a JSON value at a path relative to it. */
  async function lay(files: Record<string, unknown>): Promise<void> {
    for (const [path, value] of Object.entries(files)) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), typeof value === 'string' ? value : JSON.stringify(value));
    }
  }

  /** The repo's config, loaded, with every warning the load gave. */
  function load(): { config: CheckrideConfig | null; warnings: string[] } {
    const warnings: string[] = [];
    return { config: loadConfig(repo, (message) => warnings.push(message)), warnings };
  }

  /** The repo's config resolved, keyed by each check's name. */
  const resolved = (config: CheckrideConfig | null = loadConfig(repo)): Map<string, ResolvedCheck> =>
    new Map(resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, cwd: repo }).map((c) => [checkName(c), c]));

  const local = { root: 'web', local: true } as const;
  const probe = { command: 'node', args: ['-e', ''] };

  test("its file's checks rank where the target's own do: over its pack's block and the top level", async () => {
    await lay({
      'checkride.config.json': {
        targets: { web: local, api: { lang: 'ts', root: 'api' } },
        packs: { ts: { checks: { lint: 'eslint', test: { use: 'vitest', timeout: 90 }, e2e: probe } } },
        checks: { lint: { timeout: 30, order: 2 }, types: { timeout: 30 } },
      },
      'web/checkride.config.json': { lang: 'ts', checks: { lint: 'oxlint', test: { timeout: 5 }, e2e: { ...probe, args: ['web'] }, probe } },
      'api/.keep': '',
    });
    const checks = resolved();
    // The local file's pick beats the pack block's, and the top level's tuning still reaches it.
    expect(check(checks, 'web:lint')).toMatchObject({ target: 'web', root: 'web', pack: 'ts', adapter: { name: 'oxlint', timeout: 30 }, order: 2, origin: 'config' });
    expect(check(checks, 'api:lint')).toMatchObject({ adapter: { name: 'eslint', timeout: 30 } });
    // Its tuning beats the pack block's, whose pick it leaves standing.
    expect(check(checks, 'web:test')).toMatchObject({ adapter: { name: 'vitest', timeout: 5 } });
    expect(check(checks, 'api:test')).toMatchObject({ adapter: { name: 'vitest', timeout: 90 } });
    // And its custom checks are the target's own, over the pack block's of the same name.
    expect(check(checks, 'web:e2e').adapter?.args).toEqual(['web']);
    expect(check(checks, 'web:probe')).toMatchObject({ target: 'web', origin: 'custom' });
    expect(checks.has('api:probe')).toBe(false);
  });

  test('loadConfig returns the config as written, and composedConfig folds the file in, once (D43)', async () => {
    await lay({ 'checkride.config.json': { targets: { web: local } }, 'web/checkride.config.json': { lang: 'ts', lnag: 'ts', checks: { probe } } });
    const { config, warnings } = load();
    expect(config).toEqual({ targets: { web: { root: 'web', local: true } } });
    expect(warnings).toEqual([`checkride: web/checkride.config.json has a top-level key "lnag", which a local target's file doesn't read (it reads lang, checks, include, exclude, timeout and extends)`]);
    const again: string[] = [];
    const whole = composedConfig(config, repo, undefined, (message) => again.push(message));
    expect(whole).toEqual({ targets: { web: { lang: 'ts', checks: { probe }, root: 'web', local: true } } });
    // The file was read as the config loaded, so composing reads and warns about nothing again.
    expect(again).toEqual([]);
    expect(composedConfig(whole, repo)).toBe(whole);
    expect(composedConfig(config, repo)).toBe(whole);
  });

  test('a config with no local target composes to itself, and so does none at all', () => {
    const config: CheckrideConfig = { targets: { api: { lang: 'ts', root: 'api' } } };
    expect(composedConfig(config, repo)).toBe(config);
    expect(composedConfig(null, repo)).toBeNull();
  });

  test('a config built by hand composes as a loaded one does', async () => {
    await lay({ 'web/checkride.config.json': { lang: 'ts', checks: { probe } } });
    expect(check(resolved({ targets: { web: local } }), 'web:probe')).toMatchObject({ target: 'web', pack: 'ts' });
  });

  test("a --config file's local targets are read under the repo, at <cwd>/<root>/ (D36)", async () => {
    const outside = await mkdtemp(join(tmpdir(), 'checkride-local-named-'));
    try {
      await writeFile(join(outside, 'named.json'), JSON.stringify({ targets: { web: local } }));
      await lay({ 'web/checkride.config.json': { lang: 'ts', checks: { probe } } });
      expect(check(resolved(loadConfigFile(join(outside, 'named.json'), repo)), 'web:probe')).toMatchObject({ target: 'web' });
      // And a problem with the local file names the config that declared the target.
      await lay({ 'web/checkride.config.json': { lang: 'ts', gate: {} } });
      expect(() => loadConfigFile(join(outside, 'named.json'), repo)).toThrow(`invalid ${join(outside, 'named.json')}: web/checkride.config.json sets gate`);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a named suite reads its own local file, <root>/checkride.<suite>.config.json (D29)", async () => {
    await lay({
      'checkride.evals.config.json': { targets: { web: local } },
      'web/checkride.config.json': { lang: 'ts', checks: { nope: probe } },
      'web/checkride.evals.config.json': { lang: 'ts', checks: { evals: probe } },
    });
    const suite = suiteNamed('evals');
    const config = loadConfig(repo, undefined, suite.configFile);
    const checks = resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, cwd: repo, suite }).map(checkName);
    expect(checks).toEqual(['web:evals']);
    await rm(join(repo, 'web', 'checkride.evals.config.json'));
    expect(() => loadConfig(repo, undefined, suite.configFile)).toThrow(
      'invalid checkride.evals.config.json: targets.web is local, and its file web/checkride.evals.config.json is missing',
    );
  });

  test("its timeout is the default of the target's checks, under an entry's own", async () => {
    await lay({
      'checkride.config.json': { timeout: 600, targets: { web: local, api: { lang: 'ts', root: 'api' } }, packs: { ts: { checks: { slow: probe } } } },
      'web/checkride.config.json': { lang: 'ts', timeout: 45, checks: { lint: 'oxlint', test: { use: 'vitest', timeout: 5 } } },
      'api/.keep': '',
    });
    const checks = resolved();
    expect(check(checks, 'web:lint').adapter?.timeout).toBe(45);
    expect(check(checks, 'web:slow').adapter?.timeout).toBe(45);
    expect(check(checks, 'web:test').adapter?.timeout).toBe(5);
    expect(check(checks, 'api:slow').adapter?.timeout).toBeUndefined();
  });

  describe('what its entry and its file refuse', () => {
    test.each(['lang', 'checks', 'include', 'exclude', 'timeout'])('%s in the entry beside local: true names the file that should hold it (D35)', async (key) => {
      await lay({ 'checkride.config.json': { targets: { web: { ...local, [key]: 'ts' } } }, 'web/checkride.config.json': { lang: 'ts' } });
      expect(load).toThrow(invalid(`targets.web sets ${key} beside local: true, and a local target's entry holds only root, local, note: move ${key} to web/checkride.config.json`));
    });

    test.each(['targets', 'schemas', 'unclaimed', 'packs', 'gate', 'changedBase', 'requirePins'])('%s in the local file names the file', async (key) => {
      await lay({ 'checkride.config.json': { targets: { web: local } }, 'web/checkride.config.json': { lang: 'ts', [key]: {} } });
      expect(load).toThrow(invalid(`web/checkride.config.json sets ${key}, which belongs to the whole repo`));
    });

    test('a missing local file names its path', async () => {
      await lay({ 'checkride.config.json': { targets: { web: local } }, 'web/.keep': '' });
      expect(load).toThrow(invalid('targets.web is local, and its file web/checkride.config.json is missing: a local target keeps its lang and its checks there'));
    });

    test('a local file that is not JSON names itself', async () => {
      await lay({ 'checkride.config.json': { targets: { web: local } }, 'web/checkride.config.json': '{ nope' });
      expect(load).toThrow(/^invalid checkride\.config\.json: .* \(in web\/checkride\.config\.json\)$/);
    });

    test('two local targets at one root name each other (D44)', async () => {
      await lay({ 'checkride.config.json': { targets: { web: local, site: { root: './web/', local: true } } }, 'web/checkride.config.json': { lang: 'ts' } });
      expect(load).toThrow(invalid("local targets 'web' and 'site' share the root 'web', and a root holds one local file, web/checkride.config.json, with one lang"));
    });

    test("a local target at the declaring file's own directory names the file (D44)", async () => {
      await lay({ 'checkride.config.json': { targets: { all: { root: '.', local: true } } } });
      expect(load).toThrow(invalid('targets.all is local at the root, where its file would be checkride.config.json, the file that declares it'));
    });

    test('a local target shares a root with a declared one of another pack, and never with one of its own', async () => {
      await lay({ 'checkride.config.json': { targets: { web: local, scripts: { lang: 'bash', root: 'web' } } }, 'web/checkride.config.json': { lang: 'ts' } });
      expect(load().config).not.toBeNull();
      await lay({ 'web/checkride.config.json': { lang: 'bash' } });
      expect(load).toThrow(invalid("bash targets 'web' and 'scripts' share the root 'web'"));
    });

    test('local takes true or false, and false leaves the target whole', async () => {
      await lay({ 'checkride.config.json': { targets: { web: { lang: 'ts', root: 'web', local: false } } }, 'web/.keep': '' });
      expect(resolved().has('web:types')).toBe(true);
      await lay({ 'checkride.config.json': { targets: { web: { lang: 'ts', root: 'web', local: 'yes' } } } });
      expect(load).toThrow(invalid('targets.web.local must be true or false (got "yes")'));
    });

    test('timeout is the local file\'s alone', async () => {
      await lay({ 'checkride.config.json': { targets: { web: { lang: 'ts', root: 'web', timeout: 5 } } }, 'web/.keep': '' });
      expect(load).toThrow(invalid("targets.web has an unknown key 'timeout'"));
    });

    test.each([
      [{}, 'targets.web has no lang: name its pack'],
      [{ lang: 'nope' }, 'targets.web.lang "nope" isn\'t a pack'],
      [{ lang: 'ts', timeout: -1 }, 'targets.web.timeout must be a number of seconds, 0 or more (got -1)'],
      [{ lang: 'ts', include: ['src/**'] }, 'targets.web sets include, but ts checks its root'],
      [{ lang: 'ts', checks: { lint: 'golangci-lint' } }, "targets.web.checks.lint names 'golangci-lint', which isn't a ts adapter"],
      [{ lang: 'ts', checks: { spell: false } }, 'targets.web.checks.spell configures spell, a repo-scope slot'],
    ])('a rule the composed target breaks names the local file: %j', async (file, reason) => {
      await lay({ 'checkride.config.json': { targets: { web: local } }, 'web/checkride.config.json': file });
      expect(load).toThrow(`invalid checkride.config.json: ${reason}`);
      expect(load).toThrow(/ \(in web\/checkride\.config\.json\)$/);
    });

    test('a hand-built config is held to the same rules as it resolves', async () => {
      await lay({ 'web/checkride.config.json': { lang: 'ts', schemas: [] } });
      expect(() => resolved({ targets: { web: local } })).toThrow(invalid('web/checkride.config.json sets schemas'));
      // A cast, since the type refuses what the rule does.
      const beside = { targets: { web: { ...local, lang: 'ts' } } } as CheckrideConfig;
      expect(() => resolved(beside)).toThrow(invalid('targets.web sets lang beside local: true'));
    });
  });

  describe('a preset its file extends (D42)', () => {
    const preset = {
      requirePins: true,
      packs: { ts: { checks: { lint: 'eslint' } } },
      timeout: 60,
      checks: { lint: 'golangci-lint', test: 'vitest', spell: false, unit: probe },
    };

    test('hands over what a local file may hold, and each other key is dropped with a warning naming the preset', async () => {
      await lay({
        'checkride.config.json': { targets: { web: local } },
        'presets/team.json': preset,
        'web/checkride.config.json': { extends: '../presets/team.json', lang: 'ts', checks: { test: { timeout: 5 } } },
      });
      const { config, warnings } = load();
      const base = warnings.map((w) => w.replace(/^checkride: \S+/, 'checkride: <preset>'));
      expect(base).toEqual([
        `checkride: <preset> has a top-level key "requirePins", which web/checkride.config.json, a local target's file, doesn't read (it reads lang, checks, include, exclude, timeout and extends)`,
        `checkride: <preset> has a top-level key "packs", which web/checkride.config.json, a local target's file, doesn't read (it reads lang, checks, include, exclude, timeout and extends)`,
        `checkride: <preset> configures spell, a repo-scope slot, which web/checkride.config.json, a local target's file, doesn't read (configure it in the repo's top-level checks)`,
      ]);
      for (const warning of warnings) expect(warning).toContain('team.json');
      const whole = composedConfig(config, repo);
      // The go pick is another pack's, so it's left to the targets that can run it; the ts one merges with the file's own entry.
      expect(whole?.targets?.['web']).toEqual({ lang: 'ts', timeout: 60, checks: { test: { timeout: 5 }, unit: probe }, root: 'web', local: true });
      // `"vitest"` under `{ timeout }` replaces, as any preset's string entry does, so the file's tuning stands alone.
      const checks = resolved(config);
      expect(check(checks, 'web:unit')).toMatchObject({ origin: 'custom', adapter: { timeout: 60 } });
      expect(checks.has('spell')).toBe(true);
      expect(check(checks, 'web:lint').adapter?.name).not.toBe('eslint');
    });

    test("a preset may name the file's lang, and a preset of a preset is read the same way", async () => {
      await lay({
        'checkride.config.json': { targets: { api: { root: 'api', local: true } } },
        'presets/base.json': { gate: { only: ['lint'] }, checks: { lint: 'golangci-lint' } },
        'presets/go.json': { extends: './base.json', lang: 'go' },
        'api/checkride.config.json': { extends: '../presets/go.json' },
      });
      const { config, warnings } = load();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('base.json has a top-level key "gate"');
      expect(composedConfig(config, repo)?.targets?.['api']).toEqual({ lang: 'go', checks: { lint: 'golangci-lint' }, root: 'api', local: true });
    });

    test('a preset that declares targets is still refused', async () => {
      await lay({
        'checkride.config.json': { targets: { web: local } },
        'presets/team.json': { targets: { x: { lang: 'ts', root: '.' } } },
        'web/checkride.config.json': { extends: '../presets/team.json', lang: 'ts' },
      });
      expect(load).toThrow('extends "../presets/team.json" declares targets (in web/checkride.config.json)');
    });
  });

  describe('the containment rule on the paths it names', () => {
    let outside: string;
    beforeEach(async () => {
      outside = await mkdtemp(join(tmpdir(), 'checkride-local-outside-'));
      await writeFile(join(outside, 'checkride.config.json'), JSON.stringify({ lang: 'ts', checks: { stolen: probe } }));
      await lay({ 'checkride.config.json': { targets: { web: local } } });
    });
    afterEach(async () => {
      await rm(outside, { recursive: true, force: true });
    });

    test('a local file that is a link out of the repo is never read', async () => {
      await mkdir(join(repo, 'web'));
      await symlink(join(outside, 'checkride.config.json'), join(repo, 'web', 'checkride.config.json'));
      expect(load).toThrow('invalid checkride.config.json: targets.web is local, and its file web/checkride.config.json resolves outside the repository, where checkride reads no config');
    });

    test('nor is one under a root that is a link out of the repo', async () => {
      await symlink(outside, join(repo, 'web'));
      expect(load).toThrow('its file web/checkride.config.json resolves outside the repository');
    });

    test('a link that stays inside the repo is read where it really is', async () => {
      await lay({ 'shared/web.json': { lang: 'ts', checks: { probe } }, 'web/.keep': '' });
      await symlink(join(repo, 'shared', 'web.json'), join(repo, 'web', 'checkride.config.json'));
      expect(check(resolved(), 'web:probe')).toMatchObject({ target: 'web' });
    });

    test('a preset path that leaves the repo is refused, by the path or by a link', async () => {
      await writeFile(join(outside, 'preset.json'), JSON.stringify({ checks: { stolen: probe } }));
      await lay({ 'web/checkride.config.json': { extends: join(outside, 'preset.json'), lang: 'ts' } });
      expect(load).toThrow(`invalid checkride.config.json: extends "${join(outside, 'preset.json')}" (in web/checkride.config.json) resolves outside the repository, where a local target's file reads nothing`);
      await symlink(join(outside, 'preset.json'), join(repo, 'web', 'team.json'));
      await lay({ 'web/checkride.config.json': { extends: './team.json', lang: 'ts' } });
      expect(load).toThrow('extends "./team.json" (in web/checkride.config.json) resolves outside the repository');
    });
  });
});

describe('a config includes the files that declare more targets (D9)', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'checkride-include-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  /** Write `files` under the repo, each a JSON value, or text as it is, at a path relative to it. */
  async function lay(files: Record<string, unknown>): Promise<void> {
    for (const [path, value] of Object.entries(files)) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), typeof value === 'string' ? value : JSON.stringify(value));
    }
  }

  const load = (): CheckrideConfig | null => loadConfig(repo);
  const probe = { command: 'node', args: ['-e', ''] };

  /** A repo whose root config includes `services`, which declares a go target and a local one. */
  const services = {
    'checkride.config.json': { include: ['services'], targets: { web: { lang: 'ts', root: 'web' } }, packs: { go: { checks: { probe } } } },
    'services/checkride.config.json': { targets: { api: { lang: 'go', root: 'api' }, billing: { root: 'billing', local: true } } },
    'services/billing/checkride.config.json': { lang: 'go', checks: { own: probe } },
    'services/api/.keep': '',
    'web/.keep': '',
  };

  test("an included file's targets join the repo's, roots relative to the file, names flat", async () => {
    await lay(services);
    const config = load();
    // As written, the config still says what it includes.
    expect(config).toMatchObject({ include: ['services'], targets: { web: { lang: 'ts', root: 'web' } } });
    const whole = composedConfig(config, repo);
    expect(whole).not.toHaveProperty('include');
    expect(whole?.targets).toEqual({
      web: { lang: 'ts', root: 'web' },
      api: { lang: 'go', root: 'services/api' },
      billing: { lang: 'go', checks: { own: probe }, root: 'services/billing', local: true },
    });
    expect([...(declaringFiles(whole) ?? [])]).toEqual([['api', 'services/checkride.config.json'], ['billing', 'services/checkride.config.json']]);
    expect(declaringFiles(config)).toBeNull();
    expect(composedConfig(whole, repo)).toBe(whole);

    const checks = new Map(resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, cwd: repo }).map((c) => [checkName(c), c]));
    // The repo's packs block reaches an included target, and a local one keeps its own file's checks.
    expect(check(checks, 'api:probe')).toMatchObject({ target: 'api', root: 'services/api', pack: 'go' });
    expect(check(checks, 'billing:own')).toMatchObject({ target: 'billing', root: 'services/billing' });
    expect(checks.has('web:types')).toBe(true);
  });

  test('an included file may include others, and a config may include with no targets of its own', async () => {
    await lay({
      'checkride.config.json': { include: ['services'] },
      'services/checkride.config.json': { include: ['billing', 'api'] },
      'services/billing/checkride.config.json': { targets: { billing: { lang: 'go', root: '.' } } },
      'services/api/checkride.config.json': { targets: { api: { lang: 'go', root: 'v2' } } },
      'services/api/v2/.keep': '',
    });
    const whole = composedConfig(load(), repo);
    expect(whole?.targets).toEqual({ billing: { lang: 'go', root: 'services/billing' }, api: { lang: 'go', root: 'services/api/v2' } });
    expect(declaringFiles(whole)?.get('api')).toBe('services/api/checkride.config.json');
  });

  test('a config with no include has no declaring files, and composes as before', async () => {
    await lay({ 'checkride.config.json': { targets: { web: { lang: 'ts', root: 'web' } } }, 'web/.keep': '' });
    const config = load();
    expect(composedConfig(config, repo)).toBe(config);
    expect(declaringFiles(config)).toBeNull();
  });

  test("a named suite includes its own files, <dir>/checkride.<suite>.config.json (D34)", async () => {
    await lay({
      'checkride.evals.config.json': { include: ['services'] },
      'services/checkride.config.json': { targets: { nope: { lang: 'go', root: 'api' } } },
      'services/checkride.evals.config.json': { targets: { api: { lang: 'go', root: 'api', checks: { evals: probe } } } },
      'services/api/.keep': '',
    });
    const suite = suiteNamed('evals');
    const config = loadConfig(repo, undefined, suite.configFile);
    expect(resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, cwd: repo, suite }).map(checkName)).toEqual(['api:evals']);
    expect(declaringFiles(composedConfig(config, repo, suite))?.get('api')).toBe('services/checkride.evals.config.json');
  });

  describe('what it refuses, each naming the file', () => {
    test('a name declared in two files names both', async () => {
      await lay({ ...services, 'checkride.config.json': { include: ['services'], targets: { api: { lang: 'ts', root: 'web' } } } });
      expect(load).toThrow(invalid("target 'api' is declared twice, in checkride.config.json and in services/checkride.config.json: target names are one flat set across every included file"));
    });

    test('a cycle names the chain, and so does a file that includes itself', async () => {
      await lay({
        'checkride.config.json': { include: ['a'] },
        'a/checkride.config.json': { include: ['b'] },
        'a/b/checkride.config.json': { include: ['.'] },
      });
      expect(load).toThrow(invalid('circular include: checkride.config.json -> a/checkride.config.json -> a/b/checkride.config.json -> a/b/checkride.config.json'));
      await lay({ 'checkride.config.json': { include: ['.'] } });
      expect(load).toThrow(invalid('circular include: checkride.config.json -> checkride.config.json'));
    });

    test('a file two lists reach declares its targets twice', async () => {
      await lay({
        'checkride.config.json': { include: ['services', 'services/api'] },
        'services/checkride.config.json': { include: ['api'] },
        'services/api/checkride.config.json': { targets: { api: { lang: 'go', root: '.' } } },
      });
      expect(load).toThrow(invalid("target 'api' is declared twice, in services/api/checkride.config.json and in services/api/checkride.config.json"));
    });

    test.each(['checks', 'packs', 'schemas', 'extends', 'timeout', 'lang'])('%s in an included file', async (key) => {
      await lay({ ...services, 'services/checkride.config.json': { targets: { api: { lang: 'go', root: 'api' } }, [key]: {} } });
      expect(load).toThrow(invalid(`services/checkride.config.json sets ${key}, which an included file can't hold: it holds targets, include, note and $schema, and ${key} belongs to the repo's own config`));
    });

    test('a missing included file names its path and the file that includes it', async () => {
      await lay({ 'checkride.config.json': { include: ['services'] }, 'services/.keep': '' });
      expect(load).toThrow(invalid('checkride.config.json includes services/checkride.config.json, which is missing'));
    });

    test('an included file that is not JSON names itself', async () => {
      await lay({ 'checkride.config.json': { include: ['services'] }, 'services/checkride.config.json': '{ nope' });
      expect(load).toThrow(/^invalid checkride\.config\.json: .* \(in services\/checkride\.config\.json\)$/);
    });

    test('an include list that is no list of directories below the file', async () => {
      await lay({ 'checkride.config.json': { include: 'services' } });
      expect(load).toThrow(invalid('include (in checkride.config.json) must be an array of directories'));
      await lay({ 'checkride.config.json': { include: ['services'] }, 'services/checkride.config.json': { include: ['../web'] } });
      expect(load).toThrow(invalid('include (in services/checkride.config.json) holds "../web", which leaves the directory of the file that lists it'));
    });

    test('files that declare no target between them', async () => {
      await lay({ 'checkride.config.json': { include: ['services'] }, 'services/checkride.config.json': { targets: {} } });
      expect(load).toThrow(invalid('include names services/checkride.config.json, and no file declares a target: declare one, or drop include'));
    });

    test('a rule an included target breaks names its file', async () => {
      await lay({ ...services, 'services/checkride.config.json': { targets: { api: { lang: 'nope', root: 'api' } } } });
      expect(load).toThrow(invalid('targets.api.lang "nope" isn\'t a pack (packs: ts, bash, go, rust, python, terraform, odin) (in services/checkride.config.json)'));
      await lay({ ...services, 'services/checkride.config.json': { targets: { api: { lang: 'go', root: 'gone' } } } });
      expect(load).toThrow(invalid('targets.api.root "services/gone" doesn\'t exist in the repo (in services/checkride.config.json)'));
      await lay({ ...services, 'services/checkride.config.json': { targets: { api: { lang: 'go', root: '../web' } } } });
      expect(load).toThrow(invalid('targets.api.root "../web" leaves the directory of the file that declares it: give a directory relative to services/checkride.config.json (in services/checkride.config.json)'));
    });

    test("a local target at an included file's own directory names that file (D44)", async () => {
      await lay({ 'checkride.config.json': { include: ['services'] }, 'services/checkride.config.json': { targets: { all: { root: '.', local: true } } } });
      expect(load).toThrow(invalid("targets.all is local at 'services', where its file would be services/checkride.config.json, the file that declares it"));
    });

    test('two targets of one pack still cannot nest across files', async () => {
      await lay({
        'checkride.config.json': { include: ['services'], targets: { all: { lang: 'go', root: 'services' } } },
        'services/checkride.config.json': { targets: { api: { lang: 'go', root: 'api' } } },
        'services/api/.keep': '',
      });
      expect(load).toThrow(invalid("go target 'api' sits inside 'all' ('services/api' is under 'services'), and two targets of one pack can't nest"));
    });

    test('a preset that sets include, as one that declares targets', async () => {
      await lay({ 'checkride.config.json': { extends: './preset.json' }, 'preset.json': { include: ['services'] } });
      expect(load).toThrow(invalid('extends "./preset.json" sets include (in checkride.config.json): a preset can\'t know a repo\'s files, so only the repo\'s own config may include them'));
    });

    test("include in a --config file (D36), which may still declare local targets", async () => {
      const outside = await mkdtemp(join(tmpdir(), 'checkride-include-named-'));
      try {
        await lay(services);
        await writeFile(join(outside, 'named.json'), JSON.stringify({ include: ['services'] }));
        expect(() => loadConfigFile(join(outside, 'named.json'), repo)).toThrow(
          `invalid ${join(outside, 'named.json')}: a config named by --config or CHECKRIDE_CONFIG can't include: an included file's roots are relative to a file inside the repo, and this one can sit outside it`,
        );
        await writeFile(join(outside, 'named.json'), JSON.stringify({ targets: { billing: { root: 'services/billing', local: true } } }));
        expect(composedConfig(loadConfigFile(join(outside, 'named.json'), repo), repo)?.targets?.['billing']).toMatchObject({ lang: 'go' });
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    test('an included file that links out of the repo is never read', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'checkride-include-outside-'));
      try {
        await writeFile(join(outside, 'checkride.config.json'), JSON.stringify({ targets: { stolen: { lang: 'ts', root: '.' } } }));
        await lay({ 'checkride.config.json': { include: ['services'] } });
        await symlink(outside, join(repo, 'services'));
        expect(load).toThrow(invalid('checkride.config.json includes services/checkride.config.json, which resolves outside the repository, where checkride reads no config'));
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});

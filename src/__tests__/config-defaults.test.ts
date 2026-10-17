/**
 * The defaults layer (R3, R13.1): a config read from `--defaults` that fills
 * only the slots the repo's entries and detection leave empty, with
 * `origin: 'defaults'`, and whose custom checks join only under names the
 * repo declares nowhere. Each resolution case injects `fileExists`, which
 * answers for paths relative to the repo root.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ADAPTERS, SLOTS } from '../adapters.js';
import type { CheckrideConfig, ResolvedCheck } from '../config.js';
import { loadConfigFile, loadDefaultsFile, resolveChecks } from '../config.js';
import { checkName } from '../targets/index.js';

const NO_MANIFEST = { scripts: new Set<string>(), deps: new Set<string>() };
const present = (...files: string[]) => (f: string): boolean => files.includes(f);
/** A `fileExists` whose disk has gone away, for an error that isn't a config error. */
const diskGone = (): boolean => { throw new Error('disk gone'); };

/** Resolve the catalogue with `config` and `defaults`, keyed by each check's name. */
function resolve(
  config: CheckrideConfig | null,
  defaults: CheckrideConfig,
  fileExists: (f: string) => boolean = present(),
): Map<string, ResolvedCheck> {
  const checks = resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, defaults, fileExists, manifest: NO_MANIFEST });
  return new Map(checks.map((c) => [checkName(c), c]));
}

/** The one check named `name`, or a failure naming what resolved instead. */
function check(checks: Map<string, ResolvedCheck>, name: string): ResolvedCheck {
  const found = checks.get(name);
  if (found === undefined) throw new Error(`no check ${name}; resolved ${[...checks.keys()].join(', ')}`);
  return found;
}

describe('a defaults entry fills only what the repo and detection leave empty', () => {
  test('it fills an empty slot, marked defaults', () => {
    expect(check(resolve(null, { checks: { lint: 'oxlint' } }), 'lint')).toMatchObject({ adapter: { name: 'oxlint' }, skip: null, origin: 'defaults' });
  });

  // F35
  test('a tool the repo detects beats it, with origin detected', () => {
    const checks = resolve(null, { checks: { lint: 'eslint' } }, present('.oxlintrc.json'));
    expect(check(checks, 'lint')).toMatchObject({ adapter: { name: 'oxlint' }, origin: 'detected', detectedBy: '.oxlintrc.json' });
  });

  test('a repo entry that decides the slot beats it: a pick, a false, and a pick the registry lacks', () => {
    const defaults = { checks: { lint: 'oxlint', test: 'vitest', types: 'tsc' } };
    const checks = resolve({ checks: { lint: 'biome', test: false, types: 'nope' } }, defaults);
    expect(check(checks, 'lint')).toMatchObject({ adapter: { name: 'biome' }, origin: 'config' });
    expect(check(checks, 'test')).toMatchObject({ adapter: null, skip: 'disabled in checkride.config.json' });
    expect(check(checks, 'types')).toMatchObject({ adapter: null, skip: "configured adapter 'nope' is not in the registry" });
  });

  test('the repo’s tuning applies over the pick, and over the defaults’ own tuning', () => {
    const checks = resolve({ checks: { lint: { timeout: 5 } } }, { checks: { lint: { use: 'oxlint', timeout: 60, order: 'first' } } });
    expect(check(checks, 'lint')).toMatchObject({ adapter: { name: 'oxlint', timeout: 5, order: 'first' }, origin: 'defaults' });
  });

  test('a slot it fills keeps the opt-in status the repo gives it', () => {
    expect(check(resolve(null, { checks: { format: 'prettier' } }), 'format')).toMatchObject({ adapter: { name: 'prettier' }, optIn: true, explicit: false });
    expect(check(resolve({ checks: { format: { timeout: 9 } } }, { checks: { format: 'prettier' } }), 'format').explicit).toBe(true);
    expect(check(resolve(null, { checks: { format: { use: 'prettier', optIn: false } } }), 'format')).toMatchObject({ optIn: false });
  });

  test('its pack block ranks over its top level, and its false leaves the gap', () => {
    const checks = resolve(null, { packs: { ts: { checks: { lint: 'biome', test: false } } }, checks: { lint: 'oxlint', test: 'vitest' } });
    expect(check(checks, 'lint')).toMatchObject({ adapter: { name: 'biome' }, origin: 'defaults' });
    expect(check(checks, 'test')).toMatchObject({ adapter: null, skip: 'no tool detected for slot' });
  });

  test('a repo-scope slot takes the top-level entry', () => {
    expect(check(resolve(null, { checks: { docs: 'markdownlint-cli2' } }), 'docs')).toMatchObject({ adapter: { name: 'markdownlint-cli2' }, origin: 'defaults' });
  });

  test('it never wakes an inactive slot', () => {
    expect(check(resolve(null, { checks: { unclaimed: 'unclaimed' } }), 'unclaimed')).toMatchObject({ adapter: null, inactive: true });
  });

  test('a script-gated slot it fills still stands down without the script, and says nothing of the defaults', () => {
    const build = check(resolve(null, { checks: { build: 'build' } }), 'build');
    expect(build).toMatchObject({ adapter: null, skip: "no 'build' script in package.json" });
    expect(build).not.toHaveProperty('origin');
  });
});

describe('a defaults pick lands only where the check can run it', () => {
  test('a top-level ts linter leaves a go root’s gap, and the go pack block fills it', () => {
    const goRoot = present('go.mod');
    for (const lint of ['oxlint', { use: 'oxlint' }]) {
      const gap = check(resolve(null, { checks: { lint } }, goRoot), 'lint');
      expect(gap).toMatchObject({ adapter: null, skip: 'no tool detected for slot', pack: 'go' });
      expect(gap).not.toHaveProperty('origin');
    }
    const filled = resolve(null, { checks: { lint: 'oxlint' }, packs: { go: { checks: { lint: 'golangci-lint' } } } }, goRoot);
    expect(check(filled, 'lint')).toMatchObject({ adapter: { name: 'golangci-lint' }, origin: 'defaults', pack: 'go' });
  });

  test('in multi-target mode it fills each target its detection left empty, and no other', () => {
    const config: CheckrideConfig = { targets: { web: { lang: 'ts', root: 'apps/web' }, api: { lang: 'go', root: 'apps/api' } } };
    const defaults: CheckrideConfig = { packs: { ts: { checks: { lint: 'eslint' } } }, checks: { docs: 'rumdl' } };
    const checks = resolve(config, defaults, present('apps/api/go.mod', 'apps/web/.oxlintrc.json'));
    expect(check(checks, 'web:lint')).toMatchObject({ adapter: { name: 'oxlint' }, origin: 'detected' });
    expect(check(checks, 'api:lint')).toMatchObject({ adapter: null });
    expect(check(checks, 'docs')).toMatchObject({ adapter: { name: 'rumdl' }, origin: 'defaults', pack: 'repo' });
    const empty = resolve(config, defaults, present('apps/api/go.mod'));
    expect(check(empty, 'web:lint')).toMatchObject({ adapter: { name: 'eslint' }, origin: 'defaults', target: 'web' });
  });
});

describe("the defaults' custom checks", () => {
  const licenses = { command: 'licenses' };

  test('one joins under a name the repo declares nowhere, marked defaults', () => {
    expect(check(resolve(null, { checks: { licenses } }), 'licenses')).toMatchObject({ adapter: { command: 'licenses' }, origin: 'defaults' });
  });

  test('one its detect gate stands down is skipped with no origin', () => {
    const gated = check(resolve(null, { checks: { licenses: { ...licenses, detect: ['LICENSES.md'] } } }), 'licenses');
    expect(gated).toMatchObject({ adapter: null, skip: 'no detect file present' });
    expect(gated).not.toHaveProperty('origin');
  });

  test("the repo's check of that name wins, and so does the repo's false", () => {
    const own = resolve({ checks: { licenses: { command: 'repo-licenses' } } }, { checks: { licenses } });
    expect([...own.values()].filter((c) => c.slot === 'licenses')).toEqual([expect.objectContaining({ adapter: expect.objectContaining({ command: 'repo-licenses' }), origin: 'custom' })]);
    expect(resolve({ checks: { licenses: false } }, { checks: { licenses } }).has('licenses')).toBe(false);
  });

  test('a name a target or a pack block of the repo declares keeps it out too', () => {
    const config: CheckrideConfig = { targets: { web: { lang: 'ts', root: 'apps/web', checks: { licenses: { command: 'web' } } } } };
    expect(resolve(config, { checks: { licenses } }).has('licenses')).toBe(false);
  });

  test("a target's own false keeps the defaults' pack check of that name out of every target", () => {
    const config: CheckrideConfig = {
      targets: { web: { lang: 'ts', root: 'apps/web', checks: { audit: false } }, api: { lang: 'ts', root: 'apps/api' } },
    };
    const checks = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config,
      defaults: { packs: { ts: { checks: { audit: { command: 'audit' } } } } },
      fileExists: present(),
      manifest: NO_MANIFEST,
    });
    expect(checks.filter((c) => c.slot === 'audit')).toEqual([]);
    for (const c of checks) expect(typeof c.slot).toBe('string');
  });

  test('a pack block’s custom check joins every target of the pack, after the repo’s own', () => {
    const config: CheckrideConfig = { targets: { web: { lang: 'ts', root: 'apps/web', checks: { e2e: { command: 'e2e' } } } } };
    const names = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config,
      defaults: { packs: { ts: { checks: { audit: { command: 'audit' } } } } },
      fileExists: present(),
      manifest: NO_MANIFEST,
    }).map(checkName);
    expect(names.indexOf('web:audit')).toBe(names.indexOf('web:e2e') + 1);
  });
});

describe("a slot a target's pack doesn't fill", () => {
  const slots = [...SLOTS, { name: 'fake', scope: 'target' as const }];
  const web = { lang: 'ts', root: 'apps/web' } as const;
  const run = (config: CheckrideConfig, defaults: CheckrideConfig): Map<string, ResolvedCheck> =>
    new Map(resolveChecks({ slots, adapters: ADAPTERS, config, defaults, fileExists: present(), manifest: NO_MANIFEST }).map((c) => [checkName(c), c]));

  test("gets a check when the repo's pack block names one, or the defaults' pack block does", () => {
    expect(check(run({ targets: { web }, packs: { ts: { checks: { fake: { command: 'repo' } } } } }, {}), 'web:fake')).toMatchObject({ origin: 'config' });
    expect(check(run({ targets: { web } }, { packs: { ts: { checks: { fake: { command: 'defaults' } } } } }), 'web:fake')).toMatchObject({ origin: 'defaults' });
  });

  test("gets none from the defaults' top level alone", () => {
    expect(run({ targets: { web } }, { checks: { fake: { command: 'defaults' } } }).has('web:fake')).toBe(false);
  });
});

describe('the pack block of a repo without targets ranks under its top level', () => {
  test('a ts root reads packs.ts for a target-scope slot and a custom check', () => {
    const checks = resolve({ checks: { test: { timeout: 3 } }, packs: { ts: { checks: { lint: 'biome', test: 'vitest', gen: { command: 'gen' } } } } }, {});
    expect(check(checks, 'lint')).toMatchObject({ adapter: { name: 'biome' }, origin: 'config' });
    expect(check(checks, 'test')).toMatchObject({ adapter: { name: 'vitest', timeout: 3 }, origin: 'config' });
    expect(check(checks, 'gen')).toMatchObject({ adapter: { command: 'gen' }, origin: 'custom' });
    expect(check(checks, 'gen')).not.toHaveProperty('pack');
  });
});

describe('loading a defaults file', () => {
  let dir: string;
  let repo: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-defaults-'));
    repo = await mkdtemp(join(tmpdir(), 'checkride-defaults-repo-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  async function write(name: string, body: unknown): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, JSON.stringify(body));
    return path;
  }

  test('it reads checks, packs, timeout, requirePins, schemas and static, and resolves its extends against itself', async () => {
    await mkdir(join(dir, 'base'));
    await writeFile(join(dir, 'base', 'shared.json'), JSON.stringify({ checks: { spell: 'typos' } }));
    const path = await write('defaults.json', {
      extends: './base/shared.json',
      checks: { licenses: { command: 'licenses', static: true } },
      packs: { go: { checks: { lint: 'golangci-lint' } } },
      timeout: 60,
      requirePins: true,
      schemas: [],
    });
    expect(loadDefaultsFile(path, repo)).toMatchObject({ checks: { spell: 'typos', licenses: { static: true } }, timeout: 60, requirePins: true });
  });

  // F36
  test('targets is an error naming the file, in the file or anything it extends (V11)', async () => {
    const path = await write('defaults.json', { targets: { app: { lang: 'ts', root: '.' } } });
    expect(() => loadDefaultsFile(path, repo)).toThrow(`invalid ${path}: a defaults file can't declare targets`);
    await write('preset.json', { targets: { app: { lang: 'ts', root: '.' } } });
    const extending = await write('extending.json', { extends: './preset.json' });
    expect(() => loadDefaultsFile(extending, repo)).toThrow(new RegExp(`^invalid ${extending}: extends "./preset.json" declares targets`));
  });

  test.each(['gate', 'changedBase', 'unclaimed', 'rules'])('the repo-only or unknown key %s is an error naming the file', async (key) => {
    const path = await write('defaults.json', { [key]: {} });
    expect(() => loadDefaultsFile(path, repo)).toThrow(`invalid ${path}: a defaults file can't set ${key}`);
  });

  test('every entry is held to resolution’s rules at load, whether or not it fills a slot here', async () => {
    const order = await write('order.json', { packs: { go: { checks: { lint: { use: 'golangci-lint', order: 'soon' } } } } });
    expect(() => loadDefaultsFile(order, repo)).toThrow(new RegExp(`^invalid ${order}: 'lint' order must be`));
    const tuning = await write('tuning.json', { checks: { test: { optIn: 'yes' } } });
    expect(() => loadDefaultsFile(tuning, repo)).toThrow(`invalid ${tuning}: 'test' optIn must be a boolean`);
    const custom = await write('custom.json', { checks: { licenses: { command: 'x', skipExitCode: 0 } } });
    expect(() => loadDefaultsFile(custom, repo)).toThrow(`invalid ${custom}: 'licenses' skipExitCode must be an integer`);
    const tuned = await write('tuned.json', { checks: { lint: { order: 'soon' } } });
    expect(() => loadDefaultsFile(tuned, repo)).toThrow(new RegExp(`^invalid ${tuned}: 'lint' order must be`));
    const links = await write('links.json', { checks: { links: { use: 'links', allowlist: ['('] } } });
    expect(() => loadDefaultsFile(links, repo)).toThrow(`invalid ${links}: 'links' allowlist entry "(" is not a valid regular expression`);
  });

  test('a top-level entry naming an adapter no pack has is an error, since it could fill nothing', async () => {
    for (const lint of ['oxlnt', { use: 'oxlnt' }]) {
      const path = await write('defaults.json', { checks: { lint } });
      expect(() => loadDefaultsFile(path, repo)).toThrow(`invalid ${path}: 'lint' names 'oxlnt', which isn't an adapter of any pack`);
    }
  });
});

describe('a --config file’s errors name the file', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-config-label-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('as it loads, and as it resolves', async () => {
    const empty = join(dir, 'empty.json');
    await writeFile(empty, JSON.stringify({ targets: {} }));
    expect(() => loadConfigFile(empty, dir)).toThrow(new RegExp(`^invalid ${empty}: targets is empty`));
    const late = join(dir, 'late.json');
    await writeFile(late, JSON.stringify({ checks: { lint: { use: 'oxlint', order: 'soon' } } }));
    const config = loadConfigFile(late, dir);
    expect(() => resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, fileExists: present(), manifest: NO_MANIFEST })).toThrow(
      new RegExp(`^invalid ${late}: 'lint' order must be`),
    );
  });

  test('an error that isn’t a config error passes through unchanged', async () => {
    const path = join(dir, 'ci.json');
    await writeFile(path, JSON.stringify({ checks: {} }));
    const config = loadConfigFile(path, dir);
    expect(() => resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, fileExists: diskGone, manifest: NO_MANIFEST })).toThrow(/^disk gone$/);
  });

  test('the repo’s own file keeps its name', () => {
    const config = { checks: { lint: { use: 'oxlint', order: 'soon' } } } as unknown as CheckrideConfig;
    expect(() => resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, fileExists: present(), manifest: NO_MANIFEST })).toThrow(
      /^invalid checkride\.config\.json: 'lint' order must be/,
    );
  });
});

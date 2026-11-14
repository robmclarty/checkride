/**
 * The keys a local target's entry and its file each hold (D8, D35, D42), and
 * the entry the two compose into. These read no file: `src/config.ts` reads
 * the local file, and `config-targets.test.ts` covers the two together.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { composedEntry, declaresLocal, heldByLocal, isLocalEntry, localEntryProblem, localFileOf, localFileProblem, unreadWarnings } from '../local.js';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schema');

/** A shipped schema file, parsed. */
function schemaFile(name: string): { properties: Record<string, unknown>; definitions: Record<string, { properties?: Record<string, unknown> }> } {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), 'utf8')) as ReturnType<typeof schemaFile>;
}

const REPO_KEYS = new Set(['$schema', 'note', 'extends', 'timeout', 'changedBase', 'requirePins', 'unclaimed', 'schemas', 'targets', 'packs', 'gate', 'checks']);
const REPO_SLOTS = new Set(['struct', 'docs', 'links', 'spell']);
const FILE = 'web/checkride.config.json';

describe('which entries are local', () => {
  test('only an entry that says local: true is local', () => {
    expect(isLocalEntry({ root: 'web', local: true })).toBe(true);
    expect(isLocalEntry({ root: 'web', local: false })).toBe(false);
    expect(isLocalEntry({ root: 'web', local: 'true' })).toBe(false);
    expect(isLocalEntry({ lang: 'ts', root: 'web' })).toBe(false);
    expect(isLocalEntry(null)).toBe(false);
  });

  test('a targets block declares a local target once any entry is one', () => {
    expect(declaresLocal({ web: { root: 'web', local: true }, api: { lang: 'go', root: 'api' } })).toBe(true);
    expect(declaresLocal({ api: { lang: 'go', root: 'api' } })).toBe(false);
    expect(declaresLocal(undefined)).toBe(false);
    expect(declaresLocal([{ local: true }])).toBe(false);
  });

  test("a local target's file sits at its root, under the name the suite's config goes by", () => {
    expect(localFileOf('web', 'checkride.config.json')).toBe(FILE);
    expect(localFileOf('services/api/', 'checkride.evals.config.json')).toBe('services/api/checkride.evals.config.json');
  });
});

describe("a local target's entry (D35)", () => {
  test('root, local and note are the whole of it', () => {
    expect(localEntryProblem('web', { root: 'web', local: true, note: 'the storefront' }, FILE)).toBeNull();
  });

  test.each(['lang', 'checks', 'include', 'exclude', 'timeout', 'extends'])('%s beside local: true names the entry and the file that should hold it', (key) => {
    const problem = localEntryProblem('web', { root: 'web', local: true, [key]: 'x' }, FILE);
    expect(problem).toBe(`targets.web sets ${key} beside local: true, and a local target's entry holds only root, local, note: move ${key} to ${FILE}`);
  });
});

describe("a local target's file (D8)", () => {
  test('lang, checks, include, exclude, timeout and extends are its own', () => {
    const own = { $schema: 's', note: 'n', extends: './base.json', lang: 'ts', checks: {}, include: [], exclude: [], timeout: 30 };
    expect(localFileProblem(own, FILE, REPO_KEYS)).toBeNull();
    expect(unreadWarnings(own, FILE, FILE, REPO_SLOTS)).toEqual([]);
  });

  test.each(['targets', 'schemas', 'unclaimed', 'packs', 'gate', 'changedBase', 'requirePins'])('%s belongs to the whole repo, and the problem names the file', (key) => {
    const problem = localFileProblem({ lang: 'ts', [key]: {} }, FILE, REPO_KEYS);
    expect(problem).toContain(`${FILE} sets ${key}, which belongs to the whole repo`);
    expect(problem).toContain(`set ${key} in the repo's own config`);
  });

  test('a key no config reads is a warning naming the file, never a refusal', () => {
    expect(localFileProblem({ lang: 'ts', lnag: 'ts' }, FILE, REPO_KEYS)).toBeNull();
    expect(unreadWarnings({ lang: 'ts', lnag: 'ts' }, FILE, FILE, REPO_SLOTS)).toEqual([
      `checkride: ${FILE} has a top-level key "lnag", which a local target's file doesn't read (it reads lang, checks, include, exclude, timeout and extends)`,
    ]);
  });

  test("its own entry for a repo-scope slot draws no warning here: the target's rules refuse it", () => {
    expect(unreadWarnings({ lang: 'ts', checks: { spell: false } }, FILE, FILE, REPO_SLOTS)).toEqual([]);
  });
});

describe('a preset a local file extends (D42)', () => {
  const preset = { timeout: 60, requirePins: true, packs: { ts: {} }, checks: { lint: 'oxlint', spell: false, docs: 'markdownlint-cli2' } };

  test('hands over only what a local file may hold', () => {
    expect(heldByLocal(preset, REPO_SLOTS)).toEqual({ timeout: 60, checks: { lint: 'oxlint' } });
    expect(heldByLocal({ lang: 'go', gate: {} }, REPO_SLOTS)).toEqual({ lang: 'go' });
  });

  test('each key it drops is a warning naming the preset and the local file', () => {
    expect(unreadWarnings(preset, 'presets/base.json', FILE, REPO_SLOTS)).toEqual([
      `checkride: presets/base.json has a top-level key "requirePins", which ${FILE}, a local target's file, doesn't read (it reads lang, checks, include, exclude, timeout and extends)`,
      `checkride: presets/base.json has a top-level key "packs", which ${FILE}, a local target's file, doesn't read (it reads lang, checks, include, exclude, timeout and extends)`,
      `checkride: presets/base.json configures spell, a repo-scope slot, which ${FILE}, a local target's file, doesn't read (configure it in the repo's top-level checks)`,
      `checkride: presets/base.json configures docs, a repo-scope slot, which ${FILE}, a local target's file, doesn't read (configure it in the repo's top-level checks)`,
    ]);
  });
});

describe('the entry a local target composes into', () => {
  test("is the entry's root and local with what the file holds for it", () => {
    const file = { $schema: 's', extends: './x.json', lang: 'bash', include: ['bin/*'], exclude: ['bin/old'], checks: { lint: 'shellcheck' }, timeout: 30, stray: 1 };
    expect(composedEntry({ root: 'scripts', local: true }, file)).toEqual({
      lang: 'bash',
      include: ['bin/*'],
      exclude: ['bin/old'],
      checks: { lint: 'shellcheck' },
      timeout: 30,
      root: 'scripts',
      local: true,
    });
  });

  test("keeps the entry's note over the file's, and leaves out what the file doesn't set", () => {
    expect(composedEntry({ root: 'web', local: true, note: 'entry' }, { lang: 'ts', note: 'file' })).toEqual({ lang: 'ts', root: 'web', local: true, note: 'entry' });
    expect(composedEntry({ root: 'web', local: true }, { note: 'file' })).toEqual({ root: 'web', local: true, note: 'file' });
  });
});

describe('the two schema files agree with the rules', () => {
  const config = schemaFile('checkride.config.schema.json');
  const local = schemaFile('checkride.local.schema.json');

  test("the local file's schema takes exactly the keys a local file holds", () => {
    const keys = Object.keys(local.properties);
    expect(keys.toSorted()).toEqual(['$schema', 'checks', 'exclude', 'extends', 'include', 'lang', 'note', 'timeout']);
    const own = Object.fromEntries(keys.map((key) => [key, 1]));
    expect(localFileProblem(own, FILE, REPO_KEYS)).toBeNull();
    expect(unreadWarnings(own, FILE, FILE, REPO_SLOTS)).toEqual([]);
  });

  test("the config schema's local entry takes root, local and note, and a declared one may say local: false", () => {
    expect(Object.keys(config.definitions['localTarget']?.properties ?? {}).toSorted()).toEqual(['local', 'note', 'root']);
    expect(config.definitions['localTarget']?.properties?.['local']).toMatchObject({ const: true });
    expect(config.definitions['declaredTarget']?.properties?.['local']).toMatchObject({ const: false });
  });

  test('every definition the local schema carries is the config schema\'s, word for word', () => {
    // The local schema stands alone, since a bundled schema reads no other file, so its copies are held to their source here.
    expect(Object.keys(local.definitions).toSorted()).toEqual(['customCheck', 'inheritedOverride', 'note', 'order', 'packName', 'slotConfig', 'slotTuning', 'useConfig']);
    for (const [name, definition] of Object.entries(local.definitions)) expect(definition, name).toEqual(config.definitions[name]);
    expect(local.properties['include']).toEqual(config.definitions['declaredTarget']?.properties?.['include']);
    expect(local.properties['exclude']).toEqual(config.definitions['declaredTarget']?.properties?.['exclude']);
  });
});

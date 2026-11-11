import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { fakeSea } from '../../test/helpers/sea.js';
import { runtime, useRuntime } from '../channel.js';
import { readResource } from '../resources.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let sea: ReturnType<typeof fakeSea>;

beforeEach(() => {
  sea = fakeSea(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe('readResource in the binary', () => {
  test('serves the same relative path from the embedded assets, and never the package directory', () => {
    sea.binary = true;
    sea.assets.set('templates/ts/shared/oxlintrc.json', 'embedded');
    expect(readResource('templates/ts/shared/oxlintrc.json')).toBe('embedded');
    // On disk beside this test, but not embedded: the binary has no package directory to fall back to.
    expect(() => readResource('skills/check/SKILL.md')).toThrow(/asset not found: skills\/check\/SKILL\.md/);
  });
});

describe('runtime', () => {
  test('is npm outside a single executable application, and binary inside one', () => {
    expect(runtime().channel).toBe('npm');
    sea.binary = true;
    expect(runtime().channel).toBe('binary');
  });

  test('names the Node this process runs on as the one a binary embeds, and none for npm', () => {
    expect(runtime().embeddedNode).toBeNull();
    sea.binary = true;
    expect(runtime().embeddedNode).toBe(process.versions.node);
  });

  test('outside the binary there is no embedded file to read', () => {
    sea.assets.set('package.json', '{}');
    expect(runtime().asset).toBeNull();
  });

  test('is worked out once, from node:sea', () => {
    useRuntime(undefined);
    const lookup = vi.spyOn(process, 'getBuiltinModule');
    const first = runtime();
    expect(runtime()).toBe(first);
    expect(lookup.mock.calls.filter(([id]) => id === 'node:sea')).toHaveLength(1);
    expect(first.channel).toBe('npm');
  });

  test('inside a single executable application it is the binary’s, reading its assets', () => {
    useRuntime(undefined);
    const real = process.getBuiltinModule.bind(process);
    const module = { isSea: () => true, getAsset: (key: string, encoding: string) => `${key} as ${encoding}` };
    vi.spyOn(process, 'getBuiltinModule').mockImplementation((id: string) => (id === 'node:sea' ? module : real(id)));
    expect(runtime().channel).toBe('binary');
    expect(runtime().asset?.('package.json')).toBe('package.json as utf8');
  });

  test('a runtime with no node:sea, as Bun has none, is the npm channel', () => {
    useRuntime(undefined);
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(() => undefined);
    expect(runtime().channel).toBe('npm');
    useRuntime(undefined);
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(() => {
      throw new Error('No such built-in module: node:sea');
    });
    expect(runtime().channel).toBe('npm');
  });
});

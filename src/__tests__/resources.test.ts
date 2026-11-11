import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { fakeSea } from '../../test/helpers/sea.js';
import { channel, embeddedAsset, nodeVersion } from '../channel.js';
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

describe('channel', () => {
  test('is npm outside a single executable application, and binary inside one', () => {
    expect(channel()).toBe('npm');
    sea.binary = true;
    expect(channel()).toBe('binary');
  });

  test('names the Node this process runs on, the one a binary embeds', () => {
    expect(nodeVersion()).toBe(process.versions.node);
  });
});

describe('embeddedAsset', () => {
  test('refuses outside the binary, which embeds nothing', () => {
    sea.assets.set('package.json', '{}');
    expect(() => embeddedAsset('package.json')).toThrow('no embedded asset package.json: not the standalone binary');
  });

  test('a runtime with no node:sea, as Bun has none, is the npm channel', () => {
    vi.restoreAllMocks();
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(() => undefined);
    expect(channel()).toBe('npm');
    expect(() => embeddedAsset('package.json')).toThrow(/not the standalone binary/);
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(() => {
      throw new Error('No such built-in module: node:sea');
    });
    expect(channel()).toBe('npm');
  });
});

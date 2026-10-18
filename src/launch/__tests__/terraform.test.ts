import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { exactVersion, tfVersionDeclaration } from '../terraform.js';

describe('exactVersion', () => {
  test.each([
    ['1.5.7', '1.5.7'],
    ['1.5.7\n', '1.5.7'],
    ['v1.13.1', '1.13.1'],
    ['1.6.0-rc1', '1.6.0-rc1'],
  ])('%j names the release %s', (text, version) => {
    expect(exactVersion(text)).toBe(version);
  });

  test.each(['latest', 'latest:^1.5', 'min-required', 'latest-allowed', '1.5', '>= 1.5.0', ''])('%j is a constraint, not a release', (text) => {
    expect(exactVersion(text)).toBeUndefined();
  });
});

describe('tfVersionDeclaration', () => {
  let repo: string;
  beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'checkride-tf-version-')); });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  test('names the file from the repo root, the CLI it declares and its manager, and no release for a constraint', async () => {
    await writeFile(join(repo, '.terraform-version'), 'latest:^1.5\n');
    expect(tfVersionDeclaration(repo, repo)).toMatchObject({ file: '.terraform-version', cli: { bin: 'terraform' }, manager: 'tfenv' });
    expect(tfVersionDeclaration(repo, repo)).not.toHaveProperty('version');
    await writeFile(join(repo, '.opentofu-version'), '1.13.1\n');
    expect(tfVersionDeclaration(repo, repo)).toMatchObject({ file: '.opentofu-version', cli: { bin: 'tofu' }, manager: 'tofuenv', version: '1.13.1' });
  });

  test('finds none in a tree without one', () => {
    expect(tfVersionDeclaration(repo, repo)).toBeNull();
  });
});

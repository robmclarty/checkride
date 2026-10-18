import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { implicitPack } from '../index.js';
import { markerAt, markerKind } from '../markers.js';

describe('markerAt', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-marker-at-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('answers a marker name by the file, and a glob by any file in the directory itself', async () => {
    const at = markerAt(dir);
    expect(at('go.mod')).toBe(false);
    expect(at('*.tf')).toBe(false);
    await writeFile(join(dir, 'go.mod'), '');
    await writeFile(join(dir, 'main.tf'), '');
    // The listing is read once, on the first glob asked about, so a fresh one sees the new file.
    expect(markerAt(dir)('go.mod')).toBe(true);
    expect(markerAt(dir)('*.tf')).toBe(true);
  });

  test('a glob matches no directory and nothing below, and an unreadable directory holds nothing', async () => {
    await mkdir(join(dir, 'odd.tf'));
    await mkdir(join(dir, 'infra'));
    await writeFile(join(dir, 'infra', 'main.tf'), '');
    expect(markerAt(dir)('*.tf')).toBe(false);
    expect(markerAt(join(dir, 'missing'))('*.tf')).toBe(false);
  });

  test('a root holding only a .tf file is a terraform root, and a lock file beside a python marker is python’s (R2.1)', async () => {
    await writeFile(join(dir, 'main.tf'), '');
    expect(implicitPack(markerAt(dir))).toBe('terraform');
    await writeFile(join(dir, 'pyproject.toml'), '');
    expect(implicitPack(markerAt(dir))).toBe('python');
  });
});

describe('markerKind', () => {
  test('names the pack each marker file marks, terraform’s by its glob', () => {
    expect(markerKind('infra/main.tf')).toBe('terraform');
    expect(markerKind('infra/.terraform.lock.hcl')).toBe('terraform');
    expect(markerKind('svc/go.mod')).toBe('go');
    expect(markerKind('infra/vars.tfvars')).toBeNull();
  });
});

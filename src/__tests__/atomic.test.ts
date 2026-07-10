import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { writeFileAtomic } from '../atomic.js';

describe('writeFileAtomic', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-atomic-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('writes new content and leaves no temp sibling behind', async () => {
    const path = join(dir, 'summary.json');
    await writeFileAtomic(path, '{"ok":true}\n');
    expect(await readFile(path, 'utf8')).toBe('{"ok":true}\n');
    expect(await readdir(dir)).toEqual(['summary.json']);
  });

  test('replaces existing content in place', async () => {
    const path = join(dir, 'summary.json');
    await writeFile(path, 'old');
    await writeFileAtomic(path, 'new');
    expect(await readFile(path, 'utf8')).toBe('new');
    expect(await readdir(dir)).toEqual(['summary.json']);
  });

  test('a failed write cleans up its temp file and leaves the target untouched', async () => {
    const path = join(dir, 'nested', 'summary.json'); // parent dir missing -> write fails
    await expect(writeFileAtomic(path, 'data')).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });
});

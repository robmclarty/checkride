import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { checkLinks } from './index.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'checkride-links-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(rel: string, body: string): Promise<void> {
  const full = join(dir, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, body);
}

test('passes when relative targets resolve', async () => {
  await write('TARGET.md', '# target\n');
  await write('README.md', 'see [target](./TARGET.md) and [ext](https://example.com)\n');
  const out = await checkLinks(dir);
  expect(out.ok).toBe(true);
  expect(out.exit_code).toBe(0);
  expect(JSON.parse(out.stdout)).toEqual({ ok: true });
});

test('fails and reports a broken relative target', async () => {
  await write('README.md', 'broken [link](./missing.md)\n');
  const out = await checkLinks(dir);
  expect(out.ok).toBe(false);
  expect(out.exit_code).toBe(1);
  const misses = JSON.parse(out.stdout) as { link: string; file: string }[];
  expect(misses).toHaveLength(1);
  expect(misses[0]?.link).toBe('./missing.md');
  expect(out.stderr).toContain('broken link in README.md');
});

test('skips external links, bare anchors, and strips fragments', async () => {
  await write('TARGET.md', '# t\n');
  await write(
    'README.md',
    [
      '[ext](http://example.com)',
      '[mail](mailto:a@b.c)',
      '[anchor](#section)',
      '[frag](./TARGET.md#heading)',
    ].join('\n'),
  );
  const out = await checkLinks(dir);
  expect(out.ok).toBe(true);
});

test('ignores markdown under excluded directories', async () => {
  await write('node_modules/pkg/README.md', '[broken](./nope.md)\n');
  await write('README.md', '# clean\n');
  const out = await checkLinks(dir);
  expect(out.ok).toBe(true);
});

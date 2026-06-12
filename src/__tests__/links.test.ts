import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { checkLinks } from '../links.js';

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

test('fails and reports a broken relative target with its line number', async () => {
  await write('README.md', '# title\n\nbroken [link](./missing.md)\n');
  const out = await checkLinks(dir);
  expect(out.ok).toBe(false);
  expect(out.exit_code).toBe(1);
  const misses = JSON.parse(out.stdout) as { link: string; file: string; line: number }[];
  expect(misses).toHaveLength(1);
  expect(misses[0]?.link).toBe('./missing.md');
  expect(misses[0]?.line).toBe(3);
  expect(out.stderr).toContain('broken link in README.md:3');
});

test('skips external links, bare anchors, and strips fragments', async () => {
  await write('TARGET.md', '# t\n');
  await write(
    'README.md',
    [
      '[ext](http://example.com/missing.md)',
      '[mail](mailto:a@b.c)',
      '[anchor](#section)',
      '[frag](./TARGET.md#heading)',
    ].join('\n'),
  );
  const out = await checkLinks(dir);
  expect(out.ok).toBe(true);
});

test('an external host that looks like a path is still skipped', async () => {
  // If isExternal were broken, this https target would resolve as a relative
  // path, miss on disk, and fail.
  await write('README.md', '[x](https://example.com/does/not/exist.md)\n');
  const out = await checkLinks(dir);
  expect(out.ok).toBe(true);
});

test('ignores markdown under excluded directories', async () => {
  await write('node_modules/pkg/README.md', '[broken](./nope.md)\n');
  await write('README.md', '# clean\n');
  const out = await checkLinks(dir);
  expect(out.ok).toBe(true);
});

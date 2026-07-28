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

test('config exclude skips a directory the walk would otherwise fail on', async () => {
  await write('.ridgeline/builds/x/spec.md', '[illustrative](target)\n');
  await write('README.md', '# clean\n');
  // Without the extra exclude, the .ridgeline markdown fails.
  expect((await checkLinks(dir)).ok).toBe(false);
  // With it, the directory is never walked.
  expect((await checkLinks(dir, { exclude: ['.ridgeline'] })).ok).toBe(true);
});

test('config allowlist tolerates a matching broken link but still catches others', async () => {
  await write(
    'README.md',
    ['[illustrative](foo/bar)', '[real miss](./missing.md)'].join('\n') + '\n',
  );
  const out = await checkLinks(dir, { allowlist: ['^foo/'] });
  expect(out.ok).toBe(false);
  const misses = JSON.parse(out.stdout) as { link: string }[];
  expect(misses.map((m) => m.link)).toEqual(['./missing.md']);
});

test('an allowlist that matches every broken link passes', async () => {
  await write('docs/spec.md', '[a](x) and [b](y/z)\n');
  const out = await checkLinks(dir, { allowlist: ['.'] });
  expect(out.ok).toBe(true);
});

const TICKS = '`'.repeat(3);

test('skips links inside a fenced code block, but not after it closes', async () => {
  await write(
    'README.md',
    [
      `${TICKS}markdown`,
      '[example](./does-not-exist.md)',
      TICKS,
      '',
      '[real miss](./missing.md)',
    ].join('\n') + '\n',
  );
  const out = await checkLinks(dir);
  expect(out.ok).toBe(false);
  const misses = JSON.parse(out.stdout) as { link: string; line: number }[];
  expect(misses.map((m) => m.link)).toEqual(['./missing.md']);
  expect(misses[0]?.line).toBe(5);
});

test('skips links inside a tilde fence', async () => {
  await write('README.md', ['~~~', '[example](./nope.md)', '~~~'].join('\n') + '\n');
  expect((await checkLinks(dir)).ok).toBe(true);
});

test('a fence is not closed by a shorter marker or a different character', async () => {
  // The inner ``` and ~~~ lines are content of the ```` block, not terminators.
  await write(
    'README.md',
    ['````', TICKS, '[a](./nope.md)', TICKS, '~~~', '[b](./nope.md)', '````'].join('\n') + '\n',
  );
  expect((await checkLinks(dir)).ok).toBe(true);
});

test('a closing fence may be longer than the opening one', async () => {
  await write('README.md', [TICKS, '[a](./nope.md)', '`````', '[b](./missing.md)'].join('\n') + '\n');
  const out = await checkLinks(dir);
  expect(out.ok).toBe(false);
  const misses = JSON.parse(out.stdout) as { link: string }[];
  expect(misses.map((m) => m.link)).toEqual(['./missing.md']);
});

test('an indented fence still opens a block', async () => {
  await write('README.md', [`   ${TICKS}`, '[a](./nope.md)', `   ${TICKS}`].join('\n') + '\n');
  expect((await checkLinks(dir)).ok).toBe(true);
});

test('skips links inside inline code spans', async () => {
  await write(
    'README.md',
    [
      'write `[example](./nope.md)` to link a file',
      'a doubled span: ``[example](./nope.md)`` too',
      'but [real miss](./missing.md) still counts',
    ].join('\n') + '\n',
  );
  const out = await checkLinks(dir);
  expect(out.ok).toBe(false);
  const misses = JSON.parse(out.stdout) as { link: string; line: number }[];
  expect(misses.map((m) => m.link)).toEqual(['./missing.md']);
  expect(misses[0]?.line).toBe(3);
});

test('an unclosed backtick is literal text, not a span that swallows a link', async () => {
  await write('README.md', 'a stray ` tick then [broken](./missing.md)\n');
  const out = await checkLinks(dir);
  expect(out.ok).toBe(false);
  const misses = JSON.parse(out.stdout) as { link: string }[];
  expect(misses.map((m) => m.link)).toEqual(['./missing.md']);
});

test('a backtick-fence info string containing backticks does not open a block', async () => {
  // ``` `a` ``` is an inline span holding `a`, so the next line is ordinary text.
  await write('README.md', [`${TICKS} \`a\` ${TICKS}`, '[broken](./missing.md)'].join('\n') + '\n');
  const out = await checkLinks(dir);
  expect(out.ok).toBe(false);
  const misses = JSON.parse(out.stdout) as { link: string; line: number }[];
  expect(misses.map((m) => m.link)).toEqual(['./missing.md']);
  expect(misses[0]?.line).toBe(2);
});

test('an unterminated fence skips the rest of the file', async () => {
  await write('README.md', [TICKS, '[a](./nope.md)', '[b](./nope.md)'].join('\n') + '\n');
  expect((await checkLinks(dir)).ok).toBe(true);
});

test('a 4-space indented code block is still checked', async () => {
  // Deliberate: indented blocks are ambiguous with list continuation, so the
  // check stays strict there rather than risking false negatives.
  await write('README.md', '    [indented](./missing.md)\n');
  expect((await checkLinks(dir)).ok).toBe(false);
});

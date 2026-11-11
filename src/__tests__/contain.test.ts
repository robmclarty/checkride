/**
 * The containment rule (`../contain.ts`): where a path really is, against a
 * repository root, learned without touching anything outside that root.
 *
 * `node:fs` is a recording stand-in here, so each case can show the walk
 * asked the disk about paths inside the repository alone.
 */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { forget, touched } from '../../test/helpers/fs-spy.js';
import type { Located, Root } from '../contain.js';
import { located, locatedSync, repoRoot } from '../contain.js';

vi.mock('node:fs', async (original) => {
  const { spied } = await import('../../test/helpers/fs-spy.js');
  return spied(await original<typeof import('node:fs')>());
});
vi.mock('node:fs/promises', async (original) => {
  const { spied } = await import('../../test/helpers/fs-spy.js');
  return spied(await original<typeof import('node:fs/promises')>());
});

let parent: string;
let dir: string;
let real: string;
let outside: string;
let root: Root;

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'checkride-contain-'));
  dir = join(parent, 'repo');
  outside = join(parent, 'outside');
  await mkdir(join(dir, 'docs', 'voice'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(dir, 'docs', 'voice', 'sample.md'), 'Prose.\n');
  await writeFile(join(outside, 'secret.md'), 'Nobody else\'s business.\n');
  real = await realpath(dir);
  root = repoRoot(dir);
  forget();
});
afterEach(async () => { await rm(parent, { recursive: true, force: true }); });

/** Both forms' answer for `path`, which must be one answer, and every path they asked the disk about. */
async function where(path: string): Promise<{ at: Located; asked: string[] }> {
  forget();
  const sync = locatedSync(root, path);
  const promised = await located(root, path);
  expect(promised).toEqual(sync);
  return { at: sync, asked: touched().map((t) => t.path) };
}

/** True for a path the repository holds, in either spelling of its root. */
const inRepo = (path: string): boolean => path.startsWith(`${real}/`) || path === real || path.startsWith(`${dir}/`) || path === dir;

describe('a path inside the repository', () => {
  test('a file is where it is, by its real path', async () => {
    const { at, asked } = await where(join(dir, 'docs', 'voice', 'sample.md'));
    expect(at).toEqual({ inside: join(real, 'docs', 'voice', 'sample.md') });
    // The stand-in records: each segment is asked about, once by each form, and nothing above the root is.
    expect([...new Set(asked)]).toEqual([join(real, 'docs'), join(real, 'docs', 'voice'), join(real, 'docs', 'voice', 'sample.md')]);
  });

  test('a relative path is read from the root as given', async () => {
    expect((await where('docs/voice')).at).toEqual({ inside: join(real, 'docs', 'voice') });
  });

  test('the root itself is inside it', async () => {
    expect((await where(dir)).at).toEqual({ inside: real });
    expect((await where('.')).at).toEqual({ inside: real });
    expect((await where(real)).at).toEqual({ inside: real });
  });

  test('a path that is not there is missing, and so is one below a file', async () => {
    expect((await where('docs/gone')).at).toBe('missing');
    expect((await where('docs/voice/sample.md/deeper')).at).toBe('missing');
  });

  test('a .. that stays inside is resolved as text', async () => {
    expect((await where('docs/../docs/voice')).at).toEqual({ inside: join(real, 'docs', 'voice') });
  });
});

describe('a symlink that stays inside', () => {
  test('to a file, by an absolute target in the spelling the root was given in', async () => {
    await symlink(join(dir, 'docs', 'voice', 'sample.md'), join(dir, 'alias.md'));
    expect((await where('alias.md')).at).toEqual({ inside: join(real, 'docs', 'voice', 'sample.md') });
  });

  test('to a file, by an absolute target in the real spelling', async () => {
    await symlink(join(real, 'docs', 'voice', 'sample.md'), join(dir, 'alias.md'));
    expect((await where('alias.md')).at).toEqual({ inside: join(real, 'docs', 'voice', 'sample.md') });
  });

  test('to a directory, by a relative target, with more of the path behind it', async () => {
    await symlink(join('docs', 'voice'), join(dir, 'v'));
    expect((await where('v/sample.md')).at).toEqual({ inside: join(real, 'docs', 'voice', 'sample.md') });
  });

  test('through a second link', async () => {
    await symlink('docs', join(dir, 'd'));
    await symlink(join('..', 'd', 'voice'), join(dir, 'docs', 'again'));
    expect((await where('docs/again/sample.md')).at).toEqual({ inside: join(real, 'docs', 'voice', 'sample.md') });
  });

  test('to the root', async () => {
    await symlink('..', join(dir, 'docs', 'up'));
    expect((await where('docs/up')).at).toEqual({ inside: real });
    expect((await where('docs/up/docs/voice/sample.md')).at).toEqual({ inside: join(real, 'docs', 'voice', 'sample.md') });
  });

  test('to nothing is missing', async () => {
    await symlink('gone.md', join(dir, 'dangling.md'));
    expect((await where('dangling.md')).at).toBe('missing');
  });

  test('to itself is missing, and the walk ends', async () => {
    await symlink('loop', join(dir, 'loop'));
    expect((await where('loop')).at).toBe('missing');
  });
});

/** `path`'s answer, having asked the disk about nothing but the repository. */
async function outsideOf(path: string): Promise<Located> {
  const { at, asked } = await where(path);
  expect(asked.filter((p) => !inRepo(p))).toEqual([]);
  return at;
}

describe('a path that leaves the repository is outside, and nothing outside is touched', () => {
  test('an absolute path elsewhere', async () => {
    expect(await outsideOf(join(outside, 'secret.md'))).toBe('outside');
    expect((await where(join(outside, 'secret.md'))).asked).toEqual([]);
  });

  test('a relative path that climbs out', async () => {
    expect(await outsideOf('../outside/secret.md')).toBe('outside');
    expect(await outsideOf('docs/../../outside')).toBe('outside');
  });

  test.each([
    ['a file that exists', 'secret.md'],
    ['a file that does not', 'no-such-file.md'],
  ])('a link to %s outside: the same answer either way', async (_name, target) => {
    await symlink(join(outside, target), join(dir, 'linked.md'));
    expect(await outsideOf('linked.md')).toBe('outside');
  });

  test.each([
    ['a directory that exists', 'outside'],
    ['a directory that does not', 'no-such-directory'],
  ])('a path through a link to %s outside: the same answer either way', async (_name, target) => {
    await symlink(join('..', '..', target), join(dir, 'docs', 'vendor'));
    expect(await outsideOf('docs/vendor/secret.md')).toBe('outside');
    expect(await outsideOf('docs/vendor')).toBe('outside');
  });

  test('a link inside that leads to a link out', async () => {
    await symlink(outside, join(dir, 'docs', 'out'));
    await symlink(join('docs', 'out'), join(dir, 'hop'));
    expect(await outsideOf('hop/secret.md')).toBe('outside');
  });

  test('a link to the parent of the repository', async () => {
    await symlink(join('..'), join(dir, 'up'));
    expect(await outsideOf('up/outside/secret.md')).toBe('outside');
    // Even the way back in: the parent is outside, and is never read to find the repo in it.
    expect(await outsideOf('up/repo/docs')).toBe('outside');
  });
});

test('a root that is not there is its own real path, and holds nothing', () => {
  const gone = repoRoot(join(parent, 'no-repo'));
  expect(gone.real).toBe(gone.given);
  expect(locatedSync(gone, 'x')).toBe('missing');
});

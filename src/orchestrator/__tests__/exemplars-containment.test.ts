/**
 * The `prose` pre-flight's containment, with the disk watched: an exemplars
 * path that leaves the repository gets one answer whether or not anything is
 * where it leads, and nothing outside the repository is asked about on the
 * way to it. `node:fs` is a recording stand-in (`test/helpers/fs-spy.ts`).
 */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { failOn, forget, touched } from '../../../test/helpers/fs-spy.js';
import type { Adapter } from '../../adapters.js';
import type { CheckOutcome } from '../../links.js';
import { missingExemplarsOutcome } from '../spawn.js';

vi.mock('node:fs', async (original) => {
  const { spied } = await import('../../../test/helpers/fs-spy.js');
  return spied(await original<typeof import('node:fs')>());
});
vi.mock('node:fs/promises', async (original) => {
  const { spied } = await import('../../../test/helpers/fs-spy.js');
  return spied(await original<typeof import('node:fs/promises')>());
});

const vale: Adapter = { name: 'vale', slot: 'prose', description: 'vale', detect: [], command: 'vale', args: [], outputFile: null, devDeps: {}, options: { prose: { exemplars: 'docs/voice' } } };

let parent: string;
let dir: string;
let real: string;
let outside: string;

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'checkride-exemplars-contain-'));
  dir = join(parent, 'repo');
  outside = join(parent, 'outside');
  await mkdir(join(dir, 'docs'), { recursive: true });
  await mkdir(join(outside, 'voice'), { recursive: true });
  await writeFile(join(outside, 'voice', 'secret.md'), 'Nobody else\'s business.\n');
  real = await realpath(dir);
});
afterEach(async () => { await rm(parent, { recursive: true, force: true }); });

/** The pre-flight's outcome, and every path it asked the disk about that the repository doesn't hold. */
function preflight(): { outcome: CheckOutcome | null; outsideRepo: string[] } {
  forget();
  const outcome = missingExemplarsOutcome(vale, dir);
  const asked = touched().map((t) => t.path);
  return { outcome, outsideRepo: asked.filter((path) => !path.startsWith(real) && !path.startsWith(dir)) };
}

/** Point `link`, a path in the repo, at `target`, replacing whatever is there. */
async function relink(link: string, target: string): Promise<void> {
  await rm(link, { recursive: true, force: true });
  await symlink(target, link);
}

describe('an exemplars path that leaves the repository', () => {
  test.each([
    ['the directory itself is a link out', 'docs/voice', 'voice', 'no-such-directory'],
    ['a parent of it is a link out', 'docs', '.', 'no-such-parent'],
  ])('%s: one refusal whether or not anything is there, and nothing outside is touched', async (_name, link, there, gone) => {
    await relink(join(dir, link), join(outside, there));
    const exists = preflight();
    await relink(join(dir, link), join(outside, gone));
    const missing = preflight();

    expect(exists.outcome?.refusal).toBe('the `prose` slot names `docs/voice` as its voice exemplars, and that path resolves outside the repository');
    expect(exists.outcome).toMatchObject({ ok: false, exit_code: 1, stdout: '' });
    expect(missing.outcome).toEqual(exists.outcome);
    expect(exists.outsideRepo).toEqual([]);
    expect(missing.outsideRepo).toEqual([]);
  });
});

describe('the entries of an exemplars directory inside the repository', () => {
  beforeEach(async () => { await mkdir(join(dir, 'docs', 'voice')); });

  test.each(['voice/secret.md', 'voice/no-such-file.md', 'voice', 'no-such-directory'])('a link out to %s is passed over, untouched, the same beside a real file or alone', async (target) => {
    await symlink(join(outside, target), join(dir, 'docs', 'voice', 'linked'));
    const alone = preflight();
    expect(alone.outcome?.refusal).toBe('the `prose` slot names `docs/voice` as its voice exemplars, and that path has no files in it');
    expect(alone.outcome?.stderr).not.toContain('linked');
    expect(alone.outsideRepo).toEqual([]);

    await writeFile(join(dir, 'docs', 'voice', 'sample.md'), 'A sentence in my own voice.\n');
    const beside = preflight();
    expect(beside.outcome).toBeNull();
    expect(beside.outsideRepo).toEqual([]);
  });

  test('an entry that can\'t be read is passed over, and the others still count', async () => {
    await writeFile(join(dir, 'README.md'), 'Prose.\n');
    await symlink(join(dir, 'README.md'), join(dir, 'docs', 'voice', 'unreadable.md'));
    forget();
    failOn('statSync', join(real, 'README.md'), 'EACCES');
    const alone = missingExemplarsOutcome(vale, dir);
    expect(alone?.refusal).toBe('the `prose` slot names `docs/voice` as its voice exemplars, and that path has no files in it');

    await writeFile(join(dir, 'docs', 'voice', 'sample.md'), 'A sentence in my own voice.\n');
    forget();
    failOn('statSync', join(real, 'README.md'), 'EACCES');
    expect(missingExemplarsOutcome(vale, dir)).toBeNull();
  });

  test('an entry deleted between the listing and the look is passed over too', async () => {
    await writeFile(join(dir, 'README.md'), 'Prose.\n');
    await symlink(join(dir, 'README.md'), join(dir, 'docs', 'voice', 'going.md'));
    await writeFile(join(dir, 'docs', 'voice', 'sample.md'), 'A sentence in my own voice.\n');
    forget();
    failOn('lstatSync', join(real, 'docs', 'voice', 'going.md'), 'ENOENT');
    expect(missingExemplarsOutcome(vale, dir)).toBeNull();
  });

  test('a directory that can\'t be listed is the directory\'s fault, and the refusal says what failed', async () => {
    await writeFile(join(dir, 'docs', 'voice', 'sample.md'), 'A sentence in my own voice.\n');
    forget();
    failOn('readdirSync', join(real, 'docs', 'voice'), 'EACCES');
    const outcome = missingExemplarsOutcome(vale, dir);
    expect(outcome?.refusal).toBe('the `prose` slot names `docs/voice` as its voice exemplars, and that path can\'t be read (EACCES)');
    expect(outcome?.stderr).not.toContain('does not exist');
  });
});

/**
 * The `prose` slot's `exemplars` path against a repo whose author is a
 * stranger: its config and its symlinks each try to point the pre-flight at a
 * directory outside the repository, and none of them gets that directory
 * listed, a file in it opened, or a word about what is there printed.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../../src/cli.js';

function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

/** A run's output and artifacts without what differs between two runs of one repo: when it ran and how long it took. */
function timeless(text: string): string {
  return text.replaceAll(/\d+ms/g, '<ms>').replaceAll(/"(timestamp|[a-z_]*_ms|started_at|finished_at)":\s*("[^"]*"|\d+)/g, '"$1": <masked>');
}

describe('prose exemplars in a hostile repo', () => {
  /** In the outside file's text and in its name, so neither a read nor a listing of it goes unseen. */
  const SECRET = 'hunter2-never-printed';
  let parent: string;
  let dir: string;

  /** A run of the `prose` slot, with everything it printed and everything it wrote under `.check/`. */
  async function run(flags: string[] = []): Promise<{ code: number; everything: string }> {
    const stdout = capture();
    const stderr = capture();
    const code = await runCli([...flags, '--only', 'prose'], { cwd: dir, stdout, stderr, env: {} });
    const files = await readdir(join(dir, '.check')).catch(() => []);
    const written = await Promise.all(files.map((file) => readFile(join(dir, '.check', file), 'utf8').catch(() => '')));
    return { code, everything: [stdout.text(), stderr.text(), ...files, ...written].join('\n') };
  }

  const exemplars = (path: string): Promise<void> =>
    writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ checks: { links: false, prose: { use: 'vale', exemplars: path } } }));

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'checkride-exemplars-hostile-'));
    dir = join(parent, 'repo');
    await mkdir(join(dir, 'docs'), { recursive: true });
    await mkdir(join(parent, 'private'));
    await writeFile(join(parent, 'private', `${SECRET}.md`), `${SECRET}\n`);
  });
  afterEach(async () => { await rm(parent, { recursive: true, force: true }); });

  test('an exemplars path that climbs out of the repo never loads: exit 2, before any check runs', async () => {
    await exemplars('../private');
    const { code, everything } = await run();
    expect(code).toBe(2);
    expect(everything).toContain("'prose' exemplars \"../private\" leaves the repository: it is read from the repo root, so name a directory inside the repo");
    expect(everything).not.toContain(SECRET);
  });

  test.each(['/etc', 'C:\\Users\\voice', 'C:/Users/voice', '\\\\server\\share\\voice'])('an absolute exemplars path never loads: %s', async (path) => {
    await exemplars(path);
    const { code, everything } = await run();
    expect(code).toBe(2);
    expect(everything).toContain('is absolute: give it relative to the repo root');
  });

  test('an exemplars directory that is a symlink out of the repo fails the check, unlisted', async () => {
    await symlink(join(parent, 'private'), join(dir, 'docs', 'voice'));
    await exemplars('docs/voice');
    const { code, everything } = await run();
    expect(code).toBe(1);
    expect(everything).toContain('the `prose` slot names `docs/voice` as its voice exemplars, and that path resolves outside the repository');
    expect(everything).not.toContain(SECRET);
  });

  test.each([
    ['a directory that exists', 'private'],
    ['a directory that does not', 'no-such-directory'],
  ])('a link out to %s: the same exit code, output and artifacts', async (_name, target) => {
    await symlink(join(parent, 'private'), join(dir, 'docs', 'voice'));
    await exemplars('docs/voice');
    const exists = await run();
    await rm(join(dir, 'docs', 'voice'));
    await rm(join(dir, '.check'), { recursive: true, force: true });
    await symlink(join(parent, target), join(dir, 'docs', 'voice'));
    const other = await run();
    expect(other.code).toBe(1);
    expect(timeless(other.everything)).toBe(timeless(exists.everything));
  });

  test('an exemplar file that is a symlink out of the repo is passed over, unread and unnamed', async () => {
    await mkdir(join(dir, 'docs', 'voice'));
    await symlink(join(parent, 'private', `${SECRET}.md`), join(dir, 'docs', 'voice', 'linked.md'));
    await exemplars('docs/voice');
    const { code, everything } = await run();
    expect(code).toBe(1);
    expect(everything).toContain('the `prose` slot names `docs/voice` as its voice exemplars, and that path has no files in it');
    expect(everything).not.toContain('linked.md');
    expect(everything).not.toContain(SECRET);
  });

  test('under --static-only neither link gets the outside directory listed or its file read', async () => {
    await symlink(join(parent, 'private'), join(dir, 'docs', 'voice'));
    await exemplars('docs/voice');
    const { code, everything } = await run(['--static-only']);
    expect(code).toBe(1);
    expect(everything).toContain('and that path resolves outside the repository');
    expect(everything).not.toContain(SECRET);
  });
});

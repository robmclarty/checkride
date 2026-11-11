/**
 * The `schema` slot's containment, with the disk watched: a schema, a `$ref`
 * and a data file that leave the repository each get one answer whether or
 * not anything is where they lead, and nothing outside the repository is
 * asked about on the way to it. `node:fs` is a recording stand-in
 * (`test/helpers/fs-spy.ts`).
 */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';

import { forget, touched } from '../../../test/helpers/fs-spy.js';
import { CHECKOUT } from '../../../test/helpers/schema-libraries.js';
import type { GitRunner } from '../../git.js';
import type { SchemaChecked } from '../check.js';
import { checkSchemas } from '../check.js';
import { loadLibraries } from '../libraries.js';
import type { SchemaLibraries } from '../library-types.js';
import type { SchemaRule } from '../rules.js';

vi.mock('node:fs', async (original) => {
  const { spied } = await import('../../../test/helpers/fs-spy.js');
  return spied(await original<typeof import('node:fs')>());
});
vi.mock('node:fs/promises', async (original) => {
  const { spied } = await import('../../../test/helpers/fs-spy.js');
  return spied(await original<typeof import('node:fs/promises')>());
});

let libraries: SchemaLibraries;
let parent: string;
let dir: string;
let real: string;
let outside: string;

beforeAll(() => {
  const loaded = loadLibraries(['ajv'], { repo: CHECKOUT, pm: 'pnpm' });
  if (!('libraries' in loaded)) throw new Error(loaded.refusal);
  libraries = loaded.libraries;
});
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'checkride-schema-touch-'));
  dir = join(parent, 'repo');
  outside = join(parent, 'outside');
  await mkdir(join(dir, 'data'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'there.json'), JSON.stringify({ required: ['hunter2'] }));
  await writeFile(join(dir, 'ok.schema.json'), '{}');
  await writeFile(join(dir, 'data', 'a.json'), '{}');
  real = await realpath(dir);
});
afterEach(async () => { await rm(parent, { recursive: true, force: true }); });

/** A git that lists exactly `files`, so the run asks the disk about nothing its rules don't name. */
const listing = (files: readonly string[]): GitRunner => () => Promise.resolve({ ok: true, stdout: files.join('\0') });

/** What a run of `rules` came to, and every path it asked the disk about that the repository doesn't hold. */
async function checked(rules: readonly SchemaRule[], files: readonly string[] = ['data/a.json']): Promise<{ said: SchemaChecked; outsideRepo: string[] }> {
  forget();
  const said = await checkSchemas(dir, { rules, configFile: 'checkride.config.json', libraries, git: listing(files) });
  const asked = touched().map((t) => t.path);
  return { said, outsideRepo: asked.filter((path) => !path.startsWith(real) && !path.startsWith(dir)) };
}

/** The same run with `link` pointing at something outside that is there, then at something that isn't. */
async function eitherWay(link: string, run: () => ReturnType<typeof checked>): Promise<{ there: Awaited<ReturnType<typeof checked>>; gone: Awaited<ReturnType<typeof checked>> }> {
  await symlink(join(outside, 'there.json'), join(dir, link));
  const there = await run();
  await rm(join(dir, link));
  await symlink(join(outside, 'no-such-file.json'), join(dir, link));
  return { there, gone: await run() };
}

test('a schema that is a link out is refused the same whether or not its target exists, untouched', async () => {
  const { there, gone } = await eitherWay('linked.schema.json', () => checked([{ files: ['data/*.json'], schema: 'linked.schema.json' }]));
  expect(there.said).toEqual({ refusal: 'checkride: schemas[0] names the schema `linked.schema.json`, which resolves outside the repository: a schema is read only from inside it.\n' });
  expect(gone.said).toEqual(there.said);
  expect([there.outsideRepo, gone.outsideRepo]).toEqual([[], []]);
});

test('a $ref through a link out is refused the same whether or not its target exists, untouched', async () => {
  await writeFile(join(dir, 'main.schema.json'), JSON.stringify({ properties: { a: { $ref: 'linked.json' } } }));
  const { there, gone } = await eitherWay('linked.json', () => checked([{ files: ['data/*.json'], schema: 'main.schema.json' }]));
  expect(there.said).toEqual({ refusal: 'checkride: the schema `main.schema.json` refers to `linked.json`, which resolves outside the repository: a schema is read only from inside it.\n' });
  expect(gone.said).toEqual(there.said);
  expect([there.outsideRepo, gone.outsideRepo]).toEqual([[], []]);
});

test.each(['../outside/there.json', '../outside/no-such-file.json'])('a $ref that climbs out is refused without the disk being asked: %s', async (ref) => {
  await writeFile(join(dir, 'main.schema.json'), JSON.stringify({ properties: { a: { $ref: ref } } }));
  const { said, outsideRepo } = await checked([{ files: ['data/*.json'], schema: 'main.schema.json' }]);
  expect(said).toEqual({ refusal: `checkride: the schema \`main.schema.json\` refers to \`${ref}\`, which resolves outside the repository: a schema is read only from inside it.\n` });
  expect(outsideRepo).toEqual([]);
});

test('a data file that is a link out is the same finding whether or not its target exists, untouched', async () => {
  const { there, gone } = await eitherWay('data/leak.json', () => checked([{ files: ['data/*.json'], schema: 'ok.schema.json' }], ['data/a.json', 'data/leak.json']));
  if (!('outcome' in there.said)) throw new Error(there.said.refusal);
  expect(JSON.parse(there.said.outcome.stdout)).toEqual({
    rules: [{ schema: 'ok.schema.json', files: 2 }],
    errors: [{ file: 'data/leak.json', rule: 0, instancePath: '', keyword: 'symlink', message: "resolves outside the repository, so it isn't read" }],
  });
  expect(gone.said).toEqual(there.said);
  expect([there.outsideRepo, gone.outsideRepo]).toEqual([[], []]);
});

test('a schema path that names the repository root is a path inside it that holds no schema, not one outside', async () => {
  await symlink(dir, join(dir, 'self'));
  for (const schema of ['.', 'self']) {
    const { said } = await checked([{ files: ['data/*.json'], schema }]);
    expect(said).toEqual({ refusal: `checkride: schemas[0] names the schema \`${schema}\`, which can't be read: no such file from the repo root.\n` });
  }
});

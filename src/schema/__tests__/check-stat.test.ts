/**
 * The check asks the disk about a path only once a rule's globs match it. A
 * repo lists far more files than its rules name, and each answer is a `stat`
 * on the orchestrator's event loop, so the rest must cost none.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { CHECKOUT } from '../../../test/helpers/schema-libraries.js';
import type { GitRunner } from '../../git.js';
import { checkSchemas } from '../check.js';
import { loadLibraries } from '../libraries.js';

const statted = vi.hoisted((): string[] => []);

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  const statSync = (path: string): unknown => {
    statted.push(path);
    return fs.statSync(path);
  };
  return { ...fs, statSync };
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'checkride-schema-stat-'));
  statted.length = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('only the paths a rule matches are statted, each once, however many rules match it', async () => {
  const loaded = loadLibraries(['ajv'], { repo: CHECKOUT, pm: 'pnpm' });
  if (!('libraries' in loaded)) throw new Error(loaded.refusal);
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 's.json'), '{}');
  await writeFile(join(dir, 'data', 'a.json'), '{}');
  const others = Array.from({ length: 500 }, (_, at) => `src/file-${at}.ts`);
  const git: GitRunner = () => Promise.resolve({ ok: true, stdout: ['s.json', 'data/a.json', 'data/gone.json', ...others].join('\0') });
  const rules = [{ files: ['data/*.json'], schema: 's.json' }, { files: ['data/a.json'], schema: 's.json' }];
  const checked = await checkSchemas(dir, { rules, configFile: 'checkride.config.json', libraries: loaded.libraries, git });
  if (!('outcome' in checked)) throw new Error(checked.refusal);
  expect(JSON.parse(checked.outcome.stdout)).toEqual({ rules: [{ schema: 's.json', files: 1 }, { schema: 's.json', files: 1 }], errors: [] });
  expect(statted.map((path) => path.slice(dir.length + 1)).toSorted()).toEqual(['data/a.json', 'data/gone.json']);
});

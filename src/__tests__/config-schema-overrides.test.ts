/**
 * The config schema and the loader agree on where a file may override part
 * of a check a preset declares. One set of fixtures is read by both: the
 * loader, which either carries the override onto the check that runs or
 * doesn't, and the published schema, which either accepts the file or
 * doesn't. A fixture the two disagree on fails, so neither can drift from
 * the other.
 *
 * The schema reads one file, so one thing is past it: whether the preset
 * really declares the check an entry overrides. In each fixture with a preset
 * it does. An override of a check no preset declares passes the schema and
 * resolves to no check at all.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Ajv from 'ajv';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { CHECKOUT } from '../../test/helpers/schema-libraries.js';
import { ADAPTERS, SLOTS } from '../adapters.js';
import { loadConfig, resolveChecks } from '../config.js';

/** The description an override sets, which the check that runs carries when the loader merged it. */
const OVERRIDDEN = 'overridden here';

const TARGET = { lang: 'go', root: '.' };

/**
 * A fixture: the preset a file extends, `null` for a file with no `extends`;
 * the file's own keys; and whether the override takes effect, which is also
 * whether the schema accepts the file.
 */
type Fixture = { name: string; preset: object | null; local: object; merges: boolean };

const FIXTURES: readonly Fixture[] = [
  {
    name: 'a top-level custom check the preset declares',
    preset: { checks: { licenses: { command: 'echo' } } },
    local: { checks: { licenses: { description: OVERRIDDEN } } },
    merges: true,
  },
  {
    name: 'a top-level slot the preset picks a tool for',
    preset: { checks: { links: { use: 'links' } } },
    local: { checks: { links: { description: OVERRIDDEN } } },
    merges: true,
  },
  {
    name: "a pack block's custom check the preset declares, in a repo with targets",
    preset: { packs: { go: { checks: { licenses: { command: 'echo' } } } } },
    local: { targets: { api: TARGET }, packs: { go: { checks: { licenses: { description: OVERRIDDEN } } } } },
    merges: true,
  },
  {
    name: "a pack block's custom check the preset declares, in a repo without targets",
    preset: { packs: { go: { checks: { licenses: { command: 'echo' } } } } },
    local: { packs: { go: { checks: { licenses: { description: OVERRIDDEN } } } } },
    merges: true,
  },
  {
    name: "a pack block's slot the preset picks a tool for",
    preset: { packs: { go: { checks: { lint: { use: 'staticcheck' } } } } },
    local: { targets: { api: TARGET }, packs: { go: { checks: { lint: { description: OVERRIDDEN } } } } },
    merges: true,
  },
  {
    name: "a target's custom check: a preset declares no targets, so nothing merges",
    preset: { packs: { go: { checks: { licenses: { command: 'echo' } } } } },
    local: { targets: { api: { ...TARGET, checks: { licenses: { description: OVERRIDDEN } } } } },
    merges: false,
  },
  {
    name: "a target's slot: only its tuning layers over the pack's entry",
    preset: { packs: { go: { checks: { lint: { use: 'staticcheck' } } } } },
    local: { targets: { api: { ...TARGET, checks: { lint: { description: OVERRIDDEN } } } } },
    merges: false,
  },
  {
    name: 'a top-level entry in a file with no extends: nothing to inherit',
    preset: null,
    local: { checks: { licenses: { description: OVERRIDDEN } } },
    merges: false,
  },
  {
    name: "a pack block's entry in a file with no extends",
    preset: null,
    local: { targets: { api: TARGET }, packs: { go: { checks: { licenses: { description: OVERRIDDEN } } } } },
    merges: false,
  },
];

/** The fixture's file, as it sits on disk: its own keys, under `extends` when it has a preset. */
const fileOf = ({ preset, local }: Fixture): object => (preset === null ? local : { extends: './preset.json', ...local });

// ajv's types declare a default export NodeNext reads as the module namespace, so the constructor is cast to the part used here.
type AjvCtor = new (options: { strict: boolean; allErrors: boolean }) => { compile: (schema: unknown) => (file: unknown) => boolean };

const schema: unknown = JSON.parse(readFileSync(join(CHECKOUT, 'schema', 'checkride.config.schema.json'), 'utf8'));
const validate = new (Ajv as unknown as AjvCtor)({ strict: false, allErrors: true }).compile(schema);

/** The top-level keys the fixtures that merge, or that don't, put an override under. */
function blocks(merges: boolean): string[] {
  return FIXTURES.filter((f) => f.merges === merges)
    .flatMap((f) => Object.keys(f.local))
    .filter((key) => key !== 'targets' || !merges);
}

describe('where a file may override part of a check a preset declares', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-overrides-'));
    await writeFile(join(dir, 'go.mod'), 'module example.com/app\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Whether the loader carries the fixture's override onto a check that runs. */
  async function loaderMerges(fixture: Fixture): Promise<boolean> {
    if (fixture.preset !== null) await writeFile(join(dir, 'preset.json'), JSON.stringify(fixture.preset));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify(fileOf(fixture)));
    const resolved = resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config: loadConfig(dir), cwd: dir });
    return resolved.some((check) => check.adapter?.description === OVERRIDDEN);
  }

  test.each(FIXTURES)('$name', async (fixture) => {
    const merges = await loaderMerges(fixture);
    expect(merges, 'the loader').toBe(fixture.merges);
    expect(validate(fileOf(fixture)), 'the schema').toBe(merges);
  });

  test('the fixtures cover an override that merges and one that does not, in each block', () => {
    expect(new Set(blocks(true))).toEqual(new Set(['checks', 'packs']));
    expect(new Set(blocks(false))).toEqual(new Set(['checks', 'packs', 'targets']));
  });
});

/**
 * The `schema` slot through the CLI: when it joins a run, how it is selected
 * and tuned, what a named suite does with it, what a missing library costs,
 * and how its findings reach the baseline, the terminal and the annotations.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { installLibraries } from '../../../test/helpers/schema-libraries.js';
import { ADAPTERS, SLOTS } from '../../adapters.js';
import { runCli } from '../../cli.js';
import type { CheckrideConfig } from '../../config.js';
import { resolveChecks } from '../../config.js';
import { selectChecks } from '../../orchestrator/index.js';
import { suiteNamed } from '../../suite.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'checkride-schema-slot-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

async function write(rel: string, body: string | object): Promise<void> {
  const full = join(dir, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, typeof body === 'string' ? body : JSON.stringify(body));
}

async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(argv, { cwd: dir, stdout, stderr, env: {} });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

type Entry = { name: string; ok: boolean; adapter: string | null; skipped?: boolean; reason?: string; origin?: string; output_file: string | null; exit_code: number };

/** The checks a run recorded, from the summary under `out`. */
async function checks(out = '.check'): Promise<Entry[]> {
  const summary = JSON.parse(await readFile(join(dir, out, 'summary.json'), 'utf8')) as { checks: Entry[] };
  return summary.checks;
}

/** A check that always passes, so a run has something to run beside the slot. */
const PROBE = { command: process.execPath, args: ['-e', ''] };

const PERSON = { type: 'object', required: ['name'], properties: { name: { type: 'string', pattern: '^[A-Z]' } } };

/** A repo with one rule over `people/*.json`, and the files in `people`. */
async function repo(people: Record<string, object>, config: CheckrideConfig = {}): Promise<void> {
  await write('schemas/person.json', PERSON);
  for (const [name, body] of Object.entries(people)) await write(`people/${name}.json`, body);
  await write('checkride.config.json', { checks: { probe: PROBE, links: false }, schemas: [{ files: ['people/*.json'], schema: 'schemas/person.json' }], ...config });
}

describe('without schemas the slot is not in a run', () => {
  test.each([
    ['no schemas key', {}],
    ['an empty schemas', { schemas: [] }],
  ])('%s: the summary has no schema entry, and no schema.json is written', async (_name, extra) => {
    await write('checkride.config.json', { checks: { probe: PROBE, links: false }, ...extra });
    const run = await cli();
    expect(run.code).toBe(0);
    expect((await checks()).map((c) => c.name)).not.toContain('schema');
    expect(run.stderr).not.toMatch(/^ +\S schema\b/m);
    expect(existsSync(join(dir, '.check', 'schema.json'))).toBe(false);
  });

  test('it resolves inactive, which no default run and no --all selects', () => {
    const resolved = resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config: {}, fileExists: () => false, manifest: { scripts: new Set(), deps: new Set() } });
    const schema = resolved.find((c) => c.slot === 'schema');
    expect(schema).toMatchObject({ adapter: null, inactive: true, skip: 'runs only when checkride.config.json declares schemas' });
    expect(selectChecks(resolved, {}).map((c) => c.slot)).not.toContain('schema');
    expect(selectChecks(resolved, { all: true }).map((c) => c.slot)).not.toContain('schema');
  });

  test('naming it records it as skipped, with the reason', async () => {
    await write('checkride.config.json', { checks: { probe: PROBE, links: false } });
    await cli('--only', 'schema');
    expect((await checks()).find((c) => c.name === 'schema')).toMatchObject({ skipped: true, reason: 'runs only when checkride.config.json declares schemas' });
  });
});

describe('a custom check named schema, which a repo could have before the slot existed', () => {
  const CUSTOM = { command: process.execPath, args: ['-e', 'console.log("mine")'], detect: ['marker.txt'], description: 'Our own schema lint' };

  test('with no schemas key it is the custom check it always was: gated by detect, after the catalogue, recorded as custom', async () => {
    await write('checkride.config.json', { checks: { schema: CUSTOM, probe: PROBE, links: false } });
    expect((await cli()).code).toBe(0);
    const before = await checks();
    expect(before.find((c) => c.name === 'schema')).toMatchObject({ skipped: true, reason: 'no detect file present' });
    // In config key order among the customs, after every catalogue slot, as any custom check sits.
    expect(before.map((c) => c.name).slice(-2)).toEqual(['schema', 'probe']);

    await write('marker.txt', '');
    const run = await cli();
    expect(run.code).toBe(0);
    expect((await checks()).find((c) => c.name === 'schema')).toMatchObject({ ok: true, adapter: 'custom:schema', origin: 'custom', output_file: null, exit_code: 0 });
    expect(run.stderr).toMatch(/✔ schema +\d+ms {2}Our own schema lint {2}\[custom\]/);
    expect(await readFile(join(dir, '.check', 'schema.stdout.txt'), 'utf8')).toBe('mine\n');
    expect(existsSync(join(dir, '.check', 'schema.json'))).toBe(false);
  });

  test('it resolves as a custom check and the slot stands aside, with an empty schemas too, and from a defaults layer', () => {
    const at = { slots: SLOTS, adapters: ADAPTERS, fileExists: () => true, manifest: { scripts: new Set<string>(), deps: new Set<string>() } };
    for (const input of [{ config: { checks: { schema: CUSTOM } } }, { config: { schemas: [], checks: { schema: CUSTOM } } }, { config: {}, defaults: { checks: { schema: CUSTOM } } }]) {
      const found = resolveChecks({ ...at, ...input }).filter((c) => c.slot === 'schema');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ adapter: { name: 'custom:schema', command: process.execPath } });
      expect(found[0]?.inactive).toBeUndefined();
      expect(found[0]?.adapter?.builtin).toBeUndefined();
    }
  });

  test('beside schemas rules it is a config error that names the clash and says to rename it', async () => {
    await write('checkride.config.json', { checks: { schema: CUSTOM }, schemas: [{ files: ['a.json'], schema: 's.json' }] });
    const run = await cli();
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      'invalid checkride.config.json: checks.schema is a custom check, and schemas switches on the built-in schema check, which takes that name: rename the custom check (checks.schema-lint, say), so that neither stands in for the other',
    );
    expect(existsSync(join(dir, '.check', 'summary.json'))).toBe(false);
  });

  test('the clash is caught across layers: a repo\'s custom check under a defaults file\'s rules, and a suite\'s', () => {
    const at = { slots: SLOTS, adapters: ADAPTERS, fileExists: () => true, manifest: { scripts: new Set<string>(), deps: new Set<string>() } };
    const rules = [{ files: ['a.json'], schema: 's.json' }];
    expect(() => resolveChecks({ ...at, config: { checks: { schema: CUSTOM } }, defaults: { schemas: rules } })).toThrow(/checks\.schema is a custom check, and schemas switches on the built-in schema check/);
    expect(() => resolveChecks({ ...at, config: { checks: { schema: CUSTOM }, schemas: rules }, suite: suiteNamed('evals') })).toThrow(/rename the custom check/);
  });

  test('an entry that names the built-in, or only tunes it, is no clash', () => {
    const at = { slots: SLOTS, adapters: ADAPTERS, fileExists: () => false, manifest: { scripts: new Set<string>(), deps: new Set<string>() } };
    const rules = [{ files: ['a.json'], schema: 's.json' }];
    for (const entry of ['schema', { use: 'schema', timeout: 9 }, { timeout: 9 }, false] as const) {
      expect(() => resolveChecks({ ...at, config: { schemas: rules, checks: { schema: entry } } })).not.toThrow();
    }
  });
});

describe('with schemas it is a slot like any other', () => {
  beforeEach(async () => {
    await installLibraries(dir, ['ajv']);
  });

  test('it joins the default run, as a built-in, and writes schema.json', async () => {
    await repo({ ada: { name: 'Ada' } });
    const run = await cli();
    expect(run.code).toBe(0);
    const schema = (await checks()).find((c) => c.name === 'schema');
    expect(schema).toMatchObject({ ok: true, adapter: 'schema', origin: 'built-in', output_file: 'schema.json', exit_code: 0 });
    expect(JSON.parse(await readFile(join(dir, '.check', 'schema.json'), 'utf8'))).toEqual({ rules: [{ schema: 'schemas/person.json', files: 1 }], errors: [] });
  });

  test('--only schema runs it alone, and --skip schema leaves it out', async () => {
    await repo({ ada: { name: 'Ada' } });
    await cli('--only', 'schema');
    expect((await checks()).filter((c) => c.skipped !== true).map((c) => c.name)).toEqual(['schema']);
    await cli('--skip', 'schema');
    expect((await checks()).filter((c) => c.skipped !== true).map((c) => c.name)).toEqual(['probe']);
  });

  test('a checks.schema entry tunes it: optIn takes it out of the default run, and --include brings it back', async () => {
    await repo({ ada: { name: 'ada' } }, { checks: { probe: PROBE, links: false, schema: { optIn: true, timeout: 30, order: 'last' } } });
    expect((await cli()).code).toBe(0);
    expect((await checks()).filter((c) => c.skipped !== true).map((c) => c.name)).toEqual(['probe']);
    expect((await cli('--include', 'schema')).code).toBe(1);
    expect((await checks()).filter((c) => c.skipped !== true).map((c) => c.name)).toEqual(['probe', 'schema']);
  });

  test('timeout and order reach its adapter, and false switches it off', () => {
    const at = { slots: SLOTS, adapters: ADAPTERS, fileExists: () => false, manifest: { scripts: new Set<string>(), deps: new Set<string>() } };
    const schemas = [{ files: ['a.json'], schema: 's.json' }];
    const tuned = resolveChecks({ ...at, config: { schemas, checks: { schema: { timeout: 30, order: 2 } } } }).find((c) => c.slot === 'schema');
    expect(tuned).toMatchObject({ adapter: { name: 'schema', builtin: 'schema', timeout: 30 }, order: 2 });
    expect(tuned?.adapter?.options?.schema).toEqual({ rules: schemas, configFile: 'checkride.config.json' });
    const off = resolveChecks({ ...at, config: { schemas, checks: { schema: false } } }).find((c) => c.slot === 'schema');
    expect(off).toMatchObject({ adapter: null, skip: 'disabled in checkride.config.json' });
  });

  test('the defaults layer supplies rules where the repo sets no schemas key, and never over the repo\'s own', () => {
    const at = { slots: SLOTS, adapters: ADAPTERS, fileExists: () => false, manifest: { scripts: new Set<string>(), deps: new Set<string>() } };
    const defaults = { schemas: [{ files: ['d.json'], schema: 'd.schema.json' }] };
    const rulesOf = (config: CheckrideConfig): unknown => resolveChecks({ ...at, config, defaults }).find((c) => c.slot === 'schema')?.adapter?.options?.schema?.rules;
    expect(rulesOf({})).toEqual(defaults.schemas);
    expect(rulesOf({ schemas: [{ files: ['r.json'], schema: 'r.schema.json' }] })).toEqual([{ files: ['r.json'], schema: 'r.schema.json' }]);
    expect(rulesOf({ schemas: [] })).toBeUndefined();
  });

  test('--changed runs every rule', async () => {
    await repo({ ada: { name: 'ada' } });
    expect((await cli('--changed', '--only', 'schema')).code).toBe(1);
    expect(JSON.parse(await readFile(join(dir, '.check', 'schema.json'), 'utf8'))).toMatchObject({ rules: [{ files: 1 }], errors: [{ file: 'people/ada.json' }] });
  });
});

describe('in a named suite', () => {
  beforeEach(async () => {
    await installLibraries(dir, ['ajv']);
    await write('schemas/label.json', { type: 'object', required: ['label'] });
    await write('labels/a.json', { label: 'cat' });
    await write('checkride.config.json', { checks: { links: false, probe: PROBE } });
  });

  test("the suite's schemas declare the check: it runs with no checks.schema entry, into the suite's directory", async () => {
    await write('checkride.evals.config.json', { schemas: [{ files: ['labels/*.json'], schema: 'schemas/label.json' }] });
    const run = await cli('--suite', 'evals');
    expect(run.code).toBe(0);
    expect((await checks('.check/suites/evals')).map((c) => c.name)).toEqual(['schema']);
    expect(JSON.parse(await readFile(join(dir, '.check/suites/evals/schema.json'), 'utf8'))).toEqual({ rules: [{ schema: 'schemas/label.json', files: 1 }], errors: [] });
    // The default suite, whose config holds no rule, still has no schema check.
    await cli();
    expect((await checks()).filter((c) => c.skipped !== true).map((c) => c.name)).toEqual(['probe']);
  });

  test("a rule that matches nothing names the suite's own config file", async () => {
    await write('checkride.evals.config.json', { schemas: [{ files: ['gone/*.json'], schema: 'schemas/label.json' }] });
    const run = await cli('--suite', 'evals');
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('checkride.evals.config.json  /schemas/0/files matches no files (gone/*.json)  [files]');
  });

  test('a suite with no schemas has no schema check, as it has no other built-in', async () => {
    await write('checkride.evals.config.json', { checks: { probe: PROBE } });
    await cli('--suite', 'evals', '--all');
    expect((await checks('.check/suites/evals')).map((c) => c.name)).toEqual(['probe']);
    const resolved = resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config: { checks: { probe: PROBE } }, suite: suiteNamed('evals'), cwd: dir });
    expect(resolved.map((c) => c.slot)).toEqual(['probe']);
  });

  test('an entry that tunes it without naming a tool is the config error any slot gets there', async () => {
    await write('checkride.evals.config.json', { schemas: [{ files: ['labels/*.json'], schema: 'schemas/label.json' }], checks: { schema: { timeout: 5 } } });
    const run = await cli('--suite', 'evals');
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('checks.schema names no tool');
  });

  test('use: schema beside the rules tunes it', async () => {
    await write('checkride.evals.config.json', { schemas: [{ files: ['labels/*.json'], schema: 'schemas/label.json' }], checks: { schema: { use: 'schema', timeout: 5 } } });
    expect((await cli('--suite', 'evals')).code).toBe(0);
    expect((await checks('.check/suites/evals')).map((c) => `${c.name}:${c.origin}`)).toEqual(['schema:config']);
  });
});

describe('a library the repo has not installed', () => {
  test('refuses the check, exit 1, with the package and the install command as its reason', async () => {
    await repo({ ada: { name: 'Ada' } });
    const run = await cli('--only', 'schema');
    expect(run.code).toBe(1);
    const [schema] = await checks();
    expect(schema).toMatchObject({ ok: false, exit_code: 1, reason: 'the `schema` slot needs `ajv`, which is not installed in this project: run `pnpm add -D ajv@^8`' });
    expect(run.stderr).toContain('the `schema` slot needs `ajv`, which is not installed in this project: run `pnpm add -D ajv@^8`');
    expect(existsSync(join(dir, '.check', 'schema.json'))).toBe(false);
  });

  test("the install command is the repo's package manager's", async () => {
    await repo({ ada: { name: 'Ada' } });
    await write('package-lock.json', {});
    await cli('--only', 'schema');
    expect((await checks())[0]?.reason).toContain('run `npm install -D ajv@^8`');
  });

  test('a json-only config needs ajv alone, and a frontmatter rule needs yaml beside it', async () => {
    await installLibraries(dir, ['ajv']);
    await repo({ ada: { name: 'Ada' } });
    expect((await cli('--only', 'schema')).code).toBe(0);
    await write('skills/pdf/SKILL.md', '---\nname: pdf\ndescription: Reads PDFs.\n---\n');
    await repo({ ada: { name: 'Ada' } }, { schemas: [{ files: ['people/*.json'], schema: 'schemas/person.json' }, { files: ['skills/*/SKILL.md'], schema: 'checkride:agent-skill' }] });
    expect((await cli('--only', 'schema')).code).toBe(1);
    expect((await checks())[0]?.reason).toBe('the `schema` slot needs `yaml`, which is not installed in this project: run `pnpm add -D yaml@^2`');
    await installLibraries(dir, ['yaml']);
    expect((await cli('--only', 'schema')).code).toBe(0);
  });

  test('under --static-only it is a skip, as any check whose tool needs the install is', async () => {
    await repo({ ada: { name: 'Ada' } });
    const run = await cli('--static-only', '--only', 'schema');
    expect(run.code).toBe(0);
    expect((await checks())[0]).toMatchObject({ skipped: true, reason: expect.stringContaining('static-only: needs an install (the `schema` slot needs `ajv`') as string });
  });

  test('a schema it cannot use fails it with the reason, under --static-only too', async () => {
    await installLibraries(dir, ['ajv']);
    await repo({ ada: { name: 'Ada' } }, { schemas: [{ files: ['people/*.json'], schema: 'schemas/gone.json' }] });
    for (const flags of [[], ['--static-only']]) {
      expect((await cli(...flags, '--only', 'schema')).code).toBe(1);
      expect((await checks())[0]).toMatchObject({ ok: false, reason: "schemas[0] names the schema `schemas/gone.json`, which can't be read: no such file from the repo root" });
    }
  });
});

/** The lines printed beneath the slot's red status line. */
function beneath(stderr: string): string[] {
  const all = stderr.split('\n');
  const rest = all.slice(all.findIndex((line) => line.startsWith('  ✘ schema ')) + 1);
  const end = rest.findIndex((line) => !line.startsWith('           '));
  return rest.slice(0, end === -1 ? rest.length : end).map((line) => line.slice(11));
}

describe('its findings', () => {
  beforeEach(async () => {
    await installLibraries(dir, ['ajv']);
  });

  test('a baselined missing property cannot be swapped for another at the same pointer', async () => {
    await write('schemas/person.json', { type: 'object', required: ['name', 'role'] });
    await write('people/ada.json', { role: 'engineer' });
    await write('checkride.config.json', { checks: { links: false }, schemas: [{ files: ['people/*.json'], schema: 'schemas/person.json' }] });
    expect((await cli('--only', 'schema')).code).toBe(1);
    expect((await cli('baseline', '--only', 'schema')).code).toBe(0);
    const baseline = JSON.parse(await readFile(join(dir, 'checkride.baseline.json'), 'utf8')) as { slots: Record<string, unknown> };
    expect(baseline.slots['schema']).toEqual(['people/ada.json:required::name']);
    expect((await cli('--only', 'schema')).code).toBe(0);

    // One missing property in, another out: the same keyword at the same pointer, the same count.
    await write('people/ada.json', { name: 'Ada' });
    const swapped = await cli('--only', 'schema');
    expect(swapped.code).toBe(1);
    expect(swapped.stderr).toContain("people/ada.json: must have required property 'role' [required]");
    expect(JSON.parse(await readFile(join(dir, '.check', 'schema.json'), 'utf8'))).toMatchObject({ errors: [{ keyword: 'required', instancePath: '', param: 'role' }] });
  });

  test('the excerpt lists them as path:line, message and keyword, then the report', async () => {
    await installLibraries(dir, ['yaml']);
    await write('skills/pdf/SKILL.md', '---\nname: PDF\ndescription: Reads PDFs.\n---\n');
    await repo({ ada: { name: 'ada' } }, { schemas: [{ files: ['people/*.json'], schema: 'schemas/person.json' }, { files: ['skills/*/SKILL.md'], schema: 'checkride:agent-skill' }] });
    const run = await cli('--only', 'schema');
    expect(beneath(run.stderr)).toEqual([
      'people/ada.json  /name must match pattern "^[A-Z]"  [pattern]',
      'skills/pdf/SKILL.md:2  /name must match pattern "^[a-z0-9]+(-[a-z0-9]+)*$"  [pattern]',
      "skills/pdf/SKILL.md:2  /name must equal the parent directory's name, 'pdf'  [directory-name]",
      'full output: .check/schema.json',
    ]);
  });

  test('--annotate github annotates each, with its file, its line when known, and its keyword in the title', async () => {
    await installLibraries(dir, ['yaml']);
    await write('skills/pdf/SKILL.md', '---\nname: PDF\ndescription: Reads PDFs.\n---\n');
    await repo({ ada: { name: 'ada' } }, { schemas: [{ files: ['people/*.json'], schema: 'schemas/person.json' }, { files: ['skills/*/SKILL.md'], schema: 'checkride:agent-skill' }] });
    const run = await cli('--only', 'schema', '--annotate', 'github');
    expect(run.stderr.split('\n').filter((line) => line.startsWith('::'))).toEqual([
      '::error file=people/ada.json,title=schema%3A pattern::/name must match pattern "^[A-Z]"',
      '::error file=skills/pdf/SKILL.md,line=2,title=schema%3A pattern::/name must match pattern "^[a-z0-9]+(-[a-z0-9]+)*$"',
      "::error file=skills/pdf/SKILL.md,line=2,title=schema%3A directory-name::/name must equal the parent directory's name, 'pdf'",
    ]);
  });

  test('a baseline masks a grandfathered finding, through a reworded message, and a new one is still red', async () => {
    await repo({ ada: { name: 'ada' } });
    expect((await cli('--only', 'schema')).code).toBe(1);
    expect((await cli('baseline', '--only', 'schema')).code).toBe(0);
    const baseline = JSON.parse(await readFile(join(dir, 'checkride.baseline.json'), 'utf8')) as { slots: Record<string, unknown> };
    expect(baseline.slots['schema']).toEqual(['people/ada.json:pattern:/name']);
    expect((await cli('--only', 'schema')).code).toBe(0);

    // The schema's pattern is rewritten, so the message that quotes it changes, and the finding is the one it was.
    await write('schemas/person.json', { ...PERSON, properties: { name: { type: 'string', pattern: '^[A-Z][a-z]+$' } } });
    const reworded = await cli('--only', 'schema');
    expect(reworded.code).toBe(0);
    expect(JSON.parse(await readFile(join(dir, '.check', 'schema.json'), 'utf8'))).toMatchObject({ errors: [{ message: 'must match pattern "^[A-Z][a-z]+$"' }] });

    await write('people/bo.json', { name: 'bo' });
    const fresh = await cli('--only', 'schema');
    expect(fresh.code).toBe(1);
    expect(fresh.stderr).toContain('people/bo.json: /name must match pattern "^[A-Z][a-z]+$" [pattern]');
    expect(fresh.stderr).not.toContain('people/ada.json: ');
  });
});

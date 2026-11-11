/**
 * The `schema` slot's surface, as docs/contract.md states it: the slot is
 * absent from a run until the config holds a `schemas` rule, `schema.json`
 * has the shape consumers read, the exit codes are 0 and 1, a library the
 * repo lacks is a reason and never a crash, a named suite's rules declare
 * the check, and the package depends on nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../../src/cli.js';
import { CHECKOUT, installLibraries } from '../helpers/schema-libraries.js';

function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

type Entry = { name: string; ok: boolean; adapter: string | null; exit_code: number | null; output_file: string | null; skipped?: boolean; reason?: string; origin?: string };

const PROBE = { command: process.execPath, args: ['-e', ''] };
const SCHEMA = { type: 'object', required: ['label'], properties: { label: { type: 'string' } } };

describe('the schema slot', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-schema-contract-'));
    await mkdir(join(dir, 'labels'));
    await writeFile(join(dir, 'label.schema.json'), JSON.stringify(SCHEMA));
    await writeFile(join(dir, 'labels', 'a.json'), JSON.stringify({ label: 'cat' }));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const config = (extra: object, file = 'checkride.config.json'): Promise<void> =>
    writeFile(join(dir, file), JSON.stringify({ checks: { probe: PROBE, links: false }, ...extra }));
  const run = async (...argv: string[]): Promise<{ code: number; stderr: string }> => {
    const stderr = capture();
    return { code: await runCli(argv, { cwd: dir, stdout: capture(), stderr, env: {} }), stderr: stderr.text() };
  };
  const entries = async (...out: string[]): Promise<Entry[]> =>
    (JSON.parse(await readFile(join(dir, ...(out.length > 0 ? out : ['.check']), 'summary.json'), 'utf8')) as { checks: Entry[] }).checks;
  const RULE = { files: ['labels/*.json'], schema: 'label.schema.json' };

  test('without a schemas rule it is in no run: no entry, no schema.json, under no flag short of naming it', async () => {
    for (const extra of [{}, { schemas: [] }]) {
      await config(extra);
      expect((await run()).code).toBe(0);
      expect((await entries()).map((c) => c.name)).not.toContain('schema');
      expect(existsSync(join(dir, '.check', 'schema.json'))).toBe(false);
    }
    await run('--only', 'schema');
    expect((await entries()).find((c) => c.name === 'schema')).toMatchObject({
      skipped: true,
      adapter: null,
      reason: 'runs only when checkride.config.json declares schemas',
    });
  });

  test('with a rule it joins the default run as a built-in, exits 0, and writes schema.json even when it passes', async () => {
    await installLibraries(dir, ['ajv']);
    await config({ schemas: [RULE] });
    expect((await run()).code).toBe(0);
    expect((await entries()).find((c) => c.name === 'schema')).toMatchObject({ ok: true, adapter: 'schema', exit_code: 0, output_file: 'schema.json', origin: 'built-in' });
    expect(JSON.parse(readFileSync(join(dir, '.check', 'schema.json'), 'utf8'))).toEqual({ rules: [{ schema: 'label.schema.json', files: 1 }], errors: [] });
  });

  test('an error exits 1, and carries file, rule, instancePath, keyword and message, and param where the keyword names what is at fault', async () => {
    await installLibraries(dir, ['ajv']);
    await config({ schemas: [RULE, { files: ['nothing/*.json'], schema: 'label.schema.json' }] });
    await writeFile(join(dir, 'labels', 'b.json'), JSON.stringify({ label: 3 }));
    await writeFile(join(dir, 'labels', 'c.json'), JSON.stringify({}));
    expect((await run()).code).toBe(1);
    expect((await entries()).find((c) => c.name === 'schema')).toMatchObject({ ok: false, exit_code: 1, output_file: 'schema.json' });
    expect(JSON.parse(readFileSync(join(dir, '.check', 'schema.json'), 'utf8'))).toEqual({
      rules: [{ schema: 'label.schema.json', files: 3 }, { schema: 'label.schema.json', files: 0 }],
      errors: [
        { file: 'labels/b.json', rule: 0, instancePath: '/label', keyword: 'type', message: 'must be string' },
        { file: 'labels/c.json', rule: 0, instancePath: '', keyword: 'required', message: "must have required property 'label'", param: 'label' },
        { file: 'checkride.config.json', rule: 1, instancePath: '/schemas/1/files', keyword: 'files', message: 'matches no files (nothing/*.json)' },
      ],
    });
  });

  test('a library the repo has not installed is exit 1 with the package and the install command as the reason', async () => {
    await config({ schemas: [RULE] });
    const { code, stderr } = await run();
    expect(code).toBe(1);
    const reason = 'the `schema` slot needs `ajv`, which is not installed in this project: run `pnpm add -D ajv@^8`';
    expect((await entries()).find((c) => c.name === 'schema')).toMatchObject({ ok: false, exit_code: 1, reason });
    expect(stderr).toContain(reason);
    expect(existsSync(join(dir, '.check', 'schema.json'))).toBe(false);
  });

  test('a schema it cannot use is exit 1 with a reason that names it', async () => {
    await installLibraries(dir, ['ajv']);
    await config({ schemas: [{ files: ['labels/*.json'], schema: 'gone.schema.json' }] });
    expect((await run()).code).toBe(1);
    expect((await entries()).find((c) => c.name === 'schema')?.reason).toBe("schemas[0] names the schema `gone.schema.json`, which can't be read: no such file from the repo root");
  });

  test('an unknown bundled id and an extension no format is named for are config errors, exit 2', async () => {
    await config({ schemas: [{ files: ['labels/*.json'], schema: 'checkride:nope' }] });
    const unknown = await run();
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('the bundled schemas are checkride:agent-skill and checkride:checkride-config');
    await config({ schemas: [{ files: ['labels/*.toml'], schema: 'label.schema.json' }] });
    const unplaced = await run();
    expect(unplaced.code).toBe(2);
    expect(unplaced.stderr).toContain('set schemas[0].format to json, jsonc, yaml or frontmatter');
  });

  test('a custom check named schema, in a config with no schemas rule, is the custom check it was before the slot existed', async () => {
    const custom = { command: process.execPath, args: ['-e', ''], detect: ['marker.txt'] };
    await config({ checks: { probe: PROBE, links: false, schema: custom } });
    expect((await run()).code).toBe(0);
    expect((await entries()).find((c) => c.name === 'schema')).toMatchObject({ skipped: true, reason: 'no detect file present' });
    await writeFile(join(dir, 'marker.txt'), '');
    expect((await run()).code).toBe(0);
    expect((await entries()).find((c) => c.name === 'schema')).toMatchObject({ ok: true, adapter: 'custom:schema', origin: 'custom', output_file: null });
  });

  test('a custom check named schema beside schemas rules is a config error, exit 2, that says to rename it', async () => {
    await config({ checks: { schema: { command: process.execPath, args: ['-e', ''] } }, schemas: [RULE] });
    const clash = await run();
    expect(clash.code).toBe(2);
    expect(clash.stderr).toContain('checks.schema is a custom check, and schemas switches on the built-in schema check, which takes that name: rename the custom check');
  });

  test("a Yarn Plug'n'Play repo is told the slot reads node_modules, and to use the binary or the node-modules linker", async () => {
    await config({ schemas: [RULE] });
    await writeFile(join(dir, 'yarn.lock'), '');
    await writeFile(join(dir, '.pnp.cjs'), '');
    expect((await run()).code).toBe(1);
    expect((await entries()).find((c) => c.name === 'schema')?.reason).toBe(
      "the `schema` slot reads `ajv` from node_modules, which Yarn Plug'n'Play doesn't write: run the standalone checkride binary, which bundles it, or set `nodeLinker: node-modules` in .yarnrc.yml",
    );
  });

  test("a named suite's schemas rules declare the check, and its report lands in the suite's directory", async () => {
    await installLibraries(dir, ['ajv']);
    await config({});
    await writeFile(join(dir, 'checkride.evals.config.json'), JSON.stringify({ schemas: [RULE] }));
    expect((await run('--suite', 'evals')).code).toBe(0);
    expect((await entries('.check', 'suites', 'evals')).map((c) => c.name)).toEqual(['schema']);
    expect(existsSync(join(dir, '.check', 'suites', 'evals', 'schema.json'))).toBe(true);
    expect(existsSync(join(dir, '.check', 'schema.json'))).toBe(false);
  });

  test('the package depends on nothing: the three libraries are optional peers at the majors the slot reads', () => {
    const manifest = JSON.parse(readFileSync(join(CHECKOUT, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest['dependencies']).toBeUndefined();
    expect(manifest['peerDependencies']).toEqual({ ajv: '^8.0.0', 'jsonc-parser': '^3.0.0', yaml: '^2.0.0' });
    expect(manifest['peerDependenciesMeta']).toEqual({ ajv: { optional: true }, 'jsonc-parser': { optional: true }, yaml: { optional: true } });
  });
});

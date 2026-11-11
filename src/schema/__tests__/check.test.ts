import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { CHECKOUT } from '../../../test/helpers/schema-libraries.js';
import type { GitRunner } from '../../git.js';
import type { SchemaError, SchemaReport } from '../check.js';
import { checkSchemas } from '../check.js';
import { loadLibraries } from '../libraries.js';
import type { SchemaLibraries } from '../library-types.js';
import type { SchemaRule } from '../rules.js';

let libraries: SchemaLibraries;
let dir: string;

beforeAll(async () => {
  const loaded = loadLibraries(['ajv', 'yaml', 'jsonc-parser'], { repo: CHECKOUT, pm: 'pnpm' });
  if (!('libraries' in loaded)) throw new Error(loaded.refusal);
  libraries = loaded.libraries;
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'checkride-schema-check-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(rel: string, body: string | object): Promise<void> {
  const full = join(dir, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, typeof body === 'string' ? body : JSON.stringify(body));
}

/** No git here: the files are every file under the repo. */
const noGit: GitRunner = () => Promise.resolve({ ok: false, error: 'not-a-repo', detail: '' });

/** A git that lists exactly `files`. */
const listing = (files: readonly string[]): GitRunner => () => Promise.resolve({ ok: true, stdout: files.join('\0') });

/** Run `rules`, and hand back the report with the outcome's verdict. */
async function run(rules: readonly SchemaRule[], git: GitRunner = noGit): Promise<SchemaReport & { ok: boolean; exit: number; stderr: string }> {
  const checked = await checkSchemas(dir, { rules, configFile: 'checkride.config.json', libraries, git });
  if (!('outcome' in checked)) throw new Error(`refused: ${checked.refusal}`);
  const report = JSON.parse(checked.outcome.stdout) as SchemaReport;
  return { ...report, ok: checked.outcome.ok, exit: checked.outcome.exit_code, stderr: checked.outcome.stderr };
}

/** The refusal `rules` fail with. */
async function refusal(rules: readonly SchemaRule[]): Promise<string> {
  const checked = await checkSchemas(dir, { rules, configFile: 'checkride.config.json', libraries, git: noGit });
  if (!('refusal' in checked)) throw new Error('expected a refusal');
  return checked.refusal;
}

const PERSON = { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 2 }, age: { type: 'integer' } }, additionalProperties: false };

const SKILL = (name: string, description = 'Does a thing.'): string => `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;

describe('a green run', () => {
  test('exit 0, each rule with how many files it matched, and no errors', async () => {
    await write('schemas/person.json', PERSON);
    await write('people/a.json', { name: 'Ada' });
    await write('people/b.yaml', 'name: Bo\nage: 3\n');
    await write('people/c.jsonc', '{ // the third\n "name": "Cy", }');
    await write('other/d.json', { nope: true });
    const report = await run([
      { files: ['people/*.json'], schema: 'schemas/person.json' },
      { files: ['people/*.{yaml,jsonc}'], schema: 'schemas/person.json' },
    ]);
    expect(report).toMatchObject({ ok: true, exit: 0, stderr: '' });
    expect(report.rules).toEqual([{ schema: 'schemas/person.json', files: 1 }, { schema: 'schemas/person.json', files: 2 }]);
    expect(report.errors).toEqual([]);
  });

  test('the report is exactly rules and errors', async () => {
    await write('s.json', {});
    await write('a.json', {});
    const checked = await checkSchemas(dir, { rules: [{ files: ['a.json'], schema: 's.json' }], configFile: 'checkride.config.json', libraries, git: noGit });
    if (!('outcome' in checked)) throw new Error('refused');
    expect(JSON.parse(checked.outcome.stdout)).toEqual({ rules: [{ schema: 's.json', files: 1 }], errors: [] });
    expect(checked.outcome.stdout.endsWith('\n')).toBe(true);
  });
});

describe('a red run', () => {
  test('exit 1, and each error carries file, rule, instancePath, keyword, message, and line when known', async () => {
    await write('schemas/person.json', PERSON);
    await write('people/a.yaml', 'name: A\nage: old\n');
    await write('people/b.json', { name: 'Bo', extra: 1 });
    const report = await run([
      { files: ['people/*.json'], schema: 'schemas/person.json' },
      { files: ['people/*.yaml'], schema: 'schemas/person.json' },
    ]);
    expect(report).toMatchObject({ ok: false, exit: 1 });
    expect(report.errors).toEqual<SchemaError[]>([
      { file: 'people/b.json', rule: 0, instancePath: '', keyword: 'additionalProperties', message: "must NOT have additional properties: 'extra'", param: 'extra' },
      { file: 'people/a.yaml', rule: 1, instancePath: '/name', keyword: 'minLength', message: 'must NOT have fewer than 2 characters', line: 1 },
      { file: 'people/a.yaml', rule: 1, instancePath: '/age', keyword: 'type', message: 'must be integer', line: 2 },
    ]);
    expect(report.stderr.split('\n')).toEqual([
      "schema: people/b.json: must NOT have additional properties: 'extra' [additionalProperties]",
      'schema: people/a.yaml:1: /name must NOT have fewer than 2 characters [minLength]',
      'schema: people/a.yaml:2: /age must be integer [type]',
      '',
    ]);
  });

  test('rules run in order, and a file two rules match is checked by each', async () => {
    await write('a.json', { n: 'x' });
    await write('one.json', { properties: { n: { type: 'number' } } });
    await write('two.json', { required: ['m'] });
    const report = await run([{ files: ['a.json'], schema: 'two.json' }, { files: ['a.json'], schema: 'one.json' }]);
    expect(report.errors.map((e) => `${e.rule}:${e.keyword}`)).toEqual(['0:required', '1:type']);
  });

  test("a file that doesn't parse is an error on that file, with its line, and the rest still run", async () => {
    await write('s.json', { type: 'object' });
    await write('data/bad.json', '{\n  "a": 1,\n}\n');
    await write('data/good.json', {});
    await write('data/dupe.yml', 'a: 1\na: 2\n');
    await write('docs/none.md', '# no block\n');
    const report = await run([{ files: ['data/*.json'], schema: 's.json' }, { files: ['data/*.yml', 'docs/*.md'], schema: 's.json' }]);
    expect(report.rules).toEqual([{ schema: 's.json', files: 2 }, { schema: 's.json', files: 2 }]);
    expect(report.errors.map(({ file, rule, keyword, line }) => ({ file, rule, keyword, line }))).toEqual([
      { file: 'data/bad.json', rule: 0, keyword: 'parse', line: 3 },
      { file: 'data/dupe.yml', rule: 1, keyword: 'parse', line: 2 },
      { file: 'docs/none.md', rule: 1, keyword: 'frontmatter', line: 1 },
    ]);
  });

  test('a rule with no format reads each file by its own extension', async () => {
    await write('s.json', { required: ['a'] });
    await write('c/x.json', '{ "a": 1 }');
    await write('c/y.jsonc', '{ "a": 1, } // fine here');
    await write('c/z.json', '{ "a": 1, }');
    const report = await run([{ files: ['c/*.{json,jsonc}'], schema: 's.json' }]);
    expect(report.errors.map((e) => `${e.file}:${e.keyword}`)).toEqual(['c/z.json:parse']);
  });
});

describe('a parser that throws', () => {
  test('is that file not parsing, and the files after it are still checked', async () => {
    await write('s.json', { required: ['a'] });
    await write('a.yaml', 'boom: true\n');
    await write('b.json', {});
    const throwing = { ...libraries, yaml: { parseDocument: () => { throw new Error('the parser gave up'); } } };
    const checked = await checkSchemas(dir, { rules: [{ files: ['*.yaml', 'b.json'], schema: 's.json' }], configFile: 'checkride.config.json', libraries: throwing, git: noGit });
    if (!('outcome' in checked)) throw new Error('refused');
    expect((JSON.parse(checked.outcome.stdout) as SchemaReport).errors).toEqual([
      { file: 'a.yaml', rule: 0, instancePath: '', keyword: 'parse', message: 'the parser gave up' },
      { file: 'b.json', rule: 0, instancePath: '', keyword: 'required', message: "must have required property 'a'", param: 'a' },
    ]);
  });
});

/** Each error of `value` under `schema`, as `<keyword>@<pointer>=<param>`, `-` for an error with none. */
async function errorsOf(schema: object, value: object): Promise<string[]> {
  await write('s.json', schema);
  await write('a.json', value);
  return (await run([{ files: ['a.json'], schema: 's.json' }])).errors.map((e) => `${e.keyword}@${e.instancePath}=${e.param ?? '-'}`);
}

/** A git that fails to list, for a reason that is neither a missing git nor a directory outside a repo. */
const brokenGit: GitRunner = () => Promise.resolve({ ok: false, error: 'failed', detail: 'fatal: index file corrupt' });

describe('param: what a keyword names as at fault', () => {
  test('required names each property it misses, so two at one pointer are told apart', async () => {
    expect(await errorsOf({ required: ['name', 'description'] }, {})).toEqual(['required@=name', 'required@=description']);
  });

  test('additionalProperties and unevaluatedProperties name the property they found', async () => {
    expect(await errorsOf({ properties: { a: {} }, additionalProperties: false }, { a: 1, b: 2, c: 3 })).toEqual(['additionalProperties@=b', 'additionalProperties@=c']);
    expect(await errorsOf({ properties: { a: {} }, unevaluatedProperties: false }, { a: 1, z: 2 })).toEqual(['unevaluatedProperties@=z']);
  });

  test('propertyNames names the name it refused, and dependentRequired the property it misses', async () => {
    expect((await errorsOf({ propertyNames: { pattern: '^[a-z]+$' } }, { Bad: 1 })).filter((e) => e.startsWith('propertyNames'))).toEqual(['propertyNames@=Bad']);
    expect(await errorsOf({ dependentRequired: { card: ['billing'] } }, { card: 1 })).toEqual(['dependentRequired@=billing']);
  });

  test('a keyword that names nothing carries none: its parameters restate the schema', async () => {
    expect(await errorsOf({ properties: { n: { type: 'string', pattern: '^a', enum: ['ab'] } } }, { n: 'b' })).toEqual(['enum@/n=-', 'pattern@/n=-']);
    expect(await errorsOf({ properties: { n: { type: 'integer', minimum: 3 } } }, { n: 1 })).toEqual(['minimum@/n=-']);
  });
});

describe('a byte order mark', () => {
  const BOM = '\uFEFF';

  test('is no part of a file, in any format', async () => {
    await write('s.json', { type: 'object', required: ['name'] });
    await write('d/a.json', `${BOM}{ "name": "a" }`);
    await write('d/b.jsonc', `${BOM}{ "name": "b", } // ok`);
    await write('d/c.yaml', `${BOM}name: c\n`);
    await write('d/d.md', `${BOM}---\nname: d\n---\n# D\n`);
    const report = await run([{ files: ['d/*.{json,jsonc,yaml,md}'], schema: 's.json' }]);
    expect(report).toMatchObject({ ok: true, rules: [{ files: 4 }], errors: [] });
  });

  test('nor of a schema file, or of a sibling it refers to', async () => {
    await write('s.json', `${BOM}${JSON.stringify({ properties: { n: { $ref: 'n.json' } } })}`);
    await write('n.json', `${BOM}${JSON.stringify({ type: 'number' })}`);
    await write('a.json', { n: 'x' });
    expect((await run([{ files: ['a.json'], schema: 's.json' }])).errors.map((e) => e.keyword)).toEqual(['type']);
  });

  test('a skill whose SKILL.md leads with one still has its frontmatter', async () => {
    await write('skills/pdf/SKILL.md', `${BOM}---\nname: pdf\ndescription: Reads PDFs.\n---\n`);
    expect(await run([{ files: ['skills/*/SKILL.md'], schema: 'checkride:agent-skill' }])).toMatchObject({ ok: true });
  });
});

describe('nothing a file or a schema holds ends the check', () => {
  test('a directory a glob matches is no file, so it is not a match', async () => {
    await write('s.json', {});
    await write('data.json/inner.txt', 'x');
    await write('real.json', {});
    const report = await run([{ files: ['*.json'], schema: 's.json' }], listing(['s.json', 'data.json', 'real.json']));
    expect(report).toMatchObject({ ok: true, rules: [{ files: 2 }] });
  });

  test('a schema path that is a directory is the refusal for a schema that cannot be read', async () => {
    await write('a.json', {});
    await write('schemas/inner.json', {});
    expect(await refusal([{ files: ['a.json'], schema: 'schemas' }])).toMatch(/names the schema `schemas`, which can't be read/);
  });

  test('bytes that are not UTF-8 are a parse error on that file', async () => {
    await write('s.json', {});
    await writeFile(join(dir, 'a.json'), Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x7d]));
    await write('b.json', {});
    const report = await run([{ files: ['{a,b}.json'], schema: 's.json' }]);
    expect(report.errors.map((e) => `${e.file}:${e.keyword}`)).toEqual(['a.json:parse']);
  });

  test('a schema that is JSON and no object is refused: true, a list, a string', async () => {
    await write('a.json', {});
    for (const text of ['true', '[]', '"type"', 'null']) {
      await write('s.json', text);
      expect(await refusal([{ files: ['a.json'], schema: 's.json' }])).toBe('checkride: the schema `s.json` is not a JSON Schema: it must be an object.\n');
    }
  });

  test('a malformed reference is refused through the check, with nothing thrown', async () => {
    await write('a.json', {});
    await write('s.json', { $ref: '100%.json' });
    expect(await refusal([{ files: ['a.json'], schema: 's.json' }])).toBe('checkride: the schema `s.json` refers to `100%.json`, which is no path: its percent-encoding is malformed.\n');
  });

  test('a git that cannot list the files is a refusal with its reason', async () => {
    await write('s.json', {});
    const checked = await checkSchemas(dir, { rules: [{ files: ['a.json'], schema: 's.json' }], configFile: 'checkride.config.json', libraries, git: brokenGit });
    expect(checked).toEqual({ refusal: "checkride: can't list the files of the schema check: fatal: index file corrupt.\n" });
  });

  test('a validator that throws is one error on that file, and the next file is still checked', async () => {
    await write('s.json', {});
    await write('a.json', {});
    await write('b.json', {});
    let calls = 0;
    const flaky = function Flaky(): { addSchema: () => void; getSchema: () => (value: unknown) => boolean } {
      return {
        addSchema: () => undefined,
        getSchema: () => () => {
          calls += 1;
          if (calls === 1) throw new Error('stack exhausted');
          return true;
        },
      };
    };
    const throwing = { ...libraries, ajv: { ...libraries.ajv, draft2020: flaky as unknown as SchemaLibraries['ajv']['draft2020'] } };
    const checked = await checkSchemas(dir, { rules: [{ files: ['{a,b}.json'], schema: 's.json' }], configFile: 'checkride.config.json', libraries: throwing, git: noGit });
    if (!('outcome' in checked)) throw new Error('refused');
    expect((JSON.parse(checked.outcome.stdout) as SchemaReport).errors).toEqual([
      { file: 'a.json', rule: 0, instancePath: '', keyword: 'validate', message: "couldn't be validated: stack exhausted" },
    ]);
  });
});

/** The whole of what a run of `rules` said, wherever it said it. */
async function said(rules: readonly SchemaRule[], git: GitRunner = noGit): Promise<string> {
  return JSON.stringify(await checkSchemas(dir, { rules, configFile: 'checkride.config.json', libraries, git }));
}

describe('containment: nothing outside the repository is read', () => {
  const SECRET = 'hunter2-do-not-echo';
  let outside: string;

  beforeEach(async () => {
    outside = await mkdtemp(join(tmpdir(), 'checkride-schema-outside-'));
    await writeFile(join(outside, 'secret.json'), JSON.stringify({ password: SECRET }));
    await writeFile(join(outside, 'schema.json'), JSON.stringify({ title: SECRET, required: ['a'] }));
    await writeFile(join(outside, 'notes.txt'), `${SECRET}\n`);
    await write('s.json', { type: 'object', properties: { password: { const: 'x' } } });
    await write('a.json', {});
  });
  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
  });

  test('a schema path that climbs out with .. is refused, and never read', async () => {
    const schema = join('..', outside.split('/').at(-1) ?? '', 'schema.json');
    const text = await refusal([{ files: ['a.json'], schema }]);
    expect(text).toBe(`checkride: schemas[0] names the schema \`${schema}\`, which resolves outside the repository: a schema is read only from inside it.\n`);
    expect(text).not.toContain(SECRET);
  });

  test('so is an absolute schema path, which a config can no longer hold but a caller might', async () => {
    expect(await refusal([{ files: ['a.json'], schema: join(outside, 'schema.json') }])).toMatch(/which resolves outside the repository/);
  });

  test('a schema that is a symlink to a file outside is refused: the real path is what is tested', async () => {
    await symlink(join(outside, 'schema.json'), join(dir, 'linked.schema.json'));
    const text = await refusal([{ files: ['a.json'], schema: 'linked.schema.json' }]);
    expect(text).toBe('checkride: schemas[0] names the schema `linked.schema.json`, which resolves outside the repository: a schema is read only from inside it.\n');
  });

  test('a schema reached through a symlinked directory that leaves the repo is refused too', async () => {
    await symlink(outside, join(dir, 'vendor-schemas'));
    expect(await refusal([{ files: ['a.json'], schema: 'vendor-schemas/schema.json' }])).toMatch(/resolves outside the repository/);
  });

  test('a schema that is a symlink to a file inside the repo is read', async () => {
    await write('schemas/real.json', { required: ['a'] });
    await symlink(join(dir, 'schemas', 'real.json'), join(dir, 'alias.json'));
    expect((await run([{ files: ['a.json'], schema: 'alias.json' }])).errors.map((e) => e.keyword)).toEqual(['required']);
  });

  test.each([
    ['a relative $ref with ..', (out: string) => `../${out.split('/').at(-1) ?? ''}/schema.json`],
    ['an absolute path $ref', (out: string) => join(out, 'schema.json')],
    ['a $ref to a file that is not JSON at all', (out: string) => join(out, 'notes.txt')],
  ])('%s that resolves outside is refused, with nothing of the file in the refusal', async (_name, refOf) => {
    const ref = refOf(outside);
    await write('main.json', { properties: { a: { $ref: ref } } });
    const text = await refusal([{ files: ['a.json'], schema: 'main.json' }]);
    expect(text).toBe(`checkride: the schema \`main.json\` refers to \`${ref}\`, which resolves outside the repository: a schema is read only from inside it.\n`);
    expect(text).not.toContain(SECRET);
  });

  test('a $ref to a sibling that is a symlink out of the repo is refused', async () => {
    await symlink(join(outside, 'schema.json'), join(dir, 'defs.json'));
    await write('main.json', { $ref: 'defs.json' });
    expect(await refusal([{ files: ['a.json'], schema: 'main.json' }])).toMatch(/refers to `defs\.json`, which resolves outside the repository/);
  });

  test('a file: URL $ref is a finding on the schema, and the file it names is never read', async () => {
    await write('main.json', { $ref: `file://${join(outside, 'schema.json')}` });
    const report = await run([{ files: ['a.json'], schema: 'main.json' }]);
    expect(report.errors.map((e) => `${e.file}:${e.keyword}`)).toEqual(['main.json:$ref']);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  test('a schema inside the repo that is not JSON is named with where it stops, and none of its text', async () => {
    await write('broken.json', `{ "ok": true }\n${SECRET}: [\n`);
    const text = await refusal([{ files: ['a.json'], schema: 'broken.json' }]);
    expect(text).toMatch(/^checkride: the schema `broken\.json` is not valid JSON( \(line 2, column 1\))?\.\n$/);
    expect(text).not.toContain(SECRET);
  });

  test('a matched data file that is a symlink out of the repo is an error on that file, counted, and never read', async () => {
    await symlink(join(outside, 'secret.json'), join(dir, 'leak.json'));
    const report = await run([{ files: ['{a,leak}.json'], schema: 's.json' }]);
    expect(report.rules).toEqual([{ schema: 's.json', files: 2 }]);
    expect(report.errors).toEqual([{ file: 'leak.json', rule: 0, instancePath: '', keyword: 'symlink', message: "resolves outside the repository, so it isn't read" }]);
    expect(await said([{ files: ['{a,leak}.json'], schema: 's.json' }])).not.toContain(SECRET);
  });

  test('so is a file listed under a symlinked directory that leaves the repo', async () => {
    await symlink(outside, join(dir, 'shared'));
    const git = listing(['a.json', 's.json', 'shared/secret.json']);
    const report = await run([{ files: ['shared/*.json'], schema: 's.json' }], git);
    expect(report.errors.map((e) => `${e.file}:${e.keyword}`)).toEqual(['shared/secret.json:symlink']);
    expect(await said([{ files: ['shared/*.json'], schema: 's.json' }], git)).not.toContain(SECRET);
  });

  test('a data file that is a symlink to a file inside the repo is read and validated as that file', async () => {
    await write('real/b.json', { password: 'not-x' });
    await symlink(join(dir, 'real', 'b.json'), join(dir, 'alias.json'));
    const report = await run([{ files: ['alias.json'], schema: 's.json' }]);
    expect(report.errors).toEqual([{ file: 'alias.json', rule: 0, instancePath: '/password', keyword: 'const', message: 'must be equal to constant' }]);
  });

  test('a dangling symlink is no file, as a path gone from disk is none', async () => {
    await symlink(join(dir, 'nowhere.json'), join(dir, 'dangling.json'));
    const report = await run([{ files: ['{a,dangling}.json'], schema: 's.json' }], listing(['a.json', 'dangling.json']));
    expect(report).toMatchObject({ ok: true, rules: [{ files: 1 }] });
  });
});

describe('two rules that name one schema', () => {
  test('share one compile: the schema is read once, and each rule still reports under its own index', async () => {
    await write('s.json', { required: ['a'] });
    await write('x/a.json', {});
    await write('y/b.json', {});
    const report = await run([{ files: ['x/*.json'], schema: 's.json' }, { files: ['y/*.json'], schema: 's.json' }]);
    expect(report.errors.map((e) => `${e.rule}:${e.file}`)).toEqual(['0:x/a.json', '1:y/b.json']);
  });

  test('a schema that cannot be used is refused at the first rule that names it', async () => {
    await write('a.json', {});
    expect(await refusal([{ files: ['a.json'], schema: 'ok.json' }, { files: ['a.json'], schema: 'ok.json' }])).toMatch(/^checkride: schemas\[0\] names the schema `ok\.json`/);
  });
});

describe('rule hygiene', () => {
  test('a rule that matches no file is an error on the config, at the rule', async () => {
    await write('s.json', {});
    await write('a.json', {});
    const report = await run([{ files: ['a.json'], schema: 's.json' }, { files: ['nothing/**/*.json', 'gone.yml'], schema: 's.json' }]);
    expect(report).toMatchObject({ ok: false, exit: 1 });
    expect(report.rules[1]).toEqual({ schema: 's.json', files: 0 });
    expect(report.errors).toEqual([
      { file: 'checkride.config.json', rule: 1, instancePath: '/schemas/1/files', keyword: 'files', message: 'matches no files (nothing/**/*.json, gone.yml)' },
    ]);
  });

  test('the config file it names is the one that holds the rules', async () => {
    await write('s.json', {});
    const checked = await checkSchemas(dir, { rules: [{ files: ['x.json'], schema: 's.json' }], configFile: 'checkride.evals.config.json', libraries, git: noGit });
    if (!('outcome' in checked)) throw new Error('refused');
    expect((JSON.parse(checked.outcome.stdout) as SchemaReport).errors[0]?.file).toBe('checkride.evals.config.json');
  });
});

describe('which files a rule sees', () => {
  test('the ones git lists, so an ignored file is never read, and a listed one gone from disk is left out', async () => {
    await write('s.json', { required: ['a'] });
    await write('data/kept.json', {});
    await write('data/ignored.json', {});
    const report = await run([{ files: ['data/*.json'], schema: 's.json' }], listing(['s.json', 'data/kept.json', 'data/deleted.json']));
    expect(report.rules).toEqual([{ schema: 's.json', files: 1 }]);
    expect(report.errors.map((e) => e.file)).toEqual(['data/kept.json']);
  });

  test('outside a git repo, every file but those under node_modules', async () => {
    await write('s.json', { required: ['a'] });
    await write('pkg/a.json', {});
    await write('node_modules/dep/package.json', {});
    const report = await run([{ files: ['**/*.json'], schema: 's.json' }]);
    expect(report.errors.map((e) => e.file).toSorted()).toEqual(['pkg/a.json', 's.json']);
  });
});

describe('a schema that cannot be used refuses the check', () => {
  test('a missing schema file is named, with the rule that names it', async () => {
    await write('a.json', {});
    expect(await refusal([{ files: ['a.json'], schema: 'schemas/gone.json' }])).toBe(
      "checkride: schemas[0] names the schema `schemas/gone.json`, which can't be read: no such file from the repo root.\n",
    );
  });

  test('a schema that is not JSON, and one that is not a schema', async () => {
    await write('a.json', {});
    await write('broken.json', '{ nope');
    await write('wrong.json', { type: 'nope' });
    expect(await refusal([{ files: ['a.json'], schema: 'broken.json' }])).toMatch(/the schema `broken\.json` is not valid JSON/);
    expect(await refusal([{ files: ['a.json'], schema: 'wrong.json' }])).toMatch(/the schema `wrong\.json` is not a valid schema/);
  });

  test('it refuses before any file is read: a later rule\'s bad schema stops an earlier rule\'s errors', async () => {
    await write('good.json', { required: ['a'] });
    await write('a.json', {});
    expect(await refusal([{ files: ['a.json'], schema: 'good.json' }, { files: ['a.json'], schema: 'gone.json' }])).toMatch(/schemas\[1\] names the schema `gone\.json`/);
  });
});

describe('$ref', () => {
  test('a sibling file by relative path is read from beside the schema', async () => {
    await write('schemas/main.json', { properties: { name: { $ref: 'defs/name.json' } } });
    await write('schemas/defs/name.json', { type: 'string' });
    await write('a.json', { name: 1 });
    const report = await run([{ files: ['a.json'], schema: 'schemas/main.json' }]);
    expect(report.errors).toEqual([{ file: 'a.json', rule: 0, instancePath: '/name', keyword: 'type', message: 'must be string' }]);
  });

  test('a URL is an error on the schema file, once for the rule, and none of its files is validated', async () => {
    await write('schemas/main.json', { properties: { name: { $ref: 'https://example.com/name.json' } } });
    await write('a.json', { name: 1 });
    await write('b.json', { name: 2 });
    const report = await run([{ files: ['*.json'], schema: 'schemas/main.json' }]);
    expect(report.rules).toEqual([{ schema: 'schemas/main.json', files: 2 }]);
    expect(report.errors).toEqual([
      {
        file: 'schemas/main.json',
        rule: 0,
        instancePath: '/properties/name/$ref',
        keyword: '$ref',
        message: 'refers to the URL https://example.com/name.json, and a check makes no network call: keep the schema it names in the repo, and refer to it by relative path',
      },
    ]);
  });
});

describe('checkride:agent-skill', () => {
  const rule: SchemaRule = { files: ['skills/*/SKILL.md'], schema: 'checkride:agent-skill' };

  test('a skill whose name is its directory, with a description, passes, whatever else it carries', async () => {
    await write('skills/pdf-tools/SKILL.md', '---\nname: pdf-tools\ndescription: Reads PDFs.\nallowed-tools: Read\nmetadata:\n  version: 2\n---\n');
    expect(await run([rule])).toMatchObject({ ok: true, rules: [{ schema: 'checkride:agent-skill', files: 1 }] });
  });

  test('name: its pattern, its 64 characters, and its presence', async () => {
    await write('skills/Bad_Name/SKILL.md', SKILL('Bad_Name'));
    await write('skills/-lead/SKILL.md', SKILL('-lead'));
    await write(`skills/${'a'.repeat(65)}/SKILL.md`, SKILL('a'.repeat(65)));
    await write('skills/none/SKILL.md', '---\ndescription: x\n---\n');
    const report = await run([rule]);
    expect(report.errors.map((e) => `${e.file.split('/')[1]?.slice(0, 8)}:${e.instancePath}:${e.keyword}:${e.line}`)).toEqual([
      '-lead:/name:pattern:2',
      'Bad_Name:/name:pattern:2',
      'aaaaaaaa:/name:maxLength:2',
      'none::required:2',
    ]);
  });

  test('description: 1 to 1024 characters, and its presence', async () => {
    await write('skills/empty/SKILL.md', '---\nname: empty\ndescription: ""\n---\n');
    await write('skills/long/SKILL.md', SKILL('long', 'x'.repeat(1025)));
    await write('skills/edge/SKILL.md', SKILL('edge', 'x'.repeat(1024)));
    await write('skills/none/SKILL.md', '---\nname: none\n---\n');
    const report = await run([rule]);
    expect(report.errors.map((e) => `${e.file}:${e.instancePath}:${e.keyword}`)).toEqual([
      'skills/empty/SKILL.md:/description:minLength',
      'skills/long/SKILL.md:/description:maxLength',
      'skills/none/SKILL.md::required',
    ]);
  });

  test("name must equal the parent directory's name, which JSON Schema can't say", async () => {
    await write('skills/pdf/SKILL.md', SKILL('pdf-tools'));
    const report = await run([rule]);
    expect(report.errors).toEqual([
      { file: 'skills/pdf/SKILL.md', rule: 0, instancePath: '/name', keyword: 'directory-name', message: "must equal the parent directory's name, 'pdf'", line: 2 },
    ]);
  });

  test('a name that is no string is the schema\'s to report, once', async () => {
    await write('skills/pdf/SKILL.md', '---\nname: 3\ndescription: x\n---\n');
    expect((await run([rule])).errors.map((e) => e.keyword)).toEqual(['type']);
  });

  test('a file with no frontmatter is an error', async () => {
    await write('skills/pdf/SKILL.md', '# PDF\n');
    expect((await run([rule])).errors.map((e) => e.keyword)).toEqual(['frontmatter']);
  });
});

describe('checkride:checkride-config', () => {
  const rule: SchemaRule = { files: ['configs/*.json'], schema: 'checkride:checkride-config' };

  test('a config checkride would load passes, and one with a key it never reads fails', async () => {
    await write('configs/good.json', { checks: { lint: { use: 'oxlint', order: 1 }, links: false }, schemas: [{ files: ['a.json'], schema: 'checkride:agent-skill' }] });
    await write('configs/bad.json', { check: {}, timeout: 'soon' });
    const report = await run([rule]);
    expect(report.rules).toEqual([{ schema: 'checkride:checkride-config', files: 2 }]);
    expect(report.errors.map((e) => `${e.file}:${e.instancePath}:${e.keyword}`).toSorted()).toEqual([
      'configs/bad.json:/timeout:type',
      'configs/bad.json::additionalProperties',
    ]);
  });
});

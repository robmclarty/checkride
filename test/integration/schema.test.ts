/**
 * The `schema` slot end to end: one git repo with a rule of each format, a
 * bundled schema, a schema that refers to a sibling file, and a rule that
 * matches nothing, run through the CLI with the libraries a repo would
 * install. The report lands in `.check/schema.json`, and the terminal lists
 * the findings beneath the slot's red line.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runCli } from '../../src/cli.js';
import { installLibraries } from '../helpers/schema-libraries.js';

const SERVICE = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['name', 'port'],
  properties: { name: { $ref: 'defs/name.json' }, port: { type: 'integer', minimum: 1 }, contact: { type: 'string', format: 'email' } },
  additionalProperties: false,
};

const WORKFLOW = { type: 'object', required: ['name', 'on'], properties: { name: { type: 'string' } } };

const CONFIG = {
  checks: { links: false },
  schemas: [
    { files: ['skills/*/SKILL.md'], schema: 'checkride:agent-skill', note: 'Every skill is named for its directory.' },
    { files: ['config/*.json'], schema: 'schemas/service.schema.json' },
    { files: ['.vscode/*.json'], schema: 'schemas/service.schema.json', format: 'jsonc' },
    { files: ['.github/workflows/*.{yml,yaml}'], schema: 'schemas/workflow.schema.json' },
    { files: ['prompts/**/*.prompt.md'], schema: 'schemas/workflow.schema.json' },
  ],
};

function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

/** The lines printed beneath the slot's status line, up to the next line that isn't indented beneath it. */
function beneath(stderr: string): string[] {
  const all = stderr.split('\n');
  const rest = all.slice(all.findIndex((line) => /^ {2}[✘✔] schema /.test(line)) + 1);
  const end = rest.findIndex((line) => !line.startsWith('           '));
  return rest.slice(0, end === -1 ? rest.length : end).map((line) => line.slice(11));
}

describe('the schema slot in a repo with several rules', () => {
  let dir: string;

  async function write(rel: string, body: string | object): Promise<void> {
    const full = join(dir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
  }

  async function cli(...argv: string[]): Promise<{ code: number; stderr: string }> {
    const stderr = capture();
    const code = await runCli(argv, { cwd: dir, stdout: capture(), stderr, env: {} });
    return { code, stderr: stderr.text() };
  }

  const report = async (): Promise<unknown> => JSON.parse(await readFile(join(dir, '.check', 'schema.json'), 'utf8'));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-schema-e2e-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    await installLibraries(dir);
    await write('.gitignore', 'node_modules/\n.check/\nconfig/local.json\n');
    await write('checkride.config.json', CONFIG);
    await write('schemas/service.schema.json', SERVICE);
    await write('schemas/defs/name.json', { type: 'string', pattern: '^[a-z-]+$' });
    await write('schemas/workflow.schema.json', WORKFLOW);
    await write('skills/pdf/SKILL.md', '---\nname: pdf\ndescription: Reads and fills PDF forms.\n---\n\n# PDF\n');
    await write('skills/review/SKILL.md', '---\nname: review\ndescription: Reviews a diff.\nlicense: MIT\n---\n');
    await write('config/api.json', { name: 'api', port: 8080, contact: 'not an address' });
    // Ignored, so never read, though it would fail.
    await write('config/local.json', '{ nope');
    await write('.vscode/service.json', '{\n  // the editor\'s copy\n  "name": "editor",\n  "port": 9000,\n}\n');
    await write('.github/workflows/ci.yml', 'name: CI\non: push\n');
    await write('.github/workflows/release.yaml', 'name: Release\non:\n  push:\n    tags: ["v*"]\n');
    await write('prompts/review/first.prompt.md', '---\nname: First pass\non: pull_request\n---\nRead the diff.\n');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('green: every rule matches, every file satisfies its schema, and the report counts them', async () => {
    const run = await cli();
    expect(run.code).toBe(0);
    expect(run.stderr).toMatch(/^ {2}✔ schema +\d+ms {2}Data files satisfy their JSON Schemas {2}\[built-in\]$/m);
    expect(await report()).toEqual({
      rules: [
        { schema: 'checkride:agent-skill', files: 2 },
        { schema: 'schemas/service.schema.json', files: 1 },
        { schema: 'schemas/service.schema.json', files: 1 },
        { schema: 'schemas/workflow.schema.json', files: 2 },
        { schema: 'schemas/workflow.schema.json', files: 1 },
      ],
      errors: [],
    });
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as { checks: Record<string, unknown>[] };
    expect(summary.checks.find((c) => c['name'] === 'schema')).toMatchObject({ ok: true, adapter: 'schema', exit_code: 0, output_file: 'schema.json', origin: 'built-in' });
  });

  test('red: each kind of error lands in the report in rule order, and the terminal lists the first of them', async () => {
    await write('skills/review/SKILL.md', '---\nname: code-review\ndescription: Reviews a diff.\n---\n');
    await write('config/api.json', '{\n  "name": "API",\n  "port": 0,\n  "extra": true\n}\n');
    await write('.vscode/service.json', '{\n  "name": "editor"\n  "port": 9000\n}\n');
    await write('.github/workflows/ci.yml', 'name: CI\non: push\nname: Again\n');
    await write('prompts/review/first.prompt.md', 'Read the diff.\n');
    await write('checkride.config.json', { ...CONFIG, schemas: [...CONFIG.schemas, { files: ['evals/**/*.yaml'], schema: 'schemas/workflow.schema.json' }] });

    const run = await cli();
    expect(run.code).toBe(1);
    expect(await report()).toEqual({
      rules: [
        { schema: 'checkride:agent-skill', files: 2 },
        { schema: 'schemas/service.schema.json', files: 1 },
        { schema: 'schemas/service.schema.json', files: 1 },
        { schema: 'schemas/workflow.schema.json', files: 2 },
        { schema: 'schemas/workflow.schema.json', files: 1 },
        { schema: 'schemas/workflow.schema.json', files: 0 },
      ],
      errors: [
        { file: 'skills/review/SKILL.md', rule: 0, instancePath: '/name', keyword: 'directory-name', message: "must equal the parent directory's name, 'review'", line: 2 },
        { file: 'config/api.json', rule: 1, instancePath: '', keyword: 'additionalProperties', message: "must NOT have additional properties: 'extra'", param: 'extra' },
        { file: 'config/api.json', rule: 1, instancePath: '/name', keyword: 'pattern', message: 'must match pattern "^[a-z-]+$"' },
        { file: 'config/api.json', rule: 1, instancePath: '/port', keyword: 'minimum', message: 'must be >= 1' },
        { file: '.vscode/service.json', rule: 2, instancePath: '', keyword: 'parse', message: 'CommaExpected', line: 3 },
        { file: '.github/workflows/ci.yml', rule: 3, instancePath: '', keyword: 'parse', message: 'Map keys must be unique', line: 3 },
        { file: 'prompts/review/first.prompt.md', rule: 4, instancePath: '', keyword: 'frontmatter', message: 'has no frontmatter block: its first line must be `---`', line: 1 },
        { file: 'checkride.config.json', rule: 5, instancePath: '/schemas/5/files', keyword: 'files', message: 'matches no files (evals/**/*.yaml)' },
      ],
    });
    expect(run.stderr).toMatch(/^ {2}✘ schema +\d+ms {2}Data files satisfy their JSON Schemas {2}\[built-in\]$/m);
    expect(beneath(run.stderr)).toEqual([
      "skills/review/SKILL.md:2  /name must equal the parent directory's name, 'review'  [directory-name]",
      "config/api.json  must NOT have additional properties: 'extra'  [additionalProperties]",
      'config/api.json  /name must match pattern "^[a-z-]+$"  [pattern]',
      'config/api.json  /port must be >= 1  [minimum]',
      '.vscode/service.json:3  CommaExpected  [parse]',
      '… and 3 more',
      'full output: .check/schema.json',
    ]);
    expect(run.stderr).toContain('✘ one or more checks failed');
  });

  test('a schema that cannot be read refuses the check, and no report is written', async () => {
    await rm(join(dir, 'schemas/defs/name.json'));
    const run = await cli();
    expect(run.code).toBe(1);
    expect(beneath(run.stderr)[0]).toBe("the schema `schemas/service.schema.json` refers to `defs/name.json`, and schemas/defs/name.json can't be read");
    await expect(report()).rejects.toThrow();
  });
});

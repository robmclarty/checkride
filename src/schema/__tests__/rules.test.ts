import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { loadConfig, loadDefaultsFile } from '../../config.js';
import { bundledSchema, bundledSchemas, isBundled } from '../bundled.js';
import { ruleFormats, schemaRulesProblem } from '../rules.js';
import { neededLibraries } from '../run.js';

describe('the bundled schemas', () => {
  test('are checkride:agent-skill and checkride:checkride-config', () => {
    expect(bundledSchemas()).toEqual(['checkride:agent-skill', 'checkride:checkride-config']);
    expect(bundledSchemas().every(isBundled)).toBe(true);
    expect(isBundled('checkride:nope')).toBe(false);
    expect(isBundled('schemas/agent-skill.json')).toBe(false);
    expect(isBundled('checkride:constructor')).toBe(false);
  });

  test('each reads as JSON, and agent-skill alone adds a check', () => {
    const skill = bundledSchema('checkride:agent-skill');
    const config = bundledSchema('checkride:checkride-config');
    expect(typeof skill?.extra).toBe('function');
    expect(config?.extra).toBeUndefined();
    expect(JSON.parse(config?.text ?? '')).toHaveProperty('properties.schemas');
    expect(bundledSchema('checkride:nope')).toBeNull();
  });

  test('agent-skill holds the limits, and says where they come from', () => {
    const schema = JSON.parse(bundledSchema('checkride:agent-skill')?.text ?? '') as Record<string, unknown>;
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema['required']).toEqual(['name', 'description']);
    expect(schema['additionalProperties']).toBe(true);
    expect(schema['properties']).toMatchObject({
      name: { type: 'string', maxLength: 64, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
      description: { type: 'string', minLength: 1, maxLength: 1024 },
    });
    expect(schema['$comment']).toContain("the Agent Skills specification's limits as recorded in checkride's design");
  });
});

/** The problem with `rule`, as the second rule of a config whose first is fine. */
const problem = (rule: unknown): string | null => schemaRulesProblem([{ files: ['ok.json'], schema: 'ok.json' }, rule]);

describe('what a rule must hold', () => {
  test('nothing is wrong with rules the slot can run, or with no rules', () => {
    expect(schemaRulesProblem(undefined)).toBeNull();
    expect(schemaRulesProblem([])).toBeNull();
    expect(problem({ files: ['skills/*/SKILL.md'], schema: 'checkride:agent-skill' })).toBeNull();
    expect(problem({ files: ['a.yml', 'b.yaml', 'c.{json,jsonc}', 'docs/**/*.mdx'], schema: 's.json' })).toBeNull();
    expect(problem({ files: ['config/*', 'Makefile'], schema: 's.json', format: 'yaml' })).toBeNull();
  });

  test('an unknown bundled id is an error listing the ones there are', () => {
    expect(problem({ files: ['a.json'], schema: 'checkride:agent-skil' })).toBe(
      'schemas[1].schema "checkride:agent-skil" is no bundled schema: the bundled schemas are checkride:agent-skill and checkride:checkride-config',
    );
  });

  test("with no format, a glob whose extension it can't place is an error naming the glob and the fix", () => {
    expect(problem({ files: ['a.json', 'config/*.toml'], schema: 's.json' })).toBe(
      'schemas[1].files has "config/*.toml", whose extension doesn\'t say how to read what it matches (.json, .jsonc, .yaml, .yml, .md or .mdx): set schemas[1].format to json, jsonc, yaml or frontmatter',
    );
    expect(problem({ files: ['config/**'], schema: 's.json' })).toMatch(/schemas\[1\]\.files has "config\/\*\*"/);
    expect(problem({ files: ['a.{json,toml}'], schema: 's.json' })).toMatch(/has "a\.\{json,toml\}"/);
  });

  test('a format outside the four, files that are no globs, and a rule that is no object', () => {
    expect(problem({ files: ['a.toml'], schema: 's.json', format: 'toml' })).toBe('schemas[1].format must be json, jsonc, yaml or frontmatter (got "toml")');
    expect(problem({ files: 'a.json', schema: 's.json' })).toBe('schemas[1].files must be an array of globs (got "a.json")');
    expect(problem({ schema: 's.json' })).toMatch(/schemas\[1\]\.files must be an array of globs/);
    expect(problem({ files: [''], schema: 's.json' })).toMatch(/must be an array of globs/);
    // A rule that is no object has no schema reference, which is the first thing asked of every rule.
    expect(problem('a.json')).toBe('schemas[1].schema must name a bundled checkride:<id> schema or a repo-relative path (got undefined)');
    expect(schemaRulesProblem({ files: ['a.json'] })).toBe('schemas must be an array of rules (got {"files":["a.json"]})');
  });
});

describe('a schema path that could leave the repo', () => {
  test.each([
    ['../shared/s.json', "has a '..' segment"],
    ['schemas/../../s.json', "has a '..' segment"],
    ['schemas\\..\\..\\s.json', "has a '..' segment"],
    ['..', "has a '..' segment"],
    ['/etc/passwd', 'is absolute'],
    ['C:\\Users\\me\\s.json', 'is absolute'],
    ['C:/Users/me/s.json', 'is absolute'],
    ['c:s.json', 'is absolute'],
    ['\\\\server\\share\\s.json', 'is absolute'],
    ['\\rooted\\s.json', 'is absolute'],
  ])('%s %s', (schema, why) => {
    const said = problem({ files: ['a.json'], schema });
    expect(said).toContain(`schemas[1].schema ${JSON.stringify(schema)} ${why}`);
  });

  test('a name with dots in it, a dotfile directory and a bundled id are none of those', () => {
    for (const schema of ['schemas/a..b.json', '.schemas/s.json', 'schemas/...json', 'checkride:agent-skill', 'ab:c/s.json']) {
      expect(problem({ files: ['a.json'], schema }), schema).toBeNull();
    }
  });

  test('a reference that leaves the repo is the error named, ahead of anything else wrong with any rule', () => {
    expect(schemaRulesProblem([{ files: 'not globs', schema: 's.json' }, { files: ['a.json'], schema: '../s.json' }])).toContain("schemas[1].schema \"../s.json\" has a '..' segment");
  });
});

describe('the formats a rule reads, and the libraries they need', () => {
  test('the one it sets, else the ones its globs name', () => {
    expect(ruleFormats({ files: ['a/*'], schema: 's', format: 'jsonc' })).toEqual(['jsonc']);
    expect(ruleFormats({ files: ['a.json', 'b.{yml,md}'], schema: 's' })).toEqual(['json', 'yaml', 'frontmatter']);
  });

  test('a json-only config needs ajv alone', () => {
    expect(neededLibraries([{ files: ['a.json'], schema: 's.json' }, { files: ['x/*'], schema: 's.json', format: 'json' }])).toEqual(['ajv']);
    expect(neededLibraries([{ files: ['a.json'], schema: 's.json' }, { files: ['b.md'], schema: 's.json' }])).toEqual(['ajv', 'yaml']);
    expect(neededLibraries([{ files: ['a.jsonc'], schema: 's.json' }])).toEqual(['ajv', 'jsonc-parser']);
  });
});

describe('at config load', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-schema-rules-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('an unknown bundled id stops the load, naming the config file', async () => {
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ schemas: [{ files: ['a.json'], schema: 'checkride:nope' }] }));
    expect(() => loadConfig(dir)).toThrow('invalid checkride.config.json: schemas[0].schema "checkride:nope" is no bundled schema: the bundled schemas are checkride:agent-skill and checkride:checkride-config');
  });

  test("so does an extension it can't place, in a named suite's config and in a defaults file", async () => {
    const config = JSON.stringify({ schemas: [{ files: ['labels/*.toml'], schema: 's.json' }] });
    await writeFile(join(dir, 'checkride.evals.config.json'), config);
    await writeFile(join(dir, 'defaults.json'), config);
    expect(() => loadConfig(dir, undefined, 'checkride.evals.config.json')).toThrow(/invalid checkride\.evals\.config\.json: schemas\[0\]\.files has "labels\/\*\.toml"/);
    expect(() => loadDefaultsFile(join(dir, 'defaults.json'), dir)).toThrow(/schemas\[0\]\.files has "labels\/\*\.toml"/);
  });

  test('a URL is still V8\'s error, ahead of these', async () => {
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ schemas: [{ files: ['a.toml'], schema: 'https://example.com/s.json' }] }));
    expect(() => loadConfig(dir)).toThrow(/is a URL, and a check never fetches/);
  });
});

import { join } from 'node:path';

import { beforeAll, describe, expect, test } from 'vitest';

import { CHECKOUT } from '../../../test/helpers/schema-libraries.js';
import type { Compiled, SchemaSource } from '../compile.js';
import { compileSchema } from '../compile.js';
import { loadLibraries } from '../libraries.js';
import type { AjvLibrary, AjvValidate } from '../library-types.js';

let ajv: AjvLibrary;

beforeAll(async () => {
  const loaded = loadLibraries(['ajv'], { repo: CHECKOUT, pm: 'pnpm' });
  if (!('libraries' in loaded)) throw new Error(loaded.refusal);
  ajv = loaded.libraries.ajv;
});

const REPO = '/repo';

/** Compile `schema` as the file `schemas/main.json` of a repo whose other files are `files`, by repo-relative path. */
function compile(schema: unknown, files: Record<string, unknown> = {}, path: string | null = join(REPO, 'schemas/main.json')): Compiled {
  const source: SchemaSource = { label: 'schemas/main.json', text: typeof schema === 'string' ? schema : JSON.stringify(schema), path };
  return compileSchema(source, {
    ajv,
    read: (file) => {
      const rel = file.slice(REPO.length + 1);
      return Object.hasOwn(files, rel) ? JSON.stringify(files[rel]) : null;
    },
    nameOf: (file) => file.slice(REPO.length + 1),
  });
}

/** The pointer of each `$ref` to a URL that a compile of `schema` reports, in the order it met them. */
function at(schema: object): string[] {
  const compiled = compile(schema);
  return compiled.kind === 'remote' ? compiled.refs.map((r) => r.pointer) : [];
}

/** A compile that must have produced a validator. */
function validator(compiled: Compiled): AjvValidate {
  if (compiled.kind !== 'ready') throw new Error(`expected a validator, got ${JSON.stringify(compiled)}`);
  return compiled.validate;
}

/** A compile that must have been refused. */
function refusal(compiled: Compiled): string {
  if (compiled.kind !== 'refused') throw new Error(`expected a refusal, got ${compiled.kind}`);
  return compiled.refusal;
}

describe('the draft a schema is read as', () => {
  // `prefixItems` is draft 2020-12's word for a tuple, and `items` as an array is draft-07's.
  const tuple2020 = { type: 'array', prefixItems: [{ type: 'string' }], items: false };
  const tuple07 = { type: 'array', items: [{ type: 'string' }], additionalItems: false };

  test('2020-12 when it names none', () => {
    const validate = validator(compile(tuple2020));
    expect(validate(['a'])).toBe(true);
    expect(validate(['a', 'b'])).toBe(false);
    expect(validate([1])).toBe(false);
  });

  test('2020-12 by its $schema', () => {
    const validate = validator(compile({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...tuple2020 }));
    expect(validate(['a', 'b'])).toBe(false);
  });

  test('draft-07 by its $schema, with or without the trailing #', () => {
    for (const $schema of ['http://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-07/schema']) {
      const validate = validator(compile({ $schema, ...tuple07 }));
      expect(validate(['a'])).toBe(true);
      expect(validate(['a', 'b'])).toBe(false);
    }
  });

  test('any other draft is refused, naming the schema and the two it reads', () => {
    const said = refusal(compile({ $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' }));
    expect(said).toBe('checkride: the schema `schemas/main.json` declares $schema "http://json-schema.org/draft-04/schema#", and the schema slot reads draft 2020-12 and draft-07.\n');
    expect(refusal(compile({ $schema: 7 }))).toMatch(/declares \$schema 7/);
  });
});

describe('what it asserts', () => {
  test('format keywords are not asserted', () => {
    const validate = validator(compile({ type: 'string', format: 'email' }));
    expect(validate('not an email')).toBe(true);
    expect(validate(3)).toBe(false);
  });

  test('every error of a value is reported, not the first alone', () => {
    const validate = validator(compile({ type: 'object', required: ['a', 'b'], properties: { c: { type: 'number' } } }));
    expect(validate({ c: 'x' })).toBe(false);
    expect(validate.errors?.map((e) => `${e.instancePath}:${e.keyword}`).toSorted()).toEqual(['/c:type', ':required', ':required']);
  });

  test('a keyword it does not know is no error', () => {
    expect(validator(compile({ type: 'string', 'x-note': 'why' }))('a')).toBe(true);
  });
});

describe('$ref', () => {
  test('a reference within the file resolves', () => {
    const validate = validator(compile({ $defs: { id: { type: 'integer' } }, properties: { id: { $ref: '#/$defs/id' } } }));
    expect(validate({ id: 1 })).toBe(true);
    expect(validate({ id: 'x' })).toBe(false);
  });

  test('a reference to a sibling file by relative path resolves, and so does one that file makes', () => {
    const files = {
      'schemas/defs/common.json': { $defs: { name: { $ref: '../name.json' } } },
      'schemas/name.json': { type: 'string', minLength: 2 },
    };
    const validate = validator(compile({ type: 'object', properties: { name: { $ref: 'defs/common.json#/$defs/name' } } }, files));
    expect(validate({ name: 'ok' })).toBe(true);
    expect(validate({ name: 'x' })).toBe(false);
    expect(validate.errors?.[0]).toMatchObject({ instancePath: '/name', keyword: 'minLength' });
  });

  test('a relative reference resolves from a schema with an $id of its own, too', () => {
    const files = { 'schemas/name.json': { type: 'string' } };
    const validate = validator(compile({ $id: 'https://example.com/schemas/main.json', properties: { name: { $ref: 'name.json' } } }, files));
    expect(validate({ name: 1 })).toBe(false);
    expect(validate({ name: 'a' })).toBe(true);
  });

  test('two references to one sibling read it once', () => {
    const files = { 'schemas/name.json': { type: 'string' } };
    const validate = validator(compile({ properties: { a: { $ref: 'name.json' }, b: { $ref: './name.json' } } }, files));
    expect(validate({ a: 'x', b: 2 })).toBe(false);
  });

  test('a reference to a URL is a finding on the schema file, with the pointer to it', () => {
    const compiled = compile({ properties: { a: { $ref: 'https://example.com/a.json#/x' }, b: { $ref: '#/properties/a' } } });
    expect(compiled).toEqual({ kind: 'remote', refs: [{ file: 'schemas/main.json', pointer: '/properties/a/$ref', ref: 'https://example.com/a.json#/x' }] });
  });

  test('a URL in a sibling file is a finding on that file', () => {
    const files = { 'schemas/defs.json': { $defs: { a: { $ref: 'http://example.com/a.json' } } } };
    const compiled = compile({ $ref: 'defs.json#/$defs/a' }, files);
    expect(compiled).toEqual({ kind: 'remote', refs: [{ file: 'schemas/defs.json', pointer: '/$defs/a/$ref', ref: 'http://example.com/a.json' }] });
  });

  test("a reference to the schema's own $id is no URL to fetch", () => {
    const validate = validator(compile({ $id: 'https://example.com/tree.json', type: 'object', properties: { child: { $ref: 'https://example.com/tree.json' } } }));
    expect(validate({ child: { child: {} } })).toBe(true);
    expect(validate({ child: 1 })).toBe(false);
  });

  test('a $ref inside data is not a reference: an enum, a const, a default, an example, an annotation, or a dependencies list', () => {
    const url = { $ref: 'https://example.com/never-fetched.json' };
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      properties: {
        link: { enum: [url], default: url, examples: [url], const: url },
        $ref: { type: 'string' },
        default: { $ref: '#/definitions/n' },
        examples: { $ref: '#/definitions/n' },
      },
      definitions: { n: { type: 'number' } },
      dependencies: { link: ['$ref', 'default'] },
      'x-source': url,
      required: ['$ref'],
    };
    const validate = validator(compile(schema));
    expect(validate({ $ref: 'x', default: 1, examples: 2 })).toBe(true);
    expect(validate({ $ref: 'x', default: 'x' })).toBe(false);
    expect(validate({ $ref: 'x', examples: 'x' })).toBe(false);
  });

  test('a $ref is read everywhere a schema can sit: lists, maps, conditionals, and the schema half of dependencies', () => {
    const url = { $ref: 'https://example.com/a.json' };
    expect(at({ allOf: [{}, url], items: url, not: url })).toEqual(['/allOf/1/$ref', '/items/$ref', '/not/$ref']);
    expect(at(Object.fromEntries(['prefixItems', 'if', 'then', 'else', 'contains'].map((key) => [key, key === 'prefixItems' ? [url] : url])))).toEqual(['/prefixItems/0/$ref', '/if/$ref', '/then/$ref', '/else/$ref', '/contains/$ref']);
    expect(at({ patternProperties: { '^a/b~': url }, additionalProperties: url, propertyNames: url })).toEqual(['/patternProperties/^a~1b~0/$ref', '/additionalProperties/$ref', '/propertyNames/$ref']);
    expect(at({ $schema: 'http://json-schema.org/draft-07/schema#', dependencies: { a: url, b: ['a'] }, items: [url] })).toEqual(['/dependencies/a/$ref', '/items/0/$ref']);
    expect(at({ $defs: { a: { properties: { b: url } } }, dependentSchemas: { c: url }, unevaluatedProperties: url })).toEqual(['/$defs/a/properties/b/$ref', '/dependentSchemas/c/$ref', '/unevaluatedProperties/$ref']);
  });

  test("the draft's own meta-schema is no URL to fetch: ajv holds it", () => {
    const draft07 = validator(compile({ $schema: 'http://json-schema.org/draft-07/schema#', properties: { schema: { $ref: 'http://json-schema.org/draft-07/schema#' } } }));
    expect(draft07({ schema: { type: 'string' } })).toBe(true);
    expect(draft07({ schema: { type: 'nope' } })).toBe(false);
    const draft2020 = validator(compile({ properties: { schema: { $ref: 'https://json-schema.org/draft/2020-12/schema' } } }));
    expect(draft2020({ schema: { type: 'string' } })).toBe(true);
    expect(draft2020({ schema: { type: 12 } })).toBe(false);
  });

  test("another draft's meta-schema is a URL like any other: this instance doesn't hold it", () => {
    const compiled = compile({ $schema: 'http://json-schema.org/draft-07/schema#', properties: { s: { $ref: 'https://json-schema.org/draft/2020-12/schema' } } });
    expect(compiled).toEqual({ kind: 'remote', refs: [{ file: 'schemas/main.json', pointer: '/properties/s/$ref', ref: 'https://json-schema.org/draft/2020-12/schema' }] });
  });

  test("a relative reference to an $id the file itself declares is within the file, and no sibling is read", () => {
    const schema = { $defs: { item: { $id: 'item.json', type: 'integer' } }, type: 'array', items: { $ref: 'item.json' } };
    const validate = validator(compile(schema));
    expect(validate([1, 2])).toBe(true);
    expect(validate([1, 'x'])).toBe(false);
  });

  test('so is one under a schema with an $id of its own, by relative path or by the URL it resolves to', () => {
    for (const ref of ['item.json', 'https://example.com/schemas/item.json', './item.json#/properties/n']) {
      const schema = {
        $id: 'https://example.com/schemas/list.json',
        $defs: { item: { $id: 'item.json', type: 'object', properties: { n: { type: 'integer' } } } },
        properties: { first: { $ref: ref } },
      };
      const validate = validator(compile(schema));
      expect(validate({ first: ref.endsWith('/n') ? 1 : { n: 1 } }), ref).toBe(true);
      expect(validate({ first: ref.endsWith('/n') ? 'x' : { n: 'x' } }), ref).toBe(false);
    }
  });

  test('a reference to the file by its own name is the file', () => {
    const validate = validator(compile({ type: 'object', properties: { child: { $ref: 'main.json' } } }));
    expect(validate({ child: { child: {} } })).toBe(true);
    expect(validate({ child: 1 })).toBe(false);
  });

  test('a reference whose percent-encoding is malformed is a refusal naming the schema and the reference, never a throw', () => {
    expect(refusal(compile({ $ref: '100%.json' }))).toBe('checkride: the schema `schemas/main.json` refers to `100%.json`, which is no path: its percent-encoding is malformed.\n');
  });

  test('a percent-encoded name is read as the file it names', () => {
    const validate = validator(compile({ $ref: 'my%20defs.json' }, { 'schemas/my defs.json': { type: 'string' } }));
    expect(validate('a')).toBe(true);
    expect(validate(1)).toBe(false);
  });

  test('a sibling that cannot be read is a refusal naming both files', () => {
    expect(refusal(compile({ $ref: 'gone.json' }))).toBe("checkride: the schema `schemas/main.json` refers to `gone.json`, and schemas/gone.json can't be read.\n");
  });

  test('a bundled schema has no file to read a sibling beside', () => {
    expect(refusal(compile({ $ref: 'other.json' }, {}, null))).toMatch(/refers to `other\.json`, which names no file beside it/);
  });

  test('a reference nothing in the file defines is a refusal', () => {
    expect(refusal(compile({ $ref: '#/$defs/nope' }))).toMatch(/^checkride: the schema `schemas\/main\.json` is not a valid schema: .*nope/);
  });
});

describe('a schema that cannot be used', () => {
  test('text that is not JSON', () => {
    expect(refusal(compile('{ "type": '))).toMatch(/^checkride: the schema `schemas\/main\.json` is not valid JSON: /);
  });

  test('JSON that is not an object', () => {
    expect(refusal(compile('[1, 2]'))).toBe('checkride: the schema `schemas/main.json` is not a JSON Schema: it must be an object.\n');
  });

  test('an object that is not a valid schema', () => {
    expect(refusal(compile({ type: 'nope' }))).toMatch(/^checkride: the schema `schemas\/main\.json` is not a valid schema: schema is invalid/);
  });

  test('a sibling that is not a valid schema is named, not the file that refers to it', () => {
    const said = refusal(compile({ $ref: 'bad.json' }, { 'schemas/bad.json': { type: 12 } }));
    expect(said).toMatch(/^checkride: the schema `schemas\/bad\.json` is not a valid schema/);
  });
});

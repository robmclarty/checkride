import { beforeAll, describe, expect, test } from 'vitest';

import { CHECKOUT } from '../../../test/helpers/schema-libraries.js';
import type { Parsed } from '../formats.js';
import { formatOfPath, isSchemaFormat, parseAs } from '../formats.js';
import { loadLibraries } from '../libraries.js';
import type { SchemaLibraries } from '../library-types.js';

let libraries: SchemaLibraries;

beforeAll(async () => {
  const loaded = loadLibraries(['ajv', 'yaml', 'jsonc-parser'], { repo: CHECKOUT, pm: 'pnpm' });
  if (!('libraries' in loaded)) throw new Error(loaded.refusal);
  libraries = loaded.libraries;
});

/** A parse that must have succeeded. */
function value(parsed: Parsed): unknown {
  if (!parsed.ok) throw new Error(`expected a value, got: ${parsed.message}`);
  return parsed.value;
}

/** A parse that must have failed. */
function failure(parsed: Parsed): { keyword: string; message: string; line?: number } {
  if (parsed.ok) throw new Error('expected a parse error');
  return parsed;
}

describe('the format an extension names', () => {
  test('.json, .jsonc, .yaml and .yml, and .md and .mdx as frontmatter, in any case', () => {
    expect(formatOfPath('a/b.json')).toBe('json');
    expect(formatOfPath('tsconfig.jsonc')).toBe('jsonc');
    expect(formatOfPath('ci.yaml')).toBe('yaml');
    expect(formatOfPath('.github/workflows/ci.yml')).toBe('yaml');
    expect(formatOfPath('skills/pdf/SKILL.md')).toBe('frontmatter');
    expect(formatOfPath('docs/page.mdx')).toBe('frontmatter');
    expect(formatOfPath('A.JSON')).toBe('json');
  });

  test("null for an extension it can't place, and for none", () => {
    expect(formatOfPath('config.toml')).toBeNull();
    expect(formatOfPath('Makefile')).toBeNull();
    expect(formatOfPath('.json')).toBeNull();
  });

  test('a format is one of the four', () => {
    expect(['json', 'jsonc', 'yaml', 'frontmatter'].every(isSchemaFormat)).toBe(true);
    expect(isSchemaFormat('toml')).toBe(false);
    expect(isSchemaFormat(undefined)).toBe(false);
  });
});

describe('json', () => {
  test('parses strict JSON, with no line for a pointer', () => {
    const parsed = parseAs('json', '{ "a": [1, 2] }', {});
    expect(value(parsed)).toEqual({ a: [1, 2] });
    expect(parsed.ok && parsed.lineOf('/a/0')).toBeUndefined();
  });

  test('a trailing comma is an error, with the line it sits on', () => {
    const error = failure(parseAs('json', '{\n  "a": 1,\n}\n', {}));
    expect(error.keyword).toBe('parse');
    expect(error.line).toBe(3);
  });

  test('a comment is an error', () => {
    expect(failure(parseAs('json', '// note\n{ "a": 1 }', {})).keyword).toBe('parse');
  });

  test('it needs neither parser library', () => {
    expect(value(parseAs('json', '1', {}))).toBe(1);
  });
});

describe('jsonc', () => {
  test('allows comments and a trailing comma', () => {
    const text = '{\n  // why\n  "a": 1, /* and */\n  "b": [true,],\n}\n';
    expect(value(parseAs('jsonc', text, libraries))).toEqual({ a: 1, b: [true] });
  });

  test('a pointer has the line its value sits on, array items included', () => {
    const parsed = parseAs('jsonc', '{\n  // why\n  "a": 1,\n  "b": [\n    true,\n    { "c~/d": 2 }\n  ]\n}\n', libraries);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.lineOf('')).toBe(1);
    expect(parsed.lineOf('/a')).toBe(3);
    expect(parsed.lineOf('/b/0')).toBe(5);
    expect(parsed.lineOf('/b/1/c~0~1d')).toBe(6);
    expect(parsed.lineOf('/nope')).toBeUndefined();
  });

  test('the tree that places a pointer is parsed once for a file, on the first pointer asked, and never for a file with no error', () => {
    const jsonc = libraries.jsonc;
    if (jsonc === undefined) throw new Error('jsonc-parser is not loaded');
    let trees = 0;
    const counting = { ...jsonc, parseTree: (...args: Parameters<typeof jsonc.parseTree>) => { trees += 1; return jsonc.parseTree(...args); } };
    const parsed = parseAs('jsonc', '{\n  "a": 1,\n  "b": [2, 3],\n}\n', { jsonc: counting });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(trees).toBe(0);
    expect([parsed.lineOf('/a'), parsed.lineOf('/b/1'), parsed.lineOf(''), parsed.lineOf('/nope')]).toEqual([2, 3, 1, undefined]);
    expect(trees).toBe(1);
  });

  test('broken JSON is still an error, with its line', () => {
    const error = failure(parseAs('jsonc', '{\n  "a": 1\n  "b": 2\n}\n', libraries));
    expect(error.keyword).toBe('parse');
    expect(error.line).toBe(3);
    expect(error.message).not.toBe('');
  });

  test('an empty file is an error', () => {
    expect(failure(parseAs('jsonc', '', libraries)).keyword).toBe('parse');
  });

  test('reading one without jsonc-parser loaded is a bug, and says so', () => {
    expect(() => parseAs('jsonc', '{}', {})).toThrow(/without loading jsonc-parser/);
  });
});

describe('yaml', () => {
  test('reads the YAML 1.2 core schema: yes and no are strings, and a leading zero is no octal', () => {
    expect(value(parseAs('yaml', 'on: yes\noff: no\nn: 012\nt: true\nd: 2026-01-02\n', libraries))).toEqual({ on: 'yes', off: 'no', n: 12, t: true, d: '2026-01-02' });
  });

  test('a duplicate key is an error, with its line', () => {
    const error = failure(parseAs('yaml', 'a: 1\nb: 2\na: 3\n', libraries));
    expect(error.keyword).toBe('parse');
    expect(error.message).toBe('Map keys must be unique');
    expect(error.line).toBe(3);
  });

  test('broken YAML is an error', () => {
    expect(failure(parseAs('yaml', 'a: [1, 2\nb: 3\n', libraries)).keyword).toBe('parse');
  });

  test('a pointer has the line its value sits on', () => {
    const parsed = parseAs('yaml', 'name: x\njobs:\n  build:\n    steps:\n      - run: a\n      - run: b\n', libraries);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.lineOf('')).toBe(1);
    expect(parsed.lineOf('/name')).toBe(1);
    expect(parsed.lineOf('/jobs/build/steps/1/run')).toBe(6);
    expect(parsed.lineOf('/jobs/nope')).toBeUndefined();
  });

  test('reading one without yaml loaded is a bug, and says so', () => {
    expect(() => parseAs('yaml', 'a: 1', {})).toThrow(/without loading yaml/);
    expect(() => parseAs('frontmatter', '---\n---\n', {})).toThrow(/without loading yaml/);
  });
});

describe('frontmatter', () => {
  test('reads the YAML between the first line and the next line that is ---', () => {
    const text = '---\nname: pdf\ndescription: Reads PDFs.\n---\n# Title\n\n---\n\nbody: not this\n';
    expect(value(parseAs('frontmatter', text, libraries))).toEqual({ name: 'pdf', description: 'Reads PDFs.' });
  });

  test('lines are the file\'s, one below the block\'s own', () => {
    const parsed = parseAs('frontmatter', '---\nname: pdf\ndescription: x\n---\n', libraries);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.lineOf('/name')).toBe(2);
    expect(parsed.lineOf('/description')).toBe(3);
  });

  test('a file that does not begin with --- has no block, which is an error', () => {
    for (const text of ['# Title\n\n---\nname: x\n---\n', '\n---\nname: x\n---\n', ' ---\nname: x\n---\n', '']) {
      const error = failure(parseAs('frontmatter', text, libraries));
      expect(error.keyword).toBe('frontmatter');
      expect(error.message).toMatch(/no frontmatter block/);
      expect(error.line).toBe(1);
    }
  });

  test('a block that never closes is an error: a longer or indented line is no fence', () => {
    for (const text of ['---\nname: x\n', '---\nname: x\n----\n', '---\nname: x\n ---\n']) {
      const error = failure(parseAs('frontmatter', text, libraries));
      expect(error.keyword).toBe('frontmatter');
      expect(error.message).toMatch(/never closes/);
    }
  });

  test('CRLF line endings read the same', () => {
    expect(value(parseAs('frontmatter', '---\r\nname: pdf\r\n---\r\nbody\r\n', libraries))).toEqual({ name: 'pdf' });
  });

  test('a YAML error inside the block names the file\'s line', () => {
    const error = failure(parseAs('frontmatter', '---\nname: a\nname: b\n---\n', libraries));
    expect(error.keyword).toBe('parse');
    expect(error.line).toBe(3);
  });

  test('an empty block is no value at all', () => {
    expect(value(parseAs('frontmatter', '---\n---\nbody\n', libraries))).toBeNull();
  });
});

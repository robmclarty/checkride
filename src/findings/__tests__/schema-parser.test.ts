import { describe, expect, test } from 'vitest';

import { fingerprint, printedByKey } from '../../baseline/index.js';
import { isParseable, parseFindings } from '../api.js';
import { baselineParserFor, parserFor } from '../registry.js';

/** A report as the `schema` built-in writes it, with `errors`. */
const report = (errors: readonly unknown[]): string => `${JSON.stringify({ rules: [{ schema: 'checkride:agent-skill', files: 3 }], errors }, null, 2)}\n`;

const PATTERN = { file: 'skills/pdf/SKILL.md', rule: 0, instancePath: '/name', keyword: 'pattern', message: 'must match pattern "^[a-z0-9]+(-[a-z0-9]+)*$"', line: 2 };
/** The one key a report with the one `error` fingerprints to. */
const key = (error: object): string => [...(fingerprint('schema', report([error])) ?? [])][0] ?? '';

/** A `required` error at a skill's root: the property it misses as its `param`, when it has one, under `message`. */
const missing = (param: string | undefined, message = `must have required property '${param ?? ''}'`): object => ({
  file: 'skills/pdf/SKILL.md',
  rule: 0,
  instancePath: '',
  keyword: 'required',
  message,
  ...(param === undefined ? {} : { param }),
});

const PARSE = { file: 'config/app.json', rule: 1, instancePath: '', keyword: 'parse', message: 'Unexpected token } in JSON at position 12' };

describe('the schema parser', () => {
  test('is registered under the adapter, reads the artifact, and keys the baseline', () => {
    expect(isParseable('schema')).toBe(true);
    expect(parserFor('schema')?.stream).toBe('artifact');
    expect(baselineParserFor('schema')).toBe(parserFor('schema'));
  });

  test('each error is a finding: its keyword the rule, its pointer opening the message, its line when known', () => {
    expect(parseFindings('schema', report([PATTERN, PARSE]))).toEqual([
      { adapter: 'schema', slot: 'schema', file: 'skills/pdf/SKILL.md', line: 2, rule: 'pattern', message: '/name must match pattern "^[a-z0-9]+(-[a-z0-9]+)*$"', gates: true },
      { adapter: 'schema', slot: 'schema', file: 'config/app.json', rule: 'parse', message: 'Unexpected token } in JSON at position 12', gates: true },
    ]);
  });

  test('a clean report is no findings, and a payload with no errors array is not a report', () => {
    expect(parseFindings('schema', report([]))).toEqual([]);
    expect(parseFindings('schema', '{ "rules": [] }')).toBeNull();
    expect(parseFindings('schema', '{"ok":true}')).toBeNull();
    expect(parseFindings('schema', 'not json')).toBeNull();
    expect(parseFindings('schema', '')).toBeNull();
  });

  test('an error with no file or no keyword is passed over, and the rest are read', () => {
    const errors = [{ ...PATTERN, file: '' }, { ...PATTERN, keyword: undefined }, 'nope', PARSE];
    expect(parseFindings('schema', report(errors))?.map((f) => f.file)).toEqual(['config/app.json']);
  });

  test('the key is the file, the keyword and the pointer', () => {
    expect([...(fingerprint('schema', report([PATTERN, PARSE])) ?? [])]).toEqual(['skills/pdf/SKILL.md:pattern:/name', 'config/app.json:parse:']);
  });

  test('the key holds when the message changes, or the line moves', () => {
    const reworded = { ...PATTERN, message: 'must match pattern "^[a-z]+$"', line: 9 };
    const reparsed = { ...PARSE, message: 'Expected double-quoted property name in JSON at position 12 (line 3 column 1)', line: 3 };
    expect(fingerprint('schema', report([reworded, reparsed]))).toEqual(fingerprint('schema', report([PATTERN, PARSE])));
  });

  test('the key changes with the file, the keyword or the pointer', () => {
    expect(key({ ...PATTERN, file: 'skills/doc/SKILL.md' })).not.toBe(key(PATTERN));
    expect(key({ ...PATTERN, keyword: 'maxLength' })).not.toBe(key(PATTERN));
    expect(key({ ...PATTERN, instancePath: '/description' })).not.toBe(key(PATTERN));
  });

  test('an error that names what is at fault carries it into the key, read from param and never scraped from the message', () => {
    expect(key(missing('name'))).toBe('skills/pdf/SKILL.md:required::name');
    // The same finding under another wording of the message keeps its key.
    expect(key(missing('name', 'is missing the property "name"'))).toBe('skills/pdf/SKILL.md:required::name');
    // A report with no param keys as it did, message or no.
    expect(key(missing(undefined, "must have required property 'name'"))).toBe('skills/pdf/SKILL.md:required:');
    expect(key({ file: 'a.json', rule: 0, instancePath: '/x', keyword: 'additionalProperties', message: 'x', param: 'extra' })).toBe('a.json:additionalProperties:/x:extra');
  });

  test('a baselined missing name is not a missing description: the swap is a new key, and a gone one', () => {
    const before = fingerprint('schema', report([missing('name')]));
    const after = fingerprint('schema', report([missing('description')]));
    expect(before).toEqual(new Set(['skills/pdf/SKILL.md:required::name']));
    expect(after).toEqual(new Set(['skills/pdf/SKILL.md:required::description']));
    // Both missing at once are two keys, where without the param they were one key counted twice.
    expect(fingerprint('schema', report([missing('name'), missing('description')]))?.size).toBe(2);
  });

  test('since the key holds no message, a reader is shown the finding itself', () => {
    expect(printedByKey('schema', report([PATTERN]))?.get('skills/pdf/SKILL.md:pattern:/name')).toEqual([
      'skills/pdf/SKILL.md: /name must match pattern "^[a-z0-9]+(-[a-z0-9]+)*$" [pattern]',
    ]);
  });
});

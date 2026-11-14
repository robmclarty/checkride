/**
 * What an `include` list and an included file hold (D9, D34), and how an
 * included file's targets join the repo's as one flat set. These read no
 * file: `src/config.ts` reads each one, and `config-targets.test.ts` covers
 * the two together.
 */

import { describe, expect, test } from 'vitest';

import { includedDir, includedFileProblem, includeListProblem, joinedTargets } from '../include.js';

const FILE = 'services/checkride.config.json';

describe('an include list', () => {
  test('is an array of directories below the file that lists it', () => {
    expect(includeListProblem(['services', './tools/', 'a/b'], 'checkride.config.json')).toBeNull();
    expect(includeListProblem([], 'checkride.config.json')).toBeNull();
  });

  test.each([
    ['services', 'include (in checkride.config.json) must be an array of directories, each holding a config file to include (got "services")'],
    [[7], "include (in checkride.config.json) holds 7, which isn't a directory's path"],
    [[''], 'include (in checkride.config.json) holds "", which isn\'t a directory\'s path'],
    [['../other'], 'include (in checkride.config.json) holds "../other", which leaves the directory of the file that lists it: give a directory below it'],
    [['a/../../b'], 'include (in checkride.config.json) holds "a/../../b", which leaves the directory'],
    [['/etc'], 'include (in checkride.config.json) holds "/etc", which leaves the directory'],
    [['C:\\x'], 'include (in checkride.config.json) holds "C:\\\\x", which leaves the directory'],
    [['\\\\server\\share'], 'which leaves the directory'],
  ])('%j is refused, naming the file', (include, reason) => {
    expect(includeListProblem(include, 'checkride.config.json')).toContain(reason);
  });

  test("an entry names a directory relative to the including file's own", () => {
    expect(includedDir('.', 'services')).toBe('services');
    expect(includedDir('.', './services/')).toBe('services');
    expect(includedDir('services', 'billing')).toBe('services/billing');
    expect(includedDir('services', '.')).toBe('services');
    expect(includedDir('.', '.')).toBe('.');
  });
});

describe('an included file (D34)', () => {
  test('holds targets, include, note and $schema', () => {
    expect(includedFileProblem({ $schema: 's', note: 'n', targets: {}, include: ['x'] }, FILE)).toBeNull();
    expect(includedFileProblem({ include: ['x'] }, FILE)).toBeNull();
  });

  test.each(['checks', 'packs', 'schemas', 'changedBase', 'extends', 'timeout', 'gate', 'requirePins', 'unclaimed', 'lang', 'typo'])('%s is refused, naming the file', (key) => {
    expect(includedFileProblem({ targets: {}, [key]: {} }, FILE)).toBe(
      `${FILE} sets ${key}, which an included file can't hold: it holds targets, include, note and $schema, and ${key} belongs to the repo's own config`,
    );
  });

  test('its targets are an object, and it declares or includes something', () => {
    expect(includedFileProblem({ targets: [] }, FILE)).toBe(`targets must be an object of named targets (got []) (in ${FILE})`);
    expect(includedFileProblem({ note: 'empty' }, FILE)).toBe(`${FILE} is included, and declares no targets and includes no file that could`);
  });
});

describe("included files' targets join the repo's as one flat set (D9)", () => {
  const top = { file: 'checkride.config.json', dir: '.', targets: { web: { lang: 'ts', root: 'web' } } };
  const services = { file: FILE, dir: 'services', targets: { api: { lang: 'go', root: 'api' }, billing: { root: './billing/', local: true } } };

  test("each included file's roots are relative to itself, and the order is file order", () => {
    const joined = joinedTargets([top, services]);
    if (typeof joined === 'string') throw new Error(joined);
    expect(joined.targets).toEqual({
      web: { lang: 'ts', root: 'web' },
      api: { lang: 'go', root: 'services/api' },
      billing: { root: 'services/billing', local: true },
    });
    expect(Object.keys(joined.targets)).toEqual(['web', 'api', 'billing']);
    expect([...joined.declaredIn]).toEqual([['web', 'checkride.config.json'], ['api', FILE], ['billing', FILE]]);
  });

  test('a root of . is the included file\'s own directory', () => {
    const joined = joinedTargets([{ file: FILE, dir: 'services', targets: { all: { lang: 'go', root: '.' } } }]);
    expect(joined).toMatchObject({ targets: { all: { root: 'services' } } });
  });

  test('a name two files declare names both', () => {
    const again = { file: 'tools/checkride.config.json', dir: 'tools', targets: { api: { lang: 'go', root: 'api' } } };
    expect(joinedTargets([top, services, again])).toBe(
      `target 'api' is declared twice, in ${FILE} and in tools/checkride.config.json: target names are one flat set across every included file`,
    );
    expect(joinedTargets([top, { ...services, targets: { web: { lang: 'go', root: 'web' } } }])).toContain(`in checkride.config.json and in ${FILE}`);
  });

  test.each(['../web', '/abs', 'a/../../b'])('a root that leaves its file\'s directory is refused: %s', (root) => {
    expect(joinedTargets([{ file: FILE, dir: 'services', targets: { api: { lang: 'go', root } } }])).toBe(
      `targets.api.root ${JSON.stringify(root)} leaves the directory of the file that declares it: give a directory relative to ${FILE} (in ${FILE})`,
    );
  });

  test('an entry that is no target passes through, for the target rules to name', () => {
    const joined = joinedTargets([{ file: FILE, dir: 'services', targets: { api: 'go', odd: { lang: 'go', root: 7 }, none: { lang: 'go' } } }]);
    expect(joined).toMatchObject({ targets: { api: 'go', odd: { lang: 'go', root: 7 }, none: { lang: 'go' } } });
  });
});

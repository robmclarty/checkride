/**
 * R7.4 as a change to a config: a repo with targets gains one more, and a
 * repo without them names its implicit target, takes the top-level entries
 * for target-scope slots into it, and renames its baseline entries.
 */

import { describe, expect, test } from 'vitest';

import { addTarget } from '../add.js';

const rules = { rootName: 'app', implicitPack: 'ts', targetSlots: new Set(['types', 'lint', 'test']) };

describe('addTarget', () => {
  test('converts an implicit repo: the implicit target is named, takes its slots’ entries, and its baseline entries follow', () => {
    const raw = { $schema: 'x', extends: './base.json', checks: { lint: 'oxlint', types: { timeout: 30 }, links: false, licenses: { command: 'node' } } };
    const change = addTarget(raw, { name: 'scripts', lang: 'bash', root: 'scripts', checks: { lint: 'shellcheck' } }, rules);
    expect(change.config).toEqual({
      $schema: 'x',
      extends: './base.json',
      targets: {
        app: { lang: 'ts', root: '.', checks: { lint: 'oxlint', types: { timeout: 30 } } },
        scripts: { lang: 'bash', root: 'scripts', checks: { lint: 'shellcheck' } },
      },
      checks: { links: false, licenses: { command: 'node' } },
    });
    expect(Object.keys(change.config)).toEqual(['$schema', 'extends', 'targets', 'checks']);
    expect([...change.renames]).toEqual([['types', 'app:types'], ['lint', 'app:lint'], ['test', 'app:test']]);
    expect(change.changes).toEqual([
      "targets.app: the repo's implicit ts target, named and rooted at .",
      'checks.lint moved to targets.app.checks.lint',
      'checks.types moved to targets.app.checks.types',
      'targets.scripts: a bash target rooted at scripts',
      'targets.scripts.checks.lint: "shellcheck"',
    ]);
  });

  test('a converted repo with nothing to lift drops an emptied checks block and writes no empty one', () => {
    const change = addTarget({ checks: { lint: false } }, { name: 'scripts', lang: 'bash', root: 'scripts' }, { ...rules, rootName: 'web' });
    expect(change.config).toEqual({
      targets: { web: { lang: 'ts', root: '.', checks: { lint: false } }, scripts: { lang: 'bash', root: 'scripts' } },
    });
    expect(addTarget({}, { name: 's', lang: 'bash', root: 's', checks: {} }, rules).config).toEqual({
      targets: { app: { lang: 'ts', root: '.' }, s: { lang: 'bash', root: 's' } },
    });
  });

  test('a target of the implicit pack at the root takes the implicit target over, the repo’s own entries winning', () => {
    const change = addTarget({ checks: { lint: 'eslint' } }, { name: 'web', lang: 'ts', root: '.', checks: { lint: 'oxlint', test: 'vitest' } }, rules);
    expect(change.config).toEqual({ targets: { web: { lang: 'ts', root: '.', checks: { lint: 'eslint', test: 'vitest' } } } });
    expect(change.renames.get('lint')).toBe('web:lint');
  });

  test('a repo with targets gains one, and keeps its top level as it was', () => {
    const raw = { targets: { web: { lang: 'ts', root: 'web' } }, checks: { lint: { timeout: 9 } } };
    const change = addTarget(raw, { name: 'scripts', lang: 'bash', root: 'scripts' }, rules);
    expect(change.config).toEqual({ ...raw, targets: { ...raw.targets, scripts: { lang: 'bash', root: 'scripts' } } });
    expect(change.renames.size).toBe(0);
    expect(change.changes).toEqual(['targets.scripts: a bash target rooted at scripts']);
  });

  test('a taken name is an error, including the one the implicit target takes', () => {
    expect(() => addTarget({ targets: { web: { lang: 'ts', root: 'web' } } }, { name: 'web', lang: 'bash', root: 'x' }, rules)).toThrow(
      'target add: targets.web already exists',
    );
    expect(() => addTarget({}, { name: 'app', lang: 'bash', root: 'scripts' }, rules)).toThrow(
      "target add: the repo's implicit target takes the name app; pass --root-name <name> to name it something else",
    );
  });
});

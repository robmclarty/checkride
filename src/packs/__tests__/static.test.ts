/**
 * R13.4's classification, rule by rule: an adapter marked static, with no
 * flag that needs the install, no code config under its directory and no
 * code-loading key in a config it reads, may run under `--static-only`; any
 * other gets the cause its `static-only:` reason names.
 */

import { describe, expect, test } from 'vitest';

import type { Adapter } from '../../adapters.js';
import { ADAPTERS } from '../../adapters.js';
import { PACKS } from '../index.js';
import type { StaticScope } from '../index.js';
import { staticCause } from '../index.js';

/** The registry row named `name` for `slot`. */
function row(name: string, slot?: string): Adapter {
  const found = Object.values(PACKS).flatMap((p) => p.adapters).find((a) => a.name === name && (slot === undefined || a.slot === slot));
  if (found === undefined) throw new Error(`no adapter ${name}`);
  return found;
}

/** A scope at `dir` over `files`, each with the text given, or `{}`. */
function scope(files: Record<string, string>, dir = '.'): StaticScope {
  return { dir, files: Object.keys(files), read: (path) => files[path] ?? null };
}

/** oxlint without the blessed `--type-aware`, the way a repo that runs it plain does. */
const plainOxlint: Adapter = { ...row('oxlint'), args: ['exec', 'oxlint', '--format=json'] };

describe('staticCause (R13.4)', () => {
  test('an adapter the registry doesn’t mark static never qualifies', () => {
    expect(staticCause(row('tsc'), scope({}))).toBe("tsc isn't a static check");
    expect(staticCause(row('eslint'), scope({}))).toBe("eslint isn't a static check");
    expect(staticCause({ ...row('tsc'), name: 'custom:lint' }, scope({}))).toBe("custom:lint isn't a static check");
  });

  test('the marked rows are the ones R13.4 lists, each of them pure data', () => {
    const marked = Object.values(PACKS).flatMap((p) => p.adapters.filter((a) => a.static === true).map((a) => a.name));
    expect(marked.toSorted()).toEqual(
      ['ast-grep', 'biome', 'biome-format', 'cspell', 'gofmt', 'links', 'markdownlint-cli2', 'oxlint', 'prettier', 'rumdl', 'ruff', 'ruff-format', 'shellcheck', 'shfmt', 'typos', 'unclaimed', 'vale'].toSorted(),
    );
    expect(JSON.parse(JSON.stringify(ADAPTERS))).toEqual(ADAPTERS);
  });

  test('a flag that needs the install skips it: the blessed oxlint runs with --type-aware', () => {
    expect(staticCause(row('oxlint'), scope({}))).toBe('oxlint runs with --type-aware, which needs the install');
    expect(staticCause({ ...plainOxlint, changedArgs: ['--type-aware'] }, scope({}))).toBe('oxlint runs with --type-aware, which needs the install');
    expect(staticCause(plainOxlint, scope({}))).toBeNull();
  });

  // F40
  test('.oxlintrc.json declaring jsPlugins skips lint, with the sniff’s reason; one that doesn’t, doesn’t', () => {
    expect(staticCause(plainOxlint, scope({ '.oxlintrc.json': '{\n  "jsPlugins": ["./rules/x.js"],\n  "rules": {}\n}\n' }))).toBe(
      '.oxlintrc.json sets jsPlugins, which loads code',
    );
    expect(staticCause(plainOxlint, scope({ '.oxlintrc.json': '{ "rules": { "no-jsPlugins-here": "off" } }' }))).toBeNull();
  });

  test('a code config under the check’s directory skips it, at any depth, and one outside it doesn’t', () => {
    const markdownlint = row('markdownlint-cli2');
    expect(staticCause(markdownlint, scope({ 'docs/.markdownlint.cjs': '' }))).toBe('docs/.markdownlint.cjs is code markdownlint-cli2 would run');
    expect(staticCause(markdownlint, scope({ 'web/.markdownlint.cjs': '' }, 'api'))).toBeNull();
    expect(staticCause(row('prettier'), scope({ 'web/prettier.config.mjs': '' }, 'web'))).toBe('web/prettier.config.mjs is code prettier would run');
  });

  test('a key that loads code counts only with a value that does, where the row names one', () => {
    const cspell = row('cspell');
    expect(staticCause(cspell, scope({ 'cspell.json': '{ "import": ["@cspell/dict-x/cspell-ext.json"] }' }))).toBeNull();
    expect(staticCause(cspell, scope({ 'cspell.json': '{\n  "import": [\n    "./dict.json",\n    "./words.mjs"\n  ]\n}' }))).toBe(
      'cspell.json sets import, which loads code',
    );
    expect(staticCause(cspell, scope({ 'cspell.yaml': 'import:\n  - ./dict.json\n  - ./plugin.cjs\nwords: [a]\n' }))).toBe('cspell.yaml sets import, which loads code');
    expect(staticCause(cspell, scope({ 'cspell.yaml': 'import:\n  - ./dict.json\nwords:\n  - plugin.cjs\n' }))).toBeNull();
    expect(staticCause(cspell, scope({ 'cspell.yaml': 'import: ["./plugin.cjs"]\n' }))).toBe('cspell.yaml sets import, which loads code');
    // An array that runs on ends at its bracket, so a script named under another key doesn't count.
    expect(staticCause(cspell, scope({ 'cspell.json': '{\n  "import": [\n    "./dict.json"\n  ],\n  "ignorePaths": ["dist/*.js"]\n}' }))).toBeNull();
    // A comment after the value is no part of it, and a key on the last line reads its block as empty.
    expect(staticCause(cspell, scope({ 'cspell.yaml': 'import: ./dict.json # not ./x.js\n' }))).toBeNull();
    expect(staticCause(cspell, scope({ 'cspell.yaml': 'words: [a]\nimport:' }))).toBeNull();
  });

  test('a vale style that extends script skips prose, through the styles path glob', () => {
    const vale = row('vale');
    expect(staticCause(vale, scope({ '.vale/styles/Repo/Count.yml': 'extends: script\nscript: |\n  x\n' }))).toBe(
      '.vale/styles/Repo/Count.yml sets extends, which loads code',
    );
    expect(staticCause(vale, scope({ '.vale/styles/Repo/Words.yml': 'extends: existence # a list\ntokens: [a]\n' }))).toBeNull();
    expect(staticCause(vale, scope({ 'other/Count.yml': 'extends: script\n' }))).toBeNull();
  });

  test('ast-grep’s customLanguages and markdownlint-cli2’s customRules are read from YAML and JSONC alike', () => {
    expect(staticCause(row('ast-grep'), scope({ 'sgconfig.yml': 'ruleDirs: [rules]\ncustomLanguages:\n  mojo: {}\n' }))).toBe(
      'sgconfig.yml sets customLanguages, which loads code',
    );
    expect(staticCause(row('markdownlint-cli2'), scope({ '.markdownlint-cli2.jsonc': '{ // rules\n  "customRules": ["./r.js"] }' }))).toBe(
      '.markdownlint-cli2.jsonc sets customRules, which loads code',
    );
  });

  test('a config file that can’t be read loads nothing, and the built-ins qualify', () => {
    expect(staticCause(plainOxlint, { dir: '.', files: ['.oxlintrc.json'], read: () => null })).toBeNull();
    expect(staticCause(row('links'), scope({}))).toBeNull();
    expect(staticCause(row('shellcheck'), scope({}))).toBeNull();
  });
});

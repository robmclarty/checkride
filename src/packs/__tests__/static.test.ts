/**
 * R13.4's classification, rule by rule: an adapter marked static, with no
 * flag that needs the install or loads code, no code config under its
 * directory and no code-loading key in a config it reads, may run under
 * `--static-only`; any other gets the cause its `static-only:` reason names.
 * tflint's rules are held against what tflint 0.64.0 was seen to run.
 */

// cspell:ignore mport

import { describe, expect, test } from 'vitest';

import type { Adapter } from '../../adapters.js';
import { ADAPTERS } from '../../adapters.js';
import { readResource } from '../../resources.js';
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

/** The cause a config file's code-loading key gives. */
function loads(file: string, key = 'plugin'): string {
  return `${file} sets ${key}, which loads code`;
}

describe('staticCause (R13.4)', () => {
  test('an adapter the registry doesn’t mark static never qualifies', () => {
    expect(staticCause(row('tsc'), scope({}))).toBe("tsc isn't a static check");
    expect(staticCause(row('eslint'), scope({}))).toBe("eslint isn't a static check");
    expect(staticCause({ ...row('tsc'), name: 'custom:lint' }, scope({}))).toBe("custom:lint isn't a static check");
  });

  test('the marked rows are the ones R13.4 lists, each of them pure data', () => {
    const marked = Object.values(PACKS).flatMap((p) => p.adapters.filter((a) => a.static === true).map((a) => a.name));
    expect(marked.toSorted()).toEqual(
      ['ast-grep', 'biome', 'biome-format', 'cspell', 'gofmt', 'links', 'markdownlint-cli2', 'oxlint', 'prettier', 'rumdl', 'ruff', 'ruff-format', 'shellcheck', 'shfmt', 'terraform-fmt', 'tflint', 'trivy-config', 'typos', 'unclaimed', 'vale'].toSorted(),
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

  test('a code config under the check’s directory skips it, at any depth and in any case, and one outside it doesn’t', () => {
    const markdownlint = row('markdownlint-cli2');
    expect(staticCause(markdownlint, scope({ 'docs/.markdownlint.cjs': '' }))).toBe('docs/.markdownlint.cjs is code markdownlint-cli2 would run');
    expect(staticCause(markdownlint, scope({ 'web/.markdownlint.cjs': '' }, 'api'))).toBeNull();
    expect(staticCause(row('prettier'), scope({ 'web/prettier.config.mjs': '' }, 'web'))).toBe('web/prettier.config.mjs is code prettier would run');
    // macOS opens a config by any case of its name.
    expect(staticCause(markdownlint, scope({ 'docs/.MarkdownLint.CJS': '' }))).toBe('docs/.MarkdownLint.CJS is code markdownlint-cli2 would run');
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

  test('a key or value spelled with \\u escapes counts, read both decoded and as written', () => {
    const cspell = row('cspell');
    expect(staticCause(cspell, scope({ 'cspell.json': '{ "\\u0069mport": ["./words.mjs"] }' }))).toBe('cspell.json sets import, which loads code');
    // Decoded, the escaped quote would end the string at ./a; as written, the value still ends in .mjs.
    expect(staticCause(cspell, scope({ 'cspell.json': '{ "import": ["./a\\u0022.mjs"] }' }))).toBe('cspell.json sets import, which loads code');
  });

  test('a key spelled with YAML’s \\x or \\U escapes counts, and an escape past Unicode’s last is read as written', () => {
    const prettier = row('prettier');
    expect(staticCause(prettier, scope({ '.prettierrc.yaml': '"pl\\x75gins": [./x.mjs]\n' }))).toBe(loads('.prettierrc.yaml', 'plugins'));
    expect(staticCause(prettier, scope({ '.prettierrc.yaml': '"pl\\U00000075gins": [./x.mjs]\n' }))).toBe(loads('.prettierrc.yaml', 'plugins'));
    expect(staticCause(prettier, scope({ '.prettierrc.toml': '"\\U00000070lugins" = ["./x.mjs"]\n' }))).toBe(loads('.prettierrc.toml', 'plugins'));
    expect(staticCause(prettier, scope({ '.prettierrc.yaml': 'semi: "\\UFFFFFFFF"\n' }))).toBeNull();
  });

  // The YAML parser reads each of these as the same `plugins` key a line of its own sets.
  test('a key counts opening a flow mapping, after a comma, and past a tag, an anchor or a ?, and a longer name doesn’t', () => {
    const prettier = row('prettier');
    for (const config of [
      '{plugins: [./x.mjs]}\n',
      '{semi: false, plugins: [./x.mjs]}\n',
      '{semi: false,plugins: [./x.mjs]}\n',
      '--- {plugins: [./x.mjs]}\n',
      '!!str plugins: [./x.mjs]\n',
      '&p plugins: [./x.mjs]\n',
      '? plugins\n: [./x.mjs]\n',
    ]) {
      expect(staticCause(prettier, scope({ '.prettierrc.yaml': config })), config).toBe(loads('.prettierrc.yaml', 'plugins'));
    }
    expect(staticCause(prettier, scope({ '.prettierrc.json5': "{ semi: false, plugins: ['./x.mjs'] }\n" }))).toBe(loads('.prettierrc.json5', 'plugins'));
    expect(staticCause(prettier, scope({ '.prettierrc.yaml': '{no-plugins: [x], pluginsDir: x, my_plugins: x, semi: false}\n' }))).toBeNull();
  });

  test('a flow sequence’s bare items are values too, beside its quoted ones, so a flow-mapped import of a script counts', () => {
    const cspell = row('cspell');
    expect(staticCause(cspell, scope({ 'cspell.yaml': '{import: [./dict.json, ./words.mjs]}\n' }))).toBe('cspell.yaml sets import, which loads code');
    expect(staticCause(cspell, scope({ 'cspell.yaml': 'import: ["./dict.json", ./words.mjs]\n' }))).toBe('cspell.yaml sets import, which loads code');
    expect(staticCause(cspell, scope({ 'cspell.yaml': '{words: [a], import: [./dict.json]}\n' }))).toBeNull();
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

  describe('tflint, which runs a plugin as a binary (each case probed at tflint 0.64.0)', () => {
    const tflint = row('tflint');
    const terraformOnly = 'plugin "terraform" {\n  enabled = true\n  preset  = "recommended"\n}\n';

    test('a terraform-only .tflint.hcl with no .tflint.d/ keeps lint, the blessed scaffold, a bare label and a comment naming a plugin included', () => {
      expect(staticCause(tflint, scope({ '.tflint.hcl': terraformOnly, 'main.tf': '' }))).toBeNull();
      expect(staticCause(tflint, scope({ '.tflint.hcl': readResource('templates/terraform/shared/tflint.hcl') }))).toBeNull();
      expect(staticCause(tflint, scope({ '.tflint.hcl': 'plugin terraform {\n  enabled = true\n}\n' }))).toBeNull();
      expect(staticCause(tflint, scope({ '.tflint.hcl': `# plugin "aws" {\n// plugin "google" {\n${terraformOnly}` }))).toBeNull();
      // A /* inside a string opens no block comment, so the line comment after it is still one.
      expect(staticCause(tflint, scope({ '.tflint.hcl': `config {\n  format = "/*"\n}\n# plugin "aws" {\n${terraformOnly}` }))).toBeNull();
      expect(staticCause(tflint, scope({ '.tflint.hcl': 'plugin /* the bundled ruleset */ "terraform" {\n}\n' }))).toBeNull();
      // A rule's label, or a key a longer name holds, is no plugin, source or version.
      expect(staticCause(tflint, scope({ '.tflint.hcl': 'rule "terraform_required_version" {\n  enabled = true\n}\nplugin_x = 1\n' }))).toBeNull();
      expect(staticCause(tflint, scope({}))).toBeNull();
    });

    // Bypass 1: tflint runs .tflint.d/plugins/tflint-ruleset-terraform in place of its bundled ruleset.
    test('a file anywhere under a .tflint.d/ skips lint, even beside a terraform-only config, in any case and through a symlink', () => {
      const plant = '.tflint.d/plugins/tflint-ruleset-terraform';
      expect(staticCause(tflint, scope({ '.tflint.hcl': terraformOnly, [plant]: '' }))).toBe(`${plant} is code tflint would run`);
      expect(staticCause(tflint, scope({ [`infra/vendor/m/${plant}`]: '' }, 'infra'))).toBe(`infra/vendor/m/${plant} is code tflint would run`);
      expect(staticCause(tflint, scope({ '.TFLint.D/Plugins/TFLINT-RULESET-TERRAFORM': '' }))).toBe('.TFLint.D/Plugins/TFLINT-RULESET-TERRAFORM is code tflint would run');
      // A symlink in .tflint.d's place is an entry of that name, not a directory the walk enters.
      expect(staticCause(tflint, scope({ 'infra/.tflint.d': '' }, 'infra'))).toBe('infra/.tflint.d is code tflint would run');
      expect(staticCause(tflint, scope({ [`api/${plant}`]: '' }, 'infra'))).toBeNull();
      expect(staticCause(tflint, scope({ 'docs/tflint.d.md': '', 'x.tflint.d/plugin': '' }))).toBeNull();
    });

    // Bypass 2: `plugin aws {` is a bare label, and HCL takes it as readily as a quoted one.
    test('a plugin block other than terraform’s skips lint, its label quoted or bare, wherever HCL lets the block open', () => {
      expect(staticCause(tflint, scope({ '.tflint.hcl': 'plugin aws {\n  enabled = true\n}\n' }))).toBe(loads('.tflint.hcl'));
      expect(staticCause(tflint, scope({ '.tflint.hcl': `${terraformOnly}\nplugin "aws" {\n  enabled = true\n}\n` }))).toBe(loads('.tflint.hcl'));
      expect(staticCause(tflint, scope({ 'envs/prod/.tflint.hcl': '  plugin "google" {\n  }\n' }))).toBe(loads('envs/prod/.tflint.hcl'));
      for (const config of [
        'plugin\taws\t{\n}\n',
        'plugin "aws" { enabled = true }\n',
        'plugin /* c */ "aws" {\n}\n',
        'plugin /*\n*/ "aws" {\n}\n',
        '/* x */ plugin "aws" {\n}\n',
        // A # inside a block comment opens no line comment.
        '/* # */ plugin "aws" {\n}\n',
        // A /* inside a heredoc reads as a comment that runs on, which hides nothing.
        'rule "x" {\n  message = <<EOT\n/*\nEOT\n}\nplugin "aws" {\n}\n',
        // An escaped quote stays inside its label, and an escape is read as written.
        'plugin "a\\"b" {\n}\n',
        'plugin "terr\\u0061form" {\n}\n',
        // A plugin named in a block comment counts: the sniff never drops one.
        '/* plugin "aws" { } */\n',
        // A plugin whose label can't be read counts too, as one spread wider than the sniff reads does.
        'plugin "terraform" "aws" {\n}\n',
        'plugin\n',
        `plugin /* ${' '.repeat(2000)} */ "terraform" {\n}\n`,
      ]) {
        expect(staticCause(tflint, scope({ 'infra/.TFLint.hcl': config }, 'infra')), config).toBe(loads('infra/.TFLint.hcl'));
      }
    });

    // Bypass 3: `plugin "terraform"` with a source runs the release `tflint --init` downloaded.
    test('source, version or plugin_dir skips lint, a terraform plugin’s or a rule’s, on its own line or a block’s one', () => {
      expect(staticCause(tflint, scope({ '.tflint.hcl': 'plugin "terraform" {\n  enabled = true\n  source  = "github.com/x/tflint-ruleset-terraform"\n}\n' }))).toBe(
        loads('.tflint.hcl', 'source'),
      );
      expect(staticCause(tflint, scope({ '.tflint.hcl': 'plugin "terraform" { version = "0.1.0" }\n' }))).toBe(loads('.tflint.hcl', 'version'));
      expect(staticCause(tflint, scope({ '.tflint.hcl': 'config {\n  plugin_dir = "./plugins"\n}\n' }))).toBe(loads('.tflint.hcl', 'plugin_dir'));
      expect(staticCause(tflint, scope({ '.tflint.hcl': 'rule "terraform_required_providers" {\n  source = false\n}\n' }))).toBe(loads('.tflint.hcl', 'source'));
    });

    test('a .tflint.json, which tflint reads without a .tflint.hcl, skips lint wherever it names a plugin or one of those keys', () => {
      expect(staticCause(tflint, scope({ '.tflint.json': '{"plugin": {"terraform": {"enabled": true}}}' }))).toBe(loads('.tflint.json'));
      expect(staticCause(tflint, scope({ '.TFLINT.JSON': '{\n  "config": {\n    "plugin_dir": "./p"\n  }\n}\n' }))).toBe(loads('.TFLINT.JSON', 'plugin_dir'));
      expect(staticCause(tflint, scope({ '.tflint.json': '{"pl\\u0075gin": {"aws": {}}}' }))).toBe(loads('.tflint.json'));
      expect(staticCause(tflint, scope({ '.tflint.json': '{"rule": {"terraform_unused_declarations": {"enabled": true}}}' }))).toBeNull();
    });

    test('--chdir, --config, -c and --enable-plugin skip lint in any form a command line takes them, since each reaches past the sniffs', () => {
      const argv = (...flags: string[]): Adapter => ({ ...tflint, args: ['exec', 'tflint', '--recursive', ...flags, '--format=json'] });
      expect(staticCause(argv('--chdir=../elsewhere'), scope({}))).toBe('tflint runs with --chdir, which can load code');
      expect(staticCause(argv('--config', 'other.hcl'), scope({}))).toBe('tflint runs with --config, which can load code');
      expect(staticCause(argv('-c', 'other.hcl'), scope({}))).toBe('tflint runs with -c, which can load code');
      expect(staticCause(argv('-cother.hcl'), scope({}))).toBe('tflint runs with -c, which can load code');
      expect(staticCause(argv('-vc', 'other.hcl'), scope({}))).toBe('tflint runs with -c, which can load code');
      expect(staticCause(argv('--enable-plugin=aws'), scope({}))).toBe('tflint runs with --enable-plugin, which can load code');
      expect(staticCause({ ...tflint, changedArgs: ['--config=x.hcl'] }, scope({}))).toBe('tflint runs with --config, which can load code');
      expect(staticCause(argv('--minimum-failure-severity=error', '-f', 'json'), scope({}))).toBeNull();
    });

    test('the rest of the pack: fmt and trivy read the configuration as data, and validate needs the init', () => {
      expect(staticCause(row('terraform-fmt'), scope({}))).toBeNull();
      expect(staticCause(row('trivy-config'), scope({}))).toBeNull();
      expect(staticCause(row('terraform-validate'), scope({}))).toBe("terraform-validate isn't a static check");
    });
  });

  test('a config file that can’t be read loads nothing, and the built-ins qualify', () => {
    expect(staticCause(plainOxlint, { dir: '.', files: ['.oxlintrc.json'], read: () => null })).toBeNull();
    expect(staticCause(row('links'), scope({}))).toBeNull();
    expect(staticCause(row('shellcheck'), scope({}))).toBeNull();
  });
});

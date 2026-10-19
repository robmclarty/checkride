/**
 * The repo pack: the slots that check the repo as a whole rather than one
 * language's code — its structure, markdown, links, spelling and prose.
 *
 * It fills every repo-scope slot, and has no root markers of its own. Its
 * tools resolve through the project's own package manager first, then a
 * `mise.toml` pin, then `PATH`, so a repo without Node can run them as single
 * binaries: rumdl for `docs`, typos for `spell`, and the vale and ast-grep
 * binaries. A repo without `targets` is checked as one TypeScript project
 * whose every tool resolves through its package manager alone, as before
 * (R5.4); the launcher gives its checks that chain, not this one.
 */

import type { Pack } from './types.js';

/** The markdownlint-cli2 config keys that load code: rules, markdown-it plugins, output formatters, and where it resolves them from. */
const MARKDOWNLINT_CODE_KEYS: readonly string[] = ['customRules', 'markdownItPlugins', 'outputFormatters', 'modulePaths'];

/**
 * A reference that reaches into a `node_modules`, which the sniffs never
 * read, so whatever it names can't be vouched for and counts.
 */
const INTO_NODE_MODULES = '(?:^|[\\\\/])node_modules(?:[\\\\/]|$)';

/**
 * A vale `StylesPath` whose styles the sniffs never read: one inside a
 * `node_modules`, or one outside the repo, absolute, under the home
 * directory, or climbing out with `..`.
 */
const UNREAD_STYLES = `${INTO_NODE_MODULES}|^(?:[/\\\\~]|[A-Za-z]:[/\\\\])|(?:^|[/\\\\])\\.\\.(?:[/\\\\]|$)`;

/**
 * A cspell `import` loads code when it names a script, JavaScript or
 * TypeScript, rather than a dictionary or a JSON config, and may when it
 * reaches into a `node_modules`, whose JSON config could import one.
 */
const CSPELL_SCRIPT = `\\.[cm]?[jt]s$|${INTO_NODE_MODULES}`;

/** Every config name cspell 10 reads as data, each of which can `import` a script. */
const CSPELL_DATA_CONFIGS: readonly string[] = [
  'cspell.json',
  '.cspell.json',
  'cspell.jsonc',
  '.cspell.jsonc',
  'cspell.yaml',
  '.cspell.yaml',
  'cspell.yml',
  '.cspell.yml',
  'cspell.config.json',
  '.cspell.config.json',
  'cspell.config.jsonc',
  '.cspell.config.jsonc',
  'cspell.config.yaml',
  '.cspell.config.yaml',
  'cspell.config.yml',
  '.cspell.config.yml',
  'cspell.config.toml',
  '.cspell.config.toml',
];

export const REPO_PACK: Pack = {
  name: 'repo',
  markers: [],
  pins: ['js-lockfile', 'mise', 'path'],
  env: {},
  adapters: [
    {
      name: 'ast-grep',
      slot: 'struct',
      description: 'Structural rules (ast-grep)',
      detect: ['sgconfig.yml', 'sgconfig.yaml'],
      command: 'pnpm',
      args: ['exec', 'ast-grep', 'scan', '--json=compact'],
      outputFile: 'struct.json',
      static: true,
      codeKeys: [
        { file: 'sgconfig.yml', keys: ['customLanguages'] },
        { file: 'sgconfig.yaml', keys: ['customLanguages'] },
      ],
      devDeps: { '@ast-grep/cli': '0.45.3' },
    },
    {
      name: 'markdownlint-cli2',
      slot: 'docs',
      description: 'Markdown linting',
      detect: [
        '.markdownlint-cli2.jsonc',
        '.markdownlint-cli2.json',
        '.markdownlint-cli2.yaml',
        '.markdownlint-cli2.cjs',
        '.markdownlint-cli2.mjs',
      ],
      command: 'pnpm',
      args: ['exec', 'markdownlint-cli2'],
      outputFile: null,
      fixArgs: ['exec', 'markdownlint-cli2', '--fix'],
      static: true,
      codeConfigs: ['.markdownlint-cli2.cjs', '.markdownlint-cli2.mjs', '.markdownlint.cjs', '.markdownlint.mjs'],
      codeKeys: [
        { file: '.markdownlint-cli2.jsonc', keys: [...MARKDOWNLINT_CODE_KEYS] },
        { file: '.markdownlint-cli2.json', keys: [...MARKDOWNLINT_CODE_KEYS] },
        { file: '.markdownlint-cli2.yaml', keys: [...MARKDOWNLINT_CODE_KEYS] },
        { file: 'package.json', keys: [...MARKDOWNLINT_CODE_KEYS], under: 'markdownlint-cli2' },
      ],
      devDeps: { 'markdownlint-cli2': '0.23.3' },
    },
    {
      name: 'rumdl',
      slot: 'docs',
      description: 'rumdl: Markdown linting',
      detect: ['.rumdl.toml', 'rumdl.toml'],
      command: 'pnpm',
      // `--no-cache` keeps rumdl from writing `.rumdl_cache` into the checkout,
      // and JSON is one array of every warning, with its file, line and rule.
      args: ['exec', 'rumdl', 'check', '--no-cache', '--output-format', 'json', '.'],
      outputFile: 'docs.json',
      fixArgs: ['exec', 'rumdl', 'check', '--no-cache', '--fix', '.'],
      static: true,
      devDeps: {},
    },
    {
      name: 'links',
      slot: 'links',
      description: 'Relative markdown link targets exist on disk',
      detect: [],
      command: 'node',
      args: [],
      outputFile: 'links.json',
      builtin: 'links',
      static: true,
      devDeps: {},
    },
    {
      name: 'cspell',
      slot: 'spell',
      description: 'Spell check',
      detect: [
        'cspell.json',
        '.cspell.json',
        'cspell.config.json',
        'cspell.config.yaml',
        'cspell.config.cjs',
        'cspell.config.mjs',
      ],
      detectDeps: ['cspell'],
      command: 'pnpm',
      args: ['exec', 'cspell', '--no-progress', '--no-summary', '--reporter=default'],
      outputFile: null,
      static: true,
      codeConfigs: [
        'cspell.config.js',
        'cspell.config.cjs',
        'cspell.config.mjs',
        'cspell.config.ts',
        'cspell.config.mts',
        'cspell.config.cts',
        '.cspell.config.js',
        '.cspell.config.cjs',
        '.cspell.config.mjs',
        '.cspell.config.ts',
        '.cspell.config.mts',
        '.cspell.config.cts',
      ],
      codeKeys: [
        ...CSPELL_DATA_CONFIGS.map((file) => ({ file, keys: ['import'], value: CSPELL_SCRIPT })),
        { file: 'package.json', keys: ['import'], value: CSPELL_SCRIPT, under: 'cspell' },
      ],
      devDeps: { cspell: '10.3.6' },
    },
    {
      name: 'typos',
      slot: 'spell',
      description: 'typos: common misspellings',
      detect: ['_typos.toml', 'typos.toml', '.typos.toml'],
      command: 'pnpm',
      // typos flags only words it holds a correction for, which is the slot's
      // stance, and `brief` prints each one as `file:line:col: message`.
      args: ['exec', 'typos', '--format', 'brief'],
      outputFile: null,
      fixArgs: ['exec', 'typos', '--write-changes'],
      static: true,
      devDeps: {},
    },
    {
      name: 'vale',
      slot: 'prose',
      description: 'Vale: writing style (prose linting)',
      // Vale's own config-discovery names, and the whole detection signal: no
      // `detectDeps`, because vale hard-errors (E100, exit 2) with no config file
      // — it is not configless-capable, so a repo that installed the tool but never
      // wrote its config must not be opted in.
      detect: ['.vale.ini', '_vale.ini'],
      command: 'pnpm',
      // `--no-global` keeps the verdict off ~/.vale.ini, so a check means the same
      // thing on every machine. The trailing `.` is load-bearing: vale lints
      // nothing at all without a path argument. It also reads no .gitignore and
      // skips no hidden directory, so a repo narrows the walk by overriding
      // `args` with explicit paths — the same way this one already does for lint.
      args: ['exec', 'vale', '--no-global', '--output=JSON', '.'],
      outputFile: 'prose.json',
      static: true,
      // `StylesPath` can name any directory, so a style can sit anywhere, and
      // one the sniffs never read, in a node_modules or outside the repo,
      // counts unread.
      codeKeys: [
        { file: '**/*.yml', keys: ['extends'], value: '^script$' },
        { file: '.vale.ini', keys: ['StylesPath'], value: UNREAD_STYLES },
        { file: '_vale.ini', keys: ['StylesPath'], value: UNREAD_STYLES },
      ],
      devDeps: { '@vvago/vale': '3.24.0' },
    },
    {
      name: 'unclaimed',
      slot: 'unclaimed',
      description: 'Every toolchain marker sits inside a target that checks it',
      // Always available once the slot is active, which takes `targets`: a
      // marker outside every target is code no check reads.
      detect: [],
      command: 'node',
      args: [],
      outputFile: 'unclaimed.json',
      builtin: 'unclaimed',
      static: true,
      devDeps: {},
    },
  ],
};

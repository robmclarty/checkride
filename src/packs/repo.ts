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
      devDeps: {},
    },
  ],
};

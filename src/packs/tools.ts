/**
 * Every external tool the packs run, described once. An adapter names its tool
 * by `bin`; this is where that name meets the package that provides it.
 */

import type { Tool } from './types.js';

/** One row per tool, by executable name. */
export const TOOLS: readonly Tool[] = [
  {
    bin: 'ast-grep',
    npm: '@ast-grep/cli',
    mise: ['ast-grep', 'aqua:ast-grep/ast-grep'],
    install: 'add @ast-grep/cli to devDependencies, or pin the binary with `mise use ast-grep@<version>`',
  },
  { bin: 'attw', npm: '@arethetypeswrong/cli', install: 'add @arethetypeswrong/cli to devDependencies' },
  { bin: 'biome', npm: '@biomejs/biome', install: 'add @biomejs/biome to devDependencies' },
  { bin: 'cspell', npm: 'cspell', install: 'add cspell to devDependencies' },
  { bin: 'eslint', npm: 'eslint', install: 'add eslint to devDependencies' },
  { bin: 'fallow', npm: 'fallow', install: 'add fallow to devDependencies' },
  { bin: 'jest', npm: 'jest', install: 'add jest to devDependencies' },
  { bin: 'knip', npm: 'knip', install: 'add knip to devDependencies' },
  { bin: 'markdownlint-cli2', npm: 'markdownlint-cli2', install: 'add markdownlint-cli2 to devDependencies' },
  { bin: 'oxlint', npm: 'oxlint', install: 'add oxlint to devDependencies' },
  { bin: 'prettier', npm: 'prettier', install: 'add prettier to devDependencies' },
  { bin: 'publint', npm: 'publint', install: 'add publint to devDependencies' },
  {
    bin: 'rumdl',
    mise: ['rumdl', 'aqua:rvben/rumdl'],
    install: 'pin it with `mise use rumdl@<version>`, or install rumdl (https://github.com/rvben/rumdl)',
  },
  {
    bin: 'shellcheck',
    mise: ['shellcheck', 'aqua:koalaman/shellcheck'],
    install: 'pin it with `mise use shellcheck@<version>`, or install shellcheck (https://www.shellcheck.net)',
  },
  {
    bin: 'shfmt',
    mise: ['shfmt', 'aqua:mvdan/sh'],
    install: 'pin it with `mise use shfmt@<version>`, or install shfmt (https://github.com/mvdan/sh)',
  },
  { bin: 'stryker', npm: '@stryker-mutator/core', install: 'add @stryker-mutator/core to devDependencies' },
  { bin: 'tsc', npm: 'typescript', install: 'add typescript to devDependencies' },
  {
    bin: 'typos',
    mise: ['typos', 'aqua:crate-ci/typos'],
    install: 'pin it with `mise use typos@<version>`, or install typos (https://github.com/crate-ci/typos)',
  },
  {
    bin: 'vale',
    npm: '@vvago/vale',
    mise: ['vale', 'aqua:vale-cli/vale'],
    install: 'add @vvago/vale to devDependencies, or pin the binary with `mise use vale@<version>`',
  },
  { bin: 'vitest', npm: 'vitest', install: 'add vitest to devDependencies' },
];

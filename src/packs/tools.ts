/**
 * Every external tool the packs run, described once. An adapter names its tool
 * by `bin`; this is where that name meets the package that provides it.
 */

import type { Tool } from './types.js';

/** One row per tool, by executable name. */
export const TOOLS: readonly Tool[] = [
  { bin: 'ast-grep', npm: '@ast-grep/cli', install: 'add @ast-grep/cli to devDependencies' },
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
  { bin: 'stryker', npm: '@stryker-mutator/core', install: 'add @stryker-mutator/core to devDependencies' },
  { bin: 'tsc', npm: 'typescript', install: 'add typescript to devDependencies' },
  { bin: 'vale', npm: '@vvago/vale', install: 'add @vvago/vale to devDependencies' },
  { bin: 'vitest', npm: 'vitest', install: 'add vitest to devDependencies' },
];

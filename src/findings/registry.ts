/**
 * The parser registry: one parser per tool output format, keyed by adapter
 * name (not slot), decided per adapter against real fixtures rather than from
 * an up-front list.
 *
 * Keyed on the adapter's name, so an alternate tool that shares a slot with a
 * parsed default (biome or eslint for `lint`, knip for `dead`) has no parser
 * until it grows its own, and a custom check that names itself after a parsed
 * adapter is read by that adapter's parser.
 */

import { astGrepParser } from './parsers/ast-grep.js';
import { cargoCheckParser, clippyParser } from './parsers/cargo.js';
import { cspellParser } from './parsers/cspell.js';
import { fallowParser } from './parsers/fallow.js';
import { goBuildParser } from './parsers/go-build.js';
import { golangciLintParser } from './parsers/golangci-lint.js';
import { markdownlintCli2Parser } from './parsers/markdownlint-cli2.js';
import { oxlintParser } from './parsers/oxlint.js';
import { rumdlParser } from './parsers/rumdl.js';
import { shellcheckParser } from './parsers/shellcheck.js';
import { staticcheckParser } from './parsers/staticcheck.js';
import { tscParser } from './parsers/tsc.js';
import { typosParser } from './parsers/typos.js';
import { valeParser } from './parsers/vale.js';
import type { Parser } from './types.js';

/**
 * Parsers keyed by adapter name; everything else has none. One `fallow`
 * adapter fills all three fallow slots (dead, dupes and health), and its
 * parser dispatches on the report's `kind`, so one registration serves every
 * slot.
 */
const PARSERS: Readonly<Record<string, Parser>> = {
  oxlint: oxlintParser,
  'ast-grep': astGrepParser,
  cspell: cspellParser,
  vale: valeParser,
  fallow: fallowParser,
  'golangci-lint': golangciLintParser,
  staticcheck: staticcheckParser,
  clippy: clippyParser,
  'cargo-check': cargoCheckParser,
  shellcheck: shellcheckParser,
  'markdownlint-cli2': markdownlintCli2Parser,
  rumdl: rumdlParser,
  typos: typosParser,
  tsc: tscParser,
  'go-build': goBuildParser,
};

/** The parser registered for `adapter`, or `undefined` when its output has none. */
export function parserFor(adapter: string): Parser | undefined {
  return Object.hasOwn(PARSERS, adapter) ? PARSERS[adapter] : undefined;
}

/**
 * The parser the baseline keys `adapter` with: its registered parser, unless
 * that one only serves `checkride/findings`, as a type checker's does (D31).
 */
export function baselineParserFor(adapter: string): Parser | undefined {
  const parser = parserFor(adapter);
  return parser?.parseOnly === true ? undefined : parser;
}

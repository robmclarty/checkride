/**
 * Named suites: more than one checkride suite in one repo. A suite named
 * `evals` is three things at the repo root, each fixed by its name: the config
 * `checkride.evals.config.json`, the baseline `checkride.evals.baseline.json`,
 * and the output directory `.check/suites/evals/`. With no suite named a
 * command runs the default one, `checkride.config.json`,
 * `checkride.baseline.json` and `.check/`, as it always has.
 *
 * A suite is data here, a {@link Suite} the command line resolves once
 * ({@link namedSuite}) and every command it reaches takes as an option. Nothing
 * in this module holds state.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CHECK_DIR } from './artifacts/index.js';
import { BASELINE_FILE } from './baseline/index.js';

/** The variable that names the suite when `--suite` doesn't. */
export const SUITE_ENV = 'CHECKRIDE_SUITE';

/**
 * The directory under the output directory that holds every suite's own. A
 * target's artifacts sit under `<out>/<target>/`, so no target may take this
 * name.
 */
export const SUITES_DIR = 'suites';

/**
 * A suite's name, as the source of a pattern: one lowercase word, so it reads
 * as one part of a file name. Everything that matches a suite's file by name,
 * the generated edit guard included, builds its pattern from this.
 */
export const SUITE_NAME_SOURCE = '[a-z][a-z0-9-]*';

const SUITE_NAME = new RegExp(`^${SUITE_NAME_SOURCE}$`);

/** The names whose files would read as the default suite's: `checkride.baseline.config.json`, and its like. */
const RESERVED_NAMES: ReadonlySet<string> = new Set(['config', 'baseline']);

/** A suite's config file, by which {@link listSuites} finds it. */
const SUITE_CONFIG = new RegExp(`^checkride\\.(${SUITE_NAME_SOURCE})\\.config\\.json$`);

/**
 * A suite as every command reads it: the three paths it runs with, each
 * relative to the repo root, and its name when it has one. The default suite
 * ({@link DEFAULT_SUITE}) has none.
 */
export type Suite = {
  /** A named suite's name; absent on the default suite. */
  name?: string;
  /** `checkride.<name>.config.json`, or `checkride.config.json`. */
  configFile: string;
  /** `checkride.<name>.baseline.json`, or `checkride.baseline.json`. */
  baselineFile: string;
  /** `.check/suites/<name>`, or `.check`: where its runs write unless `--out` names another directory. */
  out: string;
};

/** The default suite, the one a command runs when none is named: `checkride.config.json`, `checkride.baseline.json` and `.check`. */
export const DEFAULT_SUITE: Suite = { configFile: 'checkride.config.json', baselineFile: BASELINE_FILE, out: CHECK_DIR };

/**
 * True for a named suite, which runs exactly the checks its config declares:
 * detection fills no slot there and no built-in joins on its own. The one
 * place that rule is read off a suite, so resolution can't be handed a suite
 * and forget it.
 */
export function declaresItsChecks(suite: Suite): boolean {
  return suite.name !== undefined;
}

/** The absolute directory `suite`'s runs write to in the repo at `cwd`, when no flag or variable names another. */
export function suiteOutDir(cwd: string, suite: Suite): string {
  return join(cwd, suite.out);
}

/** What named a value for a command: the value, and `from`, the flag or variable that gave it, as an error names it. */
export type Named = { value: string; from: string };

/**
 * The value `flag` was given, else the one its `variable` holds (an empty
 * variable counts as unset), with what named it, or `null` when neither did.
 */
export function flagOrVariable(flag: string, given: string | undefined, variable: string, env: Readonly<Record<string, string | undefined>>): Named | null {
  if (given !== undefined) return { value: given, from: flag };
  const set = env[variable];
  return set === undefined || set === '' ? null : { value: set, from: variable };
}

/** The suite named `name`, or a usage error for a name outside the grammar or one of the reserved two. */
export function suiteNamed(name: string): Suite {
  if (!SUITE_NAME.test(name)) {
    throw new Error(`invalid suite name ${JSON.stringify(name)} (expected a lowercase word: a letter, then letters, digits or hyphens)`);
  }
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`invalid suite name '${name}' (its files would read as the default suite's; pick another name)`);
  }
  return {
    name,
    configFile: `checkride.${name}.config.json`,
    baselineFile: `checkride.${name}.baseline.json`,
    out: [CHECK_DIR, SUITES_DIR, name].join('/'),
  };
}

/** The suites `cwd` holds, by name and in name order: each `checkride.<name>.config.json` at its root. */
export function listSuites(cwd: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(cwd);
  } catch {
    return [];
  }
  return entries
    .flatMap((entry) => SUITE_CONFIG.exec(entry)?.[1] ?? [])
    .filter((name) => !RESERVED_NAMES.has(name))
    .toSorted();
}

/** What {@link namedSuite} reads beside the flag: the environment, and each flag a suite can't be combined with. */
export type SuiteSources = {
  env: Readonly<Record<string, string | undefined>>;
  /**
   * What already names a config, a defaults layer or discovery for this
   * command, as the words an error uses (`--config`, `CHECKRIDE_DEFAULTS`,
   * `--discover`). A suite's name fixes its config, and a defaults layer or
   * discovery adds checks a suite leaves out on purpose, so any of them
   * beside a suite is a usage error.
   */
  conflicts?: readonly string[];
};

/**
 * The suite a command was pointed at: `--suite`, else `CHECKRIDE_SUITE` (an
 * empty variable counts as unset), or the default suite when neither names
 * one. A name outside the grammar, a suite with no config file, and a suite
 * beside `--config`, `--defaults` or `--discover` are usage errors.
 */
export function namedSuite(cwd: string, flag: string | undefined, sources: SuiteSources): Suite {
  if (flag === '') throw new Error('--suite was passed with no name');
  const asked = flagOrVariable('--suite', flag, SUITE_ENV, sources.env);
  if (asked === null) return DEFAULT_SUITE;
  const { from } = asked;
  const suite = suiteNamed(asked.value);
  const [conflict] = sources.conflicts ?? [];
  if (conflict !== undefined) throw new Error(conflictProblem(from, conflict));
  if (!existsSync(join(cwd, suite.configFile))) throw new Error(missingProblem(from, suite, cwd));
  return suite;
}

/** Why a suite can't sit beside each flag, by the word its name holds, so a variable, or a flag in a script, reads as its flag. */
const CONFLICT_REASONS: Readonly<Record<string, string>> = {
  config: "a suite's name already names its config",
  defaults: 'a suite runs exactly the checks its config declares, so no defaults layer fills the rest',
  discover: 'a suite runs exactly the checks its config declares, and discovery declares none',
};

/** Why a suite can't sit beside the flag or variable `other`. */
function conflictProblem(from: string, other: string): string {
  const named = other.toLowerCase();
  const key = Object.keys(CONFLICT_REASONS).find((flag) => named.includes(flag));
  return `${from} can't be combined with ${other}: ${key === undefined ? 'a suite fixes what it would name' : CONFLICT_REASONS[key]}`;
}

/** The usage error for a suite with no config: the path it looked for, and the suites that do exist. */
function missingProblem(from: string, suite: Suite, cwd: string): string {
  const found = listSuites(cwd);
  const others = found.length > 0 ? `the suites here are ${found.join(', ')}` : `there are no suites here (no file matches checkride.<name>.config.json)`;
  return `${from} names '${suite.name}', which has no config: ${join(cwd, suite.configFile)} is missing; ${others}`;
}

/** The words that pick `suite` on a command line, each its own argument: none for the default suite. */
export function suiteFlags(suite: Suite): string[] {
  return suite.name === undefined ? [] : ['--suite', suite.name];
}

/**
 * `command` as someone would type it for `suite`: with ` --suite <name>`
 * after it for a named suite, and as it is for the default one. Every hint
 * that names a checkride command goes through here, so a hint given under a
 * named suite never sends its reader to the default suite's files.
 */
export function suiteCommand(command: string, suite: Suite): string {
  return [command, ...suiteFlags(suite)].join(' ');
}

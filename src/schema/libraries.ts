/**
 * Where the `schema` slot's three libraries come from, and the refusal for
 * one that isn't there.
 *
 * checkride depends on nothing at run time, so `ajv`, `yaml` and
 * `jsonc-parser` are optional peers: the npm package loads each from the
 * `node_modules` at the root of the repo a run is in, the way a tool is found
 * in the project's own install, and never from its own location. Each is loaded only when a rule needs it:
 * `ajv` for any rule, `yaml` for a `yaml` or `frontmatter` rule,
 * `jsonc-parser` for a `jsonc` one.
 *
 * A caller hands the loader its {@link LibrarySource}, the repo's install or
 * the binary's bundle, and `./source.ts` is the one place that picks.
 *
 * Nothing this package ships imports any of the three. The standalone binary
 * has no install to read, so its build bundles them
 * (`build/sea/schema-libraries.mjs`) and its main module registers them here
 * before the CLI starts (`build/sea/entry.mjs`, under
 * {@link BUNDLED_LIBRARIES}), and there a repo's copies are never consulted.
 *
 * A library a rule needs and the repo hasn't installed, or installed at a
 * major the slot doesn't read, refuses the check before it does any work
 * ({@link libraryRefusal}), as a tool the project never installed refuses
 * its check. A Yarn Plug'n'Play install writes no `node_modules` for them to
 * be read from, and its refusal says so in place of naming an install
 * command that wouldn't help.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';

import type { SchemaFormat } from '../adapters.js';
import { isRecord } from '../json.js';
import type { PackageManager } from '../launch/index.js';
import { installCommand, installedVersion, isPnPInstall } from '../launch/index.js';
import type { AjvConstructor, AjvLibrary, JsoncLibrary, LibraryName, SchemaLibraries, YamlLibrary } from './library-types.js';

/**
 * The major of each library the slot reads, which is the peer range
 * `package.json` declares for it: `^8.0.0`, `^2.0.0` and `^3.0.0`.
 */
export const SUPPORTED_MAJORS: Readonly<Record<LibraryName, number>> = { ajv: 8, yaml: 2, 'jsonc-parser': 3 };

/** The library that parses each format, beside `ajv`; strict JSON needs none. */
const PARSER_OF: Readonly<Record<SchemaFormat, LibraryName | null>> = { json: null, jsonc: 'jsonc-parser', yaml: 'yaml', frontmatter: 'yaml' };

/**
 * One library as a run finds it: the version it would load, `null` for none,
 * and what's wrong with it, `missing` or a major the slot doesn't read.
 */
export type LibraryState = { name: LibraryName; version: string | null; problem: 'missing' | 'unsupported' | null };

/** Where a run's libraries are looked up: the repo root, and its package manager, which the refusal's install command is in. */
export type LibrariesAt = { repo: string; pm: PackageManager };

/** The libraries rules of `formats` need, `ajv` first: it validates every rule. */
export function librariesFor(formats: Iterable<SchemaFormat>): LibraryName[] {
  const parsers = [...formats].flatMap((format) => PARSER_OF[format] ?? []);
  return ['ajv', ...new Set(parsers)];
}

/**
 * Where the repo's install holds `name`: `node_modules/<name>` at the repo
 * root, and nowhere else. Node's own lookup would go on to `NODE_PATH`, which
 * `pnpm run` points at the store's hoisted packages, so a copy some other
 * dependency brought in, at whatever major it wanted, would load on one
 * machine and not the next. A library the repo didn't declare isn't the
 * repo's to validate with.
 */
function packageDir(repo: string, name: string): string {
  return join(repo, 'node_modules', name);
}

/** `name` as the repo's install holds it. */
function repoState(name: LibraryName, repo: string): LibraryState {
  const version = installedVersion(repo, name);
  if (version === undefined) return { name, version: null, problem: 'missing' };
  return { name, version, problem: Number.parseInt(version, 10) === SUPPORTED_MAJORS[name] ? null : 'unsupported' };
}

/** The module the repo's install holds for `specifier`: a library's name, or a path inside one, as `ajv/dist/2020`. */
function repoModule(repo: string, specifier: string): unknown {
  const [name = '', ...inside] = specifier.split('/');
  const require = createRequire(join(repo, 'package.json'));
  const loaded: unknown = require(join(packageDir(repo, name), ...inside));
  return loaded;
}

/**
 * Where the standalone binary's build registers the libraries it bundles: a
 * property of the global object under this symbol, set before the CLI's
 * modules run. It holds `modules`, each library's module by the specifier a
 * repo's copy is required by (`ajv`, `ajv/dist/2020`, `yaml`,
 * `jsonc-parser`), and `versions`, the version of each that was bundled.
 */
export const BUNDLED_LIBRARIES = Symbol.for('checkride.schema.libraries');

/** What the binary's build registers under {@link BUNDLED_LIBRARIES}. */
type Bundled = { modules: Record<string, unknown>; versions: Record<string, unknown> };

/** The libraries the binary's build registered. A binary built without them is a broken build, and says so. */
function bundled(): Bundled {
  const found: unknown = Reflect.get(globalThis, BUNDLED_LIBRARIES);
  const modules = isRecord(found) ? found['modules'] : undefined;
  const versions = isRecord(found) ? found['versions'] : undefined;
  if (!isRecord(modules) || !isRecord(versions)) throw new Error("this checkride binary was built without the schema slot's libraries");
  return { modules, versions };
}

/** The version of `name` the binary bundles. */
function bundledVersion(name: LibraryName, versions: Bundled['versions']): string {
  const version = versions[name];
  return typeof version === 'string' ? version : '';
}

/**
 * Where a run's libraries come from: how each one stands there, the module
 * behind a specifier (a library's name, or a path inside one, as
 * `ajv/dist/2020`), and which of the two sources it is. A caller picks the
 * source (`./source.ts`) and the loader and `doctor`'s probe read whatever
 * they are handed, so neither asks which channel it runs from.
 */
export type LibrarySource = {
  label: 'repo' | 'bundled';
  states: (names: readonly LibraryName[]) => LibraryState[];
  load: (specifier: string) => unknown;
};

/** The repo's own install: `node_modules` at the root of `repo`. */
export function repoSource(repo: string): LibrarySource {
  return {
    label: 'repo',
    states: (names) => names.map((name) => repoState(name, repo)),
    load: (specifier) => repoModule(repo, specifier),
  };
}

/**
 * The copies the standalone binary bundles, which are always there and never
 * a repo's. The registry is read when a library is asked for, not when the
 * source is made, so a binary built without them fails the check that needed
 * them and nothing else.
 */
export function bundledSource(): LibrarySource {
  return {
    label: 'bundled',
    states: (names) => names.map((name) => ({ name, version: bundledVersion(name, bundled().versions), problem: null })),
    load: (specifier) => bundled().modules[specifier],
  };
}

/** `items` as a sentence lists them: `a`, `a and b`, `a, b and c`. */
function listed(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** What the refusal says the slot needs: the libraries the repo lacks, then the ones it holds at a major the slot doesn't read. */
function needs(broken: readonly LibraryState[]): string {
  const missing = broken.filter((state) => state.problem === 'missing').map(({ name }) => `\`${name}\``);
  const unsupported = broken
    .filter((state) => state.problem === 'unsupported')
    .map(({ name, version }) => `\`${name}\` ${SUPPORTED_MAJORS[name]} (this project installs ${version ?? 'another major'})`);
  const lacks = missing.length === 0 ? [] : [`${listed(missing)}, which ${missing.length === 1 ? 'is' : 'are'} not installed in this project`];
  return [...lacks, ...(unsupported.length === 0 ? [] : [listed(unsupported)])].join(', and ');
}

/** The command that installs `names` under the repo's package manager, each at the major the slot reads. */
function installOf(names: readonly LibraryName[], at: LibrariesAt): string {
  return installCommand(at.pm, names.map((name) => `${name}@^${SUPPORTED_MAJORS[name]}`).join(' '));
}

/** A refusal's line saying where each of `broken` was looked for. */
function lookedFor(broken: readonly LibraryState[], at: LibrariesAt): string {
  return `  looked for: ${broken.map(({ name }) => `node_modules/${name} (${SUPPORTED_MAJORS[name]}.x)`).join(', ')} in ${at.repo}`;
}

/**
 * Why the `schema` check can't run with the libraries in `states`, or `null`
 * when each can be loaded. The first line names each package and the command
 * that installs them under the repo's package manager.
 */
export function libraryRefusal(states: readonly LibraryState[], at: LibrariesAt): string | null {
  const broken = states.filter((state) => state.problem !== null);
  if (broken.length === 0) return null;
  if (at.pm === 'yarn' && isPnPInstall(at.repo)) return plugAndPlayRefusal(broken, at);
  return [
    `checkride: the \`schema\` slot needs ${needs(broken)}: run \`${installOf(broken.map(({ name }) => name), at)}\`.`,
    '',
    lookedFor(broken, at),
    '',
    'checkride depends on nothing at run time, so it validates with the `ajv`, `yaml`',
    'and `jsonc-parser` this repo installs: `ajv` for any rule, `yaml` for a `yaml` or',
    '`frontmatter` rule, and `jsonc-parser` for a `jsonc` one. The standalone binary',
    'bundles all three.',
    '',
  ].join('\n');
}

/**
 * The refusal in a Yarn Plug'n'Play repo, which keeps its packages in zip
 * archives and writes no `node_modules`: no install command puts a library
 * where the slot reads it, so the remedy is another channel or another linker.
 */
function plugAndPlayRefusal(broken: readonly LibraryState[], at: LibrariesAt): string {
  const names = listed(broken.map(({ name }) => `\`${name}\``));
  return [
    `checkride: the \`schema\` slot reads ${names} from node_modules, which Yarn Plug'n'Play doesn't write: run the standalone checkride binary, which bundles ${broken.length === 1 ? 'it' : 'them'}, or set \`nodeLinker: node-modules\` in .yarnrc.yml.`,
    '',
    lookedFor(broken, at),
    '',
    'checkride depends on nothing at run time, so the npm package validates with the',
    "libraries a repo's install holds under node_modules. Adding them to package.json",
    "changes nothing here, since Plug'n'Play keeps them in its own archives.",
    '',
  ].join('\n');
}

/** `module`, or the `default` it wraps, down to the first function: a constructor, however its module was loaded. */
function constructorOf(module: unknown, what: string): AjvConstructor {
  let found = module;
  while (isRecord(found) && 'default' in found) found = found['default'];
  if (!isConstructor(found)) throw new Error(`${what} exports no constructor`);
  return found;
}

/** True for a function, which is all a constructor can be told by. */
function isConstructor(value: unknown): value is AjvConstructor {
  return typeof value === 'function';
}

/** True for a module that holds the function `member`. */
function hasFunction(module: unknown, member: string): boolean {
  return (isRecord(module) || typeof module === 'function') && typeof Reflect.get(module, member) === 'function';
}

/** `module`, or the `default` it wraps, whichever holds the function `member`; `undefined` when neither does. */
function holding(module: unknown, member: string): unknown {
  return [module, isRecord(module) ? module['default'] : undefined].find((found) => hasFunction(found, member));
}

/** True for a module with what the slot calls of `yaml`. */
function isYaml(module: unknown): module is YamlLibrary {
  return hasFunction(module, 'parseDocument');
}

/** True for a module with what the slot calls of `jsonc-parser`. */
function isJsonc(module: unknown): module is JsoncLibrary {
  return ['parse', 'parseTree', 'findNodeAtLocation', 'printParseErrorCode'].every((member) => hasFunction(module, member));
}

/** `yaml`, read off the module a load handed back. */
function yamlOf(module: unknown): YamlLibrary {
  const found = holding(module, 'parseDocument');
  if (!isYaml(found)) throw new Error('yaml exports no parseDocument');
  return found;
}

/** `jsonc-parser`, read off the module a load handed back. */
function jsoncOf(module: unknown): JsoncLibrary {
  const found = holding(module, 'parseTree');
  if (!isJsonc(found)) throw new Error('jsonc-parser exports no parseTree');
  return found;
}

/** One library's module, by the entry `specifier`. */
type Load = (specifier: string) => unknown;

/** `ajv`'s two constructors, from the modules `load` hands back for `ajv` and `ajv/dist/2020`. */
function ajvOf(load: Load): AjvLibrary {
  return { draft07: constructorOf(load('ajv'), 'ajv'), draft2020: constructorOf(load('ajv/dist/2020'), 'ajv/dist/2020') };
}

/** The libraries in `names`, each read off the module `load` hands back for it. */
function shaped(names: readonly LibraryName[], load: Load): SchemaLibraries {
  return {
    ajv: ajvOf(load),
    ...(names.includes('yaml') ? { yaml: yamlOf(load('yaml')) } : {}),
    ...(names.includes('jsonc-parser') ? { jsonc: jsoncOf(load('jsonc-parser')) } : {}),
  };
}

/** What {@link loadLibraries} hands back: the libraries, or the refusal the check fails with. */
export type LoadedLibraries = { libraries: SchemaLibraries } | { refusal: string };

/**
 * Load `names` from `source`, for a run in the repo at `at.repo`: the
 * libraries, or the refusal when one is missing or at a major the slot
 * doesn't read, or is in the repo's install and won't load. Nothing is loaded
 * that `names` leaves out, and nothing at all when one of them can't be.
 * `source` is the repo's own install unless the caller hands another.
 */
export function loadLibraries(names: readonly LibraryName[], at: LibrariesAt, source: LibrarySource = repoSource(at.repo)): LoadedLibraries {
  const refusal = libraryRefusal(source.states(names), at);
  if (refusal !== null) return { refusal };
  try {
    return { libraries: shaped(names, source.load) };
  } catch (error) {
    // A bundle that won't load is a broken build, and no install mends it.
    if (source.label !== 'repo') throw error;
    // An install that holds the package and can't load it: half written, or missing one of its own dependencies.
    const why = error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
    return { refusal: `checkride: the \`schema\` slot could not load its libraries from node_modules (${why}): reinstall them with \`${installOf(names, at)}\`.\n` };
  }
}

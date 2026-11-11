/**
 * The `schema` slot's libraries for a test repo. The slot loads `ajv`, `yaml`
 * and `jsonc-parser` from the repo it runs in, never from checkride's own
 * install, so a temp repo has none until a test gives it some:
 * `installLibraries` links this checkout's copies into the repo's
 * `node_modules`, the ones it names or all three, and `stubLibrary` writes a
 * package that holds only a version, for a test of what the loader reads
 * before it loads anything.
 *
 * The standalone binary reads none of that: its build registers the copies
 * it bundles. `registerBundledLibraries` does what the binary's main module
 * does, with what the very module the build bundles exports
 * (`build/sea/schema-libraries.mjs`), so a unit test of the binary channel
 * runs on the real wiring; `clearBundledLibraries` takes them away again.
 */

import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This checkout's root, whose `node_modules` holds the three libraries as dev dependencies. */
export const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The three libraries, by their npm names. */
const LIBRARY_NAMES = ['ajv', 'yaml', 'jsonc-parser'] as const;

/** Link this checkout's copies of `names` into `repo/node_modules`, as an install there would hold them. */
export async function installLibraries(repo: string, names: readonly (typeof LIBRARY_NAMES)[number][] = LIBRARY_NAMES): Promise<void> {
  await mkdir(join(repo, 'node_modules'), { recursive: true });
  await Promise.all(names.map((name) => symlink(join(CHECKOUT, 'node_modules', name), join(repo, 'node_modules', name), 'dir')));
}

/** Write `repo/node_modules/<name>` as a package at `version` with nothing in it. */
export async function stubLibrary(repo: string, name: string, version: string): Promise<void> {
  const dir = join(repo, 'node_modules', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version }));
}

/** Where the binary's build registers its libraries, as `src/schema/libraries.ts` names it. */
const BUNDLED = Symbol.for('checkride.schema.libraries');

/** Register the libraries the binary bundles, as the binary's main module does before the CLI starts. */
export async function registerBundledLibraries(): Promise<void> {
  const wiring: unknown = await import(pathToFileURL(join(CHECKOUT, 'build', 'sea', 'schema-libraries.mjs')).href);
  Reflect.set(globalThis, BUNDLED, Reflect.get(Object(wiring), 'libraries'));
}

/** Take the registered libraries away, as on the npm channel, where nothing registers any. */
export function clearBundledLibraries(): void {
  Reflect.deleteProperty(globalThis, BUNDLED);
}

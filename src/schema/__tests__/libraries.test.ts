import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { CHECKOUT, clearBundledLibraries, installLibraries, registerBundledLibraries, stubLibrary } from '../../../test/helpers/schema-libraries.js';
import { fakeSea } from '../../../test/helpers/sea.js';
import { runSchemaCheck } from '../run.js';
import { BUNDLED_LIBRARIES, librariesFor, libraryRefusal, libraryStates, loadLibraries, SUPPORTED_MAJORS } from '../libraries.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'checkride-schema-libs-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  clearBundledLibraries();
  await rm(repo, { recursive: true, force: true });
});

const ALL = ['ajv', 'yaml', 'jsonc-parser'] as const;

/** The refusal's first line, as the summary records its reason. */
const firstLine = (text: string): string => text.split('\n')[0] ?? '';

describe('which libraries a rule needs', () => {
  test('ajv for any rule, and nothing beside it for strict JSON', () => {
    expect(librariesFor(['json'])).toEqual(['ajv']);
    expect(librariesFor([])).toEqual(['ajv']);
  });

  test('yaml for a yaml or a frontmatter rule, jsonc-parser for a jsonc one, each once', () => {
    expect(librariesFor(['yaml'])).toEqual(['ajv', 'yaml']);
    expect(librariesFor(['frontmatter', 'yaml', 'json'])).toEqual(['ajv', 'yaml']);
    expect(librariesFor(['jsonc'])).toEqual(['ajv', 'jsonc-parser']);
    expect(librariesFor(['jsonc', 'frontmatter'])).toEqual(['ajv', 'jsonc-parser', 'yaml']);
  });
});

describe('the peer ranges package.json declares', () => {
  test('each library is an optional peer at the major the slot reads, pinned exactly as a dev dependency, and never a dependency', async () => {
    const manifest = JSON.parse(await readFile(join(CHECKOUT, 'package.json'), 'utf8')) as Record<string, Record<string, unknown> | undefined>;
    expect(manifest['dependencies']).toBeUndefined();
    for (const name of ALL) {
      expect(manifest['peerDependencies']?.[name], name).toBe(`^${SUPPORTED_MAJORS[name]}.0.0`);
      expect(manifest['peerDependenciesMeta']?.[name], name).toEqual({ optional: true });
      expect(manifest['devDependencies']?.[name], name).toMatch(new RegExp(`^${SUPPORTED_MAJORS[name]}\\.\\d+\\.\\d+$`));
    }
    expect(Object.keys(manifest['peerDependencies'] ?? {}).toSorted()).toEqual([...ALL].toSorted());
  });
});

describe('resolving from the repo a run is in', () => {
  test("a repo with no install has none, though checkride's own install holds all three", async () => {
    expect(libraryStates(ALL, CHECKOUT).map((s) => s.problem)).toEqual([null, null, null]);
    expect(libraryStates(ALL, repo)).toEqual(ALL.map((name) => ({ name, version: null, problem: 'missing' })));
    const loaded = loadLibraries(['ajv'], { repo, pm: 'pnpm' });
    expect(loaded).toHaveProperty('refusal');
  });

  test("the version it reports is the repo's copy's, not checkride's", async () => {
    await stubLibrary(repo, 'ajv', '8.0.1');
    await stubLibrary(repo, 'yaml', '2.0.0');
    expect(libraryStates(['ajv', 'yaml'], repo)).toEqual([
      { name: 'ajv', version: '8.0.1', problem: null },
      { name: 'yaml', version: '2.0.0', problem: null },
    ]);
  });

  test("it loads the repo's copies, and only the ones asked for", async () => {
    await installLibraries(repo, ['ajv']);
    const loaded = loadLibraries(['ajv'], { repo, pm: 'pnpm' });
    if (!('libraries' in loaded)) throw new Error(loaded.refusal);
    expect(typeof loaded.libraries.ajv.draft07).toBe('function');
    expect(typeof loaded.libraries.ajv.draft2020).toBe('function');
    expect(loaded.libraries.yaml).toBeUndefined();
    expect(loaded.libraries.jsonc).toBeUndefined();
    expect(Object.keys(loaded.libraries.versions)).toEqual(['ajv']);
  });

  test('all three load, each with the members the slot calls', async () => {
    await installLibraries(repo);
    const loaded = loadLibraries(ALL, { repo, pm: 'pnpm' });
    if (!('libraries' in loaded)) throw new Error(loaded.refusal);
    expect(typeof loaded.libraries.yaml?.parseDocument).toBe('function');
    expect(typeof loaded.libraries.jsonc?.parseTree).toBe('function');
    expect(Object.keys(loaded.libraries.versions)).toEqual([...ALL]);
  });
});

describe('the refusal for a library the repo lacks', () => {
  test.each([
    ['ajv', 'pnpm', 'pnpm add -D ajv@^8'],
    ['yaml', 'npm', 'npm install -D yaml@^2'],
    ['jsonc-parser', 'bun', 'bun add -d jsonc-parser@^3'],
  ] as const)('%s: the first line names the package and the install command under %s', async (missing, pm, command) => {
    await installLibraries(repo, ALL.filter((name) => name !== missing));
    const loaded = loadLibraries(ALL, { repo, pm });
    if (!('refusal' in loaded)) throw new Error('expected a refusal');
    expect(firstLine(loaded.refusal)).toBe(`checkride: the \`schema\` slot needs \`${missing}\`, which is not installed in this project: run \`${command}\`.`);
    expect(loaded.refusal).toContain(`looked for: node_modules/${missing} (${SUPPORTED_MAJORS[missing]}.x) in ${repo}`);
  });

  test('several missing are named together, in one install command', () => {
    const states = [
      { name: 'ajv', version: null, problem: 'missing' },
      { name: 'yaml', version: null, problem: 'missing' },
      { name: 'jsonc-parser', version: '3.3.1', problem: null },
    ] as const;
    expect(firstLine(libraryRefusal(states, { repo, pm: 'yarn' }) ?? '')).toBe(
      'checkride: the `schema` slot needs `ajv` and `yaml`, which are not installed in this project: run `yarn add -D ajv@^8 yaml@^2`.',
    );
  });

  test("a copy at a major the slot doesn't read is refused with the version found, before anything loads", async () => {
    await stubLibrary(repo, 'ajv', '6.12.6');
    const loaded = loadLibraries(['ajv'], { repo, pm: 'pnpm' });
    if (!('refusal' in loaded)) throw new Error('expected a refusal');
    expect(firstLine(loaded.refusal)).toBe('checkride: the `schema` slot needs `ajv` 8 (this project installs 6.12.6): run `pnpm add -D ajv@^8`.');
  });

  test('nothing is refused when every library is there', async () => {
    await installLibraries(repo);
    expect(libraryRefusal(libraryStates(ALL, repo), { repo, pm: 'pnpm' })).toBeNull();
  });
});

describe('a Yarn Plug\'n\'Play repo', () => {
  beforeEach(async () => {
    await writeFile(join(repo, '.pnp.cjs'), '');
  });

  test('is told the truth: the slot reads node_modules, which PnP does not write, so no install command is named', () => {
    const loaded = loadLibraries(['ajv', 'yaml'], { repo, pm: 'yarn' });
    if (!('refusal' in loaded)) throw new Error('expected a refusal');
    expect(firstLine(loaded.refusal)).toBe(
      "checkride: the `schema` slot reads `ajv` and `yaml` from node_modules, which Yarn Plug'n'Play doesn't write: run the standalone checkride binary, which bundles them, or set `nodeLinker: node-modules` in .yarnrc.yml.",
    );
    expect(loaded.refusal).not.toContain('yarn add');
  });

  test('one library reads in the singular', () => {
    const states = [{ name: 'ajv', version: null, problem: 'missing' }] as const;
    expect(firstLine(libraryRefusal(states, { repo, pm: 'yarn' }) ?? '')).toContain('reads `ajv` from node_modules');
    expect(firstLine(libraryRefusal(states, { repo, pm: 'yarn' }) ?? '')).toContain('which bundles it, or set');
  });

  test('a .pnp.cjs left behind by a move off Yarn does not reroute another package manager', () => {
    const loaded = loadLibraries(['ajv'], { repo, pm: 'pnpm' });
    if (!('refusal' in loaded)) throw new Error('expected a refusal');
    expect(firstLine(loaded.refusal)).toContain('run `pnpm add -D ajv@^8`');
  });

  test('a yarn repo with a node_modules that holds them is not refused at all', async () => {
    await installLibraries(repo, ['ajv']);
    expect(loadLibraries(['ajv'], { repo, pm: 'yarn' })).toHaveProperty('libraries');
  });
});

describe('an install that holds a library and cannot load it', () => {
  test('is a refusal naming what went wrong and the reinstall, never a throw', async () => {
    // A package with a version and nothing to require: a half-written install.
    await stubLibrary(repo, 'ajv', '8.20.0');
    const loaded = loadLibraries(['ajv'], { repo, pm: 'npm' });
    if (!('refusal' in loaded)) throw new Error('expected a refusal');
    expect(loaded.refusal).toMatch(/^checkride: the `schema` slot could not load its libraries from node_modules \(.*\): reinstall them with `npm install -D ajv@\^8`\.\n$/);
  });
});

describe('in the standalone binary', () => {
  beforeEach(async () => {
    fakeSea();
    await registerBundledLibraries();
  });

  test('a run in such a binary fails its check with that reason, and the run goes on', async () => {
    clearBundledLibraries();
    const run = await runSchemaCheck({ rules: [{ files: ['a.json'], schema: 's.json' }], configFile: 'checkride.config.json' }, { repo, pm: 'pnpm' });
    expect(run).toEqual({ refusal: "checkride: the schema check stopped on an error it didn't expect: this checkride binary was built without the schema slot's libraries.\n" });
  });

  test('a binary built without the libraries says so, rather than read a repo', () => {
    clearBundledLibraries();
    expect(Reflect.get(globalThis, BUNDLED_LIBRARIES)).toBeUndefined();
    expect(() => loadLibraries(ALL, { repo: CHECKOUT, pm: 'pnpm' })).toThrow("this checkride binary was built without the schema slot's libraries");
  });

  test("the bundled copies load, and a repo's own install is never consulted", async () => {
    // A copy the slot would refuse on the npm channel: the binary doesn't look at it.
    await stubLibrary(repo, 'ajv', '6.12.6');
    const loaded = loadLibraries(ALL, { repo, pm: 'pnpm' });
    if (!('libraries' in loaded)) throw new Error(loaded.refusal);
    expect(typeof loaded.libraries.ajv.draft2020).toBe('function');
    expect(typeof loaded.libraries.yaml?.parseDocument).toBe('function');
    expect(typeof loaded.libraries.jsonc?.parseTree).toBe('function');
    expect(loaded.libraries.versions.ajv).toMatch(/^8\./);
  });

  test('every library reads as there, at its bundled version, in a repo with no install', async () => {
    const states = libraryStates(ALL, repo);
    expect(states.map((s) => s.problem)).toEqual([null, null, null]);
    expect(states.map((s) => Number.parseInt(s.version ?? '', 10))).toEqual([8, 2, 3]);
  });
});

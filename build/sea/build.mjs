// Build the standalone `checkride` binary for the host platform (R14.1).
//
// A Node single executable application: esbuild bundles `./entry.mjs`, which
// is the built CLI (`dist/cli.js`) behind the three libraries the `schema`
// slot validates with (`./schema-libraries.mjs`: `ajv`, `yaml` and
// `jsonc-parser`, at the versions package.json pins as dev dependencies),
// into one ES module, every file under `templates/`, `schema/`
// and `skills/` is embedded as an asset beside `package.json`, under the
// relative path `src/resources.ts` reads it by, and `node --build-sea` injects
// both into a copy of the Node binary. Run as `pnpm build:sea`, which builds
// `dist/` first. Never part of `pnpm check`.
//
// The Node that is embedded is pinned in `.node-version` beside this script,
// and it is also the Node that does the embedding: `--build-sea` copies the
// binary it runs from. When this script runs under any other version it
// reaches the pinned one through mise (`mise exec node@<version>`), which
// installs it on first use, so the binary is the same whatever Node the
// checkout develops on. The release workflow installs the same file's version
// with setup-node, so there this script embeds the Node it runs on.
// CHECKRIDE_SEA_NODE names a Node binary to use instead, whose version must
// still be the pinned one.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The Node embedded in the binary: the Active LTS line, pinned exactly. Bump the file on purpose, then run the binary e2e. */
const SEA_NODE_VERSION = readFileSync(join(HERE, '.node-version'), 'utf8').trim();

/** The directories whose every file the binary embeds, as `src/resources.ts` serves them. */
const ASSET_ROOTS = ['templates', 'schema', 'skills'];

const ROOT = join(HERE, '..', '..');

/** The `require` the bundle's CommonJS modules reach Node's built-ins through. */
const REQUIRE_BUILTINS = [
  'const require = (id) => {',
  '  const builtin = process.getBuiltinModule(id);',
  '  if (builtin === undefined) throw new Error(`the checkride binary bundles no module named ${id}`);',
  '  return builtin;',
  '};',
].join('\n');

/** Where the build lands: gitignored, outside `dist/`, so `npm pack` never sees it. */
const OUT_DIR = join(ROOT, '.sea');

/** Every file under `dir`, as paths relative to the package root with `/` separators, sorted. */
function filesUnder(dir) {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .toSorted();
}

/** The asset map: each embedded file's key (its relative path) to where it sits on disk. */
function assets() {
  const keys = ['package.json', ...ASSET_ROOTS.flatMap(filesUnder)];
  return Object.fromEntries(keys.map((key) => [key, join(ROOT, key)]));
}

/** The argv prefix that runs the pinned Node: this one when it matches, CHECKRIDE_SEA_NODE when set, else mise's copy. */
function pinnedNode() {
  const named = process.env['CHECKRIDE_SEA_NODE'];
  if (named !== undefined && named !== '') return [named];
  if (process.versions.node === SEA_NODE_VERSION) return [process.execPath];
  return ['mise', 'exec', `node@${SEA_NODE_VERSION}`, '--', 'node'];
}

/** Run `argv`, echoing its output, and die with its failure. */
function run(argv, options = {}) {
  const [command, ...args] = argv;
  return execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options });
}

/** Refuse to embed a Node other than the pinned one: the binary's `doctor` reports it, and the release names it. */
function assertPinned(node) {
  const version = run([...node, '--version']).trim();
  if (version !== `v${SEA_NODE_VERSION}`) {
    throw new Error(`build:sea embeds Node ${SEA_NODE_VERSION}, but ${node.join(' ')} is ${version}`);
  }
}

async function main() {
  const node = pinnedNode();
  assertPinned(node);

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // Walked once: the asset map the config embeds is the one the last line counts.
  const embedded = assets();

  const bundle = join(OUT_DIR, 'checkride.mjs');
  await build({
    entryPoints: [join(HERE, 'entry.mjs')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    // The npm package depends on nothing, and nothing under `dist/` imports
    // the `schema` slot's libraries: it loads them from the repo it runs in.
    // The binary has no install to load them from, so `./schema-libraries.mjs`
    // imports all three and this bundle carries them. An ES module build is
    // preferred where a package ships one, since jsonc-parser's `main` is a
    // UMD file whose `require` calls no bundler can follow.
    mainFields: ['module', 'main'],
    // ajv and yaml are CommonJS, and `require` a Node built-in here and
    // there, which an ES module bundle has no `require` for. Everything else
    // they require is in the bundle, so built-ins are all this one answers.
    banner: { js: REQUIRE_BUILTINS },
    target: `node${SEA_NODE_VERSION}`,
    legalComments: 'none',
    logLevel: 'warning',
  });

  const output = join(OUT_DIR, 'checkride');
  const config = join(OUT_DIR, 'sea-config.json');
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        main: bundle,
        mainFormat: 'module',
        output,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        assets: embedded,
      },
      null,
      2,
    )}\n`,
  );
  run([...node, '--build-sea', config], { stdio: ['ignore', 2, 2] });
  chmodSync(output, 0o755);

  // An injected Mach-O no longer matches the signature Node shipped with, and
  // Apple silicon refuses to run an unsigned one: sign it ad hoc.
  if (process.platform === 'darwin') run(['codesign', '--force', '--sign', '-', output]);

  const megabytes = (statSync(output).size / 1024 / 1024).toFixed(1);
  process.stderr.write(`build:sea: Node ${SEA_NODE_VERSION}, ${Object.keys(embedded).length} assets, ${megabytes} MB\n`);
  process.stdout.write(`${output}\n`);
}

await main();

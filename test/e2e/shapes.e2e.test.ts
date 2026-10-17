import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { describeWithToolchain } from '../helpers/toolchains.js';

// cspell:ignore recieve

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli.js');
const BIG = { maxBuffer: 32 * 1024 * 1024 };

/** Each shape, and where it keeps a `test/` directory: the root, plus one package. */
const SHAPES = [
  { shape: 'flat', homes: [''] },
  { shape: 'monorepo', homes: ['', join('libs', 'core')] },
  { shape: 'hybrid', homes: ['', join('packages', 'core')] },
] as const;

/**
 * A fake repo that breaks every tool a scaffold runs. Under `test/fixtures/`
 * it is data, and every tool must leave it alone. Anywhere else it fails each
 * of them, which is what keeps the green half of the probe test honest.
 */
const PROBE: Record<string, string> = {
  // docs: no space after the hash, no blank lines around the list.
  // links: a relative target that isn't there. spell: a common typo.
  'README.md': '#Malformed heading\n* a list\nA [dead link](./missing.md) to recieve.\n',
  // lint: a debugger statement. dead: a dependency no package.json lists.
  // struct: a default export, a class, an extensionless import and a deep
  // sibling import. typecheck-tests: three imports that resolve to nothing.
  'src/index.ts': [
    "import { leftPad } from 'left-pad';",
    "import { helper } from './helper';",
    "import { deep } from '../sibling/internal.js';",
    '',
    'export class Probe {}',
    '',
    'export default function probe(): string {',
    '  debugger;',
    '  return leftPad(helper() + deep(), 2);',
    '}',
    '',
  ].join('\n'),
  // test: a focused test that fails. struct: a loose test file, outside
  // test/{integration,e2e,contract,helpers}/.
  'test/loose.test.ts': [
    "import { expect, it } from 'vitest';",
    '',
    "it.only('fails whenever a tool runs it', () => {",
    '  expect(1).toBe(2);',
    '});',
    '',
  ].join('\n'),
};

/** The checks the probe fails when it sits outside `test/fixtures/`. */
const PROBED_CHECKS = ['dead', 'docs', 'links', 'lint', 'spell', 'struct', 'test', 'typecheck-tests'];

/** The scaffold's slots. The config `init` writes names each of them, so none runs on detection. */
const SLOT_CHECKS = ['types', 'lint', 'struct', 'dead', 'test', 'docs', 'links', 'spell'];

/**
 * The tag every check's status line ends with, by check name: `[config]` for
 * each slot, and `[custom]` for `typecheck-tests`, the check the config adds
 * beside them.
 */
const TAGS = { ...Object.fromEntries(SLOT_CHECKS.map((name) => [name, '[config]'])), 'typecheck-tests': '[custom]' };

/**
 * A test vitest passes, because it strips types without checking them, so
 * only a type check can fail it. That is the gap `typecheck-tests` closes.
 */
const TYPE_ERROR_TEST = [
  "import { expect, test } from 'vitest';",
  '',
  "const answer: number = 'forty-two';",
  '',
  "test('runs without a type check', () => {",
  "  expect(answer).toBe('forty-two');",
  '});',
  '',
].join('\n');

/** The ast-grep rules it breaks there, each of which must ignore fixtures. */
const PROBED_RULES = ['no-class', 'no-deep-sibling-import', 'no-default-export', 'require-js-extension', 'test-dir-layout'];

/**
 * The encoded lesson of the predecessor: a verification product whose freshly
 * generated output fails its own verification is broken. Every shape `init`
 * generates must `pnpm install` and pass `checkride` with exit 0.
 */
async function generateInstall(dir: string, shape: string): Promise<void> {
  await execFileP('node', [CLI, 'init', '--shape', shape, '--name', 't', '--scope', '@demo'], { cwd: dir, ...BIG });

  // The unpublished checkride devDep can't resolve from the registry yet; drop
  // it and exercise the built CLI directly (this tests init output + the run).
  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { devDependencies?: Record<string, string> };
  if (pkg.devDependencies) delete pkg.devDependencies['checkride'];
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2));

  await execFileP('pnpm', ['install'], { cwd: dir, ...BIG });
}

/** Each status line's closing provenance tag (`[config]`, `[detected: …]`, …), keyed by its check's name. */
function statusTags(stderr: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const line of stderr.split('\n')) {
    const name = /^ {2}[✔✘] (\S+) /.exec(line)?.[1];
    if (name !== undefined) tags[name] = /\[[^\]]*\]$/.exec(line)?.[0] ?? '';
  }
  return tags;
}

/** Run checkride and report its exit code, the checks that failed, and how each check's status line ends. */
async function check(dir: string): Promise<{ code: number; failed: string[]; tags: Record<string, string> }> {
  let code = 0;
  let stderr = '';
  try {
    ({ stderr } = await execFileP('node', [CLI], { cwd: dir, ...BIG }));
  } catch (err) {
    const failure = err as { code?: unknown; stderr?: string };
    code = typeof failure.code === 'number' ? failure.code : -1;
    stderr = failure.stderr ?? '';
  }
  const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as {
    checks: { name: string; ok: boolean }[];
  };
  return { code, failed: summary.checks.filter((c) => !c.ok).map((c) => c.name).toSorted(), tags: statusTags(stderr) };
}

/** The ids of the ast-grep rules the last run's `struct` check matched. */
async function firedRules(dir: string): Promise<string[]> {
  const matches = JSON.parse(await readFile(join(dir, '.check', 'struct.json'), 'utf8')) as { ruleId: string }[];
  return [...new Set(matches.map((m) => m.ruleId))];
}

/** The files the last run's `typecheck-tests` reported an error in, read from tsc's `<file>(<line>,<col>): error` lines. */
async function typeErrorFiles(dir: string): Promise<Set<string>> {
  const output = await readFile(join(dir, '.check', 'typecheck-tests.stdout.txt'), 'utf8');
  return new Set([...output.matchAll(/^(\S+)\(\d+,\d+\): error TS\d+/gm)].map((m) => m[1] ?? ''));
}

async function plant(dir: string, at: string, files: Record<string, string> = PROBE): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([rel, body]) => {
      const file = join(dir, at, rel);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, body);
    }),
  );
}

for (const { shape, homes } of SHAPES) {
  describe(`${shape} shape`, () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'checkride-e2e-shape-'));
      await generateInstall(dir, shape);
    });
    afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

    test('init -> pnpm install -> checkride exits 0, with every slot tagged [config] and typecheck-tests [custom]', async () => {
      expect(await check(dir)).toEqual({ code: 0, failed: [], tags: TAGS });
    });

    test('a type error in test/integration/ fails typecheck-tests and nothing else', async () => {
      const planted = homes.map((home) => join(home, 'test', 'integration', 'typed.test.ts'));
      await Promise.all(homes.map((home) => plant(dir, join(home, 'test', 'integration'), { 'typed.test.ts': TYPE_ERROR_TEST })));
      expect(await check(dir)).toEqual({ code: 1, failed: ['typecheck-tests'], tags: TAGS });
      expect(await typeErrorFiles(dir)).toEqual(new Set(planted));
      await Promise.all(homes.map((home) => rm(join(dir, home, 'test', 'integration'), { recursive: true })));
    });

    test('a broken probe fails every tool outside test/fixtures/ and none inside it', async () => {
      await Promise.all(homes.map((home) => plant(dir, join(home, 'test', 'probe'))));
      expect(await check(dir)).toEqual({ code: 1, failed: PROBED_CHECKS, tags: TAGS });
      expect(await firedRules(dir)).toEqual(expect.arrayContaining(PROBED_RULES));
      await Promise.all(homes.map((home) => rm(join(dir, home, 'test', 'probe'), { recursive: true })));

      await Promise.all(homes.map((home) => plant(dir, join(home, 'test', 'fixtures', 'probe'))));
      expect(await check(dir)).toEqual({ code: 0, failed: [], tags: TAGS });
    });
  });
}

/**
 * The shapes `init --lang go|rust` writes (R11.6). Each one, after the setup
 * `init` prints that needs the network, is green with every check resolving
 * through a pin, since the config sets `requirePins`; and its dialect rules
 * fail `struct` on the plant S4 or S5 names for it.
 */
const LANG_SHAPES = [
  { lang: 'go', shape: 'module', setup: [['go', 'get', '-tool', 'golang.org/x/tools/cmd/deadcode@v0.52.0']], plant: { 'internal/greet/dot.go': 'package greet\n\nimport . "strings"\n\nvar _ = ToUpper\n' }, rule: 'go-no-dot-import' },
  { lang: 'go', shape: 'workspace', setup: [['go', 'get', '-C', 'core', '-tool', 'golang.org/x/tools/cmd/deadcode@v0.52.0']], plant: { 'core/greet/dot.go': 'package greet\n\nimport . "strings"\n\nvar _ = ToUpper\n' }, rule: 'go-no-dot-import' },
  { lang: 'rust', shape: 'crate', setup: [], plant: { 'src/glob.rs': 'pub use std::collections::*;\n' }, rule: 'rust-no-glob-reexport' },
  { lang: 'rust', shape: 'workspace', setup: [], plant: { 'crates/core/src/glob.rs': 'pub use std::collections::*;\n' }, rule: 'rust-no-glob-reexport' },
] as const;

/** The checks a language scaffold runs, by name: its target's, the Node-free repo slots, and `unclaimed`. */
function langChecks(lang: 'go' | 'rust'): string[] {
  const target = lang === 'go' ? ['types', 'lint', 'dead', 'test'] : ['types', 'lint', 'dead', 'test', 'snippets'];
  return [...target.map((slot) => `app:${slot}`), 'struct', 'docs', 'links', 'spell', 'unclaimed'].toSorted();
}

describeWithToolchain('repo')('init --lang', () => {
  for (const { lang, shape, setup, plant: probe, rule } of LANG_SHAPES) {
    describeWithToolchain(lang)(`${lang} ${shape} shape`, () => {
      let dir: string;
      beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), `checkride-e2e-${lang}-${shape}-`));
        await execFileP('node', [CLI, 'init', '--lang', lang, '--shape', shape, '--name', 't-demo'], { cwd: dir, ...BIG });
        await execFileP('git', ['init', '-q'], { cwd: dir });
        // Setup may download; the checks never do.
        for (const [command, ...args] of setup) await execFileP(command, args, { cwd: dir, ...BIG });
      }, 300_000);
      afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

      test('init -> its setup -> checkride exits 0, every tool through a pin', async () => {
        const result = await check(dir);
        expect(result.code).toBe(0);
        const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as {
          checks: { name: string; ok: boolean; argv?: string[]; pin_source?: string }[];
        };
        expect(summary.checks.map((c) => c.name).toSorted()).toEqual(langChecks(lang));
        for (const c of summary.checks.filter((entry) => entry.argv !== undefined)) expect(c.pin_source, c.name).not.toBe('path');
      });

      test(`a ${rule} plant fails struct`, async () => {
        await plant(dir, '', probe);
        // A Go dot import fails golangci-lint's staticcheck too; struct is the check S4 names.
        expect((await check(dir)).failed).toContain('struct');
        expect(await firedRules(dir)).toEqual([rule]);
        await Promise.all(Object.keys(probe).map((rel) => rm(join(dir, rel))));
      });
    });
  }
});

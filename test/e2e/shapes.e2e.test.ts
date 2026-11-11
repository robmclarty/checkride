import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { BINARY_PIN, CI_MARKERS, describeWithMise, findMise, withNpmPin, withoutCheckridePin } from '../helpers/mise.js';
import { setupStep } from '../helpers/setup.js';
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

/** How much of each file a red check's report keeps: its last lines, and at most this many characters of them. */
const TAIL_LINES = 20;
const TAIL_CHARS = 2000;

/** The tail of `file`, bounded by {@link TAIL_LINES} and {@link TAIL_CHARS}, or `''` when there is no such file. */
async function tail(file: string): Promise<string> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS);
}

/**
 * What each red check captured, for an assertion's message. The temp directory
 * goes with `afterAll`, so a log that names only the exit code — or only the
 * slot — leaves a CI-only failure with nothing to read. Each red check reports
 * its two streams and, when the tool wrote its findings as JSON instead, the
 * `output_file` the summary names; all three are relative to `.check/`, a
 * target's check under its `<target>/`.
 */
async function redReport(dir: string): Promise<string> {
  const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as {
    checks: { name: string; ok: boolean; target?: string; slot?: string; output_file: string | null }[];
  };
  const reports = await Promise.all(
    summary.checks
      .filter((c) => !c.ok)
      .map(async (c) => {
        const stem = c.target !== undefined && c.slot !== undefined ? `${c.target}/${c.slot}` : c.name;
        const files = [`${stem}.stderr.txt`, `${stem}.stdout.txt`, ...(c.output_file === null ? [] : [c.output_file])];
        const excerpts = await Promise.all(files.map(async (file) => `--- ${file}\n${await tail(join(dir, '.check', file))}`));
        return `${c.name} failed:\n${excerpts.join('\n')}`;
      }),
  );
  return reports.join('\n\n');
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
        // No `mise trust`: the scaffold's mise.toml sets no tool option, so mise
        // reads it as written. The `mise install` init prints it skips, since
        // the dev mise.toml has the same versions of every tool but checkride,
        // which these cases run from the local build: its entry comes out, so
        // no `mise exec -- <tool>` meets a pin nothing here installed.
        const tomlPath = join(dir, 'mise.toml');
        const toml = await readFile(tomlPath, 'utf8');
        expect(toml).toMatch(BINARY_PIN);
        await writeFile(tomlPath, withoutCheckridePin(toml));
        // Setup may download; the checks never do.
        for (const [command, ...args] of setup) await setupStep(command, args, { cwd: dir });
      }, 300_000);
      afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

      test('init -> its setup -> checkride exits 0, every tool through a pin', async () => {
        const result = await check(dir);
        // The slots by name, and what each captured: the message is what a run
        // on a CI leg this machine can't reproduce leaves behind.
        expect(result.failed, await redReport(dir)).toEqual([]);
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

const MISE = findMise();

/**
 * What a run inherits from mise's environment that would trust a file unasked:
 * `MISE_YES` makes `mise which` trust the config it reads,
 * `MISE_TRUSTED_CONFIG_PATHS` trusts whatever it names, and under CI mise
 * trusts every file.
 */
const TRUSTING = new Set(['MISE_YES', 'MISE_TRUSTED_CONFIG_PATHS', ...CI_MARKERS]);

/**
 * A `mise.toml` before `mise trust` (D82). A scaffold's own needs none, so the
 * case pins checkride the npm route's way, whose entry sets a tool option:
 * mise won't read that file until someone trusts it, and a check it pins
 * refuses naming `mise trust`. checkride runs from Node here, not through
 * `mise exec`, which trusts the config it reads, and mise keeps what it trusts
 * in a state directory of the case's own. No Go is needed: the refusal comes
 * before anything runs.
 */
describeWithMise(MISE)('an untrusted mise.toml', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'checkride-e2e-untrusted-')));
    await mkdir(join(dir, 'repo'));
    await execFileP('node', [CLI, 'init', '--lang', 'go', '--name', 't-demo'], { cwd: join(dir, 'repo'), ...BIG });
    await execFileP('git', ['init', '-q'], { cwd: join(dir, 'repo') });
    const tomlPath = join(dir, 'repo', 'mise.toml');
    await writeFile(tomlPath, withNpmPin(await readFile(tomlPath, 'utf8')));
  }, 60_000);
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  test('a check in a repo whose mise.toml sets a tool option, before mise trust, refuses naming mise trust, not mise install', async () => {
    const repo = join(dir, 'repo');
    const inherited = Object.entries(process.env).filter(([key]) => !TRUSTING.has(key));
    const env = { ...Object.fromEntries(inherited), MISE_STATE_DIR: join(dir, 'state') };
    const run = spawnSync(process.execPath, [CLI, '--only', 'app:lint'], { cwd: repo, env, encoding: 'utf8' });
    expect(run.status).toBe(1);
    const refusal = await readFile(join(repo, '.check', 'app', 'lint.stderr.txt'), 'utf8');
    expect(refusal).toContain("the `lint` slot's `golangci-lint` is pinned through mise, but mise won't read a config file here until it's trusted.");
    expect(refusal).toMatch(/^ {2}mise which --version golangci-lint: .* not trusted\.$/m);
    expect(refusal).toContain('\n  mise trust\n');
    expect(refusal).not.toContain('mise install');
  }, 60_000);
});

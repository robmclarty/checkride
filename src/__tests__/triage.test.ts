/**
 * Contract corners for the triage reader.
 *
 * Every case here is a specific wrong answer the five-line AGENTS.md procedure
 * would give: it says "read `.check/summary.json` to find which check failed"
 * and stops — never mentioning exit 2 vs exit 1, vacuous green, narrow green,
 * `baselined`, `skipped`, `exit_code: -1`, a bumped `schema_version`, a stale
 * artifact, or a failing slot whose raw output the summary never names.
 *
 * Fixtures are real temp repos with a real `.check/`, because mtimes are load-
 * bearing (the freshness window) and a mocked filesystem would test the mock.
 * Only the two things a test cannot reach — spawning a toolchain, and the clock
 * — are injected.
 */

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import type { SpawnOutcome, TriageEnv, TriageReport } from '../triage/index.js';
import { isHarnessProblem, renderTriage, resolveCheckrideCli, triage } from '../triage/index.js';

const RUN_END_ISO = '2026-07-24T02:15:16.214Z';
const RUN_DURATION_MS = 90_000;
/** The freshness window's start: `timestamp` minus the run's own duration. */
const WINDOW_START = Date.parse(RUN_END_ISO) - RUN_DURATION_MS;
/** The reader's clock: the gate starts just before the run it is about to read. */
const GATE_STARTED = WINDOW_START - 500;
const FRESH_MTIME = WINDOW_START + 1000;
const FOUR_DAYS_MS = 4 * 86_400_000;
const STALE_MTIME = WINDOW_START - FOUR_DAYS_MS;

/** A stream with far more lines than any excerpt keeps, ending in `marker`. */
function noisyStream(marker: string): string {
  return `${'filler line\n'.repeat(4000)}${marker}`;
}

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type CheckJson = Record<string, unknown>;

/** A summary `checks[]` entry — passing unless overridden. */
function check(name: string, over: CheckJson = {}): CheckJson {
  return { name, adapter: name, description: `${name} check`, ok: true, exit_code: 0, duration_ms: 10, output_file: null, ...over };
}

/** A schema-1 summary whose `ok`/`checks_run` follow from its entries. */
function summaryOf(checks: CheckJson[], over: CheckJson = {}): CheckJson {
  return {
    schema_version: 1,
    timestamp: RUN_END_ISO,
    ok: checks.every((c) => c['ok'] !== false),
    checks_run: checks.filter((c) => c['skipped'] !== true).length,
    total_duration_ms: RUN_DURATION_MS,
    checks,
    ...over,
  };
}

type Artifact = { text?: string; mtimeMs?: number };

type RepoSpec = {
  /** `scripts.check`; `null` writes a package.json with no check script at all. */
  script?: string | null;
  config?: CheckJson;
  summary?: CheckJson;
  summaryMtimeMs?: number;
  artifacts?: Record<string, Artifact>;
  /** Place a `node_modules/checkride/dist/cli.js` so the doctor fold-in resolves. */
  installCheckride?: boolean;
};

async function stamp(path: string, mtimeMs: number): Promise<void> {
  await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
}

async function makeRepo(spec: RepoSpec = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'checkride-triage-'));
  dirs.push(dir);
  const scripts = spec.script === null ? {} : { check: spec.script ?? 'checkride' };
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts }));
  if (spec.config) await writeFile(join(dir, 'checkride.config.json'), JSON.stringify(spec.config));
  if (spec.installCheckride) {
    const cliDir = join(dir, 'node_modules', 'checkride', 'dist');
    await mkdir(cliDir, { recursive: true });
    await writeFile(join(cliDir, 'cli.js'), '');
  }
  const checkDir = join(dir, '.check');
  await mkdir(checkDir, { recursive: true });
  if (spec.summary) {
    const path = join(checkDir, 'summary.json');
    await writeFile(path, JSON.stringify(spec.summary));
    await stamp(path, spec.summaryMtimeMs ?? FRESH_MTIME);
  }
  await Promise.all(
    Object.entries(spec.artifacts ?? {}).map(async ([file, artifact]) => {
      const path = join(checkDir, file);
      await writeFile(path, artifact.text ?? 'output\n');
      await stamp(path, artifact.mtimeMs ?? FRESH_MTIME);
    }),
  );
  return dir;
}

const CLEAN_SPAWN: SpawnOutcome = { code: 0, signal: null, stdout: '', stderr: '', error: null };

/**
 * A fake process surface. `gate` answers `<pm> run check`; `doctor` answers the
 * `checkride doctor --json` probe, which only the broken-harness branch makes.
 */
function fakeEnv(cfg: { gate?: Partial<SpawnOutcome>; doctor?: Partial<SpawnOutcome> } = {}): TriageEnv {
  return {
    now: () => GATE_STARTED,
    timeoutMs: 1000,
    spawn: (_command, args) =>
      Promise.resolve({ ...CLEAN_SPAWN, ...(args.includes('doctor') ? cfg.doctor : cfg.gate) }),
  };
}

/** Run a triage and render it — the two things the skill actually sees. */
async function run(spec: RepoSpec, env: TriageEnv): Promise<{ report: TriageReport; text: string }> {
  const report = await triage(await makeRepo(spec), env);
  return { report, text: renderTriage(report) };
}

describe('exit code branching', () => {
  test('exit 1 is red: the checks ran and some failed', async () => {
    const { report, text } = await run(
      { summary: summaryOf([check('types', { ok: false, exit_code: 2 }), check('lint')]) },
      fakeEnv({ gate: { code: 1 } }),
    );
    expect(report.gate.verdict).toBe('red');
    expect(report.doctor).toBeNull();
    expect(report.failing.map((r) => r.slot)).toEqual(['types']);
    expect(text).toContain('**red** — 1 of 2 executed check(s) failed');
  });

  /**
   * A package manager refusing to start the script exits 1 — the same code a
   * red pipeline uses. Left unclassified, this reader confirmed the red a gate
   * had already reported and pointed at slots that never ran, which is the exact
   * confusion the reader exists to end.
   */
  test('exit 1 with a launch refusal and no summary is not red — nothing ran', async () => {
    const { report, text } = await run(
      { installCheckride: true },
      fakeEnv({
        gate: {
          code: 1,
          stderr:
            '[ERR_PNPM_UNSUPPORTED_ENGINE] Unsupported environment (bad pnpm and/or Node.js version)\n' +
            'Expected version: >=22 <23\nGot: v24.9.0\n',
        },
      }),
    );
    expect(report.gate.verdict).toBe('could-not-start');
    expect(report.gate.refusal).toContain('engines');
    expect(text).toContain('**the gate could not start**');
    expect(text).toContain('no check ran and no artifact was written');
    // The environment is the entire finding, so `doctor` comes with it.
    expect(report.doctor).not.toBeNull();
  });

  /**
   * The guard. A summary written by this run proves the pipeline started, so
   * nothing in the output can mean it did not — a check that merely printed the
   * marker must never be reclassified into an environment problem.
   */
  test('the same output with a summary from this run is still red', async () => {
    const { report } = await run(
      { summary: summaryOf([check('test', { ok: false })]) },
      fakeEnv({ gate: { code: 1, stderr: 'FAIL: expected ERR_PNPM_UNSUPPORTED_ENGINE\n' } }),
    );
    expect(report.gate.verdict).toBe('red');
    expect(report.gate.refusal).toBeNull();
  });

  test('exit 2 is a broken harness, and doctor is folded in with the diagnosis', async () => {
    const doctorReport = JSON.stringify({
      ok: false,
      checks: [
        { name: 'node', category: 'env', required: true, status: 'outdated', found: '20.1.0', expected: '>=22.18.0', hint: 'Install Node >=22.18' },
        { name: 'git', category: 'env', required: true, status: 'ok', found: '2.4', expected: null, hint: null },
        { name: 'mutation (mutation)', category: 'tool', required: false, status: 'missing', found: null, expected: null, hint: 'opt-in' },
      ],
    });
    const { report, text } = await run(
      { summary: summaryOf([check('types')]), installCheckride: true },
      fakeEnv({ gate: { code: 2, stderr: 'checkride: unknown slot `lints`\n' }, doctor: { code: 1, stdout: doctorReport } }),
    );
    expect(report.gate.verdict).toBe('harness-broken');
    expect(report.doctor?.state).toBe('ran');
    // Only the required, not-ok rows: an opt-in slot being absent is not a break.
    expect(report.doctor?.state === 'ran' && report.doctor.findings.map((f) => f.name)).toEqual(['node']);
    expect(text).toContain('**harness broken**');
    expect(text).toContain('unknown slot `lints`');
    expect(text).toContain('**node** (outdated): 20.1.0, expected >=22.18.0');
  });

  test('an off-contract exit is reported as itself, not folded into 0/1/2', async () => {
    const { report, text } = await run({}, fakeEnv({ gate: { code: 127, stderr: 'pnpm: command not found\n' } }));
    expect(report.gate.verdict).toBe('off-contract');
    expect(isHarnessProblem(report.gate.verdict)).toBe(true);
    expect(text).toContain('**off-contract exit**');
    expect(text).toContain('exit 127');
  });

  test('a gate that cannot start is an outcome, never an exception', async () => {
    const { report, text } = await run({}, fakeEnv({ gate: { code: null, error: 'spawn pnpm ENOENT' } }));
    expect(report.gate.verdict).toBe('off-contract');
    expect(text).toContain('could not start (spawn pnpm ENOENT)');
  });

  test('a repo with no check script says so instead of inventing a gate', async () => {
    const { report, text } = await run({ script: null }, fakeEnv());
    expect(report.gate.verdict).toBe('not-run');
    expect(text).toContain('**gate not run**');
    expect(text).toContain('no `check` script');
  });

  test('the reader survives a red gate with no artifacts at all', async () => {
    const { report, text } = await run({}, fakeEnv({ gate: { code: 1 } }));
    expect(report.summary.state).toBe('missing');
    expect(report.rows).toEqual([]);
    expect(text).toContain('absent; this run wrote no summary');
  });
});

/**
 * The compound `check` script `checkride init` writes — `tsc --build && node
 * dist/cli.js` — short-circuits before checkride ever runs, so a type error
 * takes the gate red with no summary to explain it. That is the ordinary way a
 * TypeScript repo fails, and the gate's own output is the only evidence of it.
 *
 * Measured on this repo: `tsc` reports on **stdout** while stderr carries only
 * pnpm's command echo, so a reader that rendered stderr alone would print the
 * echo and drop the error. Both streams render; neither is assumed.
 */
describe('a red gate that no slot explains', () => {
  const TSC_ERROR = 'src/a.ts(12,5): error TS2322: Type \'string\' is not assignable to type \'number\'.\n';
  /** What pnpm actually leaves on stderr while `tsc` reports on stdout. */
  const PNPM_ECHO = '$ tsc --build && node dist/cli.js\n';
  const COMPOUND = { script: 'tsc --build && node dist/cli.js' };

  test('the gate output is rendered, because it is the only evidence there is', async () => {
    const { report, text } = await run(
      COMPOUND,
      fakeEnv({ gate: { code: 1, stdout: TSC_ERROR, stderr: PNPM_ECHO } }),
    );
    expect(report.gate.verdict).toBe('red');
    expect(report.failing).toEqual([]);
    expect(text).toContain('**red, but no slot explains it**');
    expect(text).toContain('## gate output');
    expect(text).toContain('error TS2322');
    expect(text).toContain('the only evidence there is');
  });

  test('a diagnosis on stdout is not dropped for being on the wrong stream', async () => {
    // The measured shape: stderr holds the command echo, stdout holds the error.
    const { text } = await run(COMPOUND, fakeEnv({ gate: { code: 1, stdout: TSC_ERROR, stderr: PNPM_ECHO } }));
    expect(text).toContain('**stdout**');
    expect(text).toContain('error TS2322');
    expect(text).toContain('**stderr**');
  });

  test('a stream that caught nothing renders no block at all', async () => {
    const { text } = await run(COMPOUND, fakeEnv({ gate: { code: 1, stderr: TSC_ERROR } }));
    expect(text).toContain('**stderr**');
    expect(text).not.toContain('**stdout**');
  });

  test('a stale green summary does not become the explanation', async () => {
    const { report, text } = await run(
      { ...COMPOUND, summary: summaryOf([check('links'), check('docs')]), summaryMtimeMs: STALE_MTIME },
      fakeEnv({ gate: { code: 1, stdout: TSC_ERROR, stderr: PNPM_ECHO } }),
    );
    expect(report.fromThisRun).toBe(false);
    expect(text).toContain('**red, but no slot explains it**');
    expect(text).toContain('nothing in the table below describes this failure');
    expect(text).toContain('error TS2322');
  });

  test('with neither stream captured, it says so rather than pointing at an empty section', async () => {
    const { text } = await run({}, fakeEnv({ gate: { code: 1 } }));
    expect(text).toContain('printed nothing on either stream');
    expect(text).not.toContain('## gate output');
  });

  test('a red gate a slot DOES explain keeps the report an index, with no raw text', async () => {
    const { text } = await run(
      {
        summary: summaryOf([check('types', { ok: false, exit_code: 2 })]),
        artifacts: { 'types.stdout.txt': { text: 'error TS2322\n' } },
      },
      fakeEnv({ gate: { code: 1, stdout: 'GATE-STDOUT-MARKER\n', stderr: 'GATE-STDERR-MARKER\n' } }),
    );
    expect(text).toContain('**red** — 1 of 1 executed check(s) failed');
    expect(text).not.toContain('## gate output');
    expect(text).not.toContain('GATE-STDOUT-MARKER');
    expect(text).not.toContain('GATE-STDERR-MARKER');
  });

  test('each stream stays a bounded tail, never a log dump', async () => {
    const { text } = await run(
      {},
      fakeEnv({ gate: { code: 1, stdout: noisyStream(TSC_ERROR), stderr: noisyStream('boom\n') } }),
    );
    expect(text).toContain('error TS2322');
    expect(text).toContain('last 25 of 4001 lines');
    // Both streams together stay inside the old single-stream budget.
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(8000);
  });
});

describe('green that is not green', () => {
  test('vacuous green — ok with checks_run 0 — is called a failure wearing a pass', async () => {
    const { report, text } = await run(
      { summary: summaryOf([], { ok: true, checks_run: 0 }) },
      fakeEnv({ gate: { code: 0 } }),
    );
    expect(report.vacuous).toBe(true);
    expect(text).toContain('**vacuous green**');
    expect(text).toContain('nothing was verified');
  });

  test('narrow green — ok over a subset of the configured slots — is flagged, with the gap named', async () => {
    const { report, text } = await run(
      {
        script: 'checkride --only links,docs,spell',
        config: { checks: { links: 'links', docs: 'markdownlint-cli2', spell: 'cspell', types: 'tsc', test: 'vitest' } },
        summary: summaryOf([check('links'), check('docs'), check('spell')]),
      },
      fakeEnv({ gate: { code: 0 } }),
    );
    expect(report.coverage.uncovered).toEqual(['test', 'types']);
    expect(report.gate.narrowingFlags).toEqual(['--only']);
    expect(text).toContain('**green, but narrow**');
    expect(text).toContain('narrows the run on purpose (--only)');
    expect(text).toContain('2 had no entry in this run: test, types');
  });

  test('a disabled slot is not counted as uncovered', async () => {
    const { report } = await run(
      {
        config: { checks: { links: 'links', mutation: false } },
        summary: summaryOf([check('links')]),
      },
      fakeEnv({ gate: { code: 0 } }),
    );
    expect(report.coverage.configured).toEqual(['links']);
    expect(report.coverage.uncovered).toEqual([]);
  });

  test('full green over every configured slot is just green', async () => {
    const { report, text } = await run(
      { config: { checks: { links: 'links', docs: 'markdownlint-cli2' } }, summary: summaryOf([check('links'), check('docs')]) },
      fakeEnv({ gate: { code: 0 } }),
    );
    expect(report.coverage.uncovered).toEqual([]);
    expect(text).toContain('**green** — 2 check(s) passed');
  });

  test('with no config file the reader states the covered set rather than guessing the catalogue', async () => {
    const { report, text } = await run({ summary: summaryOf([check('links')]) }, fakeEnv({ gate: { code: 0 } }));
    expect(report.coverage.configured).toBeNull();
    expect(text).toContain('no `checkride.config.json`');
    expect(text).toContain('will not guess at the default catalogue');
  });

  test('an unparseable config makes coverage unknowable, not fatal', async () => {
    const dir = await makeRepo({ summary: summaryOf([check('links')]) });
    await writeFile(join(dir, 'checkride.config.json'), '{ not json');
    const report = await triage(dir, fakeEnv({ gate: { code: 0 } }));
    expect(report.coverage.configured).toBeNull();
  });
});

describe('the summary is an index, not evidence', () => {
  test('a schema_version this reader does not know stops it loudly', async () => {
    const { report, text } = await run(
      { summary: summaryOf([check('links')], { schema_version: 2 }) },
      fakeEnv({ gate: { code: 1 } }),
    );
    expect(report.summary.state).toBe('schema-mismatch');
    expect(report.rows).toEqual([]);
    expect(text).toContain('`schema_version` is 2, not 1; STOP');
    // The header alone is not enough: the verdict has to carry it too, or the
    // reader announces STOP and then narrates a cause anyway.
    expect(text).toContain('**red, and the summary cannot be read**');
    expect(text).not.toContain('**red, but no slot explains it**');
  });

  test('a summary predating the run is called out as an earlier run', async () => {
    const { report, text } = await run(
      { summary: summaryOf([check('links')]), summaryMtimeMs: STALE_MTIME, installCheckride: true },
      fakeEnv({ gate: { code: 2 }, doctor: { code: 0, stdout: '{"ok":true,"checks":[]}' } }),
    );
    expect(report.fromThisRun).toBe(false);
    expect(text).toContain('left by an EARLIER run');
    expect(text).toContain('predates the run just made');
  });

  test('a summary written by the run just made is trusted', async () => {
    const { report } = await run({ summary: summaryOf([check('links')]) }, fakeEnv({ gate: { code: 0 } }));
    expect(report.fromThisRun).toBe(true);
  });
});

/**
 * The case that motivated this branch: a repo whose gate is a homegrown
 * `node scripts/check.mjs` writing a checkride-shaped `.check/` — same file
 * names, no `schema_version`. Measured against a real one, the reader used to
 * fall through to the compound-script verdict and tell an agent "checkride
 * never ran, a compound script short-circuited", which was a confident,
 * specific and false diagnosis of a gate that had run all eight of its checks.
 *
 * The rule this pins: an *absent* summary is the short-circuit story; a summary
 * that exists and cannot be parsed says nothing at all, and the report must say
 * exactly that much and no more.
 */
describe('a summary this reader cannot parse', () => {
  /** No `schema_version`: the shape a non-checkride gate writes. */
  const HOMEGROWN = { ok: false, checks: [{ name: 'types', ok: false }] };
  const SCRIPT = { script: 'node scripts/check.mjs' };
  const GATE_OUT = 'types FAILED\nlint FAILED\n';

  test('it is named as not-checkride rather than as a version boundary', async () => {
    const { report, text } = await run(
      { ...SCRIPT, summary: HOMEGROWN },
      fakeEnv({ gate: { code: 1, stdout: GATE_OUT } }),
    );
    expect(report.summary.state).toBe('foreign');
    expect(text).toContain('NOT written by checkride');
    expect(text).toContain('**red, and the summary cannot be read**');
    expect(text).toContain('was not written by checkride');
    // The wrong answer: a story about checkride short-circuiting before it ran.
    expect(text).not.toContain('**red, but no slot explains it**');
    expect(text).not.toContain('short-circuits');
  });

  test('an empty table is reported as unparsed, never as nothing-failed', async () => {
    const { text } = await run({ ...SCRIPT, summary: HOMEGROWN }, fakeEnv({ gate: { code: 1, stdout: GATE_OUT } }));
    expect(text).toContain('NOT because nothing failed');
    expect(text).toContain('What this run covered is unknown');
  });

  test('coverage counts read unknown, not zero — a zero is a measurement', async () => {
    const { text } = await run({ ...SCRIPT, summary: HOMEGROWN }, fakeEnv({ gate: { code: 1, stdout: GATE_OUT } }));
    expect(text).toContain('covered: unknown');
    expect(text).not.toContain('covered: 0 slot(s) ran, 0 skipped');
  });

  test('baselined and skipped are called unknown, because both are silent by construction', async () => {
    const { text } = await run({ ...SCRIPT, summary: HOMEGROWN }, fakeEnv({ gate: { code: 1, stdout: GATE_OUT } }));
    expect(text).toContain('`baselined` and `skipped` counts are **unknown**, not zero');
  });

  test('the gate output still renders: with no index it is the only record of the run', async () => {
    const { text } = await run({ ...SCRIPT, summary: HOMEGROWN }, fakeEnv({ gate: { code: 1, stdout: GATE_OUT } }));
    expect(text).toContain('## gate output');
    expect(text).toContain('types FAILED');
  });

  test('`.check/` is listed with ages, so the leftovers are visible without an `ls`', async () => {
    const { report, text } = await run(
      {
        ...SCRIPT,
        summary: HOMEGROWN,
        artifacts: {
          'types.stdout.txt': { text: 'error TS2307\n' },
          'struct.stdout.txt': { mtimeMs: STALE_MTIME },
        },
      },
      fakeEnv({ gate: { code: 1, stdout: GATE_OUT } }),
    );
    expect(report.checkDir?.map((f) => f.file)).toEqual(['struct.stdout.txt', 'summary.json', 'types.stdout.txt']);
    expect(text).toContain('## .check/ contents');
    expect(text).toContain('`.check/types.stdout.txt`');
    // Freshness anchors on the gate's own start, so the leftover is still named.
    expect(text).toMatch(/`\.check\/struct\.stdout\.txt` \| [^|]+ \| stale/);
  });

  test('a parsed summary suppresses the listing: the rows are already the index', async () => {
    const { report, text } = await run(
      { summary: summaryOf([check('types', { ok: false })]), artifacts: { 'types.stdout.txt': {} } },
      fakeEnv({ gate: { code: 1 } }),
    );
    expect(report.checkDir).toBeNull();
    expect(text).not.toContain('## .check/ contents');
  });

  test('an ABSENT summary keeps the short-circuit story — the distinction is the point', async () => {
    const { report, text } = await run(
      { script: 'tsc --build && checkride' },
      fakeEnv({ gate: { code: 1, stdout: 'error TS2322\n' } }),
    );
    expect(report.summary.state).toBe('missing');
    expect(text).toContain('**red, but no slot explains it**');
    expect(text).not.toContain('**red, and the summary cannot be read**');
  });

  test('a green gate reports the pass without claiming to know what it covered', async () => {
    const { text } = await run({ ...SCRIPT, summary: { ok: true } }, fakeEnv({ gate: { code: 0 } }));
    expect(text).toContain('**green, with no index**');
    expect(text).toContain("the repo's own definition of done was met");
    expect(text).not.toContain('**green, but narrow**');
    expect(text).not.toContain('check(s) passed');
  });
});

describe('per-check reporting', () => {
  test('a failing slot the summary never names still gets its raw output found', async () => {
    // `output_file` is populated only when a tool emits JSON on stdout, so
    // `test` — the slot most likely to need triage — usually names nothing.
    const { report, text } = await run(
      {
        summary: summaryOf([check('test', { ok: false, exit_code: 1, output_file: null })]),
        artifacts: { 'test.stdout.txt': { text: 'FAIL src/a.test.ts > adds\n' } },
      },
      fakeEnv({ gate: { code: 1 } }),
    );
    expect(report.failing[0]?.raw?.chosen.file).toBe('test.stdout.txt');
    expect(text).toContain('read `.check/test.stdout.txt`');
  });

  test('a slot whose tool wrote nothing says so instead of pointing nowhere', async () => {
    const { text } = await run(
      { summary: summaryOf([check('build', { ok: false, exit_code: 1 })]) },
      fakeEnv({ gate: { code: 1 } }),
    );
    expect(text).toContain('no output file found under `.check/`');
  });

  test('every alternate candidate is named with its size, not counted', async () => {
    // markdownlint-cli2 inverts checkride's stream discipline: the chosen
    // stdout carries a count while the smaller stderr carries the location. A
    // bare `(+1)` leaves the agent guessing which sibling to open.
    const { report, text } = await run(
      {
        summary: summaryOf([check('docs', { ok: false, exit_code: 1 })]),
        artifacts: { 'docs.stdout.txt': { text: 'x'.repeat(2048) }, 'docs.stderr.txt': { text: 'y'.repeat(512) } },
      },
      fakeEnv({ gate: { code: 1 } }),
    );
    expect(report.failing[0]?.raw?.candidates.map((c) => c.file)).toEqual(['docs.stdout.txt', 'docs.stderr.txt']);
    expect(text).toContain('read `.check/docs.stdout.txt` (2.0 KB); also: `.check/docs.stderr.txt` (512 B)');
    // The table stays width-constrained; `(+N)` is the compromise there only.
    expect(text).toContain('`.check/docs.stdout.txt` (+1)');
  });

  test('a stale alternate carries its age, so it is never opened as this run\'s output', async () => {
    const { text } = await run(
      {
        summary: summaryOf([check('test', { ok: false, exit_code: 1 })]),
        artifacts: {
          'test.json': { text: 'z'.repeat(4096), mtimeMs: STALE_MTIME },
          'test.stdout.txt': { text: 'FAIL src/a.test.ts\n' },
        },
      },
      fakeEnv({ gate: { code: 1 } }),
    );
    expect(text).toContain('; also: `.check/test.json` (4.0 KB, stale 4.0d)');
  });

  test('a slot with one candidate gets no alternates clause at all', async () => {
    const { text } = await run(
      {
        summary: summaryOf([check('lint', { ok: false, exit_code: 1, output_file: 'lint.json' })]),
        artifacts: { 'lint.json': { text: '[]' } },
      },
      fakeEnv({ gate: { code: 1 } }),
    );
    expect(text).toContain('read `.check/lint.json` (2 B)');
    expect(text).not.toContain('; also:');
  });

  test('the table carries artifact SIZES, never artifact contents', async () => {
    const secret = 'THIS-IS-THE-ARTIFACT-BODY';
    const { text } = await run(
      {
        summary: summaryOf([check('lint', { ok: false, exit_code: 1, output_file: 'lint.json' })]),
        artifacts: { 'lint.json': { text: `${secret}${'x'.repeat(5000)}` } },
      },
      fakeEnv({ gate: { code: 1 } }),
    );
    expect(text).not.toContain(secret);
    expect(text).toContain('4.9 KB');
  });

  test('baselined findings are surfaced instead of being reported as clean', async () => {
    const { report, text } = await run(
      { summary: summaryOf([check('lint', { baselined: 4 })]) },
      fakeEnv({ gate: { code: 0 } }),
    );
    expect(report.rows[0]?.baselined).toBe(4);
    expect(text).toContain('`baselined: 4`');
    expect(text).toContain('does not mean clean');
  });

  test('a skipped slot names its reason and offers no leftover file', async () => {
    const { report, text } = await run(
      {
        summary: summaryOf([check('mutation', { skipped: true, reason: 'opt-in, not selected', exit_code: null, duration_ms: 0 })]),
        artifacts: { 'mutation.json': { text: '{}', mtimeMs: STALE_MTIME } },
      },
      fakeEnv({ gate: { code: 0 } }),
    );
    expect(report.rows[0]?.status).toBe('skipped');
    expect(report.rows[0]?.raw).toBeNull();
    expect(report.coverage.skipped).toEqual(['mutation']);
    expect(text).toContain('`mutation` skipped: opt-in, not selected');
  });

  test('exit_code -1 is named a harness problem, not a finding', async () => {
    const { text } = await run(
      { summary: summaryOf([check('security', { ok: false, exit_code: -1 })]) },
      fakeEnv({ gate: { code: 1 } }),
    );
    expect(text).toContain('`exit_code: -1`');
    expect(text).toContain('failed to spawn or timed out');
  });

  /**
   * The counterpart to the test above, and the gap that let a real defect
   * through: a slot refused because its tool is not a declared dependency
   * (`missingToolOutcome`) exits 1, so it must read as a finding. While it
   * carried -1 the caveat above fired on it and told the reader the actionable
   * failure was a harness problem to disregard.
   */
  test('a refused slot is not discounted as a harness problem', async () => {
    const { text } = await run(
      { summary: summaryOf([check('lint', { ok: false, exit_code: 1 })]) },
      fakeEnv({ gate: { code: 1 } }),
    );
    expect(text).not.toContain('failed to spawn or timed out');
    expect(text).not.toContain('not a finding');
  });

  test('a stale artifact is labelled with its age, never silently read as current', async () => {
    const { report, text } = await run(
      {
        summary: summaryOf([check('mutation', { ok: false, exit_code: 1, output_file: 'mutation.json' })]),
        artifacts: { 'mutation.json': { text: '{}', mtimeMs: STALE_MTIME } },
      },
      fakeEnv({ gate: { code: 1 } }),
    );
    expect(report.stale.map((f) => f.file)).toEqual(['mutation.json']);
    expect(text).toContain('stale 4.0d');
    expect(text).toContain("4.0d older than this run's start");
  });
});

describe('digest', () => {
  test('a fresh digest is named as the thing to read first', async () => {
    const { text } = await run(
      {
        summary: summaryOf([check('lint', { ok: false, exit_code: 1 })]),
        artifacts: { 'digest.md': { text: '# checkride failure digest\n' } },
      },
      fakeEnv({ gate: { code: 1 } }),
    );
    expect(text).toContain("bounded excerpt of this run's failing slots");
  });

  test('a digest left by an earlier run is disowned, not offered', async () => {
    const { text } = await run(
      {
        summary: summaryOf([check('lint', { ok: false, exit_code: 1 })]),
        artifacts: { 'digest.md': { text: '# old\n', mtimeMs: STALE_MTIME } },
      },
      fakeEnv({ gate: { code: 1 } }),
    );
    expect(text).toContain('is from an EARLIER run');
    expect(text).toContain("Do not read it as this run's failures");
  });

  test('no digest explains why rather than implying there were no failures', async () => {
    const { text } = await run(
      { summary: summaryOf([check('lint', { ok: false, exit_code: 1 })]) },
      fakeEnv({ gate: { code: 1 } }),
    );
    expect(text).toContain('No `.check/digest.md`');
  });
});

describe('doctor fold-in', () => {
  test('a doctor that cannot be found is reported, not invented', async () => {
    const { text } = await run({}, fakeEnv({ gate: { code: 2 } }));
    expect(text).toContain('could not be consulted');
    expect(text).toContain('checkride is not installed in this repo');
  });

  test('a green doctor narrows the break to the script or checkride itself', async () => {
    const dir = await makeRepo({ installCheckride: true });
    const report = await triage(dir, fakeEnv({ gate: { code: 2 }, doctor: { code: 0, stdout: '{"ok":true,"checks":[]}' } }));
    expect(report.doctor?.state === 'ran' && report.doctor.ok).toBe(true);
    expect(renderTriage(report)).toContain('found no broken requirement');
  });

  test('unparseable doctor output is admitted rather than guessed at', async () => {
    const dir = await makeRepo({ installCheckride: true });
    const report = await triage(dir, fakeEnv({ gate: { code: 2 }, doctor: { code: 1, stdout: 'not json' } }));
    expect(report.doctor?.state).toBe('unreadable');
  });

  test('resolveCheckrideCli prefers the installed copy and never runs a stranger', async () => {
    const bare = await makeRepo({});
    expect(resolveCheckrideCli(bare)).toBeNull();

    const installed = await makeRepo({ installCheckride: true });
    expect(resolveCheckrideCli(installed)).toBe(join(installed, 'node_modules', 'checkride', 'dist', 'cli.js'));

    // `dist/cli.js` in a repo that is NOT checkride must never be spawned.
    const impostor = await makeRepo({});
    await mkdir(join(impostor, 'dist'), { recursive: true });
    await writeFile(join(impostor, 'dist', 'cli.js'), '');
    expect(resolveCheckrideCli(impostor)).toBeNull();

    // The dogfooding case: cwd IS the checkride package.
    await writeFile(join(impostor, 'package.json'), JSON.stringify({ name: 'checkride', scripts: { check: 'x' } }));
    expect(resolveCheckrideCli(impostor)).toBe(join(impostor, 'dist', 'cli.js'));
  });
});

describe('the rendered report', () => {
  test('opens with provenance and coverage before any finding', async () => {
    const { text } = await run(
      {
        script: 'tsc --build && node dist/cli.js',
        summary: summaryOf([check('types', { ok: false, exit_code: 2 })]),
      },
      fakeEnv({ gate: { code: 1 } }),
    );
    const order = ['# checkride triage', 'gate: `pnpm run check`', '## verdict', '## coverage', '## checks', '## failing slots'];
    const positions = order.map((marker) => text.indexOf(marker));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].toSorted((a, b) => a - b));
  });

  test('always states what it did not read', async () => {
    const { text } = await run({ summary: summaryOf([check('links')]) }, fakeEnv({ gate: { code: 0 } }));
    expect(text).toContain('This reader reports sizes and locations only');
  });

  test('is deterministic: the same report renders the same bytes', async () => {
    const spec: RepoSpec = { summary: summaryOf([check('links', { ok: false, exit_code: 1 })]) };
    const dir = await makeRepo(spec);
    const first = renderTriage(await triage(dir, fakeEnv({ gate: { code: 1 } })));
    const second = renderTriage(await triage(dir, fakeEnv({ gate: { code: 1 } })));
    expect(first).toBe(second);
  });

  test('stays compact even on a fully red run', async () => {
    const checks = Array.from({ length: 17 }, (_, i) => check(`slot${i}`, { ok: false, exit_code: 1 }));
    const artifacts = Object.fromEntries(checks.map((_, i) => [`slot${i}.stdout.txt`, { text: 'x'.repeat(20_000) }]));
    const { text } = await run({ summary: summaryOf(checks), artifacts }, fakeEnv({ gate: { code: 1 } }));
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(8000);
  });
});

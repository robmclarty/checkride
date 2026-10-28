import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter } from '../adapters.js';
import type { Baseline, BaselineEntry } from '../baseline/index.js';
import { fallowVerdict } from '../baseline/index.js';
import { runBaseline } from '../baseline-command.js';
import type { CheckRunner, Out } from '../orchestrator/index.js';
import { runChecks } from '../orchestrator/index.js';

// ---------------------------------------------------------------------------
// Fixtures: fallow v7 (schema_version 7) reports, built to shape.
// ---------------------------------------------------------------------------

/** A dead-code report with one finding per listed [category, file] pair. */
function deadCode(findings: [string, string][]): string {
  const byCategory: Record<string, { path: string }[]> = {};
  for (const [category, path] of findings) (byCategory[category] ??= []).push({ path });
  const summary: Record<string, number> = { total_issues: findings.length };
  for (const [category, items] of Object.entries(byCategory)) summary[category] = items.length;
  return JSON.stringify({ schema_version: 7, kind: 'dead-code', summary, ...byCategory });
}

/** A dupes report with the given clone-group content fingerprints. */
function dupes(fingerprints: string[]): string {
  return JSON.stringify({
    schema_version: 7,
    kind: 'dupes',
    clone_groups: fingerprints.map((fingerprint) => ({ fingerprint })),
  });
}

/** A health report with one finding per given function descriptor. */
function health(findings: { path: string; name: string; line?: number; col?: number }[]): string {
  return JSON.stringify({ schema_version: 7, kind: 'health', findings });
}

/** A dead-code report whose sole category is `unused_class_members` (symbol-less members). */
function classMembers(members: { path: string; line?: number; col?: number }[]): string {
  return JSON.stringify({
    schema_version: 7,
    kind: 'dead-code',
    summary: { total_issues: members.length, unused_class_members: members.length },
    unused_class_members: members,
  });
}

/** Capture a baseline entry the way `checkride baseline` does: the slot's keys, each counted. */
function capture(raw: string): BaselineEntry {
  const { findings } = fallowVerdict(raw, null);
  return { keys: [...findings.keys()], counts: Object.fromEntries([...findings].filter(([, n]) => n >= 2)) };
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

/** fallow 3.31.0's report of one finding in each boundary array: an import out of a zone, a forbidden call, an unzoned file. */
const BOUNDARIES = fixture('findings-fallow-dead-boundaries.json');

/** fallow 3.31.0's report of a package cycle and the file cycle under it, with a package baseline listed beside them. */
const PACKAGES = fixture('findings-fallow-dead-packages.json');

const sink = (): Out => ({ write: () => true });

function fakeAdapter(over: Partial<Adapter> & { name: string; slot: string }): Adapter {
  return { description: over.name, detect: [], command: 'node', args: [], outputFile: null, devDeps: {}, ...over };
}

/** A runner that hands the given process outcome to whatever slot runs. */
function staticRunner(outcome: { ok: boolean; exit_code: number; stdout: string }): CheckRunner {
  return () => Promise.resolve({ ...outcome, stderr: '' });
}

// ---------------------------------------------------------------------------
// fallowVerdict — the parsed pass/fail decision
// ---------------------------------------------------------------------------

describe('fallowVerdict (no baseline)', () => {
  test('findings fail the slot even though fallow exited 0', () => {
    const v = fallowVerdict(deadCode([['unused_files', 'src/a.ts']]), null);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('1 finding(s)');
    expect(v.observed).toBe(true);
    expect(new Set(v.findings.keys())).toEqual(new Set(['dead-code:unused_files:src/a.ts']));
  });

  test('a clean report passes', () => {
    const v = fallowVerdict(deadCode([]), null);
    expect(v.ok).toBe(true);
    expect(v.reason).toBeNull();
    expect(v.observed).toBe(true);
  });

  test('dupes gate on clone groups (fallow itself exits 0 on any duplication)', () => {
    const v = fallowVerdict(dupes(['dup:aaaa', 'dup:bbbb']), null);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('2 finding(s)');
    expect(new Set(v.findings.keys())).toEqual(new Set(['dupes:dup:aaaa', 'dupes:dup:bbbb']));
  });
});

describe('fallowVerdict (unreadable report → loud failure, never a silent pass)', () => {
  test('an old/unsupported schema fails with an explicit reason', () => {
    const v = fallowVerdict(JSON.stringify({ schema_version: 4, kind: 'dead-code', summary: { total_issues: 0 } }), null);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('schema_version 4');
    expect(v.observed).toBe(false); // don't ratchet a baseline from a run we couldn't read
  });

  test('the schema floor is named by its schema, not by a fallow release (fallow 2.104 emits 7 too, #8)', () => {
    const v = fallowVerdict(JSON.stringify({ schema_version: 4, kind: 'health', findings: [] }), null);
    expect(v.reason).toBe('unsupported fallow schema_version 4; checkride reads schema_version 7 and later. Upgrade fallow: `pnpm up fallow`.');
  });

  test("fallow's own error report says why fallow couldn't run, and marks the check as stopped, not as findings (#8)", () => {
    const bad = JSON.stringify({ error: true, message: 'invalid value: integer `1000000`, expected u16 in /repo/fallow.toml', exit_code: 2 });
    const v = fallowVerdict(bad, null);
    expect(v).toMatchObject({ ok: false, observed: false, stopped: true });
    expect(v.reason).toBe('fallow could not run: invalid value: integer `1000000`, expected u16 in /repo/fallow.toml');
    // A TOML syntax error runs to several lines: the first names the file and where.
    const syntax = JSON.stringify({
      error: true,
      message: 'Failed to parse config file /repo/fallow.toml: TOML parse error at line 1, column 10\n  |\n1 | entry = [\n  |          ^\nunclosed array, expected `]`\n',
      exit_code: 2,
    });
    expect(fallowVerdict(syntax, null).reason).toBe('fallow could not run: Failed to parse config file /repo/fallow.toml: TOML parse error at line 1, column 10');
    // Even with a baseline holding keys, a run that never analysed anything masks nothing.
    expect(fallowVerdict(bad, { keys: ['dead-code:unused_files:src/a.ts'] })).toMatchObject({ ok: false, observed: false, stopped: true });
  });

  test('only an error report is stopped: an unreadable report is a plain failure', () => {
    expect(fallowVerdict('', null).stopped).toBeUndefined();
    expect(fallowVerdict(JSON.stringify({ error: 'nope' }), null).stopped).toBeUndefined();
    expect(fallowVerdict(JSON.stringify({ schema_version: 4, kind: 'dupes', clone_groups: [] }), null).stopped).toBeUndefined();
  });

  test('an unrecognized kind fails', () => {
    const v = fallowVerdict(JSON.stringify({ schema_version: 7, kind: 'flags' }), null);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("kind 'flags'");
  });

  test('empty / non-JSON output fails (a crash is not clean)', () => {
    expect(fallowVerdict('', null).ok).toBe(false);
    expect(fallowVerdict('boom: fatal error', null).ok).toBe(false);
  });

  test('a missing count field fails rather than reading zero issues', () => {
    const v = fallowVerdict(JSON.stringify({ schema_version: 7, kind: 'dead-code', summary: {} }), null);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('total_issues');
  });
});

describe('fallowVerdict (with baseline)', () => {
  test('a fully-grandfathered slot passes and counts the masked findings', () => {
    const raw = deadCode([['unused_files', 'src/a.ts'], ['unused_files', 'src/b.ts']]);
    const v = fallowVerdict(raw, { keys: ['dead-code:unused_files:src/a.ts', 'dead-code:unused_files:src/b.ts'] });
    expect(v.ok).toBe(true);
    expect(v.baselined).toBe(2);
    expect(v.newKeys).toEqual([]);
  });

  test('a new finding not in the baseline fails and is named', () => {
    const raw = deadCode([['unused_files', 'src/a.ts'], ['unused_files', 'src/new.ts']]);
    const v = fallowVerdict(raw, { keys: ['dead-code:unused_files:src/a.ts'] });
    expect(v.ok).toBe(false);
    expect(v.baselined).toBe(1);
    expect(v.newKeys).toEqual(['dead-code:unused_files:src/new.ts']);
  });

  test('members of one file get distinct, line-free <parent>.<member> keys', () => {
    // Shape verified against real fallow 3.9.1 output: an unused class or enum
    // member is reported as parent_name + member_name, never a single symbol.
    const raw = JSON.stringify({
      schema_version: 7,
      kind: 'dead-code',
      summary: { total_issues: 3, unused_class_members: 2, unused_enum_members: 1 },
      unused_class_members: [
        { path: 'src/a.ts', parent_name: 'Svc', member_name: 'unusedOne', line: 3, col: 2 },
        { path: 'src/a.ts', parent_name: 'Svc', member_name: 'unusedTwo', line: 4, col: 2 },
      ],
      unused_enum_members: [{ path: 'src/a.ts', parent_name: 'Color', member_name: 'Blue', line: 6, col: 33 }],
    });
    // No line or column: inserting code above a member must not re-key it.
    expect(capture(raw).keys.toSorted()).toEqual([
      'dead-code:unused_class_members:src/a.ts:Svc.unusedOne',
      'dead-code:unused_class_members:src/a.ts:Svc.unusedTwo',
      'dead-code:unused_enum_members:src/a.ts:Color.Blue',
    ]);
    expect(fallowVerdict(raw, capture(raw)).ok).toBe(true);
  });

  test('component bindings and catalog entries compose <container>.<leaf> too', () => {
    const raw = JSON.stringify({
      schema_version: 7,
      kind: 'dead-code',
      summary: { total_issues: 4 },
      unused_component_inputs: [{ path: 'src/c.ts', component_name: 'Card', input_name: 'title' }],
      unused_component_outputs: [{ path: 'src/c.ts', component_name: 'Card', output_name: 'closed' }],
      unused_catalog_entries: [{ path: 'pnpm-workspace.yaml', catalog_name: 'default', entry_name: 'lodash' }],
      // container with no leaf: the component itself is the whole identity
      unrendered_components: [{ path: 'src/d.vue', component_name: 'Widget' }],
    });
    expect(capture(raw).keys.toSorted()).toEqual([
      'dead-code:unrendered_components:src/d.vue:Widget',
      'dead-code:unused_catalog_entries:pnpm-workspace.yaml:default.lodash',
      'dead-code:unused_component_inputs:src/c.ts:Card.title',
      'dead-code:unused_component_outputs:src/c.ts:Card.closed',
    ]);
  });

  test('arrays absent from total_issues are not fingerprinted', () => {
    // workspace_diagnostics carries a path and thin_wrappers a file, so both key
    // readily — but fallow counts neither in total_issues. Keying them would put
    // the key count past the issue count and mask the un-keyable finding below.
    const raw = JSON.stringify({
      schema_version: 7,
      kind: 'dead-code',
      summary: { total_issues: 1, unused_files: 1 },
      unused_files: [{ path: 'src/a.ts' }],
      workspace_diagnostics: [{ kind: 'undeclared-workspace', path: 'packages/x', message: 'not declared' }],
      thin_wrappers: [{ file: 'src/w.tsx', line: 4, component: 'Wrap', child_component: 'Inner' }],
      next_steps: [{ id: 'trace', command: 'fallow dead-code --trace src/a.ts', reason: 'verify' }],
    });
    const v = fallowVerdict(raw, { keys: ['dead-code:unused_files:src/a.ts'] });
    expect(new Set(v.findings.keys())).toEqual(new Set(['dead-code:unused_files:src/a.ts']));
    expect(v.ok).toBe(true);
  });

  test('a key for something uncounted cannot offset an un-keyable finding', () => {
    // A future fallow adding an uncounted array this version does not know to
    // skip. Counting keys against total_issues alone would call this tracked —
    // the spurious key (2 keys, 2 issues) exactly offsets the un-keyable member —
    // and mask a finding no baseline ever grandfathered. Counting the items we
    // could not key is what catches it.
    const raw = JSON.stringify({
      schema_version: 7,
      kind: 'dead-code',
      summary: { total_issues: 2, unused_files: 1, unused_store_members: 1 },
      unused_files: [{ path: 'src/a.ts' }],
      unused_store_members: [{ note: 'opaque' }],
      future_advisories: [{ path: 'src/b.ts' }],
    });
    const v = fallowVerdict(raw, capture(raw));
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("2 finding(s), 1 checkride can't key (unused_store_members), so the baseline can't mask the check");
  });

  test('findings the parse never reached block masking, though nothing was un-keyable', () => {
    // The mirror blind spot: every item present was keyed, so an un-keyable
    // count sees nothing wrong, but the authoritative count says two findings
    // exist and only one is in an array we read.
    const raw = JSON.stringify({
      schema_version: 7,
      kind: 'dead-code',
      summary: { total_issues: 2, unused_files: 1 },
      unused_files: [{ path: 'src/a.ts' }],
    });
    const v = fallowVerdict(raw, { keys: ['dead-code:unused_files:src/a.ts'] });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("2 finding(s), and checkride keyed 1, so the baseline can't mask the check");
  });

  test('untracked findings (count exceeds fingerprints) block masking to green', () => {
    // summary claims 2 issues, but only one carries a fingerprintable identity.
    const raw = JSON.stringify({
      schema_version: 7,
      kind: 'dead-code',
      summary: { total_issues: 2, unused_files: 1, unused_store_members: 1 },
      unused_files: [{ path: 'src/a.ts' }],
      // unused_store_members present in the count but with no readable identity
      unused_store_members: [{ note: 'opaque' }],
    });
    const v = fallowVerdict(raw, { keys: ['dead-code:unused_files:src/a.ts'] });
    expect(v.ok).toBe(false); // cannot be masked green: one finding is untracked
    expect(v.reason).toBe("2 finding(s), 1 checkride can't key (unused_store_members), so the baseline can't mask the check");
  });
});

describe('fallowVerdict (boundary and package findings key, so a baseline masks them, #23)', () => {
  test('an import out of a zone, a forbidden call and an unzoned file baseline back to green', () => {
    const v = fallowVerdict(BOUNDARIES, capture(BOUNDARIES));
    expect(v).toMatchObject({ ok: true, baselined: 3, newKeys: [], reason: null });
    expect(v.untracked).toBeUndefined();
  });

  test('a package cycle baselines back to green, beside the package baseline fallow lists', () => {
    expect(fallowVerdict(PACKAGES, capture(PACKAGES))).toMatchObject({ ok: true, baselined: 2, reason: null });
  });

  test('an import keeps its key when edits move it', () => {
    const report = JSON.parse(BOUNDARIES) as { boundary_violations: { line: number; col: number }[] };
    report.boundary_violations = report.boundary_violations.map((v) => ({ ...v, line: 40, col: 2 }));
    expect(fallowVerdict(JSON.stringify(report), capture(BOUNDARIES)).ok).toBe(true);
  });

  test('a report its keys miss names what they miss, with or without a baseline', () => {
    const raw = JSON.stringify({
      schema_version: 7,
      kind: 'dead-code',
      summary: { total_issues: 3 },
      unused_files: [{ path: 'src/a.ts' }],
      unused_store_members: [{ note: 'opaque' }],
      future_cycles: [{ members: ['a', 'b'] }],
    });
    const v = fallowVerdict(raw, null);
    expect(v.reason).toBe('3 finding(s)');
    expect(v.untracked).toBe("3 finding(s), 2 checkride can't key (future_cycles, unused_store_members)");
    expect(fallowVerdict(raw, capture(raw)).untracked).toBe(v.untracked);
  });

  test('a clean report has nothing to miss', () => {
    expect(fallowVerdict(deadCode([]), null).untracked).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A key collision must only COARSEN the baseline, never disable it. Regression
// for the bug where a single duplicate fingerprint tripped a size-comparison
// guard and left the whole slot permanently red after `checkride baseline`.
// ---------------------------------------------------------------------------

describe("fallowVerdict (a target's keys name files from the repo root, D50)", () => {
  test("a baseline of repo-root-relative keys masks the same findings run from the target's root", () => {
    const raw = deadCode([['unused_files', 'src/a.ts']]);
    expect(fallowVerdict(raw, { keys: ['dead-code:unused_files:apps/web/src/a.ts'] }, 'apps/web')).toMatchObject({ ok: true, baselined: 1, newKeys: [] });
    // A key written from the repo root names another file, so it masks nothing here.
    expect(fallowVerdict(raw, { keys: ['dead-code:unused_files:src/a.ts'] }, 'apps/web')).toMatchObject({
      ok: false,
      newKeys: ['dead-code:unused_files:apps/web/src/a.ts'],
    });
  });

  test('a cycle keys each file it passes through from the repo root, and health keys its path', () => {
    const cycle = JSON.stringify({
      schema_version: 7,
      kind: 'dead-code',
      summary: { total_issues: 1, circular_dependencies: 1 },
      circular_dependencies: [{ files: ['src/b.ts', 'src/a.ts'] }],
    });
    expect([...fallowVerdict(cycle, null, 'apps/web').findings.keys()]).toEqual(['dead-code:circular_dependencies:apps/web/src/a.ts->apps/web/src/b.ts']);
    expect([...fallowVerdict(health([{ path: 'src/x.ts', name: 'tangled' }]), null, 'apps/web').findings.keys()]).toEqual([
      'health:apps/web/src/x.ts:tangled',
    ]);
  });
});

describe('fallowVerdict (key collisions coarsen the baseline; un-keyable findings still block it)', () => {
  test('health: two anonymous findings that key identically still baseline to green', () => {
    // Two <arrow> functions at the same spot collide on one key. Capturing then
    // re-running must pass; before the fix the Set collapse made this stay red.
    const raw = health([
      { path: 'src/x.ts', name: '<arrow>', line: 5, col: 3 },
      { path: 'src/x.ts', name: '<arrow>', line: 5, col: 3 },
    ]);
    expect(fallowVerdict(raw, capture(raw)).ok).toBe(true);
  });

  test('dead-code: two symbol-less members that key identically still baseline to green', () => {
    const raw = classMembers([
      { path: 'src/errors.ts', line: 10, col: 3 },
      { path: 'src/errors.ts', line: 10, col: 3 },
    ]);
    expect(fallowVerdict(raw, capture(raw)).ok).toBe(true);
  });

  test('dead-code: distinct symbol-less siblings get distinct keys, so one baseline can not mask the other', () => {
    // Disambiguation (part 2): coarsening must never grandfather a real sibling.
    const raw = classMembers([
      { path: 'src/errors.ts', line: 10, col: 3 },
      { path: 'src/errors.ts', line: 22, col: 5 },
    ]);
    const v = fallowVerdict(raw, { keys: ['dead-code:unused_class_members:src/errors.ts:10:3'] });
    expect(v.ok).toBe(false);
    expect(v.newKeys).toEqual(['dead-code:unused_class_members:src/errors.ts:22:5']);
  });

  test('health: distinct anonymous siblings get distinct keys too', () => {
    const raw = health([
      { path: 'src/x.ts', name: '<arrow>', line: 5, col: 3 },
      { path: 'src/x.ts', name: '<arrow>', line: 9, col: 3 },
    ]);
    expect(capture(raw).keys.toSorted()).toEqual(['health:src/x.ts:<arrow>:5:3', 'health:src/x.ts:<arrow>:9:3']);
  });

  test('a genuinely un-keyable finding keeps the slot red even with every keyable one grandfathered', () => {
    // The guard's real purpose: a finding with no stable identity (no path, no
    // symbol, no position) can never be individually grandfathered, so a baseline
    // must not mask it green — unlike a mere collision, which is fully tracked.
    const raw = JSON.stringify({
      schema_version: 7,
      kind: 'dead-code',
      summary: { total_issues: 2, unused_files: 1, unused_store_members: 1 },
      unused_files: [{ path: 'src/a.ts' }],
      unused_store_members: [{ note: 'opaque' }],
    });
    const v = fallowVerdict(raw, { keys: ['dead-code:unused_files:src/a.ts'] });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("2 finding(s), 1 checkride can't key (unused_store_members), so the baseline can't mask the check");
  });
});

// ---------------------------------------------------------------------------
// Orchestrator gating — the acceptance criterion: a non-zero finding count
// fails the slot even when fallow's process exits 0.
// ---------------------------------------------------------------------------

describe('runChecks — the fallow (dead) slot gates on findings, not the exit code', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-fallow-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  // The name `fallow` is what routes the verdict to the parsed report; the entry
  // declares nothing for it.
  const deadAdapter = fakeAdapter({ name: 'fallow', slot: 'dead', outputFile: 'dead.json' });

  async function run(runner: CheckRunner, baseline?: Baseline | null) {
    return runChecks({
      cwd: dir, slots: [{ name: 'dead' }], adapters: [deadAdapter], config: null,
      runner, baseline: baseline ?? null, json: true, stdout: sink(), stderr: sink(),
    });
  }

  test('findings + exit 0 → the slot FAILS (fallow JSON mode exits 0 regardless)', async () => {
    const result = await run(staticRunner({ ok: true, exit_code: 0, stdout: deadCode([['unused_files', 'src/a.ts']]) }));
    const dead = result.summary.checks.find((c) => c.name === 'dead');
    expect(dead?.ok).toBe(false);
    expect(result.ok).toBe(false);
    // the raw report is still persisted untouched for agents to read
    expect(JSON.parse(await readFile(join(dir, '.check', 'dead.json'), 'utf8'))).toMatchObject({ kind: 'dead-code' });
  });

  test('a clean report + exit 0 → the slot PASSES', async () => {
    const result = await run(staticRunner({ ok: true, exit_code: 0, stdout: deadCode([]) }));
    expect(result.summary.checks.find((c) => c.name === 'dead')?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  test('an unsupported schema + exit 0 → the slot FAILS (never a silent pass)', async () => {
    const stdout = JSON.stringify({ schema_version: 4, kind: 'dead-code', summary: { total_issues: 0 } });
    const result = await run(staticRunner({ ok: true, exit_code: 0, stdout }));
    expect(result.summary.checks.find((c) => c.name === 'dead')?.ok).toBe(false);
  });

  test('a committed baseline grandfathers the findings back to green', async () => {
    const stdout = deadCode([['unused_files', 'src/a.ts']]);
    const baseline: Baseline = { schema_version: 1, slots: { dead: ['dead-code:unused_files:src/a.ts'] } };
    const result = await run(staticRunner({ ok: true, exit_code: 0, stdout }), baseline);
    const dead = result.summary.checks.find((c) => c.name === 'dead');
    expect(dead?.ok).toBe(true);
    expect(dead?.baselined).toBe(1);
  });

  /** Capture a baseline of the dead slot from `runner`'s report, and what the capture said on stderr. */
  async function captured(runner: CheckRunner): Promise<{ baseline: Baseline; said: string }> {
    const lines: string[] = [];
    const stderr = { write: (text: string) => { lines.push(text); return true; } };
    const { baseline } = await runBaseline({ cwd: dir, slots: [{ name: 'dead' }], adapters: [deadAdapter], config: null, runner, stdout: sink(), stderr });
    return { baseline, said: lines.join('') };
  }

  test('a capture of boundary findings keys each one, and the run after it is green (#23)', async () => {
    const runner = staticRunner({ ok: false, exit_code: 1, stdout: BOUNDARIES });
    const { baseline, said } = await captured(runner);
    expect(baseline.slots['dead']).toHaveLength(3);
    expect(said).toContain('3 finding(s) across dead');
    expect(said).not.toContain("can't key");
    expect((await run(runner, baseline)).summary.checks.find((c) => c.name === 'dead')).toMatchObject({ ok: true, baselined: 3 });
  });

  test("a capture says what its keys miss, and so does the run it can't mask (#23)", async () => {
    const stdout = JSON.stringify({
      schema_version: 9,
      kind: 'dead-code',
      total_issues: 2,
      unused_files: [{ path: 'src/a.ts' }],
      future_cycles: [{ members: ['a', 'b'] }],
    });
    const runner = staticRunner({ ok: false, exit_code: 1, stdout });
    const { baseline, said } = await captured(runner);
    expect(baseline.slots['dead']).toEqual(['dead-code:unused_files:src/a.ts']);
    expect(said).toContain("baseline: dead has 2 finding(s), 1 checkride can't key (future_cycles), so the baseline can't mask it and it stays red\n");
    const lines: string[] = [];
    const stderr = { write: (text: string) => { lines.push(text); return true; } };
    const result = await runChecks({ cwd: dir, slots: [{ name: 'dead' }], adapters: [deadAdapter], config: null, runner, baseline, json: false, stdout: sink(), stderr });
    expect(result.ok).toBe(false);
    expect(lines.join('')).toContain("2 finding(s), 1 checkride can't key (future_cycles), so the baseline can't mask the check");
  });

  test('a report it never got says what stopped fallow beneath the status line: the install pnpm needs, or a timeout', async () => {
    const lines: string[] = [];
    const stderr = { write: (text: string) => { lines.push(text); return true; } };
    const said = async (runner: CheckRunner): Promise<string> => {
      lines.length = 0;
      await runChecks({ cwd: dir, slots: [{ name: 'dead' }], adapters: [deadAdapter], config: null, runner, baseline: null, json: false, stdout: sink(), stderr });
      return lines.join('');
    };
    const missing = await said(staticRunner({ ok: false, exit_code: 1, stdout: 'undefined\n[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "fallow" not found\n' }));
    expect(missing).toContain("`fallow` isn't in node_modules/.bin, and checks never install a tool: run `pnpm install` first");
    expect(missing).not.toContain('did not emit valid JSON');
    const timedOut = await said(() => Promise.resolve({ ok: false, exit_code: -1, stdout: '', stderr: 'timed out after 600s\n' }));
    expect(timedOut).toContain('timed out after 600s');
  });

  test("fallow's own error report records could-not-verify, exit -1, with fallow's message as the reason (#8)", async () => {
    const stdout = JSON.stringify({ error: true, message: 'invalid value: integer `1000000`, expected u16 in /repo/fallow.toml', exit_code: 2 });
    const lines: string[] = [];
    const stderr = { write: (text: string) => { lines.push(text); return true; } };
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'dead' }], adapters: [deadAdapter], config: null,
      runner: staticRunner({ ok: false, exit_code: 2, stdout }), baseline: null, json: false, stdout: sink(), stderr,
    });
    const dead = result.summary.checks.find((c) => c.name === 'dead');
    const reason = 'check-dead: fallow could not run: invalid value: integer `1000000`, expected u16 in /repo/fallow.toml (exit 2)';
    expect(dead).toMatchObject({ ok: false, exit_code: -1, reason });
    expect(result.ok).toBe(false);
    expect(lines.join('')).toContain(reason);
    expect(lines.join('')).not.toContain('schema_version');
    // fallow's report is still the artifact, as it printed it.
    expect(JSON.parse(await readFile(join(dir, '.check', 'dead.json'), 'utf8'))).toMatchObject({ error: true, exit_code: 2 });
  });

  test('the verdict is keyed by adapter name, not slot: the same report under `knip` is judged by exit code', async () => {
    const knip = fakeAdapter({ name: 'knip', slot: 'dead', outputFile: 'dead.json' });
    const result = await runChecks({
      cwd: dir, slots: [{ name: 'dead' }], adapters: [knip], config: null,
      runner: staticRunner({ ok: true, exit_code: 0, stdout: deadCode([['unused_files', 'src/a.ts']]) }),
      baseline: null, json: true, stdout: sink(), stderr: sink(),
    });
    expect(result.summary.checks.find((c) => c.name === 'dead')?.ok).toBe(true);
  });
});

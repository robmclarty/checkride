import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter } from '../adapters.js';
import { buildDigest, DIGEST_FILE, digestOf, withinBudget, writeDigest } from '../digest/index.js';
import type { CheckOutcome } from '../links.js';
import type { CheckRun, CheckRunner, Out, SummaryCheck } from '../orchestrator/index.js';
import { runChecks } from '../orchestrator/index.js';

function fakeAdapter(over: Partial<Adapter> & { name: string; slot: string }): Adapter {
  return { description: over.name, detect: [], command: 'node', args: [], outputFile: null, devDeps: {}, ...over };
}

/** A failing check outcome; override `stdout`/`stderr` per case. */
function outcome(over: Partial<CheckOutcome> = {}): CheckOutcome {
  return { ok: false, exit_code: 1, stdout: '', stderr: '', ...over };
}

function run(adapter: Adapter, oc: CheckOutcome): CheckRun {
  return { slot: adapter.slot, adapter, outcome: oc, name: adapter.slot };
}

/** A summary entry for a failing slot; override `ok`/`skipped` to vary it. */
function check(name: string, over: Partial<SummaryCheck> = {}): SummaryCheck {
  return { name, adapter: name, description: name, ok: false, exit_code: 1, duration_ms: 1, output_file: null, ...over };
}

/** An oxlint `--format=json` payload from `[file, code, message]` triples. */
function oxlint(findings: [string, string, string][]): string {
  return JSON.stringify({ diagnostics: findings.map(([filename, code, message]) => ({ filename, code, message })) });
}

/** An ast-grep `--json=compact` payload from `[file, ruleId, message]` triples. */
function astGrep(findings: [string, string, string][]): string {
  return JSON.stringify(findings.map(([file, ruleId, message]) => ({ file, ruleId, message })));
}

/** One `go test -json` event of package `example.com/a`. */
function goEvent(action: string, name?: string, output?: string): string {
  return JSON.stringify({ Action: action, Package: 'example.com/a', Test: name, Output: output });
}

function sink(): Out {
  return { write: () => true };
}

/** An `Out` that records what was written, for asserting on the stream. */
function capture(): Out & { text: () => string } {
  let buf = '';
  return { write: (t: string) => { buf += t; return true; }, text: () => buf };
}

/** Is a real git usable here? The recover-hint test skips without it. */
const gitAvailable = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

/** Where `needle` sits in `text`, failing the test when it's missing. */
function at(text: string, needle: string): number {
  const i = text.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
}

const redRunner: CheckRunner = () => Promise.resolve(outcome({ stdout: oxlint([['a.ts', 'no-x', 'bad']]) }));
const greenRunner: CheckRunner = () => Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });

describe('buildDigest', () => {
  const OXLINT = fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json' });

  test('returns null when nothing failed (green run)', () => {
    expect(buildDigest([], [])).toBeNull();
    expect(buildDigest([], [check('lint', { ok: true })])).toBeNull();
  });

  test('a check run with another copy than its baseline keys were captured with says its new keys may be churn', () => {
    const red = [run(OXLINT, outcome({ stdout: oxlint([['a.ts', 'no-x', 'bad']]) }))];
    const drifted = check('lint', { adapter: 'oxlint', output_file: 'lint.json', pin_source: 'nix', tool_version: '2.11.4', baseline_captured_with: { pin_source: 'path' } });
    const text = buildDigest(red, [drifted]) ?? '';
    expect(text).toContain(
      "Raw: `.check/lint.json` — 1 finding(s)\n\n_The baseline was captured with oxlint from PATH, and this run used oxlint 2.11.4 (nix), so a new key may be the tool's churn, not new debt.",
    );
    expect(text).toContain('or have a human review the new keys and re-capture._\n\n- a.ts:no-x:bad');
    expect(buildDigest(red, [check('lint', { adapter: 'oxlint', output_file: 'lint.json' })])).toContain('— 1 finding(s)\n\n- a.ts:no-x:bad');
  });

  test("a go check's note names the Go release each copy ran on, by the go pack's toolchain", () => {
    const LINT = fakeAdapter({ name: 'golangci-lint', slot: 'lint', outputFile: 'lint.json' });
    const issues = JSON.stringify({ Issues: [{ FromLinter: 'unused', Text: 'var x is unused', Pos: { Filename: 'a.go', Line: 3 } }] });
    const red = [run(LINT, outcome({ stdout: issues }))];
    const drifted = check('lint', {
      adapter: 'golangci-lint',
      pack: 'go',
      output_file: 'lint.json',
      pin_source: 'nix',
      tool_version: '2.11.4',
      toolchain_version: '1.26.0',
      baseline_captured_with: { pin_source: 'nix', tool_version: '2.11.4', toolchain_version: '1.25.3' },
    });
    expect(buildDigest(red, [drifted])).toContain(
      '_The baseline was captured with golangci-lint 2.11.4 (nix) on go 1.25.3, and this run used golangci-lint 2.11.4 (nix) on go 1.26.0, so a new key',
    );
  });

  test('caps a slot at N findings and collapses the rest to a "… more" line', () => {
    const findings = Array.from({ length: 25 }, (_, i): [string, string, string] => [`f${i}.ts`, 'no-rule', `msg ${i}`]);
    const digest = buildDigest(
      [run(OXLINT, outcome({ stdout: oxlint(findings) }))],
      [check('lint', { adapter: 'oxlint', output_file: 'lint.json' })],
      { maxItemsPerSlot: 10, maxBytes: 100_000 },
    );
    expect(digest).not.toBeNull();
    const text = digest ?? '';
    // 10 rendered findings + one "… 15 more" bullet — never more than the cap.
    const bullets = text.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(11);
    expect(text).toContain('f0.ts:no-rule:msg 0');
    expect(text).toContain('f9.ts:no-rule:msg 9');
    expect(text).not.toContain('f10.ts'); // beyond the cap
    expect(text).toContain('… 15 more (see `.check/lint.json`)');
    expect(text).toContain('Raw: `.check/lint.json` — 25 finding(s)');
  });

  test('excludes a check the summary still marks ok (e.g. fully baselined)', () => {
    const digest = buildDigest(
      [run(OXLINT, outcome({ stdout: oxlint([['a.ts', 'no-x', 'bad']]) }))],
      [check('lint', { ok: true, baselined: 1 }), check('spell')],
      { maxItemsPerSlot: 10, maxBytes: 100_000 },
    );
    // Only the genuinely failing `spell` slot is summarized; `lint` passed.
    expect(digest).toContain('1 of 2 check(s) failed');
    expect(digest).not.toContain('## lint');
  });

  test('byte budget drops whole sections past the cap and names what was omitted', () => {
    const astAdapter = fakeAdapter({ name: 'ast-grep', slot: 'struct', outputFile: 'struct.json' });
    const lintRun = run(OXLINT, outcome({ stdout: oxlint([['a.ts', 'no-x', 'bad']]) }));
    // Ten findings, so the struct section is longer than the room the note leaves.
    const structRun = run(astAdapter, outcome({ stdout: astGrep(Array.from({ length: 10 }, (_, i): [string, string, string] => [`b${i}.ts`, 'no-y', 'worse'])) }));
    const lintCheck = check('lint', { adapter: 'oxlint', output_file: 'lint.json' });
    const structCheck = check('struct', { adapter: 'ast-grep', output_file: 'struct.json' });

    // Measure a one-section digest, then budget for that and the note naming
    // what was dropped: the second section overflows and must be dropped
    // (header length is digit-stable).
    const oneSection = buildDigest([lintRun], [lintCheck], { maxItemsPerSlot: 10, maxBytes: 1_000_000 }) ?? '';
    const budget = { maxItemsPerSlot: 10, maxBytes: Buffer.byteLength(oneSection, 'utf8') + 120 };

    const digest = buildDigest([lintRun, structRun], [lintCheck, structCheck], budget) ?? '';
    // The lint section is kept whole.
    expect(digest).toContain(oneSection.slice(oneSection.indexOf('\n## lint')));
    expect(digest).not.toContain('## struct');
    expect(digest).toContain('Digest truncated');
    expect(digest).toContain('1 more failing slot(s) omitted');
    // The note fits inside the budget too.
    expect(Buffer.byteLength(digest, 'utf8')).toBeLessThanOrEqual(budget.maxBytes);
  });

  /** Sections that fill the budget leave room for the note that names the ones dropped. */
  test('a digest whose sections fill its budget still holds to it, the note included', () => {
    const findings = Array.from({ length: 10 }, (_, i): [string, string, string] => [`f${i}.ts`, 'no-x', 'm'.repeat(40)]);
    const runs = Array.from({ length: 40 }, (_, i) => run(fakeAdapter({ name: 'oxlint', slot: `s${i}`, outputFile: 'lint.json' }), outcome({ stdout: oxlint(findings) })));
    const checks = runs.map((r) => check(r.slot, { adapter: 'oxlint', output_file: 'lint.json' }));
    for (const maxBytes of [2000, 2050, 2100, 2150, 2200]) {
      const digest = buildDigest(runs, checks, { maxItemsPerSlot: 10, maxBytes }) ?? '';
      expect(digest).toContain('more failing slot(s) omitted');
      expect(Buffer.byteLength(digest, 'utf8'), String(maxBytes)).toBeLessThanOrEqual(maxBytes);
    }
  });

  /**
   * The first section is kept whatever its size, so the digest is never empty,
   * and a tool that prints its report as one compact JSON line, as knip does,
   * made that section the whole report: 83 KB for 4,000 unused files, in a
   * digest whose budget is 8,000 bytes.
   */
  test('holds a first section longer than the budget to it, cut where the budget runs out', () => {
    const knip = fakeAdapter({ name: 'knip', slot: 'dead', outputFile: 'dead.json' });
    const line = JSON.stringify({ files: Array.from({ length: 4000 }, (_, i) => `src/unused-${i}.ts`) });
    const digest = buildDigest([run(knip, outcome({ stdout: line }))], [check('dead', { adapter: 'knip', output_file: 'dead.json' })]) ?? '';
    expect(Buffer.byteLength(digest, 'utf8')).toBeLessThanOrEqual(8000);
    expect(digest).toContain('Raw: `.check/dead.json`');
    expect(digest).toContain('{"files":["src/unused-0.ts"');
    expect(digest).toContain('…\n```\n');
    expect(digest).toContain("_Digest cut here to keep to its budget; the file this section's `Raw:` line names holds the rest._");
    // The fence the cut fell inside is closed, so the note isn't read as code.
    expect((digest.match(/^```/gm) ?? []).length % 2).toBe(0);
  });

  test('a cut never splits a character, and a later section still drops whole', () => {
    const goBuild = fakeAdapter({ name: 'go-build', slot: 'types' });
    const wide = '…'.repeat(4000); // 3 bytes a character, 12,000 bytes on one line
    // Ten findings, so the lint section is longer than the room the note leaves.
    const lintRun = run(OXLINT, outcome({ stdout: oxlint(Array.from({ length: 10 }, (_, i): [string, string, string] => [`a${i}.ts`, 'no-x', 'bad'])) }));
    const digest = buildDigest(
      [run(goBuild, outcome({ stdout: wide })), lintRun],
      [check('types', { adapter: 'go-build' }), check('lint', { adapter: 'oxlint', output_file: 'lint.json' })],
    ) ?? '';
    expect(digest).not.toContain('\uFFFD');
    expect(digest).toContain('_Digest cut here to keep to its budget');
    expect(digest).not.toContain('## lint');
    expect(digest).toContain('1 more failing slot(s) omitted');
    // Cut to leave room for the note that a later section was dropped.
    expect(Buffer.byteLength(digest, 'utf8')).toBeLessThanOrEqual(8000);
  });

  /** A reader of a file an earlier release wrote, which kept a first section whole, holds it to the budget too. */
  test('withinBudget holds a digest to the default budget, and leaves one within it as it is', () => {
    const long = `# checkride failure digest\n\n## dead — knip\n\nRaw: \`.check/dead.json\`\n\n\`\`\`\n${'x'.repeat(20_000)}\n\`\`\`\n`;
    const held = withinBudget(long);
    expect(Buffer.byteLength(held, 'utf8')).toBeLessThanOrEqual(8000);
    expect(held).toContain('Raw: `.check/dead.json`');
    expect(withinBudget('# checkride failure digest\n')).toBe('# checkride failure digest\n');
  });

  test('falls back to a text tail for a slot with no fingerprint extractor', () => {
    const goBuild = fakeAdapter({ name: 'go-build', slot: 'types' }); // no extractor
    const lines = Array.from({ length: 15 }, (_, i) => `f.go:${i}:1: message ${i}`);
    const digest = buildDigest(
      [run(goBuild, outcome({ stdout: lines.join('\n') }))],
      [check('types', { adapter: 'go-build' })],
      { maxItemsPerSlot: 5, maxBytes: 100_000 },
    ) ?? '';
    expect(digest).toContain('```'); // fenced raw excerpt, not a normalized list
    expect(digest).toContain('last 5 of 15 lines');
    expect(digest).toContain('message 14'); // the tail is kept
    expect(digest).not.toContain('message 0'); // the head is dropped
    expect(digest).toContain('Raw: `.check/types.stdout.txt`');
  });

  /**
   * tsc's keys write each quoted span `'…'`, so a key no longer says which
   * name or type an error is about: a section shows tsc's own lines unless a
   * baseline masked the check, and then each new finding's message whole.
   */
  test("a tsc check no baseline masked shows tsc's own lines rather than its keys", () => {
    const tsc = fakeAdapter({ name: 'tsc', slot: 'types' });
    const plain = "src/checkout.ts(19,33): error TS2304: Cannot find name 'shippingCents'.\n";
    const unmasked = buildDigest([run(tsc, outcome({ exit_code: 2, stdout: plain }))], [check('types', { adapter: 'tsc', exit_code: 2 })]) ?? '';
    expect(unmasked).toContain(`\`\`\`\n${plain}\`\`\``);
    expect(unmasked).not.toContain("'…'");
  });

  test('a tsc check a baseline could not mask, since tsc stopped short, says why above its own lines', () => {
    const tsc = fakeAdapter({ name: 'tsc', slot: 'types' });
    const stdout = "src/a.ts(1,34): error TS1005: ',' expected.\nsrc/b.ts(5,7): error TS2322: Type 'number' is not assignable to type 'string'.\n";
    const reason = "tsc stopped short at `src/a.ts(1,34): error TS1005: ',' expected.`, so the baseline neither masked its findings nor pruned its keys";
    const digest = buildDigest([run(tsc, outcome({ exit_code: 2, stdout }))], [check('types', { adapter: 'tsc', exit_code: 2, reason })]) ?? '';
    expect(digest).toContain(`\n> ${reason}\n\n\`\`\`\nsrc/a.ts(1,34): error TS1005: ',' expected.\n`);
  });

  test('a key a baseline grandfathers fewer findings of than were found lists them all, and says the grandfathered are among them', () => {
    const tsc = fakeAdapter({ name: 'tsc', slot: 'types' });
    const stdout = [
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/a.ts(9,7): error TS2322: Type 'boolean' is not assignable to type 'number'.",
      "src/a.ts(12,7): error TS2322: Type 'bigint' is not assignable to type 'number'.",
      '',
    ].join('\n');
    // Grandfathered twice, found three times: one is new, and no key says which.
    const masked = check('types', { adapter: 'tsc', exit_code: 2, baselined: 2, new_count: 1, new: ["src/a.ts:TS2322:Type '…' is not assignable to type '…'."] });
    const digest = buildDigest([run(tsc, outcome({ exit_code: 2, stdout }))], [masked]) ?? '';
    expect(digest).toContain("- src/a.ts(12,7): error TS2322: Type 'bigint' is not assignable to type 'number'.\n");
    expect(digest).toContain('- (a key found more often than the baseline grandfathers lists each of its findings, the grandfathered ones among them)\n');
  });

  test('a tsc check a baseline masked lists each of its new findings as tsc printed it', () => {
    const tsc = fakeAdapter({ name: 'tsc', slot: 'types' });
    const stdout = [
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/a.ts(9,7): error TS2322: Type 'boolean' is not assignable to type 'number'.",
      "src/b.ts(4,1): error TS2304: Cannot find name 'shippingCents'.",
      "src/c.ts(2,1): error TS2304: Cannot find name 'grandfathered'.",
      '',
    ].join('\n');
    const masked = check('types', {
      adapter: 'tsc', exit_code: 2, baselined: 1, new_count: 3,
      new: ["src/a.ts:TS2322:Type '…' is not assignable to type '…'.", "src/b.ts:TS2304:Cannot find name '…'."],
    });
    const digest = buildDigest([run(tsc, outcome({ exit_code: 2, stdout }))], [masked]) ?? '';
    expect(digest).toContain(
      "— 3 new finding(s), not in the baseline; 1 grandfathered, not listed\n\n" +
        "- src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n" +
        "- src/a.ts(9,7): error TS2322: Type 'boolean' is not assignable to type 'number'.\n" +
        "- src/b.ts(4,1): error TS2304: Cannot find name 'shippingCents'.\n",
    );
    expect(digest).not.toContain('grandfathered\'');
  });

  /**
   * pnpm 11.28.5 prints a stray `undefined` ahead of its error, which led the
   * excerpt with nothing to say what stopped the tool (#16). The excerpt keeps
   * every byte, and the line the status line printed goes above it.
   */
  test('a section names what stopped the tool above the excerpt, which keeps its bytes', () => {
    const stdout = 'undefined\n[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "oxlint" not found\n';
    const digest = buildDigest([run(OXLINT, outcome({ stdout }))], [check('lint', { adapter: 'oxlint' })]) ?? '';
    expect(digest).toContain(
      'Raw: `.check/lint.stdout.txt`\n\n> `oxlint` isn\'t in node_modules/.bin, and checks never install a tool: run `pnpm install` first\n\n```\nundefined\n[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL]',
    );
  });

  /**
   * The stop gate hands the agent this digest, and a baselined check's raw
   * output holds every grandfathered finding too: the new ones come first,
   * from the summary, and the grandfathered ones only as a count (#13).
   */
  test('a check a baseline masked lists its new findings, and counts the grandfathered ones', () => {
    const report = oxlint(Array.from({ length: 12 }, (_, i) => [`a${String(i).padStart(2, '0')}.ts`, 'no-x', 'old'] as [string, string, string]));
    const masked = check('lint', { adapter: 'oxlint', output_file: 'lint.json', baselined: 309, new_count: 2, new: ['z.ts:no-y:new', 'zz.ts:no-y:new'] });
    const digest = buildDigest([run(OXLINT, outcome({ stdout: report }))], [masked]) ?? '';
    expect(digest).toContain('Raw: `.check/lint.json` — 2 new finding(s), not in the baseline; 309 grandfathered, not listed\n\n- z.ts:no-y:new\n- zz.ts:no-y:new\n');
    expect(digest).not.toContain('a00.ts');
    const many = check('lint', { adapter: 'oxlint', output_file: 'lint.json', new_count: 12, new: Array.from({ length: 12 }, (_, i) => `k${String(i).padStart(2, '0')}`) });
    expect(buildDigest([run(OXLINT, outcome({ stdout: report }))], [many]) ?? '').toContain("- k09\n- … and more: the summary's `new` lists 12 key(s), and `.check/lint.json` every finding\n");
  });

  test('a go test run names its failing and unfinished tests, with what each printed', () => {
    const goTest = fakeAdapter({ name: 'go-test', slot: 'test', outputFile: 'test.jsonl' });
    const stdout = [goEvent('run', 'TestAdd'), goEvent('output', 'TestAdd', '    add_test.go:9: got 1\n'), goEvent('fail', 'TestAdd'), goEvent('run', 'TestHang'), goEvent('output', undefined, 'ok example.com/b 0.1s\n')].join('\n');
    const digest = buildDigest(
      [run(goTest, outcome({ exit_code: -1, stdout, stderr: 'timed out after 600s\n' }))],
      [check('test', { adapter: 'go-test', output_file: 'test.jsonl', exit_code: -1, reason: 'timed out after 600s' })],
    ) ?? '';
    expect(digest).toContain(
      'Raw: `.check/test.jsonl` — 1 failing, 1 still running when the check stopped\n\n> timed out after 600s\n\n### FAIL example.com/a TestAdd\n\n```text\n    add_test.go:9: got 1\n```\n\n### RUNNING example.com/a TestHang\n',
    );
    const built = buildDigest([run(goTest, outcome({ stdout: '# example.com/a\na.go:1:1: expected package\n' }))], [check('test', { adapter: 'go-test' })]) ?? '';
    expect(built).toContain('```\n# example.com/a\na.go:1:1: expected package\n```');
  });

  test('a refused check names its refusal, and a timed-out one its timeout', () => {
    const refused = buildDigest(
      [run(OXLINT, outcome({ stderr: 'checkride: oxlint is not installed\nrun pnpm install\n' }))],
      [check('lint', { adapter: 'oxlint', reason: 'checkride: oxlint is not installed' })],
    ) ?? '';
    expect(refused).toContain('\n> checkride: oxlint is not installed\n');
    const tsc = fakeAdapter({ name: 'tsc', slot: 'types' });
    const timedOut = buildDigest([run(tsc, outcome({ exit_code: -1, stdout: 'building…\n', stderr: 'timed out after 600s\n' }))], [check('types', { adapter: 'tsc', exit_code: -1 })]) ?? '';
    expect(timedOut).toContain('\n> timed out after 600s\n\n```\nbuilding…\n```');
    const silent = buildDigest([run(tsc, outcome({ exit_code: -1, stderr: '' }))], [check('types', { adapter: 'tsc', exit_code: -1 })]) ?? '';
    expect(silent).toContain('exited -1 with no captured output\n');
    expect(silent).not.toContain('> ');
  });
});

describe('writeDigest (filesystem)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-digest-'));
    await mkdir(join(dir, '.check'), { recursive: true });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('writes digest.md on failure and leaves the raw output byte-identical', async () => {
    const rawPath = join(dir, '.check', 'lint.json');
    const raw = oxlint([['a.ts', 'no-x', 'bad'], ['b.ts', 'no-y', 'worse']]);
    await writeFile(rawPath, raw);

    const oxlintAdapter = fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json' });
    const built = digestOf(
      { label: '.check' },
      [run(oxlintAdapter, outcome({ stdout: raw }))],
      [check('lint', { adapter: 'oxlint', output_file: 'lint.json' })],
    );
    expect(built).toContain('## lint — oxlint');
    await writeDigest(join(dir, '.check'), built);
    expect(await readFile(join(dir, '.check', DIGEST_FILE), 'utf8')).toBe(built);
    // The raw file the digest points at is never rewritten.
    expect(await readFile(rawPath, 'utf8')).toBe(raw);
  });

  test('a green run removes a stale digest so the file always means "failed"', async () => {
    const digestPath = join(dir, '.check', DIGEST_FILE);
    await writeFile(digestPath, '# stale digest from a prior red run\n');
    const built = digestOf({ label: '.check' }, [], [check('lint', { ok: true })]);
    expect(built).toBeNull();
    await writeDigest(join(dir, '.check'), built);
    expect(existsSync(digestPath)).toBe(false);
  });
});

describe('runChecks --digest wiring', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-digest-orc-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const oxlintAdapter = fakeAdapter({ name: 'oxlint', slot: 'lint', outputFile: 'lint.json' });
  const slots = [{ name: 'lint' }];

  const opts = (runner: CheckRunner, digest: boolean) => ({
    cwd: dir, slots, adapters: [oxlintAdapter], config: null, runner, digest,
    json: true, stdout: sink(), stderr: sink(),
  });

  test('writes .check/digest.md, pointing at the untouched raw file', async () => {
    await runChecks(opts(redRunner, true));
    const digest = await readFile(join(dir, '.check', DIGEST_FILE), 'utf8');
    expect(digest).toContain('## lint — oxlint');
    expect(digest).toContain('.check/lint.json');
    // The raw output the run persisted is still valid, unmodified JSON.
    expect(JSON.parse(await readFile(join(dir, '.check', 'lint.json'), 'utf8'))).toMatchObject({
      diagnostics: [{ filename: 'a.ts' }],
    });
  });

  test('writes no digest without the flag', async () => {
    await runChecks(opts(redRunner, false));
    expect(existsSync(join(dir, '.check', DIGEST_FILE))).toBe(false);
  });

  test('a subsequent green --digest run clears the stale digest', async () => {
    await runChecks(opts(redRunner, true));
    expect(existsSync(join(dir, '.check', DIGEST_FILE))).toBe(true);
    await runChecks(opts(greenRunner, true));
    expect(existsSync(join(dir, '.check', DIGEST_FILE))).toBe(false);
  });

  test('a red human run prints the digest it wrote, below its report lines', async () => {
    const stderr = capture();
    await runChecks({ ...opts(redRunner, true), json: false, stderr });
    const digest = await readFile(join(dir, '.check', DIGEST_FILE), 'utf8');
    expect(stderr.text()).toContain(`report: .check/summary.json\ndigest: .check/${DIGEST_FILE}\n\n${digest}\n`);
  });

  /** Run git in the test's repo as a fixed identity, signing off. */
  function git(...args: string[]): void {
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: 'pipe' });
  }

  /**
   * A baseline a botched merge mangled masks nothing, so every grandfathered
   * finding reads red, and this warning is what says why. Printed past up to
   * 8 KB of digest, it was scrolled past exactly when a wall of red needed it.
   */
  test('prints the unparseable-baseline warning before the digest, and the pointers above both', async () => {
    await writeFile(join(dir, 'checkride.baseline.json'), '<<<<<<< HEAD\n{\n');
    const stderr = capture();
    await runChecks({ ...opts(redRunner, true), json: false, stderr });
    const text = stderr.text();
    const warning = at(text, 'baseline: checkride.baseline.json is present but unparseable');
    expect(at(text, `digest: .check/${DIGEST_FILE}\n`)).toBeLessThan(warning);
    expect(warning).toBeLessThan(at(text, '# checkride failure digest'));
    expect(text).toContain('See `checkride recover`.\n\n# checkride failure digest');
  });

  /**
   * The hint says the "new" findings are a merge's dropped baseline entries,
   * so the fix is `checkride recover`, not the findings: it has to be read
   * before the digest that lists them.
   */
  test.skipIf(!gitAvailable)('prints the recover hint before the digest, which comes last', async () => {
    git('init', '-q');
    await writeFile(join(dir, 'checkride.baseline.json'), JSON.stringify({ schema_version: 1, slots: { lint: ['a.ts:no-x:bad'] } }));
    git('add', '.');
    git('commit', '-q', '-m', 'baseline');
    // A merge that dropped the key the lint finding is grandfathered under.
    await writeFile(join(dir, 'checkride.baseline.json'), JSON.stringify({ schema_version: 1, slots: { lint: [] } }));
    const stderr = capture();
    await runChecks({ ...opts(redRunner, true), json: false, stderr });
    const text = stderr.text();
    expect(at(text, 'hint: 1 of 1 new finding(s) were grandfathered until')).toBeLessThan(at(text, '# checkride failure digest'));
    expect(text).toContain('see `checkride recover`\n\n# checkride failure digest');
    expect(text.trimEnd().endsWith('- a.ts:no-x:bad')).toBe(true);
  });

  test('a notice that ends without a blank line still leaves exactly one before the digest', async () => {
    // A tsconfig in a package below a root with no tool for `types` makes the
    // run end its report with an unreached warning, which no blank line follows.
    await mkdir(join(dir, 'packages', 'a'), { recursive: true });
    await writeFile(join(dir, 'packages', 'a', 'tsconfig.json'), '{}');
    const stderr = capture();
    await runChecks({ ...opts(redRunner, true), slots: [{ name: 'lint' }, { name: 'types' }], json: false, stderr });
    const text = stderr.text();
    expect(text).toMatch(/warning: types has no tool under `\.`[^\n]*\n\n# checkride failure digest/);
  });

  test.each([
    ['without the flag', redRunner, false, false],
    ['on a green run', greenRunner, true, false],
    ['under --json, which prints no report', redRunner, true, true],
  ] as const)('prints no digest %s', async (_, runner, digest, json) => {
    const stderr = capture();
    await runChecks({ ...opts(runner, digest), json, stderr });
    expect(stderr.text()).not.toContain('# checkride failure digest');
  });
});

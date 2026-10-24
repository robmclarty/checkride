import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter, Slot } from '../adapters.js';
import { ADAPTERS } from '../adapters.js';
import type { Fingerprint } from '../baseline/index.js';
import { applyBaseline, BASELINE_FILE, findingText, fingerprint, firstFinding, isFingerprintable, observedTally, stoppedShortReason, tally } from '../baseline/index.js';
import { runBaseline } from '../baseline-command.js';
import type { CheckrideConfig } from '../config.js';
import type { CheckRunner } from '../orchestrator/index.js';
import { runChecks } from '../orchestrator/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const OXLINT = read('baseline-oxlint.json');
const AST_GREP = read('baseline-ast-grep.json');
const CSPELL = read('baseline-cspell.txt');
const FALLOW_DEAD = read('baseline-fallow-dead-code.json');
const FALLOW_DUPES = read('baseline-fallow-dupes.json');
const FALLOW_HEALTH = read('baseline-fallow-health.json');
const VALE = read('baseline-vale.json');
const VALE_WARNINGS = read('baseline-vale-warnings.json');
const VALE_ERROR = read('baseline-vale-error.json');
// Real captures: oxlint 1.87.0 run with `--deny-warnings` (it exited 1), and
// ast-grep 0.45.3 over one error, one warning and one hint rule (no `--error`).
const OXLINT_DENY = read('baseline-oxlint-deny-warnings.json');
const AST_GREP_SEVERITIES = read('baseline-ast-grep-severities.json');

/** A registry adapter's argv, as it spawns with no config override: command, then args. */
function registryArgv(name: string): string[] {
  const adapter = ADAPTERS.find((a) => a.name === name);
  if (!adapter) throw new Error(`no registry adapter named ${name}`);
  return [adapter.command, ...adapter.args];
}

const OXLINT_ARGV = registryArgv('oxlint');
const AST_GREP_ARGV = registryArgv('ast-grep');

/** Reverse a JSON array, or a named array field of a JSON object, in place. */
function reversedJson(raw: string, field?: string): string {
  const parsed: unknown = JSON.parse(raw);
  if (field && parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    obj[field] = (obj[field] as unknown[]).toReversed();
    return JSON.stringify(obj);
  }
  return JSON.stringify((parsed as unknown[]).toReversed());
}

/** A vale alert report with its files, and each file's alerts, in reverse order. */
function reversedVale(raw: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown[]>;
  return JSON.stringify(Object.fromEntries(Object.entries(parsed).toReversed().map(([f, a]) => [f, a.toReversed()])));
}

/** Add one alert to a vale report, as a fresh finding would appear on a later run. */
function withAlert(raw: string, file: string, check: string, message: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown[]>;
  parsed[file] = [...(parsed[file] ?? []), { Check: check, Severity: 'error', Message: message, Line: 1, Span: [1, 2] }];
  return JSON.stringify(parsed);
}

/** Add one oxlint diagnostic to a report, as a fresh finding would appear on a later run. */
function withOxlint(raw: string, severity: string): string {
  const parsed = JSON.parse(raw) as { diagnostics: unknown[] };
  parsed.diagnostics.push({ message: 'Expected === and instead saw ==', code: 'eslint(eqeqeq)', severity, filename: 'src/cli.ts' });
  return JSON.stringify(parsed);
}

/** Add one ast-grep match to a report, as a fresh finding would appear on a later run. */
function withAstGrep(raw: string, severity: string): string {
  const parsed = JSON.parse(raw) as unknown[];
  return JSON.stringify([...parsed, { file: 'src/init.ts', ruleId: 'no-var', severity, message: 'prefer const or let' }]);
}

/**
 * F46's golden: every key each baseline fixture yields, pinned before the
 * fingerprints moved onto `../findings`' parsers. `keys` is the keying with no
 * argv, recorded by running 0.14.0's extractors (0.13's, unchanged) over each
 * fixture, so every key there is 0.13's, byte for byte. `gating` is the keying
 * under the adapter's registry args, listed only where step 4's deliberate
 * change (D27, keying only what can fail) departs from `keys`. `target` is the
 * keying under the registry args from a target rooted at `apps/web`, recorded
 * from step 27's extractors (D50).
 */
type GoldenEntry = { adapter: string; keys: string[] | null; gating?: string[] | null; target: string[] | null };
const GOLDEN_FILE = 'baseline-keys.golden.json';
const GOLDEN = JSON.parse(read(GOLDEN_FILE)) as Record<string, GoldenEntry>;
const GOLDEN_ENTRIES = Object.entries(GOLDEN);

/** One golden entry by fixture name, failing loudly when the golden lacks it. */
function golden(file: string): GoldenEntry {
  const entry = GOLDEN[file];
  if (!entry) throw new Error(`no golden entry for ${file}`);
  return entry;
}

/** A fingerprint as the golden records it: its keys sorted, or `null`. */
function sortedKeys(fp: Fingerprint | null): string[] | null {
  return fp === null ? null : [...fp].toSorted();
}

describe('fingerprint — every fixture keys as it did before the parsers (F46)', () => {
  test('the golden covers every baseline fixture', () => {
    const fixtures = readdirSync(FIXTURES).filter((f) => f.startsWith('baseline-') && f !== GOLDEN_FILE);
    expect(GOLDEN_ENTRIES.map(([file]) => file).toSorted()).toEqual(fixtures.toSorted());
  });

  test.each(GOLDEN_ENTRIES)('%s keys byte-identically to 0.13 with no argv', (file, entry) => {
    expect(sortedKeys(fingerprint(entry.adapter, read(file)))).toEqual(entry.keys);
  });

  test.each(GOLDEN_ENTRIES)('%s departs from 0.13 under its registry args only by step 4', (file, entry) => {
    const expected = entry.gating === undefined ? entry.keys : entry.gating;
    expect(sortedKeys(fingerprint(entry.adapter, read(file), registryArgv(entry.adapter)))).toEqual(expected);
  });

  test("step 4's departure touches the oxlint and ast-grep fixtures alone", () => {
    const departed = GOLDEN_ENTRIES.filter(([, entry]) => entry.gating !== undefined).map(([, entry]) => entry.adapter);
    expect(new Set(departed)).toEqual(new Set(['oxlint', 'ast-grep']));
  });

  test.each(GOLDEN_ENTRIES)("%s keys from a target's root as step 27 did (D50)", (file, entry) => {
    expect(sortedKeys(fingerprint(entry.adapter, read(file), registryArgv(entry.adapter), 'apps/web'))).toEqual(entry.target);
  });
});

describe('fingerprint — a multi-target capture keys as step 27 did (D50)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-golden-targets-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('checkride baseline over two targets and a repo-scope check writes the golden keys', async () => {
    const config: CheckrideConfig = {
      checks: { struct: 'ast-grep' },
      targets: {
        web: { lang: 'ts', root: 'apps/web', checks: { lint: 'oxlint', dead: 'fallow', health: 'fallow' } },
        api: { lang: 'ts', root: 'apps/api', checks: { lint: 'oxlint' } },
      },
    };
    // Each check replays a real capture, as its tool printed it from where it ran.
    const replay: Record<string, string> = {
      'web:lint': read('baseline-oxlint.json'),
      'web:dead': read('baseline-fallow-dead-code.json'),
      'web:health': read('baseline-fallow-health.json'),
      'api:lint': '{"diagnostics":[]}',
      struct: read('baseline-ast-grep-severities.json'),
    };
    const runner: CheckRunner = (r) => {
      const stdout = replay[r.target !== undefined ? `${r.target}:${r.slot}` : r.slot] ?? '';
      return Promise.resolve({ ok: true, exit_code: 0, stdout, stderr: '' });
    };
    const result = await runBaseline({ cwd: dir, config, runner, stderr: { write: () => true } });
    expect(result.baseline.slots).toEqual({
      'web:lint': golden('baseline-oxlint.json').target,
      'web:dead': golden('baseline-fallow-dead-code.json').target,
      'web:health': golden('baseline-fallow-health.json').target,
      'api:lint': [],
      struct: golden('baseline-ast-grep-severities.json').gating,
    });
  });
});

describe('fingerprint — extraction', () => {
  test('oxlint keys on file + rule (code) + message (no argv, so every diagnostic)', () => {
    expect(fingerprint('oxlint', OXLINT)).toEqual(
      new Set([
        'src/doctor.ts:eslint(no-await-in-loop):Unexpected `await` inside a loop.',
        'src/init.ts:eslint(no-await-in-loop):Unexpected `await` inside a loop.',
        'src/config.ts:typescript(no-unused-vars):Variable is assigned a value but never used.',
      ]),
    );
  });

  test('ast-grep keys on file + ruleId + message', () => {
    expect(fingerprint('ast-grep', AST_GREP)).toEqual(
      new Set([
        'src/cli.ts:no-default-export:avoid default exports',
        'src/config.ts:no-class:no classes',
      ]),
    );
  });

  test('cspell keys on file + message with an empty rule slot', () => {
    expect(fingerprint('cspell', CSPELL)).toEqual(
      new Set([
        'src/cli.ts::Unknown word (oxlint)',
        'src/config.ts::Unknown word (vitest)',
        'src/init.ts::Unknown word (cspell)',
      ]),
    );
  });

  test('fallow dead-code keys on category + file + symbol (v7)', () => {
    expect(fingerprint('fallow', FALLOW_DEAD)).toEqual(
      new Set([
        'dead-code:unused_files:src/unused.ts',
        'dead-code:unused_exports:src/extras.ts:extraExport',
      ]),
    );
  });

  test('fallow dupes keys on the clone-group content fingerprint (v7)', () => {
    expect(fingerprint('fallow', FALLOW_DUPES)).toEqual(new Set(['dupes:dup:0d3e33a3']));
  });

  test('fallow health keys on file + function name (v7)', () => {
    expect(fingerprint('fallow', FALLOW_HEALTH)).toEqual(new Set(['health:src/complex.ts:tangled']));
  });

  test('vale keys on file + Check + Message, across markdown and TS doc comments', () => {
    // Real `vale --output=JSON` over the scaffolded style: 10 alerts across two
    // files, 8 of them error-severity, two of those identical but for their line.
    expect(fingerprint('vale', VALE)).toEqual(
      new Set([
        "docs/tools.md:Repo.ThereIs:'There is' postpones the subject — name the thing that acts, then act.",
        "docs/tools.md:Vale.Repetition:'a' is repeated!",
        "docs/tools.md:Repo.Latin:Use 'for example' instead of 'e.g. '.",
        "docs/tools.md:Repo.LyHyphen:'newly-created': an adverb ending in '-ly' takes no hyphen.",
        "src/runner.ts:Repo.ThereIs:'There is' postpones the subject — name the thing that acts, then act.",
        "src/runner.ts:Repo.LyHyphen:'deliberately-wrapped': an adverb ending in '-ly' takes no hyphen.",
        "src/runner.ts:Repo.Latin:Use 'that is' instead of 'i.e. '.",
      ]),
    );
  });

  test('vale collapses a message wrapped across lines into one key', () => {
    // Synthetic: vale flattens a multi-line rule message itself, so this pins
    // the shared `key()` helper's collapse rather than a shape vale emits.
    const wrapped = JSON.stringify({
      'docs/a.md': [{ Check: 'Repo.Wordy', Severity: 'error', Message: "  'in order to' is wordy.\n  Prefer  'to'.  " }],
    });
    expect(fingerprint('vale', wrapped)).toEqual(new Set(["docs/a.md:Repo.Wordy:'in order to' is wordy. Prefer 'to'."]));
  });
});

/** Every key of `adapter` over `raw`, run from `root` and from the repo root. */
function bothKeys(adapter: string, raw: string, root: string): [string[], string[]] {
  return [[...(fingerprint(adapter, raw, undefined, root) ?? [])].toSorted(), [...(fingerprint(adapter, raw) ?? [])].toSorted()];
}

/** An oxlint report with one error diagnostic on `filename`. */
function oxlintOn(filename: string): string {
  return JSON.stringify({ diagnostics: [{ filename, code: 'eslint(x)', message: 'm', severity: 'error' }] });
}

describe("fingerprint — a target's keys name files from the repo root (D50)", () => {
  test.each([
    ['oxlint', OXLINT],
    ['ast-grep', AST_GREP],
    ['cspell', CSPELL],
    ['vale', VALE],
  ])('%s joins the target root onto each file, and changes nothing else in the key', (adapter, raw) => {
    const [rebased, plain] = bothKeys(adapter, raw, 'apps/web');
    expect(rebased).toEqual(plain.map((key) => `apps/web/${key}`).toSorted());
  });

  test("fallow's dead-code and health keys join the root onto their paths, and dupes keys carry none", () => {
    expect(fingerprint('fallow', FALLOW_DEAD, undefined, 'apps/web')).toEqual(
      new Set(['dead-code:unused_files:apps/web/src/unused.ts', 'dead-code:unused_exports:apps/web/src/extras.ts:extraExport']),
    );
    expect(fingerprint('fallow', FALLOW_HEALTH, undefined, 'apps/web')).toEqual(new Set(['health:apps/web/src/complex.ts:tangled']));
    expect(fingerprint('fallow', FALLOW_DUPES, undefined, 'apps/web')).toEqual(fingerprint('fallow', FALLOW_DUPES));
  });

  test('a root of . keeps every key as the tool printed it, as no root does', () => {
    for (const [adapter, raw] of [['oxlint', OXLINT], ['fallow', FALLOW_DEAD], ['cspell', CSPELL]] as const) {
      const [atRoot, plain] = bothKeys(adapter, raw, '.');
      expect(atRoot, adapter).toEqual(plain);
    }
  });

  test('an absolute path stays absolute, and ./ and .. segments normalize away', () => {
    expect(fingerprint('oxlint', oxlintOn('/tmp/a.ts'), undefined, 'apps/web')).toEqual(new Set(['/tmp/a.ts:eslint(x):m']));
    expect(fingerprint('oxlint', oxlintOn('./src/a.ts'), undefined, 'apps/web')).toEqual(new Set(['apps/web/src/a.ts:eslint(x):m']));
    expect(fingerprint('oxlint', oxlintOn('../shared/a.ts'), undefined, 'apps/web')).toEqual(new Set(['apps/shared/a.ts:eslint(x):m']));
  });
});

describe('fingerprint — vale severity and report shape', () => {
  test('only error-severity alerts are fingerprinted (D19)', () => {
    // The `prose` verdict is vale's exit code, which is 1 iff an error-severity
    // alert exists. A warning can never fail the slot, so keying one would let
    // an advisory alert block masking on an otherwise grandfathered run.
    const keys = fingerprint('vale', VALE);
    expect([...(keys ?? [])].filter((k) => k.includes('Repo.Hedge'))).toEqual([]);
    expect(keys?.size).toBe(7);
  });

  test('a warnings-only payload fingerprints to the empty set, not null (D19)', () => {
    // "Supported and observed, nothing gating" — the ratchet may prune from it.
    expect(fingerprint('vale', VALE_WARNINGS)).toEqual(new Set());
  });

  test('a clean run ({}) is an alert report with no alerts, not an unreadable one', () => {
    expect(fingerprint('vale', '{}')).toEqual(new Set());
  });

  test('a vale runtime-error report returns null, never the empty set (D16)', () => {
    // E201 (unreadable config) is a flat object an alert-shaped reader would see
    // as zero findings — which would prune every grandfathered prose key.
    expect(fingerprint('vale', VALE_ERROR)).toBeNull();
    expect(fingerprint('vale', '{"Code":"E100","Text":"no config file found","Path":"","Line":0,"Span":0}')).toBeNull();
  });

  test('any other non-alert-report shape returns null too (D16)', () => {
    for (const raw of ['not json at all', '', '[]', '"a string"', 'null', '{"docs/a.md":"not an array"}', '{"docs/a.md":[1,2]}']) {
      expect(fingerprint('vale', raw)).toBeNull();
    }
  });
});

describe('fingerprint — stability', () => {
  test('duplicate findings collapse to one key (order-independent set)', () => {
    // Each fixture repeats one finding across lines: 4 oxlint → 3 keys,
    // 3 ast-grep → 2 keys, 4 cspell → 3 keys.
    expect(fingerprint('oxlint', OXLINT)?.size).toBe(3);
    expect(fingerprint('ast-grep', AST_GREP)?.size).toBe(2);
    expect(fingerprint('cspell', CSPELL)?.size).toBe(3);
  });

  test('reordering the diagnostics does not change the key set', () => {
    expect(fingerprint('oxlint', reversedJson(OXLINT, 'diagnostics'))).toEqual(fingerprint('oxlint', OXLINT));
    expect(fingerprint('ast-grep', reversedJson(AST_GREP))).toEqual(fingerprint('ast-grep', AST_GREP));
    const cspellReversed = CSPELL.trimEnd().split('\n').toReversed().join('\n');
    expect(fingerprint('cspell', cspellReversed)).toEqual(fingerprint('cspell', CSPELL));
    expect(fingerprint('vale', reversedVale(VALE))).toEqual(fingerprint('vale', VALE));
  });

  test('shifting line and column does not change the key', () => {
    // Move every oxlint finding down 100 lines; keys must be identical.
    const shifted = JSON.parse(OXLINT) as {
      diagnostics: { labels: { span: { line: number; column: number; offset: number } }[] }[];
    };
    for (const d of shifted.diagnostics) {
      for (const label of d.labels) {
        label.span.line += 100;
        label.span.column += 7;
        label.span.offset += 4096;
      }
    }
    expect(fingerprint('oxlint', JSON.stringify(shifted))).toEqual(fingerprint('oxlint', OXLINT));
  });
});

describe('fingerprint — oxlint and ast-grep key only what can fail (D27)', () => {
  const OXLINT_ERROR = 'src/config.ts:typescript(no-unused-vars):Variable is assigned a value but never used.';
  const DENY_ERROR = 'src/runner.ts:eslint(no-debugger):`debugger` statement is not allowed';

  test('oxlint under its registry args keys error diagnostics only', () => {
    expect(fingerprint('oxlint', OXLINT, OXLINT_ARGV)).toEqual(new Set([OXLINT_ERROR]));
  });

  test('a real --deny-warnings run still reports its warnings as warnings, so only argv says they gate (F32)', () => {
    // The capture's warnings gated that run, yet each still reads `severity:
    // "warning"`: the flag, not the field, is what says they can fail.
    expect(fingerprint('oxlint', OXLINT_DENY, OXLINT_ARGV)).toEqual(new Set([DENY_ERROR]));
    expect(fingerprint('oxlint', OXLINT_DENY, [...OXLINT_ARGV, '--deny-warnings'])).toEqual(
      new Set([
        DENY_ERROR,
        'src/report.ts:eslint(eqeqeq):Expected === and instead saw ==',
        'src/runner.ts:eslint(eqeqeq):Expected === and instead saw ==',
        "src/runner.ts:eslint(no-unused-vars):Variable 'retries' is declared but never used. Unused variables should start with a '_'.",
      ]),
    );
  });

  test('--max-warnings keys warnings in either spelling', () => {
    expect(fingerprint('oxlint', OXLINT, [...OXLINT_ARGV, '--max-warnings=0'])?.size).toBe(3);
    expect(fingerprint('oxlint', OXLINT, [...OXLINT_ARGV, '--max-warnings', '5'])?.size).toBe(3);
  });

  test('an oxlint named by path is still read for its flags', () => {
    expect(fingerprint('oxlint', OXLINT, ['node_modules/.bin/oxlint', '--format=json'])).toEqual(new Set([OXLINT_ERROR]));
  });

  test('an argv that hides oxlint, or none at all, keys every diagnostic', () => {
    // A package script or `sh -c` may pass --deny-warnings where argv can't see
    // it; keying a warning that can't fail is a false red, never a false green.
    for (const argv of [['pnpm', 'run', 'lint'], ['sh', '-c', 'oxlint --format=json --deny-warnings'], undefined]) {
      expect(fingerprint('oxlint', OXLINT, argv)?.size).toBe(3);
    }
  });

  test('an oxlint diagnostic with no severity is keyed', () => {
    const bare = JSON.stringify({ diagnostics: [{ filename: 'a.ts', code: 'eslint(x)', message: 'm' }] });
    expect(fingerprint('oxlint', bare, OXLINT_ARGV)).toEqual(new Set(['a.ts:eslint(x):m']));
  });

  test('ast-grep under its registry args keys error matches only', () => {
    expect(fingerprint('ast-grep', AST_GREP_SEVERITIES, AST_GREP_ARGV)).toEqual(new Set(['src/config.ts:no-class:no classes']));
  });

  test('a bare --error, or one naming no rule, keys every match', () => {
    expect(fingerprint('ast-grep', AST_GREP_SEVERITIES, [...AST_GREP_ARGV, '--error'])?.size).toBe(3);
    expect(fingerprint('ast-grep', AST_GREP_SEVERITIES, [...AST_GREP_ARGV, '--error='])?.size).toBe(3);
  });

  test('--error=<rule> keys the rules it names, and no others', () => {
    expect(fingerprint('ast-grep', AST_GREP_SEVERITIES, [...AST_GREP_ARGV, '--error=no-var'])).toEqual(
      new Set(['src/config.ts:no-class:no classes', 'src/cli.ts:no-var:prefer const or let']),
    );
    expect(fingerprint('ast-grep', AST_GREP_SEVERITIES, [...AST_GREP_ARGV, '--error=no-var,no-console'])?.size).toBe(3);
    expect(fingerprint('ast-grep', AST_GREP_SEVERITIES, [...AST_GREP_ARGV, '--error=no-var', '--error=no-console'])?.size).toBe(3);
  });

  test('an argv that hides ast-grep, or none at all, keys every match', () => {
    for (const argv of [['pnpm', 'run', 'struct'], ['sh', '-c', 'ast-grep scan --json=compact'], undefined]) {
      expect(fingerprint('ast-grep', AST_GREP_SEVERITIES, argv)?.size).toBe(3);
    }
  });
});

describe('fingerprint — a new warning does not block masking (F31)', () => {
  test('an oxlint slot red only from grandfathered errors stays masked when a warning lands', () => {
    // oxlint exits 1 on the grandfathered error (rawOk false); the new warning
    // can't fail the slot, so it must not be the key that keeps it red.
    const captured = [...(fingerprint('oxlint', OXLINT, OXLINT_ARGV) ?? [])];
    const later = tally('oxlint', withOxlint(OXLINT, 'warning'), OXLINT_ARGV) ?? new Map<string, number>();
    expect(applyBaseline(later, { keys: captured }, false)).toEqual({ ok: true, baselined: 1, newKeys: [], excess: [], newFindings: 0 });
  });

  test('under --deny-warnings the same new warning is keyed and keeps the slot red (F32)', () => {
    const argv = [...OXLINT_ARGV, '--deny-warnings'];
    const captured = [...(fingerprint('oxlint', OXLINT, argv) ?? [])];
    const later = tally('oxlint', withOxlint(OXLINT, 'warning'), argv) ?? new Map<string, number>();
    // Four findings under three keys: one key is found twice, and the entry, captured before counts, grandfathers both.
    expect(applyBaseline(later, { keys: captured }, false)).toEqual({
      ok: false,
      baselined: 4,
      newKeys: ['src/cli.ts:eslint(eqeqeq):Expected === and instead saw =='],
      excess: [],
      newFindings: 1,
    });
  });

  test('an ast-grep slot red only from grandfathered errors stays masked when a warning lands', () => {
    const captured = [...(fingerprint('ast-grep', AST_GREP_SEVERITIES, AST_GREP_ARGV) ?? [])];
    const later = tally('ast-grep', withAstGrep(AST_GREP_SEVERITIES, 'warning'), AST_GREP_ARGV) ?? new Map<string, number>();
    expect(applyBaseline(later, { keys: captured }, false)).toEqual({ ok: true, baselined: 1, newKeys: [], excess: [], newFindings: 0 });
  });

  test('a new ast-grep error still blocks masking', () => {
    const captured = [...(fingerprint('ast-grep', AST_GREP_SEVERITIES, AST_GREP_ARGV) ?? [])];
    const later = tally('ast-grep', withAstGrep(AST_GREP_SEVERITIES, 'error'), AST_GREP_ARGV) ?? new Map<string, number>();
    expect(applyBaseline(later, { keys: captured }, false)).toEqual({
      ok: false,
      baselined: 1,
      newKeys: ['src/init.ts:no-var:prefer const or let'],
      excess: [],
      newFindings: 1,
    });
  });
});

describe('fingerprint — a prose slot through capture and masking', () => {
  /** What `checkride baseline` stores for a slot: its keys, sorted. */
  const captured = [...(fingerprint('vale', VALE) ?? [])].toSorted();

  test('a red prose slot goes green once its findings are captured', () => {
    expect(captured.length).toBe(7);
    // Eight alerts under seven keys, all grandfathered by an entry captured before counts.
    expect(applyBaseline(tally('vale', VALE) ?? new Map<string, number>(), { keys: captured }, false)).toEqual({
      ok: true,
      baselined: 8,
      newKeys: [],
      excess: [],
      newFindings: 0,
    });
  });

  test('a newly introduced finding stays red and is the only key listed', () => {
    const later = withAlert(VALE, 'docs/tools.md', 'Vale.Repetition', "'the' is repeated!");
    expect(applyBaseline(tally('vale', later) ?? new Map<string, number>(), { keys: captured }, false)).toEqual({
      ok: false,
      baselined: 8,
      newKeys: ["docs/tools.md:Vale.Repetition:'the' is repeated!"],
      excess: [],
      newFindings: 1,
    });
  });

  test('a new *warning* does not block masking — it was never keyed (D19)', () => {
    const later = JSON.parse(VALE) as Record<string, unknown[]>;
    later['docs/tools.md'] = [
      ...(later['docs/tools.md'] ?? []),
      { Check: 'Repo.Hedge', Severity: 'warning', Message: "'kind of' hedges — say the thing or cut it.", Line: 7 },
    ];
    // Vale exits 0 for a warning, so the slot is green on its own; the point is
    // that the key set is unchanged, so the baseline neither blocks nor churns.
    expect(fingerprint('vale', JSON.stringify(later))).toEqual(fingerprint('vale', VALE));
  });

  test('a run vale could not read masks nothing and prunes nothing', () => {
    // `null` short-circuits masking in the orchestrator and the ratchet's
    // observed map alike, so a broken config leaves the captured keys standing.
    expect(fingerprint('vale', VALE_ERROR)).toBeNull();
  });
});

/** An oxlint report of one finding, `message` at a.ts:3:7. */
function oneFinding(message: string, severity = 'error'): string {
  return JSON.stringify({ diagnostics: [{ filename: 'a.ts', code: 'no-x', message, severity, labels: [{ span: { line: 3, column: 7 } }] }] });
}

/** What a red check's status line names beneath it when nothing else there lists what it found. */
describe('firstFinding', () => {
  test('is null for an adapter with no parser, output its parser cannot read, or nothing that gates', () => {
    expect(firstFinding('vitest', 'FAIL a.test.ts')).toBeNull();
    expect(firstFinding('oxlint', 'not json')).toBeNull();
    expect(firstFinding('oxlint', '{"diagnostics":[]}')).toBeNull();
    // With the argv in hand, an oxlint warning can't fail the check.
    expect(firstFinding('oxlint', oneFinding('only advice', 'warning'), ['pnpm', 'exec', 'oxlint', '--format=json'])).toBeNull();
    expect(firstFinding('oxlint', oneFinding('only advice', 'warning'), ['pnpm', 'exec', 'oxlint', '--format=json', '--deny-warnings'])).toEqual({ line: 'a.ts:3:7 only advice', more: 0 });
  });

  test('a cut never splits a character that takes two UTF-16 units', () => {
    // "a.ts:3:7 " is 9 units, so the emoji's first unit lands on the 199th, the last kept before `…`.
    const { line } = firstFinding('oxlint', oneFinding(`${'x'.repeat(189)}😀${'x'.repeat(50)}`)) ?? { line: '' };
    expect(line).toBe(`a.ts:3:7 ${'x'.repeat(189)}…`);
  });
});

describe('fingerprint — support boundary', () => {
  test('a supported adapter with zero findings returns an empty set, not null', () => {
    expect(fingerprint('oxlint', '{"diagnostics":[]}')).toEqual(new Set());
    expect(fingerprint('ast-grep', '[]')).toEqual(new Set());
    expect(fingerprint('cspell', '')).toEqual(new Set());
    expect(fingerprint('tsc', '')).toEqual(new Set());
  });

  test('an adapter with no extractor returns null (baseline unsupported)', () => {
    // Alternates and non-diagnostic slots sit out (fallow is supported — below).
    for (const adapter of ['knip', 'biome-format', 'go-build', 'links', 'stryker', 'pnpm-audit']) {
      expect(fingerprint(adapter, '[]')).toBeNull();
    }
  });

  test('eslint and biome key the lint slot as oxlint does, their clean runs an empty set (#8)', () => {
    expect(fingerprint('eslint', '[]')).toEqual(new Set());
    expect(fingerprint('biome', JSON.stringify({ summary: { errors: 0, warnings: 0 }, diagnostics: [] }))).toEqual(new Set());
    expect(isFingerprintable('eslint')).toBe(true);
    expect(isFingerprintable('biome')).toBe(true);
  });

  test('findingText hands each parser the stream it declares, and stdout when there is none (D49)', () => {
    const output = { stdout: 'out', stderr: 'err' };
    for (const adapter of ['oxlint', 'cspell', 'fallow', 'tsc']) expect(findingText(adapter, output), adapter).toBe('out');
  });

  test('malformed output is unobserved (null), never throws', () => {
    // Read as clean, any of these would let the ratchet prune every key.
    expect(fingerprint('oxlint', 'not json at all')).toBeNull();
    expect(fingerprint('oxlint', '{"diagnostics":"nope"}')).toBeNull();
    expect(fingerprint('oxlint', '')).toBeNull();
    expect(fingerprint('ast-grep', '{"not":"an array"}')).toBeNull();
    expect(fingerprint('ast-grep', '')).toBeNull();
  });
});

describe('fingerprint — the go, rust and bash packs (step 50)', () => {
  // Real captures from a scratch repo at /tmp/fixture-repo: golangci-lint
  // 2.14.0 and staticcheck 0.8.2 over a module in svc/, clippy and cargo check
  // from Rust 1.99.0 over a workspace in rs/, and shellcheck 0.11.0 in scripts/.
  const STATICCHECK = read('findings-staticcheck.jsonl');

  test("each linter's gating findings key the baseline, its paths from the repo root", () => {
    expect(fingerprint('golangci-lint', read('findings-golangci-lint.json'), undefined, 'svc')?.size).toBe(4);
    expect(fingerprint('clippy', read('findings-clippy.jsonl'), undefined, 'rs')).toEqual(
      new Set([
        'rs/crates/core/src/lib.rs:clippy::needless_return:unneeded `return` statement',
        'rs/crates/core/src/lib.rs:clippy::ptr_arg:writing `&Vec` instead of `&[_]` involves a new object where a slice will do',
      ]),
    );
    // SC2086 fires twice in deploy.sh, and both key alike.
    expect(fingerprint('shellcheck', read('findings-shellcheck.json'), undefined, 'scripts')?.size).toBe(11);
  });

  test("staticcheck's absolute paths key from the repo root, so a baseline reads the same on every machine", () => {
    expect(fingerprint('staticcheck', STATICCHECK, undefined, 'svc', '/tmp/fixture-repo')).toEqual(
      new Set([
        'svc/internal/store/store.go:S1003:should use strings.Contains(parts[0], "x") instead',
        "svc/internal/store/store.go:S1025:the argument is already a string, there's no need to use fmt.Sprintf",
      ]),
    );
  });

  test('clippy warnings that -D warnings would not fail key nothing: supported, but clean', () => {
    expect(fingerprint('clippy', read('findings-clippy-warnings.jsonl'))).toEqual(new Set());
  });

  test("cargo check's errors are never keyed, since it stops at the first crate with errors", () => {
    expect(fingerprint('cargo-check', read('findings-cargo-check.jsonl'))).toBeNull();
  });

  describe('through capture and masking', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-staticcheck-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    test('a capture keys staticcheck from the repo root, and a later run masks with those keys', async () => {
      const config: CheckrideConfig = { targets: { svc: { lang: 'go', root: 'svc', checks: { lint: 'staticcheck' } } } };
      // staticcheck prints absolute paths, so the replay names files under this repo.
      const stdout = STATICCHECK.replaceAll('/tmp/fixture-repo', dir);
      const runner: CheckRunner = () => Promise.resolve({ ok: false, exit_code: 1, stdout, stderr: '' });
      const quiet = { write: () => true };
      const { baseline } = await runBaseline({ cwd: dir, config, runner, stderr: quiet });
      expect(baseline.slots['svc:lint']).toEqual([...(fingerprint('staticcheck', STATICCHECK, undefined, 'svc', '/tmp/fixture-repo') ?? [])].toSorted());
      const run = await runChecks({ cwd: dir, config, runner, baseline, only: ['svc:lint'], stderr: quiet });
      expect(run.summary.checks.find((c) => c.name === 'svc:lint')).toMatchObject({ ok: true, baselined: 2 });
    });
  });
});

// cspell:ignore recieve seperate Calcualte
describe('fingerprint — the docs, spell and type-checker parsers (step 51)', () => {
  // Real captures: markdownlint-cli2 0.23.3 and rumdl 0.2.79 over one pair of
  // Markdown files, typos 1.51.1 in `--format brief`, tsc 7.0.2 and go build
  // from Go 1.27.2.
  const MARKDOWNLINT = read('findings-markdownlint-cli2.stderr.txt');
  const BANNER = 'markdownlint-cli2 v0.23.3 (markdownlint v0.41.1)\nFinding: **/*.md\nLinting: 2 files\nSummary: 10 issues in 2 files\n';
  /** A markdownlint-cli2 run that failed on the captured report, printed where the tool prints it. */
  const markdownRun: CheckRunner = () => Promise.resolve({ ok: false, exit_code: 1, stdout: BANNER, stderr: MARKDOWNLINT });

  test("markdownlint-cli2's findings are read from stderr, and only its errors key (D32, D49)", () => {
    const output = { stdout: BANNER, stderr: MARKDOWNLINT };
    expect(findingText('markdownlint-cli2', output)).toBe(MARKDOWNLINT);
    const keys = fingerprint('markdownlint-cli2', findingText('markdownlint-cli2', output));
    expect(keys?.size).toBe(9);
    expect([...(keys ?? [])].some((k) => k.includes(':MD033:'))).toBe(false);
  });

  test("rumdl's and typos' findings key the baseline", () => {
    expect(fingerprint('rumdl', read('findings-rumdl.json'), registryArgv('rumdl'))?.size).toBe(8);
    expect(fingerprint('typos', read('findings-typos.txt'), registryArgv('typos'))).toEqual(
      new Set([
        'docs/notes.md::`teh` should be `the`',
        'docs/notes.md::`recieve` should be `receive`',
        'docs/notes.md::`seperate` should be `separate`',
        '::`seperate` should be `separate`',
        'docs/sample.ts::`Calcualte` should be `Calculate`',
      ]),
    );
  });

  test("go build's errors are never keyed, since it stops at ten in a package and skips the packages importing it", () => {
    expect(fingerprint('go-build', read('findings-go-build.jsonl'))).toBeNull();
  });

  describe('through capture and masking', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-docs-baseline-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    test('a capture grandfathers the markdown findings on stderr, and a later run masks them', async () => {
      const config: CheckrideConfig = { checks: { docs: 'markdownlint-cli2' } };
      const quiet = { write: () => true };
      const { baseline } = await runBaseline({ cwd: dir, config, runner: markdownRun, stderr: quiet });
      expect(baseline.slots['docs']).toHaveLength(9);
      const run = await runChecks({ cwd: dir, config, runner: markdownRun, baseline, only: ['docs'], stderr: quiet });
      expect(run.summary.checks.find((c) => c.name === 'docs')).toMatchObject({ ok: true, baselined: 9 });
    });
  });
});

/** A `tsc --build` that failed printing `stdout`, as tsc does with any error. */
function tscPrinting(stdout: string): CheckRunner {
  return () => Promise.resolve({ ok: false, exit_code: 2, stdout, stderr: '' });
}

describe('fingerprint — tsc', () => {
  // Real captures: tsc 7.0.2's `--build` over a solution at web/, lib and app
  // referencing it, with ordinary errors, then with a syntax error in lib, an
  // options error in app's tsconfig, and lib's declarations left unbuilt.
  const BUILD = read('findings-tsc-build.txt');
  const SYNTAX = read('findings-tsc-syntax.txt');
  const TSC_ARGV = registryArgv('tsc');
  const TYPE_ERROR = "Type '…' is not assignable to type '…'.";

  test("each error keys as <file>:<code>:<its first line, each quoted span …>, and a key counts the errors it names alike", () => {
    expect(tally('tsc', BUILD, TSC_ARGV, 'web')).toEqual(
      new Map([
        [`web/lib/src/index.ts:TS2322:${TYPE_ERROR}`, 2],
        ["web/lib/src/index.ts:TS7053:Element implicitly has an '…' type because expression of type '…' can't be used to index type '…'.", 1],
        ["web/lib/src/index.ts:TS1308:'…' expressions are only allowed within async functions and at the top levels of modules.", 1],
        ["web/app/src/main.ts:TS6133:'…' is declared but its value is never read.", 1],
        ["web/app/src/main.ts:TS2741:Property '…' is missing in type '…' but required in type '…'.", 1],
        [`web/app/src/main.ts:TS2322:${TYPE_ERROR}`, 2],
      ]),
    );
  });

  test('a run that stopped short of some errors keys nothing, so it masks nothing and prunes nothing', () => {
    for (const fixture of ['findings-tsc-syntax.txt', 'findings-tsc-config.txt', 'findings-tsc-unbuilt-reference.txt', 'findings-tsc-missing-project.txt']) {
      expect(fingerprint('tsc', read(fixture), TSC_ARGV), fixture).toBeNull();
    }
    expect(fingerprint('tsc', BUILD, [...TSC_ARGV, '--stopBuildOnErrors'])).toBeNull();
    expect(fingerprint('tsc', '', [...TSC_ARGV, '--stopBuildOnErrors'])).toEqual(new Set());
  });

  test("a run tells what its output alone can't: a TypeScript before 5.6 skipped projects, or tsc died part way", () => {
    const failed = { ok: false, exit_code: 2, stdout: BUILD, stderr: '' };
    expect(observedTally('tsc', failed, TSC_ARGV)?.size).toBe(6);
    expect(observedTally('tsc', { ...failed, tool_version: '5.5.4' }, TSC_ARGV)).toBeNull();
    expect(observedTally('tsc', { ...failed, tool_version: '5.6.3' }, TSC_ARGV)?.size).toBe(6);
    expect(observedTally('tsc', { ...failed, stderr: 'fatal error: runtime: out of memory\n' }, TSC_ARGV)).toBeNull();
    // With no repo root to read the check's tsconfig from, nothing vouches for a single project.
    expect(stoppedShortReason('tsc', { ...failed, tool_version: '5.5.4' }, TSC_ARGV)).toBe(
      "tsc stopped short: TypeScript 5.5.4's `--build` skips each project that depends on one with errors, which 5.6 and later check",
    );
    expect(stoppedShortReason('tsc', failed, TSC_ARGV)).toBeNull();
    // An adapter whose parser can't stop short has nothing to say.
    expect(stoppedShortReason('oxlint', { ok: false, exit_code: 1, stdout: '{"diagnostics":[]}', stderr: '' })).toBeNull();
  });

  describe('through capture and masking', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-tsc-baseline-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    const slots: Slot[] = [{ name: 'types' }];
    const adapters: Adapter[] = [{ name: 'tsc', slot: 'types', description: 'tsc', detect: [], command: 'pnpm', args: ['exec', 'tsc', '--build'], outputFile: null, devDeps: {} }];
    const quiet = { write: () => true };
    const run = async (stdout: string, runner: CheckRunner = tscPrinting(stdout)) => {
      const result = await runChecks({ cwd: dir, slots, adapters, config: null, runner, stdout: quiet, stderr: quiet });
      return result.summary.checks.find((c) => c.name === 'types');
    };
    /** What tsc printed of lib alone, as a build that never reached app prints. */
    const LIB_ONLY = BUILD.split('\n').slice(0, 5).join('\n') + '\n';

    test('a capture grandfathers each error, a later run masks them, and a stopped-short run masks and prunes nothing, saying why', async () => {
      await runBaseline({ cwd: dir, slots, adapters, config: null, runner: tscPrinting(BUILD), stdout: quiet, stderr: quiet });
      const captured = await readFile(join(dir, BASELINE_FILE), 'utf8');
      const baseline = JSON.parse(captured) as { slots: Record<string, string[]>; counts?: Record<string, Record<string, number>> };
      expect(baseline.slots['types']).toHaveLength(6);
      expect(baseline.counts?.['types']).toEqual({ [`app/src/main.ts:TS2322:${TYPE_ERROR}`]: 2, [`lib/src/index.ts:TS2322:${TYPE_ERROR}`]: 2 });

      expect(await run(BUILD)).toMatchObject({ ok: true, baselined: 8 });
      // A third error of a key that grandfathers two is new, whatever types it names.
      const third = `${BUILD}lib/src/index.ts(30,3): error TS2322: Type 'bigint' is not assignable to type 'number'.\n`;
      expect(await run(third)).toMatchObject({ ok: false, new_count: 1 });

      // lib's syntax error hides its four errors: unmasked, none of lib's keys pruned, and the reason says why.
      const stopped = await run(SYNTAX);
      expect(stopped).toMatchObject({
        ok: false,
        reason: "tsc stopped short at `lib/src/broken.ts(1,34): error TS1005: ',' expected.`, so the baseline neither masked its findings nor pruned its keys",
      });
      expect(stopped?.baselined).toBeUndefined();
      expect(await readFile(join(dir, BASELINE_FILE), 'utf8')).toBe(captured);
      expect(await run(BUILD)).toMatchObject({ ok: true, baselined: 8 });
    });

    test("a tsc killed under pnpm after printing only grandfathered errors stays red, and prunes none of the rest", async () => {
      await runBaseline({ cwd: dir, slots, adapters, config: null, runner: tscPrinting(BUILD), stdout: quiet, stderr: quiet });
      const captured = await readFile(join(dir, BASELINE_FILE), 'utf8');
      // pnpm 11.28.5 turns a killed tool into exit 1, and says so on stdout.
      const killed = `${LIB_ONLY}undefined\n[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command was killed with SIGKILL (Forced termination): tsc --build\n`;
      const pnpmKill: CheckRunner = () => Promise.resolve({ ok: false, exit_code: 1, stdout: killed, stderr: '' });
      const check = await run(killed, pnpmKill);
      expect(check).toMatchObject({ ok: false });
      expect(check?.reason).toMatch(/^tsc stopped short: `\[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL\] Command was killed with SIGKILL/);
      expect(await readFile(join(dir, BASELINE_FILE), 'utf8')).toBe(captured);
    });

    test('a TypeScript before 5.6 building references that printed only grandfathered errors stays red, since its --build skipped what depends on them', async () => {
      await writeFile(join(dir, 'tsconfig.json'), '{ "files": [], "references": [{ "path": "./lib" }, { "path": "./app" }] }\n');
      await runBaseline({ cwd: dir, slots, adapters, config: null, runner: tscPrinting(BUILD), stdout: quiet, stderr: quiet });
      const old: CheckRunner = () => Promise.resolve({ ok: false, exit_code: 1, stdout: LIB_ONLY, stderr: '', pin_source: 'js-lockfile', tool_version: '5.5.4' });
      expect(await run(LIB_ONLY, old)).toMatchObject({ ok: false, reason: expect.stringContaining("TypeScript 5.5.4's `--build`") as unknown });
      // From 5.6 on, a build that printed only lib's errors reached app too, and found it clean.
      const current: CheckRunner = () => Promise.resolve({ ok: false, exit_code: 2, stdout: LIB_ONLY, stderr: '', pin_source: 'js-lockfile', tool_version: '7.0.2' });
      expect(await run(LIB_ONLY, current)).toMatchObject({ ok: true, baselined: 4 });
    });

    test('a TypeScript before 5.6 building one project, which has nothing to skip, grandfathers and masks as any other', async () => {
      await writeFile(join(dir, 'tsconfig.json'), '{ "compilerOptions": { "strict": true }, "include": ["src"] }\n');
      const old: CheckRunner = () => Promise.resolve({ ok: false, exit_code: 1, stdout: BUILD, stderr: '', pin_source: 'js-lockfile', tool_version: '5.5.4' });
      await runBaseline({ cwd: dir, slots, adapters, config: null, runner: old, stdout: quiet, stderr: quiet });
      expect(JSON.parse(await readFile(join(dir, BASELINE_FILE), 'utf8'))).toMatchObject({ slots: { types: expect.any(Array) as unknown } });
      expect(await run(BUILD, old)).toMatchObject({ ok: true, baselined: 8 });
    });

    test('a capture that stopped short keeps the keys the file held, and says why', async () => {
      await runBaseline({ cwd: dir, slots, adapters, config: null, runner: tscPrinting(BUILD), stdout: quiet, stderr: quiet });
      const captured = await readFile(join(dir, BASELINE_FILE), 'utf8');
      const said: string[] = [];
      await runBaseline({ cwd: dir, slots, adapters, config: null, runner: tscPrinting(SYNTAX), stdout: quiet, stderr: { write: (t: string) => { said.push(t); return true; } } });
      expect(said.join('')).toContain(
        "baseline: types didn't reach every error (tsc stopped short at `lib/src/broken.ts(1,34): error TS1005: ',' expected.`), so it keeps its 6 previous key(s)\n",
      );
      expect(await readFile(join(dir, BASELINE_FILE), 'utf8')).toBe(captured);
    });

    test("a run's new findings list each key, and beneath it the findings tsc printed under it", async () => {
      await runBaseline({ cwd: dir, slots, adapters, config: null, runner: tscPrinting(BUILD), stdout: quiet, stderr: quiet });
      const added = [
        `${BUILD}lib/src/index.ts(30,3): error TS2322: Type 'bigint' is not assignable to type 'number'.`,
        "app/src/main.ts(12,1): error TS2304: Cannot find name 'shippingCents'.",
        '',
      ].join('\n');
      const said: string[] = [];
      await runChecks({ cwd: dir, slots, adapters, config: null, runner: tscPrinting(added), stdout: quiet, stderr: { write: (t: string) => { said.push(t); return true; } } });
      const text = said.join('');
      expect(text).toContain(
        "             app/src/main.ts:TS2304:Cannot find name '…'.\n" +
          "               app/src/main.ts(12,1): error TS2304: Cannot find name 'shippingCents'.\n",
      );
      // A key found more often than it grandfathers lists its every finding, since none says which is new.
      expect(text).toContain(`             lib/src/index.ts:TS2322:${TYPE_ERROR} (3 found, 2 grandfathered)\n`);
      expect(text).toContain("               lib/src/index.ts(30,3): error TS2322: Type 'bigint' is not assignable to type 'number'.\n");
      expect(text).toContain("               lib/src/index.ts(4,3): error TS2322: Type 'string' is not assignable to type 'number'.\n");
    });
  });
});

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { ADAPTERS } from '../adapters.js';
import { applyBaseline, fingerprint } from '../baseline/index.js';

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
    const later = fingerprint('oxlint', withOxlint(OXLINT, 'warning'), OXLINT_ARGV) ?? new Set();
    expect(applyBaseline(later, captured, false)).toEqual({ ok: true, baselined: 1, newKeys: [] });
  });

  test('under --deny-warnings the same new warning is keyed and keeps the slot red (F32)', () => {
    const argv = [...OXLINT_ARGV, '--deny-warnings'];
    const captured = [...(fingerprint('oxlint', OXLINT, argv) ?? [])];
    const later = fingerprint('oxlint', withOxlint(OXLINT, 'warning'), argv) ?? new Set();
    expect(applyBaseline(later, captured, false)).toEqual({
      ok: false,
      baselined: 3,
      newKeys: ['src/cli.ts:eslint(eqeqeq):Expected === and instead saw =='],
    });
  });

  test('an ast-grep slot red only from grandfathered errors stays masked when a warning lands', () => {
    const captured = [...(fingerprint('ast-grep', AST_GREP_SEVERITIES, AST_GREP_ARGV) ?? [])];
    const later = fingerprint('ast-grep', withAstGrep(AST_GREP_SEVERITIES, 'warning'), AST_GREP_ARGV) ?? new Set();
    expect(applyBaseline(later, captured, false)).toEqual({ ok: true, baselined: 1, newKeys: [] });
  });

  test('a new ast-grep error still blocks masking', () => {
    const captured = [...(fingerprint('ast-grep', AST_GREP_SEVERITIES, AST_GREP_ARGV) ?? [])];
    const later = fingerprint('ast-grep', withAstGrep(AST_GREP_SEVERITIES, 'error'), AST_GREP_ARGV) ?? new Set();
    expect(applyBaseline(later, captured, false)).toEqual({
      ok: false,
      baselined: 1,
      newKeys: ['src/init.ts:no-var:prefer const or let'],
    });
  });
});

describe('fingerprint — a prose slot through capture and masking', () => {
  /** What `checkride baseline` stores for a slot: its keys, sorted. */
  const captured = [...(fingerprint('vale', VALE) ?? [])].toSorted();

  test('a red prose slot goes green once its findings are captured', () => {
    expect(captured.length).toBe(7);
    expect(applyBaseline(fingerprint('vale', VALE) ?? new Set(), captured, false)).toEqual({
      ok: true,
      baselined: 7,
      newKeys: [],
    });
  });

  test('a newly introduced finding stays red and is the only key listed', () => {
    const later = withAlert(VALE, 'docs/tools.md', 'Vale.Repetition', "'the' is repeated!");
    expect(applyBaseline(fingerprint('vale', later) ?? new Set(), captured, false)).toEqual({
      ok: false,
      baselined: 7,
      newKeys: ["docs/tools.md:Vale.Repetition:'the' is repeated!"],
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

describe('fingerprint — support boundary', () => {
  test('a supported adapter with zero findings returns an empty set, not null', () => {
    expect(fingerprint('oxlint', '{"diagnostics":[]}')).toEqual(new Set());
    expect(fingerprint('ast-grep', '[]')).toEqual(new Set());
    expect(fingerprint('cspell', '')).toEqual(new Set());
  });

  test('an adapter with no extractor returns null (baseline unsupported)', () => {
    // Alternates and non-diagnostic slots sit out (fallow is supported — below).
    for (const adapter of ['knip', 'biome', 'eslint', 'tsc', 'links', 'stryker', 'pnpm-audit']) {
      expect(fingerprint(adapter, '[]')).toBeNull();
    }
  });

  test('malformed output fingerprints to an empty set, never throws', () => {
    expect(fingerprint('oxlint', 'not json at all')).toEqual(new Set());
    expect(fingerprint('oxlint', '{"diagnostics":"nope"}')).toEqual(new Set());
    expect(fingerprint('ast-grep', '{"not":"an array"}')).toEqual(new Set());
  });
});

/**
 * The parser registry and what each parser returns beside its keys: the
 * stream it declares (D49), every finding it read with whether that finding
 * gates, its 1-based position, and the fields a reader sees. The keys
 * themselves are held by the golden in
 * `src/__tests__/baseline-fingerprint.test.ts` (F46).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import type { KeyedFinding } from '../index.js';
import { currentKey, parseFallowReport, parserFor, streamText } from '../index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '__tests__', 'fixtures');
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

/** `adapter`'s findings over `raw`, failing loudly when it has no parser or can't trust the output. */
function parse(adapter: string, raw: string, argv?: readonly string[], root?: string): readonly KeyedFinding[] {
  const findings = parserFor(adapter)?.parse(raw, { argv, root, repoRoot: undefined });
  if (!findings) throw new Error(`${adapter} returned no findings`);
  return findings;
}

/** A fallow health report's keys, in report order, or `false` when it can't be read. */
function healthKeys(fixture: string, root?: string): string[] | false {
  const report = parseFallowReport(read(fixture), { root });
  return report.ok && report.findings.map((f) => f.key);
}

describe('parserFor', () => {
  test.each([
    ['oxlint', 'artifact'],
    ['ast-grep', 'artifact'],
    ['vale', 'artifact'],
    ['fallow', 'artifact'],
    ['cspell', 'stdout'],
    ['eslint', 'artifact'],
    ['biome', 'artifact'],
  ])('%s declares the %s stream', (adapter, stream) => {
    expect(parserFor(adapter)?.stream).toBe(stream);
  });

  test('an adapter with no parser, or a name only an object prototype carries, has none', () => {
    for (const adapter of ['vitest', 'knip', 'biome-format', 'constructor', 'toString', '__proto__']) {
      expect(parserFor(adapter), adapter).toBeUndefined();
    }
  });
});

describe('streamText', () => {
  const output = { stdout: 'out', stderr: 'err' };

  test('a stderr parser is handed stderr', () => {
    expect(streamText(output, 'stderr')).toBe('err');
  });

  test('a stdout or artifact parser is handed stdout, which holds the artifact', () => {
    expect(streamText(output, 'stdout')).toBe('out');
    expect(streamText(output, 'artifact')).toBe('out');
  });
});

describe('parsers return every finding, and say which gate', () => {
  const OXLINT_ARGV = ['oxlint', '--format=json'];

  test('oxlint returns its warnings beside its errors, marked as not gating', () => {
    const findings = parse('oxlint', read('baseline-oxlint.json'), OXLINT_ARGV);
    expect(findings).toHaveLength(4);
    expect(findings.filter((f) => f.gates).map((f) => f.rule)).toEqual(['typescript(no-unused-vars)']);
    expect(findings.find((f) => f.gates)).toEqual({
      file: 'src/config.ts',
      line: 12,
      column: 9,
      rule: 'typescript(no-unused-vars)',
      message: 'Variable is assigned a value but never used.',
      severity: 'error',
      gates: true,
      key: 'src/config.ts:typescript(no-unused-vars):Variable is assigned a value but never used.',
    });
  });

  test('oxlint under --deny-warnings, or with no argv, marks every finding as gating', () => {
    expect(parse('oxlint', read('baseline-oxlint.json'), [...OXLINT_ARGV, '--deny-warnings']).every((f) => f.gates)).toBe(true);
    expect(parse('oxlint', read('baseline-oxlint.json')).every((f) => f.gates)).toBe(true);
  });

  test('ast-grep marks its warning and hint matches as not gating, and counts its positions from 0', () => {
    const findings = parse('ast-grep', read('baseline-ast-grep-severities.json'), ['ast-grep', 'scan', '--json=compact']);
    expect(findings.map((f) => [f.rule, f.severity, f.gates, f.line, f.column])).toEqual([
      ['no-class', 'error', true, 1, 8],
      ['no-var', 'warning', false, 1, 1],
      ['no-console', 'hint', false, 2, 1],
    ]);
  });

  test('vale returns its warnings, and only error-severity alerts gate', () => {
    const findings = parse('vale', read('baseline-vale.json'));
    expect(findings).toHaveLength(10);
    expect(findings.filter((f) => f.gates).every((f) => f.severity === 'error')).toBe(true);
    expect(findings.filter((f) => !f.gates).every((f) => f.severity === 'warning')).toBe(true);
    expect(findings[0]).toMatchObject({ file: 'docs/tools.md', line: 1, column: 1, rule: 'Repo.ThereIs' });
  });

  test('vale returns null for its runtime-error report', () => {
    expect(parserFor('vale')?.parse(read('baseline-vale-error.json'), { argv: undefined, root: undefined })).toBeNull();
  });

  test.each([
    ['oxlint', ''],
    ['oxlint', 'Failed to parse configuration file'],
    ['oxlint', '[]'],
    ['oxlint', '{"diagnostics":"nope"}'],
    ['ast-grep', ''],
    ['ast-grep', 'error: no sgconfig.yml found'],
    ['ast-grep', '{"matches":[]}'],
  ])('%s returns null for output that is not the JSON it prints: %j', (adapter, raw) => {
    expect(parserFor(adapter)?.parse(raw, { argv: undefined, root: undefined })).toBeNull();
  });

  test('a clean oxlint or ast-grep report is an empty array, not null', () => {
    expect(parse('oxlint', '{"diagnostics":[]}')).toEqual([]);
    expect(parse('ast-grep', '[]')).toEqual([]);
  });

  test('cspell names no rule and no severity, and every unknown word gates', () => {
    const findings = parse('cspell', read('baseline-cspell.txt'), undefined, 'apps/web');
    expect(findings).toHaveLength(4);
    expect(findings[0]).toEqual({
      file: 'apps/web/src/cli.ts',
      line: 35,
      column: 37,
      rule: '',
      message: 'Unknown word (oxlint)',
      gates: true,
      key: 'apps/web/src/cli.ts::Unknown word (oxlint)',
    });
  });

  test('a finding with no file or no message is not a finding', () => {
    const raw = JSON.stringify({ diagnostics: [{ filename: '', message: 'm' }, { filename: 'a.ts', message: '' }] });
    expect(parse('oxlint', raw)).toEqual([]);
  });
});

describe('eslint', () => {
  const ESLINT_ARGV = ['pnpm', 'exec', 'eslint', '.', '--format', 'json'];
  const at = { argv: ESLINT_ARGV, root: undefined, repoRoot: '/work/repo' };
  const parseEslint = (raw: string): unknown => parserFor('eslint')?.parse(raw, at);

  test('every message is a finding keyed on its rule, a parse error on none, and only an error gates', () => {
    const findings = parserFor('eslint')?.parse(read('findings-eslint.json'), at) ?? [];
    expect(findings.map((f) => [f.key, f.severity, f.gates])).toEqual([
      ["src/a.js:no-unused-vars:'unused' is assigned a value but never used.", 'warning', false],
      ["src/a.js:prefer-const:'unused' is never reassigned. Use 'const' instead.", 'warning', false],
      ["src/a.js:eqeqeq:Expected '===' and instead saw '=='.", 'error', true],
      ["src/a.js:no-debugger:Unexpected 'debugger' statement.", 'error', true],
      ["src/a.js:eqeqeq:Expected '===' and instead saw '=='.", 'error', true],
      ['src/broken.js::Parsing error: Unexpected token =', 'error', true],
      ["src/nested/c.js:prefer-const:'y' is never reassigned. Use 'const' instead.", 'warning', false],
    ]);
    expect(findings[3]).toEqual({
      file: 'src/a.js',
      line: 4,
      column: 5,
      rule: 'no-debugger',
      message: "Unexpected 'debugger' statement.",
      severity: 'error',
      gates: true,
      key: "src/a.js:no-debugger:Unexpected 'debugger' statement.",
    });
  });

  test('a warning gates under --max-warnings, written either way, and under an argv that hides the flags', () => {
    const raw = read('findings-eslint.json');
    for (const argv of [[...ESLINT_ARGV, '--max-warnings', '0'], [...ESLINT_ARGV, '--max-warnings=10'], ['sh', '-c', 'npm run lint'], undefined]) {
      expect(parserFor('eslint')?.parse(raw, { ...at, argv })?.every((f) => f.gates), String(argv)).toBe(true);
    }
  });

  test('an absolute path outside the repo root, or with no root to measure from, stays as printed', () => {
    const findings = parserFor('eslint')?.parse(read('findings-eslint.json'), { ...at, repoRoot: undefined }) ?? [];
    expect(findings[0]?.file).toBe('/work/repo/src/a.js');
  });

  test('output that is no array of results, or holds a message the format never prints, is untrustworthy', () => {
    expect(parseEslint('')).toBeNull();
    expect(parseEslint('Oops! Something went wrong! :(')).toBeNull();
    expect(parseEslint('{"results":[]}')).toBeNull();
    expect(parseEslint('[{"filePath":"/work/repo/a.js"}]')).toBeNull();
    expect(parseEslint('[{"filePath":"/work/repo/a.js","messages":[{"ruleId":"x","severity":"high","message":"m"}]}]')).toBeNull();
    expect(parseEslint('[{"filePath":"/work/repo/a.js","messages":[{"ruleId":"x","severity":2}]}]')).toBeNull();
    expect(parseEslint('[]')).toEqual([]);
    expect(parseEslint('[{"filePath":"/work/repo/a.js","messages":[],"suppressedMessages":[{"ruleId":"x","severity":2,"message":"m"}]}]')).toEqual([]);
  });
});

describe('biome', () => {
  const BIOME_ARGV = ['pnpm', 'exec', 'biome', 'check', '--reporter=json'];
  const web = { argv: BIOME_ARGV, root: 'apps/web', repoRoot: undefined };
  const parseBiome = (value: unknown): unknown => parserFor('biome')?.parse(typeof value === 'string' ? value : JSON.stringify(value), web);

  test('every diagnostic is a finding keyed on its category, an error gates, and a warning or info does not', () => {
    const findings = parserFor('biome')?.parse(read('findings-biome.json'), web) ?? [];
    expect(findings.map((f) => [f.key, f.severity, f.gates])).toEqual([
      ['apps/web/biome.json:deserialize:The use of the recommended field has been deprecated, and will removed in the next major version of Biome. Use preset instead.', 'info', false],
      ['apps/web/src/a.js:lint/style/useConst:This let declares a variable that is only assigned once.', 'warning', false],
      ['apps/web/src/a.js:lint/correctness/noUnusedVariables:This variable unused is unused.', 'warning', false],
      ['apps/web/src/nested/c.js:lint/style/useConst:This let declares a variable that is only assigned once.', 'warning', false],
      ['apps/web/biome.json:format:Formatter would have printed the following content:', 'error', true],
      ['apps/web/src/a.js:lint/suspicious/noDoubleEquals:Using == may be unsafe if you are relying on type coercion.', 'error', true],
      ['apps/web/src/a.js:lint/suspicious/noDebugger:This is an unexpected use of the debugger statement.', 'error', true],
      ['apps/web/src/a.js:lint/suspicious/noDoubleEquals:Using == may be unsafe if you are relying on type coercion.', 'error', true],
      ['apps/web/src/a.js:format:Formatter would have printed the following content:', 'error', true],
      ["apps/web/src/broken.js:parse:Expected an identifier, an array pattern, or an object pattern but instead found '= 1'.", 'error', true],
      ['apps/web/src/broken.js:parse:expected `,` but instead found `;`', 'error', true],
      ["apps/web/src/broken.js:parse:Expected an identifier, an array pattern, or an object pattern but instead found '= 1'.", 'error', true],
      ["apps/web/src/broken.js:format:Code formatting aborted due to parsing errors. To format code with errors, enable the 'formatter.formatWithErrors' option.", 'error', true],
      ['apps/web/src/nested/c.js:format:Formatter would have printed the following content:', 'error', true],
    ]);
    // A whole-file diagnostic, such as a formatting one, names no position.
    expect(findings[4]).toEqual({
      file: 'apps/web/biome.json',
      rule: 'format',
      message: 'Formatter would have printed the following content:',
      severity: 'error',
      gates: true,
      key: 'apps/web/biome.json:format:Formatter would have printed the following content:',
    });
    expect(findings[5]).toMatchObject({ line: 3, column: 9 });
  });

  test('a warning gates under --error-on-warnings, or an argv that hides the flags; an info never does', () => {
    const raw = read('findings-biome.json');
    for (const argv of [[...BIOME_ARGV, '--error-on-warnings'], ['sh', '-c', 'npm run lint'], undefined]) {
      const findings = parserFor('biome')?.parse(raw, { ...web, argv }) ?? [];
      expect(findings.filter((f) => !f.gates).map((f) => f.severity), String(argv)).toEqual(['info']);
    }
  });

  test('a payload whose diagnostics the summary doesn\'t count, or that the format never prints, is untrustworthy', () => {
    const report = JSON.parse(read('findings-biome.json')) as { summary: Record<string, number>; diagnostics: Record<string, unknown>[] };
    expect(parseBiome('')).toBeNull();
    expect(parseBiome('[]')).toBeNull();
    expect(parseBiome({ ...report, summary: { ...report.summary, errors: 9 } })).toBeNull();
    expect(parseBiome({ ...report, summary: { ...report.summary, warnings: 4 } })).toBeNull();
    expect(parseBiome({ ...report, summary: { ...report.summary, diagnosticsNotPrinted: 3 } })).toBeNull();
    expect(parseBiome({ ...report, diagnostics: report.diagnostics.map((d, i) => (i === 5 ? { ...d, message: [{ content: 'markup' }] } : d)) })).toBeNull();
    // A clean run is an empty list, not an unread one.
    expect(parseBiome({ summary: { errors: 0, warnings: 0, infos: 0, diagnosticsNotPrinted: 0 }, diagnostics: [], command: 'check' })).toEqual([]);
  });
});

describe('the fallow parser', () => {
  const WEB = { root: 'apps/web' };

  test('a dead-code finding names its category as its rule, its symbol as its message, and its slot', () => {
    const report = parseFallowReport(read('baseline-fallow-dead-code.json'), WEB);
    expect(report.ok && report.findings.map(({ key: _key, ...rest }) => rest)).toEqual([
      { file: 'apps/web/src/unused.ts', rule: 'unused_files', message: '', gates: true, slot: 'dead' },
      { file: 'apps/web/src/extras.ts', line: 1, column: 17, rule: 'unused_exports', message: 'extraExport', gates: true, slot: 'dead' },
    ]);
  });

  test('a clone group names its first instance and its fingerprint, and a health finding its function', () => {
    const dupes = parseFallowReport(read('baseline-fallow-dupes.json'), WEB);
    expect(dupes.ok && dupes.findings[0]).toMatchObject({
      file: 'apps/web/src/dupeA.ts',
      line: 1,
      column: 26,
      rule: 'code-duplication',
      message: 'dup:0d3e33a3',
      slot: 'dupes',
    });
    const health = parseFallowReport(read('baseline-fallow-health.json'), { root: undefined });
    expect(health.ok && health.findings[0]).toEqual({
      file: 'src/complex.ts',
      line: 1,
      column: 8,
      rule: 'complexity',
      message: 'tangled',
      severity: 'high',
      gates: true,
      slot: 'health',
      key: 'health:src/complex.ts:tangled',
    });
  });

  test('a cycle names its first file and its whole chain', () => {
    const raw = JSON.stringify({
      schema_version: 7,
      kind: 'dead-code',
      summary: { total_issues: 1 },
      circular_dependencies: [{ files: ['src/b.ts', 'src/a.ts'] }],
    });
    const report = parseFallowReport(raw, { root: undefined });
    expect(report.ok && report.findings[0]).toMatchObject({ file: 'src/a.ts', message: 'src/a.ts -> src/b.ts' });
  });

  test('an unreadable report is a reason, and the parser reads it as untrustworthy', () => {
    expect(parseFallowReport('', { root: undefined })).toEqual({ ok: false, reason: 'fallow produced no JSON output' });
    expect(parserFor('fallow')?.parse('boom: fatal error', { argv: undefined, root: undefined })).toBeNull();
  });

  test("an Angular component's roll-up and its template file key without a position, and an inline template keeps its own (#8)", () => {
    // fallow 3.31.0 over two templateUrl components, one file holding two
    // inline templates, and one file holding two components.
    expect(healthKeys('findings-fallow-health-angular.json')).toEqual([
      'health:src/app/foo.component.ts:<component>',
      'health:src/app/foo.component.html:<template>',
      'health:src/app/bar.component.ts:<template>:3:0',
      'health:src/app/bar.component.ts:<template>:27:0',
      'health:src/app/one.html:<template>',
      'health:src/app/two.html:<template>',
      'health:src/app/bar.component.ts:tally',
      'health:src/app/foo.component.ts:pick',
      'health:src/app/two.component.ts:a',
      'health:src/app/two.component.ts:b',
    ]);
  });

  test("a Vue or Svelte component's template keys without a position, and a Svelte snippet keeps its own (#8)", () => {
    expect(healthKeys('findings-fallow-health-sfc.json', 'apps/web')).toEqual([
      'health:apps/web/src/A.vue:<template>',
      'health:apps/web/src/B.svelte:<template>',
      'health:apps/web/src/B.svelte:<snippet:row>:14:7',
    ]);
  });

  test('a unit that keys without a position still says where it sits', () => {
    const report = parseFallowReport(read('findings-fallow-health-angular.json'), { root: undefined });
    expect(report.ok && report.findings[0]).toMatchObject({ file: 'src/app/foo.component.ts', line: 11, column: 7, message: '<component>' });
  });
});

describe('currentKey', () => {
  test('reads an earlier release\'s positional key for a unit fallow names as the key it takes now (#8)', () => {
    expect(currentKey('health:src/app/foo.component.ts:<component>:11:6')).toBe('health:src/app/foo.component.ts:<component>');
    expect(currentKey('health:src/app/foo.component.html:<template>:2:7')).toBe('health:src/app/foo.component.html:<template>');
    expect(currentKey('health:apps/web/src/A.vue:<template>:6')).toBe('health:apps/web/src/A.vue:<template>');
  });

  test('leaves every other key as it is: an inline template, a snippet, a placeholder, a named function, any other tool', () => {
    for (const key of [
      'health:src/app/bar.component.ts:<template>:3:0',
      'health:apps/web/src/B.svelte:<snippet:row>:14:7',
      'health:src/a.ts:<arrow>:4:2',
      'health:src/a.ts:render',
      'health:src/app/foo.component.ts:<component>',
      'dead-code:unused_files:src/a.ts',
      'src/a.ts:eslint(eqeqeq):Expected === and instead saw ==',
    ]) {
      expect(currentKey(key), key).toBe(key);
    }
  });
});

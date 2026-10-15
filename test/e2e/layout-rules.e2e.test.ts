/**
 * The layout rules `init` ships, scanned on a real tree.
 *
 * A location rule matches `kind: program`, so its `files` and `ignores` globs
 * alone decide what fires, and `ast-grep test` runs snippets with no path at
 * all. So this builds a temp tree from `templates/shared/`'s sgconfig.yml and
 * rules/, plants a file at each path below, scans it once, and holds every
 * file to exactly the rules that must fire on it. Every path is planted twice:
 * at the root, the way the flat shape lays it out, and under a monorepo
 * package, where the rules' shape-agnostic globs have to reach too.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHARED = join(REPO, 'templates', 'shared');
const AST_GREP = join(REPO, 'node_modules', '.bin', 'ast-grep');

/** Where each shape keeps `src/` and `test/`: the root, or one package. */
const HOMES = [
  { shape: 'flat', home: '' },
  { shape: 'monorepo', home: 'libs/core/' },
] as const;

const EXPORT = 'export const value = 1;\n';
const DECLARE = 'export declare const value = 1;\n';
const HELPER = '../../test/helpers/make.js';

type Case = readonly [path: string, body: string, rules: readonly string[]];

/** Each file under one home, its contents, and exactly the rules that must fire on it. */
function casesUnder(home: string): Case[] {
  return [
    [`${home}src/plan/parse.test.ts`, EXPORT, ['colocate-unit-tests']],
    [`${home}src/plan/__tests__/parse.test.ts`, EXPORT, []],
    [`${home}src/plan/parse.spec.ts`, EXPORT, ['no-spec-suffix']],
    [`${home}test/e2e/cli.spec.ts`, EXPORT, ['no-spec-suffix']],
    [`${home}test/loose.test.ts`, EXPORT, ['test-dir-layout']],
    [`${home}test/unit/parse.test.ts`, EXPORT, ['test-dir-layout']],
    [`${home}test/integration/flow.test.ts`, EXPORT, []],
    [`${home}test/e2e/cli.e2e.test.ts`, EXPORT, []],
    [`${home}test/contract/report.test.ts`, EXPORT, []],
    [`${home}test/helpers/make.ts`, EXPORT, []],
    [`${home}__tests__/stray.test.ts`, EXPORT, ['tests-dir-is-src-only']],
    [`${home}test/__tests__/stray.test.ts`, EXPORT, ['test-dir-layout', 'tests-dir-is-src-only']],
    // tsc emits each colocated test's declaration here.
    [`${home}dist/__tests__/parse.test.d.ts`, DECLARE, []],
    // Reaching into test/ statically is also a deep import, so both rules agree.
    [`${home}src/report/leak.ts`, `import { value } from '${HELPER}';\nexport { value };\n`, ['no-deep-sibling-import', 'src-never-imports-test']],
    [`${home}src/report/reexport.ts`, `export { value } from '${HELPER}';\n`, ['src-never-imports-test']],
    [`${home}src/report/lazy.ts`, `export const load = () => import('${HELPER}');\n`, ['src-never-imports-test']],
    // Fixtures are data: every misplaced file above, planted under test/fixtures/, stays silent.
    [`${home}test/fixtures/repo/src/parse.test.ts`, EXPORT, []],
    [`${home}test/fixtures/repo/src/parse.spec.ts`, EXPORT, []],
    [`${home}test/fixtures/repo/test/loose.test.ts`, EXPORT, []],
    [`${home}test/fixtures/repo/__tests__/stray.test.ts`, EXPORT, []],
    [`${home}test/fixtures/loose.ts`, EXPORT, []],
    [`${home}test/fixtures/repo/src/leak.ts`, `import { value } from '${HELPER}';\nexport { value };\n`, []],
  ];
}

const CASES = HOMES.flatMap(({ home }) => casesUnder(home));

/** The shipped rules that decide by path alone, read from the templates rather than listed here. */
const LOCATION_RULES = readdirSync(join(SHARED, 'rules'))
  .filter((name) => /^rule:\n {2}kind: program$/m.test(readFileSync(join(SHARED, 'rules', name), 'utf8')))
  .map((name) => name.replace(/\.yml$/, ''))
  .toSorted();

type Finding = { readonly ruleId: string; readonly file: string };

let root = '';
let fired = new Map<string, string[]>();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'checkride-e2e-layout-'));
  cpSync(join(SHARED, 'sgconfig.yml'), join(root, 'sgconfig.yml'));
  cpSync(join(SHARED, 'rules'), join(root, 'rules'), { recursive: true });
  for (const [path, body] of CASES) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  // ast-grep exits 1 on error-level findings, which is the point here; only a
  // missing binary or a broken rule (no JSON on stdout) is fatal.
  const scan = spawnSync(AST_GREP, ['scan', '--json=compact'], { cwd: root, encoding: 'utf8' });
  if (scan.error !== undefined || !scan.stdout.trim().startsWith('[')) {
    throw new Error(`ast-grep scan did not report: ${scan.error === undefined ? scan.stderr : String(scan.error)}`);
  }
  fired = new Map();
  for (const { ruleId, file } of JSON.parse(scan.stdout) as Finding[]) {
    fired.set(file, [...(fired.get(file) ?? []), ruleId]);
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test('the templates ship the four location rules this file covers', () => {
  expect(LOCATION_RULES).toEqual(['colocate-unit-tests', 'no-spec-suffix', 'test-dir-layout', 'tests-dir-is-src-only']);
});

describe.each(HOMES)('$shape paths', ({ home }) => {
  const cases = casesUnder(home);

  test.each(cases)('%s', (path, _body, expected) => {
    const ids = [...new Set(fired.get(path) ?? [])].toSorted();
    expect(ids).toEqual(expected.toSorted());
  });

  test('each location rule fires on a misplaced file and stays silent under test/fixtures/', () => {
    const firing = new Set(cases.flatMap(([, , rules]) => rules));
    const fixtures = cases.filter(([path]) => path.startsWith(`${home}test/fixtures/`));
    for (const rule of LOCATION_RULES) {
      expect(firing, rule).toContain(rule);
      expect(fixtures.flatMap(([path]) => fired.get(path) ?? []), rule).not.toContain(rule);
    }
  });
});

/**
 * S2: the token grammar (R5.2). Each row is a token list and the checks it
 * selects, over the checks a multi-target run resolves and over an implicit
 * repo's, through `selectChecks` as `--only`, `--skip` and `--include` use it,
 * plus the tokens that select nothing and so are usage errors (F18).
 */

import { describe, expect, test } from 'vitest';

import type { ResolvedCheck } from '../../config.js';
import type { RunFlags } from '../../orchestrator/index.js';
import { selectChecks } from '../../orchestrator/index.js';
import type { Selectable } from '../tokens.js';
import { checkName, tokenProblem, validTokens } from '../tokens.js';

/** A resolved check from its name: `<target>:<slot>`, or a bare slot with no target. */
function check(name: string, optIn = false): ResolvedCheck & Selectable {
  const [target, slot] = name.includes(':') ? name.split(':') : [undefined, name];
  return { slot: slot ?? name, ...(target === undefined ? {} : { target }), optIn, adapter: null, skip: null };
}

/**
 * Three targets of three packs, the repo-scope slots and a top-level custom
 * check. `scripts` has no `types`, because its pack fills no such slot, and
 * `web:bundle-size` is a custom check of one target.
 */
const MULTI = [
  check('api:types'),
  check('api:lint'),
  check('api:test'),
  check('api:security', true),
  check('web:types'),
  check('web:format', true),
  check('web:lint'),
  check('web:test'),
  check('web:bundle-size'),
  check('scripts:format', true),
  check('scripts:lint'),
  check('struct'),
  check('links'),
  check('spell'),
  check('licenses'),
];

/** A repo with no targets: slots and one custom check, as 0.13 resolves them. */
const IMPLICIT = [check('types'), check('format', true), check('lint'), check('mutation', true), check('licenses')];

/** What a full run of {@link MULTI} selects: every check but the three opt-in ones. */
const DEFAULT_RUN = MULTI.filter((c) => !c.optIn).map(checkName);

function names(checks: readonly ResolvedCheck[], flags: RunFlags): string[] {
  return selectChecks(checks, flags).map(checkName);
}

function without(...drop: string[]): string[] {
  return DEFAULT_RUN.filter((name) => !drop.includes(name));
}

describe('S2: --only selects by token in multi-target mode', () => {
  const rows: readonly (readonly [string[], string[]])[] = [
    // A target-scope slot: that slot in every target whose pack fills it.
    [['lint'], ['api:lint', 'web:lint', 'scripts:lint']],
    [['types'], ['api:types', 'web:types']],
    // A repo-scope slot: the one repo check.
    [['links'], ['links']],
    // A target: every check of that target a full run would run.
    [['api'], ['api:types', 'api:lint', 'api:test']],
    // One check.
    [['api:lint'], ['api:lint']],
    // A top-level custom check.
    [['licenses'], ['licenses']],
    // A target's own custom check, qualified or bare.
    [['web:bundle-size'], ['web:bundle-size']],
    [['bundle-size'], ['web:bundle-size']],
    // Naming an opt-in slot opts it in, everywhere or in one target.
    [['format'], ['web:format', 'scripts:format']],
    [['web:format'], ['web:format']],
    [['api', 'api:security'], ['api:types', 'api:lint', 'api:test', 'api:security']],
    // Tokens union, in resolved order, each check once.
    [['links', 'api'], ['api:types', 'api:lint', 'api:test', 'links']],
    [['lint', 'api:lint', 'api'], ['api:types', 'api:lint', 'api:test', 'web:lint', 'scripts:lint']],
  ];
  for (const [only, selected] of rows) {
    test(`--only ${only.join(',')}`, () => {
      expect(tokenProblem(MULTI, '--only', only)).toBeNull();
      expect(names(MULTI, { only })).toEqual(selected);
    });
  }

  test('a target token lets in its opt-in slots only through --all or --include', () => {
    expect(names(MULTI, { only: ['web'], all: true })).toEqual([
      'web:types', 'web:format', 'web:lint', 'web:test', 'web:bundle-size',
    ]);
    expect(names(MULTI, { only: ['web'], include: ['format'] })).toContain('web:format');
  });
});

describe('S2: --skip and --include take the same tokens', () => {
  const rows: readonly (readonly [RunFlags, string[]])[] = [
    [{ skip: ['api'] }, without('api:types', 'api:lint', 'api:test')],
    [{ skip: ['lint'] }, without('api:lint', 'web:lint', 'scripts:lint')],
    [{ skip: ['web:lint', 'links'] }, without('web:lint', 'links')],
    [{ skip: ['bundle-size'] }, without('web:bundle-size')],
    [{ include: ['web'] }, [...DEFAULT_RUN.slice(0, 4), 'web:format', ...DEFAULT_RUN.slice(4)]],
    [{ include: ['api:security'] }, [...DEFAULT_RUN.slice(0, 3), 'api:security', ...DEFAULT_RUN.slice(3)]],
    [{ include: ['format'] }, MULTI.filter((c) => c.slot !== 'security').map(checkName)],
  ];
  for (const [flags, selected] of rows) {
    test(JSON.stringify(flags), () => {
      expect(names(MULTI, flags)).toEqual(selected);
    });
  }
});

describe('S2: implicit mode reads a token as a slot or custom-check name', () => {
  const rows: readonly (readonly [RunFlags, string[]])[] = [
    [{}, ['types', 'lint', 'licenses']],
    [{ only: ['lint'] }, ['lint']],
    [{ only: ['licenses'] }, ['licenses']],
    [{ only: ['mutation'] }, ['mutation']],
    [{ only: ['lint', 'types'] }, ['types', 'lint']],
    [{ skip: ['lint'] }, ['types', 'licenses']],
    [{ include: ['format'] }, ['types', 'format', 'lint', 'licenses']],
    // --only wins over --skip, as it always has.
    [{ only: ['lint'], skip: ['lint'] }, ['lint']],
  ];
  for (const [flags, selected] of rows) {
    test(JSON.stringify(flags), () => {
      expect(names(IMPLICIT, flags)).toEqual(selected);
    });
  }
});

describe('S2: a token that selects nothing is a usage error naming the valid ones', () => {
  const unknown: readonly (readonly [string, readonly ResolvedCheck[]])[] = [
    ['lints', MULTI],
    ['API', MULTI],
    ['api:', MULTI],
    [':lint', MULTI],
    ['api:nope', MULTI],
    ['nope:lint', MULTI],
    ['api:lint:x', MULTI],
    // The target exists and so does the slot, but its pack fills no `types`.
    ['scripts:types', MULTI],
    // A repo-scope slot or top-level custom check belongs to no target.
    ['api:links', MULTI],
    ['web:licenses', MULTI],
    // Without targets, a target-shaped token is unknown.
    ['app', IMPLICIT],
    ['app:lint', IMPLICIT],
  ];
  for (const [token, checks] of unknown) {
    test(`'${token}'`, () => {
      const problem = tokenProblem(checks, '--only', ['lint', token]);
      expect(problem).toBe(`unknown token '${token}' in --only. Valid tokens: ${validTokens(checks).join(', ')}.`);
    });
  }

  test('several unknown tokens are named together', () => {
    expect(tokenProblem(IMPLICIT, '--skip', ['lints', 'typo'])).toBe(
      "unknown tokens 'lints', 'typo' in --skip. Valid tokens: types, format, lint, mutation, licenses.",
    );
  });

  test('an empty list selects nothing, and says so', () => {
    expect(tokenProblem(IMPLICIT, 'gate.only', [])).toBe(
      'gate.only was given an empty list, which selects nothing. Valid tokens: types, format, lint, mutation, licenses.',
    );
  });

  test('an absent list is no problem', () => {
    expect(tokenProblem(IMPLICIT, '--only', undefined)).toBeNull();
    expect(tokenProblem(IMPLICIT, '--only', null)).toBeNull();
  });
});

describe('validTokens', () => {
  test('in implicit mode: the slot and custom-check names, in resolved order', () => {
    expect(validTokens(IMPLICIT)).toEqual(['types', 'format', 'lint', 'mutation', 'licenses']);
  });

  test('in multi-target mode: bare names, then targets, then every <target>:<slot>', () => {
    expect(validTokens(MULTI)).toEqual([
      'types', 'lint', 'test', 'security', 'format', 'bundle-size', 'struct', 'links', 'spell', 'licenses',
      'api', 'web', 'scripts',
      ...MULTI.filter((c) => c.target !== undefined).map(checkName),
    ]);
  });
});

/**
 * Guards on this repo's own `checkride.config.json`.
 *
 * Dogfooding only proves something while the dogfood config still matches what
 * the package ships. Where this repo overrides an adapter — lint and prose —
 * the override duplicates that adapter's argv, and a later change to the
 * registry would leave the duplicate silently stale: `pnpm check` would keep
 * passing while no longer exercising the shipped defaults. These tests turn
 * that silence into a failure.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { ADAPTERS } from '../src/adapters.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

type CheckEntry = { use?: string; args?: readonly string[] };
const config = JSON.parse(readFileSync(join(ROOT, 'checkride.config.json'), 'utf8')) as {
  checks: Record<string, CheckEntry | string | boolean>;
};

describe("this repo's checkride.config.json", () => {
  /**
   * Why the override exists: oxlint's nested-config discovery makes an
   * `.oxlintrc.json` anywhere under the tree govern its own subtree, which
   * silently voids the root config's `ignorePatterns` there. Every example
   * under `examples/` needs its own oxlint config to be genuinely standalone
   * (without one it inherits *this* config, which is a different bug), so the
   * root run has to opt out of that discovery or it lints the deliberately
   * broken example sources. See examples/README.md.
   */
  test('the lint override is the shipped oxlint argv plus --disable-nested-config', () => {
    const oxlint = ADAPTERS.find((adapter) => adapter.name === 'oxlint');
    expect(oxlint, 'the oxlint adapter has been renamed or removed').toBeDefined();

    const lint = config.checks['lint'];
    expect(typeof lint, 'lint must stay an object override').toBe('object');
    const args = (lint as CheckEntry).args;

    expect(args).toEqual([...(oxlint?.args ?? []), '--disable-nested-config']);
  });

  /**
   * Why the prose override exists: vale reads no .gitignore and skips no
   * hidden directory, so the shipped default path `.` would walk `.plumbbob/`,
   * `.claude/`, `dist/` and friends. This repo swaps that one trailing `.` for
   * its explicit prose surface (D10), the same move the lint override makes.
   */
  const shippedValeArgs = ADAPTERS.find((adapter) => adapter.name === 'vale')?.args ?? [];
  const prosePaths = ((config.checks['prose'] as CheckEntry).args ?? []).slice(shippedValeArgs.length - 1);

  test('the prose override is the shipped vale argv with the trailing `.` swapped for explicit paths', () => {
    expect(shippedValeArgs.at(-1), 'the shipped vale argv no longer ends in the default path').toBe('.');

    const prose = config.checks['prose'];
    expect(typeof prose, 'prose must stay an object override').toBe('object');
    const args = (prose as CheckEntry).args ?? [];

    expect(args.slice(0, shippedValeArgs.length - 1)).toEqual(shippedValeArgs.slice(0, -1));
    expect(prosePaths.length).toBeGreaterThan(0);
    for (const p of prosePaths) expect(p.startsWith('-'), `${p} is a flag, not a path`).toBe(false);
  });

  /**
   * Because path scoping happens in the args, a doc the path list misses is
   * silently unlinted — vale reports nothing and the slot stays green. This
   * turns that silence into a failure: every tracked .md must be reachable
   * from the configured prose paths, or sit in the excluded set below with the
   * others of its kind.
   */
  const PROSE_EXCLUDED = [
    '.claude/', // Claude Code project scaffolding — agent runbooks, not reader prose
    '.plumbbob/', // build-history artifacts, frozen as written
    'examples/', // standalone fixture repos with their own deliberate content
    'skills/', // shipped skill instructions — agent-facing procedure, not docs
    'CHANGELOG.md', // generated from commits at release (cspell skips it too)
    'CLAUDE.md', // a pointer at AGENTS.md, not standalone prose
  ];

  test('every tracked .md outside the known-excluded set is reachable from the prose paths', () => {
    const tracked = execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: ROOT })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);
    expect(tracked.length).toBeGreaterThan(0);

    const reachable = (file: string): boolean =>
      prosePaths.some((p) => file === p || file.startsWith(`${p}/`));
    const excluded = (file: string): boolean =>
      PROSE_EXCLUDED.some((e) => (e.endsWith('/') ? file.startsWith(e) : file === e));

    expect(tracked.filter((file) => !reachable(file) && !excluded(file))).toEqual([]);
  });

  /**
   * The same staleness rule, for files instead of argv: this repo's `.vale.ini`
   * and `.vale/styles/Repo/` are the scaffold `init --add prose` writes, and
   * dogfooding only proves the shipped scaffold works while the repo's copy
   * still matches it byte for byte. A deliberate local divergence is allowed —
   * by editing this test to say so.
   */
  test('the repo vale config and style are the shipped scaffold, unchanged', () => {
    const templateStyles = join(ROOT, 'templates', 'shared', 'styles', 'Repo');
    const repoStyles = join(ROOT, '.vale', 'styles', 'Repo');
    expect(readdirSync(repoStyles).toSorted()).toEqual(readdirSync(templateStyles).toSorted());

    const pairs: Array<[string, string]> = [
      [join(ROOT, 'templates', 'shared', 'vale.ini'), join(ROOT, '.vale.ini')],
      ...readdirSync(templateStyles).map(
        (f): [string, string] => [join(templateStyles, f), join(repoStyles, f)],
      ),
    ];
    for (const [from, to] of pairs) {
      expect(readFileSync(to, 'utf8'), `${to} drifted from ${from}`).toBe(readFileSync(from, 'utf8'));
    }
  });
});

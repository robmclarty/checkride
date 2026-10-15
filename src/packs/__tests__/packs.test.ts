import { describe, expect, test } from 'vitest';

import type { Adapter } from '../../adapters.js';
import { SLOTS } from '../../adapters.js';
import { PACKS, TOOLS } from '../index.js';

const ROWS: readonly Adapter[] = [...PACKS.ts.adapters, ...PACKS.repo.adapters];

/** The `<bin>` of a canonical `pnpm exec <bin> …` argument list, or undefined for anything else. */
const execBin = (args: readonly string[] | undefined): string | undefined => (args?.[0] === 'exec' ? args[1] : undefined);

/** Every bin a row runs: its check, and its fix when it has one. */
const binsOf = (row: Adapter): string[] =>
  row.command === 'pnpm' ? [execBin(row.args), execBin(row.fixArgs)].filter((b) => b !== undefined) : [];

describe('the ts and repo packs', () => {
  test('the ts pack is marked by package.json or tsconfig.json; the repo pack has no markers', () => {
    expect(PACKS.ts.markers).toEqual(['package.json', 'tsconfig.json']);
    expect(PACKS.repo.markers).toEqual([]);
  });

  test('both pin their tools through the package manager\'s lockfile and set no variables', () => {
    for (const pack of [PACKS.ts, PACKS.repo]) {
      expect(pack.pins).toEqual(['js-lockfile']);
      expect(pack.env).toEqual({});
    }
  });

  test('each pack fills only slots of its own scope', () => {
    const scopeOf = new Map(SLOTS.map((s) => [s.name, s.scope]));
    for (const row of PACKS.ts.adapters) expect(scopeOf.get(row.slot), row.name).toBe('target');
    for (const row of PACKS.repo.adapters) expect(scopeOf.get(row.slot), row.name).toBe('repo');
  });
});

describe('TOOLS', () => {
  test('describes each tool once', () => {
    const bins = TOOLS.map((t) => t.bin);
    expect(new Set(bins).size).toBe(bins.length);
  });

  test('has a row for every tool a pack runs, and none that no pack runs', () => {
    const run = new Set(ROWS.flatMap(binsOf));
    expect(TOOLS.map((t) => t.bin).toSorted()).toEqual([...run].toSorted());
  });

  test('names the npm package init installs for the rows that run each tool', () => {
    for (const row of ROWS) {
      // Built-ins pin nothing: snippets runs the tsc the tsc row already installs.
      if (Object.keys(row.devDeps).length === 0) continue;
      for (const bin of binsOf(row)) {
        const npm = TOOLS.find((t) => t.bin === bin)?.npm;
        expect(npm !== undefined && npm in row.devDeps, `${row.name} runs ${bin}`).toBe(true);
      }
    }
  });
});

/**
 * Guards on the conventions AGENTS.md states.
 *
 * AGENTS.md is the first thing a coding agent reads in this repo, which makes a
 * stale claim in it worse than no claim: the agent follows it confidently. Both
 * guards here exist because the corresponding sentence had already drifted —
 * the folder-module list named four of seven modules, and the test-placement
 * rule described a layout the repo has never used. Neither drift was
 * detectable by any check, because prose is not a surface `pnpm check` can see.
 *
 * These turn the two load-bearing claims into assertions. Everything else in
 * AGENTS.md stays prose deliberately: guarding every sentence would over-fit
 * and make the file painful to edit. These two are guarded because they
 * describe the *shape of the tree*, which changes without anyone rereading the
 * doc.
 *
 * Sibling guards: `./dogfood-config.test.ts` (this repo's checkride.config.json
 * still matches the shipped registry) and `./plugin-manifest.test.ts` (the
 * bundled plugin's version and file set).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const AGENTS = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');

/** Directory name every test file must sit inside. */
const TEST_DIR = '__tests__';

/**
 * The folder modules on disk: every directory directly under `src/` that is not
 * itself a test folder. A folder module is one that grew internals worth
 * hiding, so its `index.ts` is its only public surface.
 */
function folderModules(): string[] {
  return readdirSync(SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== TEST_DIR)
    .map((e) => e.name)
    .toSorted();
}

/** Every `*.test.ts` under `src/`, as a repo-relative path. */
function testFiles(dir: string = SRC): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFiles(full));
    else if (entry.name.endsWith('.test.ts')) found.push(relative(ROOT, full));
  }
  return found.toSorted();
}

describe('AGENTS.md matches the tree it describes', () => {
  /**
   * The deep-module claim: which directories under `src/` are folder modules.
   * The sentence names them explicitly, and it had gone stale by three
   * (`artifacts/`, `qa/`, `triage/`) before this test existed.
   */
  test('the folder-module list names exactly the folder modules on disk', () => {
    const onDisk = folderModules();
    expect(onDisk.length).toBeGreaterThan(0); // the walk found something

    // The sentence lists them as inline-code paths: `agent-setup/`, `qa/`, ...
    const sentence = /(\w+) modules \(([^)]*)\) have crossed that line/.exec(AGENTS);
    expect(sentence, 'the folder-module sentence in AGENTS.md has been reworded').not.toBeNull();

    const named = [...(sentence?.[2] ?? '').matchAll(/`([\w-]+)\/`/g)].map((m) => m[1] ?? '').toSorted();
    expect(named).toEqual(onDisk);

    // ...and the count word in front of the list agrees with it.
    const counts: Record<number, string> = { 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight' };
    expect(sentence?.[1]).toBe(counts[onDisk.length]);
  });

  test('every folder module appears in the layout tree', () => {
    for (const name of folderModules()) {
      expect(AGENTS, `${name}/ is missing from the src/ layout block`).toContain(`  ${name}/`);
    }
  });
});

describe('test placement', () => {
  /**
   * Tests are colocated with the module they cover, but always inside a
   * `__tests__/` folder — never beside the source file. AGENTS.md said the
   * opposite for several releases while no test in the repo followed it, which
   * is exactly the kind of confidently-wrong instruction an agent acts on.
   */
  test('every test under src/ lives in a __tests__/ folder', () => {
    const files = testFiles();
    expect(files.length).toBeGreaterThan(0); // the walk found something
    const misplaced = files.filter((f) => !f.split(sep).includes(TEST_DIR));
    expect(misplaced, `move these into a sibling ${TEST_DIR}/ folder`).toEqual([]);
  });

  test('AGENTS.md states that rule, and does not state the old one', () => {
    expect(AGENTS).toContain(`inside a \`${TEST_DIR}/\` folder`);
    expect(AGENTS).not.toContain('colocate `foo.test.ts` next to `foo.ts`');
  });
});

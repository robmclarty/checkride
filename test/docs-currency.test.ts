/**
 * Guards on the slot catalogues the docs publish.
 *
 * Four places outside `src/` enumerate the slots: the README's slot table and
 * its opt-in sentence, the cheat sheet's pipeline table, and the config
 * schema's `checks` description (which an editor renders as autocompletion
 * help). None is read by any tool the pipeline runs, so all four drift
 * silently — and all four had: adding `prose` was the fifth slot to land since
 * the README's opt-in sentence was last updated, and it was still missing
 * `dupes`, `health`, and the whole publish-ready bundle.
 *
 * Currency is asserted in the direction that matches each surface. A *table*
 * may curate — say less about a slot than the registry knows — but may not
 * lag, so every slot must have a row. A *sentence that enumerates* is wrong in
 * both directions: a missing name understates the catalogue and a stale one
 * names a slot that no longer exists, so those are exact-set assertions.
 *
 * Sibling guards: `./conventions.test.ts` (AGENTS.md's claims about the tree),
 * `./dogfood-config.test.ts` (this repo's config still matches the registry),
 * `./site.test.ts` (the same currency rule for `site/*.html`).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { SLOTS } from '../src/adapters.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');

const README = read('README.md');
const CHEATSHEET = read('docs', 'cheatsheet.md');
const SCHEMA = read('schema', 'checkride.config.schema.json');

const slotNames = SLOTS.map((s) => s.name);
const optInNames = SLOTS.filter((s) => s.optIn).map((s) => s.name);

/** A markdown table row whose first cell is exactly this backticked slot name. */
const hasRow = (md: string, slot: string): boolean =>
  new RegExp(`^\\|\\s*\`${slot}\`\\s*\\|`, 'm').test(md);

/**
 * The comma-separated names inside the parentheses that follow `lead`.
 * Backticks are stripped so one reader handles the README's `` `format` ``
 * style and the schema description's bare `format`.
 */
function enumeratedAfter(text: string, lead: string): string[] {
  const at = text.indexOf(lead);
  expect(at, `no "${lead}" enumeration found`).toBeGreaterThan(-1);
  const open = text.indexOf('(', at);
  const close = text.indexOf(')', open);
  expect(close, `unterminated enumeration after "${lead}"`).toBeGreaterThan(open);
  return text
    .slice(open + 1, close)
    .split(',')
    .map((s) => s.replaceAll('`', '').trim())
    .filter(Boolean);
}

describe('slot tables list every catalogue slot', () => {
  for (const [label, md] of [
    ['README.md', README],
    ['docs/cheatsheet.md', CHEATSHEET],
  ] as const) {
    test(`${label} has a row per slot`, () => {
      const missing = slotNames.filter((slot) => !hasRow(md, slot));
      expect(missing, `${label} slot table is missing: ${missing.join(', ')}`).toEqual([]);
    });
  }
});

describe('opt-in enumerations match the registry exactly', () => {
  test('README names every opt-in slot, and only those', () => {
    const listed = enumeratedAfter(README, '**Opt-in slots**');
    expect(listed.toSorted()).toEqual(optInNames.toSorted());
  });

  test("the schema's checks description enumerates the full catalogue", () => {
    const listed = enumeratedAfter(SCHEMA, 'A key that matches a catalogue slot');
    expect(listed.toSorted()).toEqual(slotNames.toSorted());
  });

  test("the schema's checks description enumerates the opt-in slots", () => {
    const listed = enumeratedAfter(SCHEMA, 'Naming an opt-in slot');
    expect(listed.toSorted()).toEqual(optInNames.toSorted());
  });

  test('the cheat sheet --include row names every opt-in slot', () => {
    const listed = enumeratedAfter(CHEATSHEET, 'Add opt-in slots');
    expect(listed.toSorted()).toEqual(optInNames.toSorted());
  });
});

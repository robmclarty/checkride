/**
 * Guards on the catalogues the docs publish: the slots, and the rules and test
 * layout a new project is scaffolded with.
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
 * The rule pack is enumerated the same way. `init` copies every file in
 * `templates/ts/shared/rules/` into a new project, and `docs/deep-modules.md`
 * names each by its `rules/` path, so that list is exact too. Both guides draw
 * the `test/` tree, held to the folders `test-dir-layout.yml` allows.
 *
 * The packs are the third catalogue. `docs/packs.md` gives each pack a section
 * whose adapter table lists the pack's rows, in its order, plus tables of pin
 * chains, pin sources and the variables each pack's checks spawn with;
 * `docs/targets.md` lists the target packs, the markers that pick an implicit
 * pack, and the slots that run once for the whole repo. Each is held to
 * `PACKS` and `SLOTS` exactly, since a row that lags misdocuments a tool and a
 * stale one names a tool no run spawns. The README's slot table carries each
 * slot's scope, held to `SLOTS` the same way.
 *
 * Sibling guards: `./conventions.test.ts` (AGENTS.md's claims about the tree),
 * `./dogfood-config.test.ts` (this repo's config still matches the registry),
 * `./site.test.ts` (the same currency rule for `site/*.html`).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { SLOTS } from '../../src/adapters.js';
import { runCli } from '../../src/cli.js';
import { PACKS } from '../../src/packs/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');

const README = read('README.md');
const CHEATSHEET = read('docs', 'cheatsheet.md');
const SCHEMA = read('schema', 'checkride.config.schema.json');
const DEEP_MODULES = read('docs', 'deep-modules.md');
const GETTING_STARTED = read('docs', 'getting-started.md');
const PACKS_MD = read('docs', 'packs.md');
const TARGETS_MD = read('docs', 'targets.md');
const CONTRACT = read('docs', 'contract.md');

const packs = Object.values(PACKS);
const scopeOf = (slot: string): string | undefined => SLOTS.find((s) => s.name === slot)?.scope;

const RULES = join('templates', 'ts', 'shared', 'rules');
const shippedRules = readdirSync(join(ROOT, RULES)).filter((f) => f.endsWith('.yml'));
/** The folders `test-dir-layout.yml` sanctions under `test/`, from its `ignores`. */
const testDirs = [...read(RULES, 'test-dir-layout.yml').matchAll(/'\*\*\/test\/([\w-]+)\/\*\*'/g)].map(
  (m) => m[1] ?? '',
);

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

/** The names a piece of markdown sets in backticks, in order. */
const backticked = (md: string): string[] => [...md.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');

/** The text from the `## <title>` heading up to the next `## ` heading. */
function section(md: string, title: string): string {
  const at = md.indexOf(`\n## ${title}\n`);
  expect(at, `no "## ${title}" section`).toBeGreaterThan(-1);
  const next = md.indexOf('\n## ', at + 1);
  return md.slice(at, next === -1 ? undefined : next);
}

/** A markdown table row's cells, trimmed. No table these tests read puts a `|` in a cell. */
const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

/** The body rows of the first table whose header row opens with `header`'s cells. */
function tableRows(md: string, ...header: string[]): string[][] {
  const lines = md.split('\n');
  const at = lines.findIndex((l) => l.startsWith('|') && cells(l).slice(0, header.length).join('|') === header.join('|'));
  expect(at, `no table headed "${header.join(' | ')}"`).toBeGreaterThan(-1);
  const body = lines.slice(at + 2);
  const end = body.findIndex((l) => !l.startsWith('|'));
  return body.slice(0, end === -1 ? undefined : end).map(cells);
}

/** The backticked names inside the parentheses that follow `lead`. */
function backtickedAfter(text: string, lead: string): string[] {
  const at = text.indexOf(lead);
  expect(at, `no "${lead}" enumeration found`).toBeGreaterThan(-1);
  const open = text.indexOf('(', at);
  return backticked(text.slice(open + 1, text.indexOf(')', open)));
}

/** The folders in the tree drawn under a line that reads exactly `test/`. */
function testTree(md: string): string[] {
  const at = md.search(/^test\/$/m);
  expect(at, 'no test/ tree found').toBeGreaterThan(-1);
  const block = md.slice(at, md.indexOf('```', at));
  return [...block.matchAll(/^[├└]── ([\w-]+)\//gm)].map((m) => m[1] ?? '');
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

  test("the CLI help's --include names every opt-in slot, and only those", async () => {
    let help = '';
    const stdout = { write: (text: string): boolean => { help += text; return true; } };
    await runCli(['--help'], { cwd: process.cwd(), stdout, stderr: { write: () => true } });
    const listed = enumeratedAfter(help, 'Add opt-in slots');
    expect(listed.toSorted()).toEqual(optInNames.toSorted());
  });
});

describe('the scaffold docs match the templates', () => {
  test('docs/deep-modules.md names every shipped rule, and only those', () => {
    const named = new Set([...DEEP_MODULES.matchAll(/\brules\/([\w-]+\.yml)/g)].map((m) => m[1] ?? ''));
    expect([...named].toSorted()).toEqual(shippedRules.toSorted());
  });

  test.each([
    ['docs/deep-modules.md', DEEP_MODULES],
    ['docs/getting-started.md', GETTING_STARTED],
  ])('%s draws the test/ folders test-dir-layout.yml allows', (_label, md) => {
    expect(testDirs).toHaveLength(5);
    expect(testTree(md).toSorted()).toEqual(testDirs.toSorted());
  });
});

describe('docs/packs.md matches PACKS', () => {
  test.each(packs.map((p) => [p.name, p] as const))('the %s pack section lists its adapter rows, in order', (name, pack) => {
    const rows = tableRows(section(PACKS_MD, `The ${name} pack`), 'Slot', 'Adapter');
    const documented = rows.map(([slot = '', adapter = '']) => `${backticked(slot)[0]}:${backticked(adapter)[0]}`);
    expect(documented).toEqual(pack.adapters.map((a) => `${a.slot}:${a.name}`));
    for (const [i, row] of rows.entries()) {
      const adapter = pack.adapters[i];
      if (adapter === undefined) continue;
      const optIn = SLOTS.find((s) => s.name === adapter.slot)?.optIn === true;
      expect(row[0]?.includes('(opt-in)'), `${adapter.name}'s slot cell marks opt-in exactly when its slot is`).toBe(optIn);
      if (adapter.outputFile !== null) expect(backticked(row.at(-1) ?? ''), `${adapter.name} writes ${adapter.outputFile}`).toContain(adapter.outputFile);
    }
  });

  test('the pin chains table gives every pack its chain', () => {
    const rows = tableRows(PACKS_MD, 'Pack', 'Pin chain').map(([pack = '', chain = '']) => [backticked(pack)[0], backticked(chain)]);
    expect(rows).toEqual(packs.map((p) => [p.name, [...p.pins]]));
  });

  test('the pin sources table has a row for every source a chain names, and override', () => {
    const rows = tableRows(PACKS_MD, 'Source', 'Declares a tool when').map(([source = '']) => backticked(source)[0]);
    const sources = new Set(['override', ...packs.flatMap((p) => p.pins)]);
    expect(rows.toSorted()).toEqual([...sources].toSorted());
  });

  test("the spawn environment table gives every pack's variables and values", () => {
    const documented: Record<string, Record<string, string>> = {};
    for (const [appliesTo = '', variables = '', value = ''] of tableRows(PACKS_MD, 'Applies to', 'Variable')) {
      if (!(appliesTo in PACKS)) continue;
      for (const variable of backticked(variables)) (documented[appliesTo] ??= {})[variable] = backticked(value)[0] ?? '';
    }
    expect(documented).toEqual(Object.fromEntries(packs.filter((p) => Object.keys(p.env).length > 0).map((p) => [p.name, p.env])));
  });
});

describe('docs/targets.md matches PACKS', () => {
  test('the packs table lists every pack a target can name', () => {
    const rows = tableRows(TARGETS_MD, 'Pack', 'Checks').map(([pack = '']) => backticked(pack)[0]);
    const targetPacks = packs.filter((p) => p.adapters.some((a) => scopeOf(a.slot) === 'target')).map((p) => p.name);
    expect(rows).toEqual(targetPacks);
  });

  test('a repo without targets picks its pack by each pack’s markers, in order', () => {
    const picks = section(TARGETS_MD, 'A repo without targets')
      .split('\n')
      .flatMap((line) => {
        const m = /^\d+\. (.*) picks `(\w+)`/.exec(line);
        return m === null ? [] : [[m[2] ?? '', backticked(m[1] ?? '')] as const];
      })
      .filter(([, markers]) => markers.length > 0);
    expect(picks).toEqual(packs.filter((p) => p.markers.length > 0).map((p) => [p.name, [...p.markers]]));
  });

  test('unclaimed names every marker a pack has', () => {
    const listed = backtickedAfter(TARGETS_MD, 'fails when a toolchain marker');
    expect(listed.toSorted()).toEqual(packs.flatMap((p) => p.markers).toSorted());
  });

  test('the repo-scope slots it names are exactly the catalogue’s', () => {
    const listed = backtickedAfter(TARGETS_MD, 'The repo-scope slots');
    expect(listed.toSorted()).toEqual(SLOTS.filter((s) => s.scope === 'repo').map((s) => s.name).toSorted());
  });
});

describe('the scope and pack enumerations match the registry', () => {
  test("README's slot table gives each slot its scope", () => {
    const rows = tableRows(README, 'Slot', 'Scope').map(([slot = '', scope = '']) => [backticked(slot)[0], scope]);
    expect(rows).toEqual(SLOTS.map((s) => [s.name, s.scope]));
  });

  test("docs/contract.md's PACKS sentence names every pack", () => {
    expect(backtickedAfter(CONTRACT, "`PACKS` maps each pack's name")).toEqual(Object.keys(PACKS));
  });
});

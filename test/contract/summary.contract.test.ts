/**
 * Contract: the `.check/summary.json` shape (docs/contract.md §summary.json).
 *
 * Every run's summary must validate against the published schema
 * (`schema/checkride.summary.schema.json`) exactly — `additionalProperties` is
 * false, so adding a field without updating the schema (and the contract doc)
 * fails this build. That is the additive-only discipline made mechanical:
 * fields are added in lockstep with the schema, never renamed, removed, or
 * retyped without a `schema_version` bump.
 *
 * The contract doc's two field tables are held to the same schema: each must
 * name exactly the schema's properties, and say "always" for exactly its
 * required ones. A field added to the schema without a row in the doc, or a
 * row left behind for a field the schema dropped, fails here.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv } from 'ajv';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { SCHEMA_VERSION } from '../../src/adapters.js';
import { runCli } from '../../src/cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, '..', '..', 'schema', 'checkride.summary.schema.json');
const contractPath = join(here, '..', '..', 'docs', 'contract.md');

type ObjectSchema = { properties: Record<string, unknown>; required: string[] };
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as ObjectSchema & {
  definitions: { check: ObjectSchema };
};

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);

function sink(): { write: (text: string) => boolean } {
  return { write: () => true };
}

/**
 * The rows of the contract doc's field table that follows `lead`: every
 * backticked name in a row's first cell, with that row's last cell (the
 * presence rule).
 */
function fieldTable(lead: string): { name: string; presence: string }[] {
  const doc = readFileSync(contractPath, 'utf8');
  const at = doc.indexOf(lead);
  expect(at, `no "${lead}" table in docs/contract.md`).toBeGreaterThan(-1);
  const lines = doc.slice(at).split('\n');
  const header = lines.findIndex((l) => l.startsWith('|'));
  const end = lines.findIndex((l, i) => i > header && !l.startsWith('|'));
  // Skip the header row and its `| --- |` separator.
  return lines.slice(header + 2, end === -1 ? undefined : end).flatMap((row) => {
    const cells = row.split('|').slice(1, -1).map((c) => c.trim());
    const presence = cells.at(-1) ?? '';
    return [...(cells[0] ?? '').matchAll(/`([^`]+)`/g)].map((m) => ({ name: m[1] ?? '', presence }));
  });
}

/** A custom check that does nothing for `ms`, on the given wave. */
function sleeper(ms: number, order = 1): Record<string, unknown> {
  return { command: 'node', args: ['-e', `setTimeout(() => {}, ${ms})`], order };
}

describe('docs/contract.md lists every summary field', () => {
  const tables = [
    ['top-level', '**Top-level fields.**', schema],
    ['per-check', '**Per-check fields.**', schema.definitions.check],
  ] as const;

  for (const [label, lead, object] of tables) {
    test(`the ${label} table names exactly the schema's properties`, () => {
      const documented = fieldTable(lead).map((f) => f.name);
      expect(documented.toSorted()).toEqual(Object.keys(object.properties).toSorted());
    });

    test(`the ${label} table says "always" for exactly the schema's required fields`, () => {
      const always = fieldTable(lead).filter((f) => f.presence.startsWith('always')).map((f) => f.name);
      expect(always.toSorted()).toEqual(object.required.toSorted());
    });
  }
});

describe('summary.json shape', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-summary-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function runAndValidate(argv: string[]): Promise<Record<string, unknown>> {
    await runCli(argv, { cwd: dir, stdout: sink(), stderr: sink() });
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as Record<string, unknown>;
    const valid = validate(summary);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
    return summary;
  }

  test('a green run with executed, skipped, and custom checks validates', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: {
        probe: { command: 'node', args: ['-e', 'process.exit(0)'] },
      },
    }));
    // The default run here executes `links` (built-in) + `probe`, and records
    // every undetected catalogue slot as skipped — all three entry kinds.
    const summary = await runAndValidate([]);
    expect(summary['schema_version']).toBe(SCHEMA_VERSION);
    expect(summary['checks_run']).toBe(2);
  });

  test('a failing run validates', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: {
        links: false,
        probe: { command: 'node', args: ['-e', 'process.exit(1)'] },
      },
    }));
    const summary = await runAndValidate([]);
    expect(summary['ok']).toBe(false);
  });

  /**
   * Contract: `origin` is present exactly when `adapter` isn't null, and
   * `detected_by` exactly when `origin` is `detected` (S21).
   */
  test('each check records why it runs, and a check with no adapter records nothing', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, '.markdownlint-cli2.jsonc'), '{}');
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: {
        struct: { command: 'node', args: ['-e', 'process.exit(0)'] },
        probe: { command: 'node', args: ['-e', 'process.exit(0)'] },
      },
    }));
    // Every slot but these sits out unresolved; docs is detected and left out by
    // --skip, so it never needs its tool installed.
    const summary = await runAndValidate(['--skip', 'docs']);
    const checks = summary['checks'] as { name: string; adapter: string | null; origin?: string; detected_by?: string }[];
    const byName = new Map(checks.map((c) => [c.name, c]));
    expect(byName.get('struct')).toMatchObject({ origin: 'config' });
    expect(byName.get('probe')).toMatchObject({ origin: 'custom' });
    expect(byName.get('links')).toMatchObject({ origin: 'built-in' });
    expect(byName.get('docs')).toMatchObject({ skipped: true, origin: 'detected', detected_by: '.markdownlint-cli2.jsonc' });
    for (const c of checks) {
      expect(c.origin !== undefined, c.name).toBe(c.adapter !== null);
      expect(c.detected_by !== undefined, c.name).toBe(c.origin === 'detected');
    }
  });

  test('a vacuous (zero-run) summary validates and says so', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ checks: { links: false } }));
    const summary = await runAndValidate([]);
    expect(summary).toMatchObject({ ok: true, checks_run: 0 });
  });

  test('the schema version constant is 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  /**
   * Contract: `total_duration_ms` is the run's **wall-clock** span, not the sum
   * of the per-check durations. Consumers derive the run's start from it
   * (`timestamp - total_duration_ms`) to judge whether a `.check/` artifact
   * belongs to this run — checkride's own readers included, in
   * `src/artifacts/freshness.ts`. Under sum semantics that window opens far too
   * early and stale artifacts read as fresh.
   *
   * ajv can only validate the *shape*, so nothing caught the published schema
   * describing this field as a sum for several releases while the code and
   * docs/contract.md said wall-clock. This pins the semantics: revert to a sum
   * and the description is no longer the only thing that has to change.
   */
  test('total_duration_ms is wall-clock, not the sum of per-check durations', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    // Three sleepers in one wave. Run concurrently the wall-clock is ~one
    // sleep; summed it is ~three.
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: { links: false, a: sleeper(600), b: sleeper(600), c: sleeper(600) },
    }));

    await runCli(['--concurrency', '3'], { cwd: dir, stdout: sink(), stderr: sink() });
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as {
      total_duration_ms: number;
      checks: { name: string; duration_ms: number; skipped?: boolean }[];
    };

    const ran = summary.checks.filter((c) => c.skipped !== true);
    const summed = ran.reduce((n, c) => n + c.duration_ms, 0);
    expect(ran).toHaveLength(3);
    expect(summed).toBeGreaterThan(1500); // the three really did sleep
    expect(summary.total_duration_ms).toBeLessThan(summed);
  }, 30_000);

  test('total_duration_ms equals the summed durations when execution is sequential', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      checks: { links: false, a: sleeper(150, 1), b: sleeper(150, 2) },
    }));
    await runCli(['--concurrency', '1'], { cwd: dir, stdout: sink(), stderr: sink() });
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as {
      total_duration_ms: number;
      checks: { duration_ms: number; skipped?: boolean }[];
    };
    const summed = summary.checks
      .filter((c) => c.skipped !== true)
      .reduce((n, c) => n + c.duration_ms, 0);
    // Equal but for the scheduling overhead between the two waves.
    expect(summary.total_duration_ms).toBeGreaterThanOrEqual(summed);
    expect(summary.total_duration_ms - summed).toBeLessThan(250);
  }, 30_000);
});

/**
 * Contract: the `.check/summary.json` shape (docs/contract.md §summary.json).
 *
 * Every run's summary must validate against the published schema
 * (`schema/checkride.summary.schema.json`) exactly — `additionalProperties` is
 * false, so adding a field without updating the schema (and the contract doc)
 * fails this build. That is the additive-only discipline made mechanical:
 * fields are added in lockstep with the schema, never renamed, removed, or
 * retyped without a `schema_version` bump.
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

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')) as object);

function sink(): { write: (text: string) => boolean } {
  return { write: () => true };
}

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

  test('a vacuous (zero-run) summary validates and says so', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'contract' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ checks: { links: false } }));
    const summary = await runAndValidate([]);
    expect(summary).toMatchObject({ ok: true, checks_run: 0 });
  });

  test('the schema version constant is 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});

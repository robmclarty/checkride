/**
 * Contract: `order: 'first'` and `order: 'last'` keep exactly their pre-wave
 * meaning — before, and after, every other check (D2). The wave vocabulary
 * generalized `order`, but these two keywords are a backward-compatibility
 * promise: a config that pinned a check first or last must still see it run
 * first or last, ahead of and behind the numeric line and the singles alike.
 *
 * Changing this is a breaking change (major-version decision + a "Contract"
 * CHANGELOG entry).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Adapter, Order } from '../../src/adapters.js';
import type { CheckRunner, Out } from '../../src/orchestrator.js';
import { runChecks } from '../../src/orchestrator.js';

function sink(): Out {
  return { write: () => true };
}

function adapter(name: string): Adapter {
  return { name, slot: name, description: name, detect: [], command: 'node', args: [], outputFile: null, devDeps: {} };
}

/** A runner that records the order in which checks execute. */
function recorder(): { runner: CheckRunner; order: string[] } {
  const order: string[] = [];
  const runner: CheckRunner = (r) => {
    order.push(r.slot);
    return Promise.resolve({ ok: true, exit_code: 0, stdout: '', stderr: '' });
  };
  return { runner, order };
}

describe("order: 'first' / 'last' backward-compat", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-order-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  // A deliberately scrambled input mixing every group: first, the numeric line,
  // an unordered ('any') check, a single, and last.
  const specs: [string, Order?][] = [
    ['wave', 10],
    ['tail', 'last'],
    ['plain'], // no order → 'any', the main group
    ['solo', 'single'],
    ['head', 'first'],
  ];
  const slots = specs.map(([name, order]) => (order === undefined ? { name } : { name, order }));
  const adapters = specs.map(([name]) => adapter(name));

  test("'first' runs before, and 'last' after, every other check — in the report and in execution", async () => {
    const rec = recorder();
    const result = await runChecks({
      cwd: dir, slots, adapters, config: null, runner: rec.runner, json: true,
      stdout: sink(), stderr: sink(),
    });

    const reported = result.summary.checks.map((c) => c.name);
    expect(reported[0]).toBe('head'); // 'first' leads the report
    expect(reported.at(-1)).toBe('tail'); // 'last' trails it
    // …and nothing slips outside that bracket.
    expect(reported.indexOf('head')).toBe(0);
    expect(reported.indexOf('tail')).toBe(reported.length - 1);

    expect(rec.order[0]).toBe('head'); // 'first' executes before all others
    expect(rec.order.at(-1)).toBe('tail'); // 'last' executes after all others
    for (const name of ['wave', 'plain', 'solo']) {
      expect(rec.order.indexOf('head')).toBeLessThan(rec.order.indexOf(name));
      expect(rec.order.indexOf('tail')).toBeGreaterThan(rec.order.indexOf(name));
    }
  });
});

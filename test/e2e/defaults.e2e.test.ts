/**
 * The shipped defaults, exercised.
 *
 * This repo's own `checkride.config.json` names all twenty slots with an
 * explicit `use` and `order`, which is deliberate — the tuned wave schedule is
 * faster than the catalogue's. The cost is that daily `pnpm check` never walks
 * the path a *consumer* walks: detection choosing an adapter, and the catalogue
 * supplying the order. AGENTS.md nonetheless claims this repo "dogfoods every
 * convention it enforces", and that claim was only true of the conventions, not
 * of the defaults.
 *
 * So: a fixture repo carrying the tool configs the catalogue detects on and
 * **no `checkride.config.json` at all**, resolved through the built CLI.
 * `doctor --json` resolves without running anything, which is what makes this
 * cheap enough to assert broadly — the untested surface here is *resolution*
 * (which adapter fills which slot, and which slots the default run selects),
 * not execution, and `resolveChecks` unit tests already cover ordering.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli.js');
const BIG = { maxBuffer: 32 * 1024 * 1024 };

type ToolCheck = {
  category: string;
  slot: string;
  adapter: string | null;
  enablement: string;
  found: string | null;
};
type Report = { packageManager: string; checks: ToolCheck[] };

/**
 * The blessed default for each detectable slot, keyed by the config file that
 * activates it. These pairs are the promise `checkride init` makes to a repo
 * that adopts the defaults, and the FIRST-adapter-wins rule in the registry is
 * what keeps them true.
 */
const DETECTED: { file: string; body: string; slot: string; adapter: string }[] = [
  { file: 'tsconfig.json', body: '{"compilerOptions":{"strict":true}}', slot: 'types', adapter: 'tsc' },
  { file: '.oxlintrc.json', body: '{}', slot: 'lint', adapter: 'oxlint' },
  { file: 'sgconfig.yml', body: 'ruleDirs:\n  - rules\n', slot: 'struct', adapter: 'ast-grep' },
  { file: 'fallow.toml', body: '[rules]\n', slot: 'dead', adapter: 'fallow' },
  { file: 'vitest.config.ts', body: 'export default {};\n', slot: 'test', adapter: 'vitest' },
  { file: '.markdownlint-cli2.jsonc', body: '{}', slot: 'docs', adapter: 'markdownlint-cli2' },
  { file: 'cspell.json', body: '{"words":[]}', slot: 'spell', adapter: 'cspell' },
];

/** Slots that fill themselves with no config file to detect. */
const ALWAYS: { slot: string; adapter: string }[] = [{ slot: 'links', adapter: 'links' }];

/** Opt-in slots: configured or not, they stay out of the default run. */
const OPT_IN = ['format', 'dupes', 'health', 'mutation', 'security', 'build', 'publint', 'attw', 'pack', 'smoke', 'snippets'];

async function doctor(dir: string): Promise<Report> {
  const { stdout } = await execFileP('node', [CLI, 'doctor', '--json'], { cwd: dir, ...BIG })
    .catch((err: { stdout: string }) => ({ stdout: err.stdout }));
  return JSON.parse(stdout) as Report;
}

describe('the default catalogue, with no checkride.config.json', () => {
  let dir: string;
  let tools: ToolCheck[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-e2e-defaults-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'defaults', private: true }));
    for (const { file, body } of DETECTED) await writeFile(join(dir, file), body);
    tools = (await doctor(dir)).checks.filter((c) => c.category === 'tool');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('detection picks the blessed adapter for every slot with a config file', () => {
    for (const { slot, adapter, file } of DETECTED) {
      const row = tools.find((c) => c.slot === slot);
      expect(row, `no ${slot} row in the doctor report`).toBeDefined();
      expect(row?.adapter, `${file} should select ${adapter} for ${slot}`).toBe(adapter);
    }
  });

  test('the always-available built-ins fill their slots with no config file', () => {
    for (const { slot, adapter } of ALWAYS) {
      expect(tools.find((c) => c.slot === slot)?.adapter).toBe(adapter);
    }
  });

  test('the default run is exactly the non-opt-in slots that resolved', () => {
    const byEnablement = (e: string): string[] =>
      tools.filter((c) => c.enablement === e).map((c) => c.slot).toSorted();

    expect(byEnablement('default')).toEqual(
      [...DETECTED.map((d) => d.slot), ...ALWAYS.map((a) => a.slot)].toSorted(),
    );
    // Every opt-in slot is reported as opt-in or unavailable — never as part of
    // the default run. This is the vacuous-green guard at the catalogue level:
    // an opt-in slot that silently joined the default run would be as wrong as
    // a default slot that silently left it.
    for (const slot of OPT_IN) {
      const row = tools.find((c) => c.slot === slot);
      expect(row, `no ${slot} row in the doctor report`).toBeDefined();
      expect(row?.enablement, `${slot} must not be in the default run`).not.toBe('default');
    }
  });

  test('a slot with no tool stands down as unavailable, never as a failure', async () => {
    // `dead` resolves via fallow.toml above; drop it and the slot must report
    // unavailable with a hint, not an error.
    await rm(join(dir, 'fallow.toml'));
    const dead = (await doctor(dir)).checks.find((c) => c.slot === 'dead');
    expect(dead).toMatchObject({ adapter: null, enablement: 'unavailable' });
  });

  test('with no lockfile or packageManager field, detection falls back to pnpm', async () => {
    expect((await doctor(dir)).packageManager).toBe('pnpm');
  });
});

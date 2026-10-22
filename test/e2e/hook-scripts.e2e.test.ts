/**
 * The hook scripts checkride writes, held to the shellcheck a bash target runs.
 *
 * A repo whose bash target covers its root lints `.claude/hooks/` and
 * `.cursor/hooks/` along with its own scripts (#19), so a finding in a
 * generated script is a finding in every such repo, and one it can't fix: the
 * next `agent-setup` writes the same bytes back. Every variant the writers can
 * produce is checked, each harness under each entry command, with and without
 * a preflight, at shellcheck's default severity, so an `info` counts.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, test } from 'vitest';

import { dirtyScript, gateScript } from '../../src/agent-setup/index.js';
import type { EntryLike } from '../../src/launch/index.js';
import { describeWithToolchain } from '../helpers/toolchains.js';

const ENTRIES: readonly EntryLike[] = ['pnpm', 'npm', 'yarn', 'bun', { kind: 'mise' }, { kind: 'path' }];
const HARNESSES = ['claude', 'cursor'] as const;

/** Every gate script the writers can produce, by a name that says which. */
function variants(): [string, string][] {
  return HARNESSES.flatMap((harness) =>
    ENTRIES.flatMap((entry) => {
      const label = `${harness} ${typeof entry === 'string' ? entry : entry.kind}`;
      return [
        [`${label} gate`, gateScript(entry, { harness })],
        [`${label} gate, unguarded`, gateScript(entry, { harness, dirtyGuard: false })],
        [`${label} gate with a preflight`, gateScript(entry, { harness, preflight: 'scripts/pre.sh' })],
      ] satisfies [string, string][];
    }),
  );
}

const dir = mkdtempSync(join(tmpdir(), 'checkride-hook-scripts-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describeWithToolchain('bash')('generated hook scripts pass shellcheck (#19)', () => {
  test.each([...variants(), ['cursor dirty', dirtyScript()]])('%s', (name, script) => {
    const file = join(dir, `${name.replaceAll(/\W+/g, '-')}.sh`);
    writeFileSync(file, script);
    const result = spawnSync('shellcheck', [file], { encoding: 'utf8' });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });
});

import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli.js');

type Run = { code: number; stdout: string; stderr: string };

async function run(bin: string, args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileP('node', [bin, ...args]);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/**
 * Regression for the 0.1.1 entrypoint bug. Package managers expose the bin as a
 * symlink (`node_modules/.bin/checkride` → `dist/cli.js`), so the CLI must run
 * when `argv[1]` is that symlink — not only when invoked as `node dist/cli.js`.
 * The original guard compared unresolved paths and silently no-op'd through the
 * symlink, so `pnpm exec checkride`, `npx checkride`, and the generated
 * `pnpm check` alias exited 0 having done nothing. Every other test invokes the
 * CLI by its real path, so the symlink path was never exercised — this asserts
 * a symlinked invocation matches a direct one exactly.
 */
test('runs identically when invoked through a bin symlink', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'checkride-bin-'));
  try {
    const link = join(dir, 'checkride'); // mimics node_modules/.bin/checkride
    await symlink(CLI, link);

    // An unknown command short-circuits before any tool spawns: exit 2 with a
    // message on stderr. Through the broken guard the symlink run was exit 0
    // with empty output, so these two runs would differ.
    const direct = await run(CLI, ['__not_a_command__']);
    const viaLink = await run(link, ['__not_a_command__']);

    expect(viaLink).toEqual(direct);
    expect(viaLink.code).toBe(2);
    expect(viaLink.stderr).toContain('unknown command');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

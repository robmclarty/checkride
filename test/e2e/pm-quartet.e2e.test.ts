import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli.js');
const BIG = { maxBuffer: 32 * 1024 * 1024 };
// Non-interactive corepack, so a shimmed yarn never stops to prompt.
const ENV = { env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' } };

/**
 * The tested envelope's package-manager axis: for each of the quartet, a real
 * project is installed *with that manager*, detected from its lockfile, and
 * checked through its exec form (`pnpm exec` / `npx` / `yarn` / `bunx`).
 * `--strict` makes a detection failure loud: if the slot silently sat out,
 * the run would exit 2, not pass vacuously. A manager missing from the local
 * machine skips its case; CI installs all four.
 */
const QUARTET: { pm: string; add: string[] }[] = [
  { pm: 'pnpm', add: ['add', '-D', 'typescript@6.0.3'] },
  { pm: 'npm', add: ['install', '--save-dev', 'typescript@6.0.3'] },
  { pm: 'yarn', add: ['add', '-D', 'typescript@6.0.3'] },
  { pm: 'bun', add: ['add', '-d', 'typescript@6.0.3'] },
];

async function available(pm: string): Promise<boolean> {
  try {
    await execFileP(pm, ['--version'], ENV);
    return true;
  } catch {
    return false;
  }
}

describe('package-manager quartet', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-e2e-pm-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  for (const { pm, add } of QUARTET) {
    test(`${pm}: install -> detect -> translated exec -> green`, async (ctx) => {
      if (!(await available(pm))) {
        ctx.skip();
        return;
      }
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'quartet', private: true }));
      await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { composite: true, outDir: 'dist', rootDir: 'src', strict: true },
        include: ['src'],
      }));
      await mkdir(join(dir, 'src'));
      await writeFile(join(dir, 'src', 'index.ts'), 'export const answer: number = 42;\n');
      // A modern yarn (berry) needs a linker that puts bins on disk; yarn 1
      // ignores this file entirely.
      if (pm === 'yarn') await writeFile(join(dir, '.yarnrc.yml'), 'nodeLinker: node-modules\n');

      await execFileP(pm, add, { cwd: dir, ...BIG, ...ENV });

      // The lockfile the install just wrote is what detection keys on.
      const { stdout } = await execFileP(
        'node', [CLI, 'doctor', '--json'], { cwd: dir, ...BIG, ...ENV },
      ).catch((err: { stdout: string }) => ({ stdout: err.stdout }));
      expect((JSON.parse(stdout) as { packageManager: string }).packageManager).toBe(pm);

      // Throws (test fails) on non-zero exit; --strict would exit 2 if the
      // types slot silently sat out instead of running.
      await execFileP('node', [CLI, '--only', 'types', '--strict'], { cwd: dir, ...BIG, ...ENV });

      const summary = JSON.parse(
        await readFile(join(dir, '.check', 'summary.json'), 'utf8'),
      ) as { ok: boolean; checks_run: number; checks: { name: string; ok: boolean }[] };
      expect(summary.ok).toBe(true);
      expect(summary.checks_run).toBe(1);
      expect(summary.checks.find((c) => c.name === 'types')).toMatchObject({ ok: true });
    });
  }
});

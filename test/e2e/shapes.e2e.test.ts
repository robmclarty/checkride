import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli', 'index.js');
const BIG = { maxBuffer: 32 * 1024 * 1024 };

/**
 * The encoded lesson of the predecessor: a verification product whose freshly
 * generated output fails its own verification is broken. Every shape `init`
 * generates must `pnpm install` and pass `checkride` with exit 0.
 */
async function generateInstallCheck(dir: string, shape: string): Promise<void> {
  await execFileP('node', [CLI, 'init', '--shape', shape, '--name', 't', '--scope', '@demo'], { cwd: dir, ...BIG });

  // The unpublished checkride devDep can't resolve from the registry yet; drop
  // it and exercise the built CLI directly (this tests init output + the run).
  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { devDependencies?: Record<string, string> };
  if (pkg.devDependencies) delete pkg.devDependencies['checkride'];
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2));

  await execFileP('pnpm', ['install'], { cwd: dir, ...BIG });
  await execFileP('node', [CLI], { cwd: dir, ...BIG }); // throws (test fails) on non-zero exit
}

describe('green out of the box', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-e2e-shape-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  for (const shape of ['flat', 'monorepo', 'hybrid']) {
    test(`${shape}: init -> pnpm install -> checkride exits 0`, async () => {
      await expect(generateInstallCheck(dir, shape)).resolves.toBeUndefined();
    });
  }
});

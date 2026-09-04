import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { Shape } from '../init.js';
import { runInit } from '../init.js';

const execFileP = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// cspell ships no `bin` subpath export; run its entry with node directly. Pinned
// to the same version the `spell` adapter installs (see src/adapters.ts).
const CSPELL_BIN = join(repoRoot, 'node_modules', 'cspell', 'bin.mjs');

/**
 * The predecessor's lesson (see test/e2e/shapes.e2e.test.ts): a verification
 * product whose freshly generated output fails its own verification is broken.
 * The full e2e suite proves that end-to-end, but it is CI-only and slow —
 * `init` + `pnpm install` + every check, ~40s for three shapes. This is the
 * fast, local half: generate a project in process and run only its `spell`
 * check, so drift between the generated prose (the AGENTS.md stanza) and the
 * generated cspell dictionary is caught by `pnpm check` on every run — the way
 * `baselined` should have been before v0.2.0 shipped.
 */
async function spellCheckGenerated(dir: string, shape: Shape): Promise<{ code: number; out: string }> {
  await runInit({ cwd: dir, shape, name: 't', scope: '@demo', hook: false });
  try {
    // No globs: cspell reads the generated cspell.json `files` field, exactly
    // as the `spell` adapter does. Exit 0 iff no unknown words.
    await execFileP(process.execPath, [CSPELL_BIN, '--no-progress', '--no-summary', '--reporter=default'], { cwd: dir });
    return { code: 0, out: '' };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() };
  }
}

describe('generated project passes its own spell check', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-spell-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  for (const shape of ['flat', 'monorepo', 'hybrid'] as const) {
    // cspell's startup alone can exceed the 5s default on slow-spawn machines.
    test(`${shape}: cspell finds no unknown words`, async () => {
      const { code, out } = await spellCheckGenerated(dir, shape);
      // On failure `out` lists each flagged `file:line - Unknown word (…)`. The
      // template runs cspell in `report-common-typos` mode, so a hit is a real
      // misspelling in the generated prose — fix the prose, not the dictionary.
      expect(code, `cspell flagged unknown word(s) in the generated ${shape} project:\n${out}`).toBe(0);
    }, 30_000);
  }
});

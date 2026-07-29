/**
 * The bundled plugin's two executable readers.
 *
 * `dist/triage/cli.js` and `dist/qa/cli.js` are what the `/checkride:check` and
 * `/checkride:qa` skills actually invoke, and `dist/cli.js` knows nothing about
 * either — so nothing else in the suite touches them. They were the only files
 * in the package with no coverage of any kind: three lines each, but three
 * lines whose failure mode is a skill that silently produces nothing.
 *
 * They can only be exercised as processes. Each does its work at module top
 * level, which is correct for a bin and untestable in-process, so these spawn
 * the built files the same way a skill does.
 *
 * The contract each promises is narrow and worth pinning: exit 0 means *a
 * report was rendered*, whatever the report says. A repo with nothing to read
 * is a legitimate answer about that repo, not a reader failure — if these ever
 * start exiting non-zero on a red or empty repo, the skills lose the ability to
 * tell "your gate is broken" from "the reader is broken".
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, '..', '..', 'dist');
const BIG = { maxBuffer: 32 * 1024 * 1024 };

const READERS = [
  { name: 'triage', bin: join(DIST, 'triage', 'cli.js') },
  { name: 'qa', bin: join(DIST, 'qa', 'cli.js') },
];

type Run = { code: number; stdout: string; stderr: string };

async function run(bin: string, args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileP('node', [bin, ...args], BIG);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('the bundled plugin readers', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-e2e-readers-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  for (const { name, bin } of READERS) {
    test(`${name}: renders a report for a repo with nothing to read, and exits 0`, async () => {
      // No package.json, no `.check/`, no config — every input absent at once.
      const result = await run(bin, [dir]);
      expect(result.code).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      expect(result.stdout).toContain('#'); // markdown, not a stack trace
      expect(result.stdout).not.toContain('Error:');
    });

    test(`${name}: reads a repo whose gate is red, and still exits 0`, async () => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({
        name: 'red', private: true, scripts: { check: 'node -e "process.exit(1)"' },
      }));
      await mkdir(join(dir, '.check'), { recursive: true });
      await writeFile(join(dir, '.check', 'summary.json'), JSON.stringify({
        schema_version: 1,
        timestamp: new Date().toISOString(),
        ok: false,
        checks_run: 1,
        total_duration_ms: 10,
        checks: [{
          name: 'lint', adapter: 'oxlint', description: 'Oxlint', ok: false,
          exit_code: 1, duration_ms: 10, output_file: 'lint.json',
        }],
      }));
      await writeFile(join(dir, '.check', 'lint.json'), JSON.stringify({ diagnostics: [] }));

      const result = await run(bin, [dir]);
      // The gate's verdict belongs in the markdown, never in this process's
      // status — a red repo must not look to the caller like a broken reader.
      expect(result.code).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
    }, 60_000);

    test(`${name}: defaults to the process cwd when given no argument`, async () => {
      const { stdout } = await execFileP('node', [bin], { cwd: dir, ...BIG });
      expect(stdout.trim().length).toBeGreaterThan(0);
    }, 60_000);
  }
});

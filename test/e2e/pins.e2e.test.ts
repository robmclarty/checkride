/**
 * `--pins` against real mise (R13.3, S8).
 *
 * A bash target's `lint` resolves shellcheck through the `override` source a
 * `--pins` file puts at the head of its chain: an installed version runs as
 * `mise exec shellcheck@<version>`, ahead of the repo's own pin, and records
 * `pin_source: "override"` with that version. A version mise hasn't
 * installed fails the check naming the tool and the install, and nothing
 * downloads (F38). The installed version is the one this repo's dev
 * `mise.toml` pins, which `mise install` put in place.
 */

import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { describeWithToolchain } from '../helpers/toolchains.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const CLI = join(ROOT, 'dist', 'cli.js');

/** The shellcheck version this repo's `mise.toml` pins, so installed on any machine the bash cases run on. */
async function devShellcheck(): Promise<string> {
  const version = /^shellcheck\s*=\s*"([^"]+)"/m.exec(await readFile(join(ROOT, 'mise.toml'), 'utf8'))?.[1];
  if (version === undefined) throw new Error('mise.toml pins no shellcheck');
  return version;
}

/** Where mise keeps installs, which a version it never installed must not appear under. */
function miseInstalls(tool: string): string {
  const out = spawnSync('mise', ['where', tool], { encoding: 'utf8', cwd: tmpdir() }).stdout.trim();
  return dirname(out);
}

type Run = { code: number; stderr: string; check: Record<string, unknown> | undefined };

const hasMise = spawnSync('mise', ['--version'], { stdio: 'ignore' }).status === 0;

(hasMise ? describeWithToolchain('bash') : describe.skip)('--pins runs the copy it pins, through mise (R13.3)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-pins-e2e-'));
    await mkdir(join(dir, 'scripts'));
    await writeFile(join(dir, 'scripts', 'deploy.sh'), '#!/bin/sh\necho "deploying"\n');
    await writeFile(join(dir, 'scripts', '.shellcheckrc'), 'disable=SC1091\n');
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ targets: { scripts: { lang: 'bash', root: 'scripts' } } }));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  /** Run checkride's `scripts:lint` with the pins file `pins`, returning the exit code, stderr and the check's summary entry. */
  async function run(pins: string): Promise<Run> {
    await writeFile(join(dir, 'pins.toml'), pins);
    const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(process.execPath, [CLI, '--only', 'scripts:lint', '--pins', 'pins.toml'], { cwd: dir }, (error, _stdout, err) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stderr: err });
      });
    });
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as { checks: Record<string, unknown>[] };
    return { code, stderr, check: summary.checks.find((c) => c['name'] === 'scripts:lint') };
  }

  test('an installed version runs as mise exec <id>@<version>, recorded as the override', async () => {
    const version = await devShellcheck();
    const result = await run(`[tools]\nshellcheck = "${version}"\n`);
    expect(result.code).toBe(0);
    expect(result.check).toMatchObject({ ok: true, pin_source: 'override', tool_version: version });
    expect(result.check?.['argv']).toEqual(expect.arrayContaining(['mise', 'exec', `shellcheck@${version}`, '--', 'shellcheck']));
  }, 60_000);

  // F38
  test('a version mise hasn’t installed fails naming the tool, and nothing downloads', async () => {
    const result = await run('[tools]\nshellcheck = "0.0.1"\n');
    expect(result.code).toBe(1);
    expect(result.check).toMatchObject({ ok: false });
    const raw = await readFile(join(dir, '.check', 'scripts', 'lint.stderr.txt'), 'utf8').catch(() => result.stderr);
    expect(`${raw}${result.stderr}`).toContain('mise install shellcheck@0.0.1');
    expect(existsSync(join(miseInstalls(`shellcheck@${await devShellcheck()}`), '0.0.1'))).toBe(false);
  }, 60_000);
});

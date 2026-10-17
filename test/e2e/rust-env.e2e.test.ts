/**
 * The rust pack's spawn environment, against real rustup (R6.4, F3).
 *
 * A rust target's checks run with the toolchain installs switched off, and the
 * toolchain the repo's `rust-toolchain.toml` names wins over one an outer shell
 * exported, as mise exports `RUSTUP_TOOLCHAIN` for its own Rust: a channel
 * that isn't installed fails the check, installs nothing, and the run names
 * the `rustup toolchain install` that fixes it. The check here is the target's
 * own `types` custom check, `cargo check`, which R6.4 covers like an adapter.
 * Only rustup's `cargo` reads the file, so the case needs rustup on `PATH`.
 */

import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, expect, test } from 'vitest';

import { describeWithToolchain } from '../helpers/toolchains.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli.js');

/** The toolchains rustup has installed, one per line. */
function installedToolchains(): string {
  return spawnSync('rustup', ['toolchain', 'list'], { encoding: 'utf8' }).stdout;
}

const hasRustup = spawnSync('rustup', ['--version'], { stdio: 'ignore' }).status === 0;

describeWithToolchain('rust')('the rust pack spawn environment (R6.4)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-rust-env-'));
    await mkdir(join(dir, 'core', 'src'), { recursive: true });
    await writeFile(join(dir, 'core', 'Cargo.toml'), '[package]\nname = "core"\nversion = "0.1.0"\nedition = "2021"\n');
    await writeFile(join(dir, 'core', 'src', 'lib.rs'), 'pub fn one() -> u8 { 1 }\n');
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({
      targets: { core: { lang: 'rust', root: 'core', checks: { types: { command: 'cargo', args: ['check', '--message-format=json'], outputFile: 'types.jsonl' } } } },
    }));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  // F3
  test.skipIf(!hasRustup)("a channel rust-toolchain.toml names that isn't installed fails, installs nothing, and the run names the install", async () => {
    // A channel old enough that no machine running these cases keeps it.
    await writeFile(join(dir, 'core', 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.70.0"\n');
    const before = installedToolchains();
    // An outer shell's toolchain, as mise exports for its own Rust, which would otherwise override the file.
    const env = { ...process.env, RUSTUP_TOOLCHAIN: 'stable', RUSTUP_AUTO_INSTALL: '1' };
    const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile('node', [CLI, '--only', 'core:types'], { cwd: dir, env }, (error, _stdout, err) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stderr: err });
      });
    });
    expect(code).toBe(1);
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as { checks: Record<string, unknown>[] };
    expect(summary.checks.find((c) => c['name'] === 'core:types')).toMatchObject({ ok: false, pack: 'rust' });
    expect(await readFile(join(dir, '.check', 'core', 'types.stderr.txt'), 'utf8')).toMatch(/toolchain '1\.70\.0-[^']+' is not installed/);
    expect(stderr).toMatch(/run `rustup toolchain install 1\.70\.0-[^`]+` first/);
    expect(installedToolchains()).toBe(before);
  });

  test('an installed toolchain checks the crate', async () => {
    const { code } = await new Promise<{ code: number }>((resolve) => {
      execFile('node', [CLI, '--only', 'core:types'], { cwd: dir }, (error) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1 });
      });
    });
    expect(code).toBe(0);
  });
});

import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { describe } from 'vitest';

import { MISE_IDS } from '../../src/channel.js';

/**
 * What mise's CI detection reads on GitHub Actions: the vendor's own
 * variable, and the four the ci_info crate takes as any CI. Where it finds
 * one, mise trusts every config file without recording it, so a file reads
 * as trusted whatever a run did. A case about trust drops these to see what
 * mise does on a laptop.
 */
export const CI_MARKERS = ['GITHUB_ACTIONS', 'CI', 'CONTINUOUS_INTEGRATION', 'BUILD_NUMBER', 'RUN_ID'] as const;

/** `text` with every character a regular expression reads as syntax escaped. */
const literal = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\/]/g, String.raw`\$&`);

/** The checkride entry a language scaffold's `mise.toml` opens with where a release has a binary for the host, its version captured. */
export const BINARY_PIN = new RegExp(`^"${literal(MISE_IDS.binary)}" = "([^"]+)"$`, 'm');

/** A scaffold's checkride entry, for the release `version`. */
export const binaryPin = (version: string): string => `"${MISE_IDS.binary}" = "${version}"`;

/** `toml`, a scaffold's `mise.toml`, which must hold the binary's pin, with that line replaced by `lines`. */
function swapPin(toml: string, lines: string): string {
  if (!BINARY_PIN.test(toml)) throw new Error(`no ${MISE_IDS.binary} pin to replace in:\n${toml}`);
  return toml.replace(BINARY_PIN, lines);
}

/**
 * A scaffold's `mise.toml` with checkride pinned the npm route's way instead.
 * That entry sets a tool option, which the scaffold's own does not, so mise
 * won't read the file until someone trusts it: what a case about an untrusted
 * `mise.toml` needs to start from.
 */
export function withNpmPin(toml: string): string {
  return swapPin(toml, `node = "22.18.0"\n"${MISE_IDS.npm}" = { version = "$1", allow_low_downloads = true }`);
}

/**
 * A scaffold's `mise.toml` without its checkride entry, for a case that runs
 * checkride from the local build. The entry names this package's version,
 * which no dev `mise.toml` installs and GitHub may not have released, so left
 * in, every `mise exec -- <tool>` a check spawns warns that the pin is
 * missing, and a mise that looked a missing pin up remotely would take an
 * offline case red.
 */
export function withoutCheckridePin(toml: string): string {
  return swapPin(toml, '').replace('[tools]\n\n', '[tools]\n');
}

/** The mise on `PATH`, or `null`, probed from the temp directory, as the toolchain gate probes. */
export function findMise(): string | null {
  const found = spawnSync('sh', ['-c', 'command -v mise'], { cwd: tmpdir(), encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : null;
}

/**
 * `describe` when mise runs, else `describe.skip` with the reason on stderr,
 * or, under `CHECKRIDE_REQUIRE_TOOLCHAINS=1`, which CI sets, a throw, so a
 * runner without mise can't pass a mise case as a skip (D42).
 */
export function describeWithMise(mise: string | null): typeof describe | typeof describe.skip {
  if (mise !== null) return describe;
  if (process.env['CHECKRIDE_REQUIRE_TOOLCHAINS'] === '1') {
    throw new Error('CHECKRIDE_REQUIRE_TOOLCHAINS=1 and mise is not on PATH; install mise (https://mise.jdx.dev)');
  }
  console.warn('skipping a mise e2e case: mise is not on PATH (install it, or set CHECKRIDE_REQUIRE_TOOLCHAINS=1 to fail instead)');
  return describe.skip;
}

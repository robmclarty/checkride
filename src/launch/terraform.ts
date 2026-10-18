/**
 * The `tf-version` pin source: a `.terraform-version` or `.opentofu-version`
 * file from the check's directory up to the repo root declares which CLI the
 * terraform pack runs, `terraform` or `tofu`, and the version it must be
 * (R6.1). It's the file tfenv and tofuenv read, so where one of those
 * managers is the `terraform` on `PATH` it picks that version itself. Where
 * it isn't, nothing would, so an exact version is checked against the copy on
 * `PATH` before the check runs, and a mismatch fails it naming the one the
 * file asks for. The version recorded is the file's, when it names one
 * exact release (R6.3).
 *
 * Which CLI a terraform target runs follows the same files: `tofu` where the
 * nearest version file is `.opentofu-version` or, with none, where a
 * `mise.toml` pins OpenTofu, and `terraform` otherwise (R5.8).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { isRecord } from '../json.js';
import type { Tool } from '../packs/index.js';
import { TERRAFORM_TOOLCHAIN, TOFU_TOOLCHAIN } from '../packs/index.js';
import { miseDeclaration } from './mise.js';
import { dirsUpTo } from './walk.js';

/** The version files a directory names its CLI in, OpenTofu's first: the CLI each declares, and the manager that reads it. */
const VERSION_FILES: readonly { file: string; cli: Tool; manager: string }[] = [
  { file: '.opentofu-version', cli: TOFU_TOOLCHAIN, manager: 'tofuenv' },
  { file: '.terraform-version', cli: TERRAFORM_TOOLCHAIN, manager: 'tfenv' },
];

/**
 * Where a version file declares the CLI: the file, relative to the repo root,
 * the CLI it declares, the version manager that reads that file, and the
 * release it names when it names one exactly (a constraint such as
 * `latest:^1.5` or `min-required` names none).
 */
export type TfVersionDeclaration = { file: string; cli: Tool; manager: string; version?: string };

/** The text of the file at `path`, or `null` when there's none to read. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The exact release a version file's text names, such as `1.5.7`, a leading `v` dropped, or `undefined`. */
export function exactVersion(text: string): string | undefined {
  return /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(text.trim())?.[1];
}

/**
 * The version file nearest `cwd`, up to `repo`, the CLI it declares and the
 * release it names, or `null` when no directory between them holds one. In
 * one directory, `.opentofu-version` comes first.
 */
export function tfVersionDeclaration(cwd: string, repo: string): TfVersionDeclaration | null {
  for (const dir of dirsUpTo(cwd, repo)) {
    for (const { file, cli, manager } of VERSION_FILES) {
      const text = readText(join(dir, file));
      if (text === null) continue;
      const version = exactVersion(text);
      return { file: relative(repo, join(dir, file)) || file, cli, manager, ...(version !== undefined ? { version } : {}) };
    }
  }
  return null;
}

/**
 * The CLI a terraform check at `cwd` runs: the one the nearest version file
 * declares, else `tofu` where a `mise.toml` up to `repo`, or the run's
 * `--pins` file (`overrides`), pins OpenTofu, else `terraform` (R5.8).
 */
export function terraformCli(cwd: string, repo: string, overrides: ReadonlyMap<string, string>): Tool {
  const declared = tfVersionDeclaration(cwd, repo);
  if (declared !== null) return declared.cli;
  const ids = TOFU_TOOLCHAIN.mise ?? [TOFU_TOOLCHAIN.bin];
  const pinsTofu = ids.some((id) => overrides.has(id)) || miseDeclaration(cwd, repo, ids) !== null;
  return pinsTofu ? TOFU_TOOLCHAIN : TERRAFORM_TOOLCHAIN;
}

/** How long the version probe may take before it counts as failed. */
const VERSION_TIMEOUT_MS = 30_000;

/**
 * What the probe runs with over the check's environment: no call to
 * HashiCorp's version service, and no download by a version manager that
 * stands in for the CLI.
 */
const PROBE_ENV: Readonly<Record<string, string>> = {
  CHECKPOINT_DISABLE: '1',
  TFENV_AUTO_INSTALL: 'false',
  TOFUENV_AUTO_INSTALL: 'false',
};

/** The version a CLI reports, or the first line of why it couldn't say. */
type CliVersion = { ok: true; version: string } | { ok: false; detail: string };

/**
 * The version the CLI at `path` reports through `version -json`, whose
 * `terraform_version` both terraform and tofu fill (checked against
 * Terraform 1.9.8 and OpenTofu 1.13.1), run from `cwd`, where a version
 * manager reads the file. A probe that fails, or prints no version, says why.
 */
export function cliVersion(path: string, cwd: string, env: Readonly<Record<string, string | undefined>>): CliVersion {
  let stdout: string;
  try {
    stdout = execFileSync(path, ['version', '-json'], {
      cwd,
      env: { ...env, ...PROBE_ENV },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: VERSION_TIMEOUT_MS,
    });
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
    return { ok: false, detail: stderr.split('\n').map((l) => l.trim()).find(Boolean) ?? 'version -json failed' };
  }
  try {
    const reported: unknown = JSON.parse(stdout);
    const version = isRecord(reported) ? reported['terraform_version'] : undefined;
    if (typeof version === 'string' && version !== '') return { ok: true, version };
  } catch {
    // Not JSON: an old CLI, or a wrapper that printed something else.
  }
  return { ok: false, detail: 'version -json printed no terraform_version' };
}

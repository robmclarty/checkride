/**
 * Contract: the distribution channel (docs/contract.md §CLI, "The channel").
 *
 * `doctor` names the channel it runs from, in its table and in `--json`, and
 * `--version` prints the version `package.json` holds. From the npm package
 * the channel is `npm`, no `embeddedNode` rides beside it, and a package
 * `extends` is resolved as a package, never refused for the channel. The
 * binary's half of the section is held by `src/__tests__/binary-channel.test.ts`
 * and, against a built binary, `test/e2e/binary.e2e.test.ts`. All of it is
 * additive: a break here is a version decision, not a test edit.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { CliDeps } from '../../src/cli.js';
import { runCli } from '../../src/cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const VERSION = (JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;

function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

describe('the distribution channel', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-channel-contract-'));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ checks: { probe: { command: process.execPath, args: ['-e', ''] } } }));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function deps(stdout: CliDeps['stdout'], stderr: CliDeps['stderr'] = capture()): CliDeps {
    return { cwd: dir, stdout, stderr, env: {} };
  }

  test('--version prints package.json’s version and nothing else', async () => {
    const stdout = capture();
    expect(await runCli(['--version'], deps(stdout))).toBe(0);
    expect(stdout.text()).toBe(`${VERSION}\n`);
  });

  test('doctor --json carries channel "npm" and no embeddedNode', async () => {
    const stdout = capture();
    await runCli(['doctor', '--json'], deps(stdout));
    const report = JSON.parse(stdout.text()) as Record<string, unknown>;
    expect(report['channel']).toBe('npm');
    expect('embeddedNode' in report).toBe(false);
  }, 30_000);

  test('doctor’s table names the channel on the line under the package manager’s', async () => {
    const stdout = capture();
    await runCli(['doctor'], deps(stdout));
    expect(stdout.text()).toMatch(/^ {2}package manager: \w+ \(detected\)\n {2}channel: npm\n/m);
  }, 30_000);

  test('a package extends is resolved as a package: a missing one is exit 2 for the package, not the channel', async () => {
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ extends: '@checkride-contract/absent-preset' }));
    const stderr = capture();
    expect(await runCli([], deps(capture(), stderr))).toBe(2);
    expect(stderr.text()).toContain('cannot resolve extends "@checkride-contract/absent-preset"');
    expect(stderr.text()).not.toContain('npm distribution');
  });
});

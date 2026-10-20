/**
 * Guards on the dev `mise.toml` and the e2e toolchain gate that reads it.
 *
 * CI installs exactly what `mise.toml` pins and then requires every pack's
 * tools, so the two lists must agree: a tool the gate probes but nobody pins
 * fails CI, and a pin no gate probes is a toolchain no case proves. The gate's
 * three outcomes are pinned here with a fake probe, since which tools this
 * machine has decides nothing. The default probe's cases spawn only Node and
 * a binary nobody has, for the same reason.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test, vi } from 'vitest';

import { describeWithToolchain, spawnProbe, TOOLCHAINS, toolchainGate } from '../helpers/toolchains.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `[tools]` keys, bare or quoted as a backend id is, to versions: a bare string, or an inline table's `version`. */
function misePins(): Map<string, string> {
  const text = readFileSync(join(ROOT, 'mise.toml'), 'utf8');
  const section = text.split(/^\[tools\]$/m)[1]?.split(/^\[/m)[0] ?? '';
  const pins = new Map<string, string>();
  for (const line of section.split('\n')) {
    const match = /^(?:"([^"]+)"|([\w-]+))\s*=\s*(?:"([^"]*)"|\{.*\bversion\s*=\s*"([^"]*)")/.exec(line);
    const [, quoted, bareKey, bare, table] = match ?? [];
    const key = quoted ?? bareKey;
    if (key !== undefined) pins.set(key, bare ?? table ?? '');
  }
  return pins;
}

const every = () => true;
const none = () => false;

describe('the dev mise.toml', () => {
  test('pins exactly the tools the e2e toolchain gate probes', () => {
    const gated = new Set(Object.values(TOOLCHAINS).flat().map((tool) => tool.mise));
    expect([...misePins().keys()].toSorted()).toEqual([...gated].toSorted());
  });

  test('pins every tool to an exact version', () => {
    for (const [tool, version] of misePins()) {
      expect(version, `${tool} must pin an exact x.y.z version`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe('toolchainGate', () => {
  test('runs a pack whose tools all run', () => {
    expect(toolchainGate('go', { env: {}, runs: every })).toEqual({ run: true });
  });

  test('skips a pack with a missing tool, naming only the missing ones', () => {
    const gate = toolchainGate('bash', { env: {}, runs: ([bin]) => bin !== 'shfmt' });
    expect(gate.run).toBe(false);
    expect(gate.run ? '' : gate.reason).toMatch(/^shfmt not found or not runnable \(run `mise install`/);
  });

  test('throws instead under CHECKRIDE_REQUIRE_TOOLCHAINS=1', () => {
    const env = { CHECKRIDE_REQUIRE_TOOLCHAINS: '1' };
    expect(() => toolchainGate('terraform', { env, runs: none }))
      .toThrow('CHECKRIDE_REQUIRE_TOOLCHAINS=1 and the terraform toolchain is incomplete: tofu, tflint, trivy');
  });

  test('treats any other value of the variable as unset', () => {
    const env = { CHECKRIDE_REQUIRE_TOOLCHAINS: 'true' };
    expect(toolchainGate('rust', { env, runs: none }).run).toBe(false);
  });

  test('quotes why a probe failed after the command it ran, in the skip and the throw alike', () => {
    const shim = 'mise ERROR No version is set for shim: cargo-nextest';
    const runs = (probe: readonly string[]) => probe[1] !== 'nextest' || shim;
    const what = `cargo nextest not found or not runnable (cargo nextest --version: ${shim})`;
    const gate = toolchainGate('rust', { env: {}, runs });
    expect(gate.run ? '' : gate.reason).toBe(`${what} (run \`mise install\`, then \`mise exec -- pnpm test:e2e\`, or set CHECKRIDE_REQUIRE_TOOLCHAINS=1 to fail instead)`);
    expect(() => toolchainGate('rust', { env: { CHECKRIDE_REQUIRE_TOOLCHAINS: '1' }, runs }))
      .toThrow(`CHECKRIDE_REQUIRE_TOOLCHAINS=1 and the rust toolchain is incomplete: ${what}; run \`mise install\``);
  });
});

describe('spawnProbe', () => {
  test('passes a probe that exits 0', () => {
    expect(spawnProbe([process.execPath, '--version'])).toBe(true);
  });

  test('says not found for a binary that isn’t on PATH', () => {
    expect(spawnProbe(['checkride-no-such-tool', '--version'])).toBe('not found');
  });

  test('quotes the error line from its output, past a warning before it, a hint after it, and its color', () => {
    const lines = ['mise WARN  a newer mise is available', '\u001b[31mmise ERROR\u001b[0m No version is set for shim: x', 'mise use -g x@1'];
    const script = `console.error(${JSON.stringify(lines.join('\n'))}); process.exit(1)`;
    expect(spawnProbe([process.execPath, '-e', script])).toBe('mise ERROR No version is set for shim: x');
  });

  test('says how it ended when it prints nothing', () => {
    expect(spawnProbe([process.execPath, '-e', 'process.exit(3)'])).toBe('exited 3');
  });
});

describe('describeWithToolchain', () => {
  test('hands back describe when the pack can run', () => {
    expect(describeWithToolchain('python', { env: {}, runs: every })).toBe(describe);
  });

  // Declared at collection, the way an e2e file uses it, so a skip that
  // didn't skip fails this run.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  describeWithToolchain('repo', { env: {}, runs: none })('with a missing tool', () => {
    test('never runs its cases', () => { expect.unreachable('a pack with a missing tool ran its cases'); });
  });
  const warned = warn.mock.calls.flat();
  warn.mockRestore();

  test('says why it skipped on stderr', () => {
    expect(warned).toEqual([expect.stringMatching(/^skipping the repo e2e cases: typos, rumdl, vale, ast-grep /)]);
  });
});

/**
 * The repo's Node pin, and finding an installed interpreter for it.
 *
 * Every filesystem touch is injected, which is the only way to test this at all:
 * the layouts are other people's version managers, and the machine running these
 * tests has whichever subset of them it happens to have — including none. So the
 * layouts are asserted as *paths this module will look at*, not as installs it
 * found here.
 */

import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  alignNode,
  findPinnedNode,
  NODE_BIN_VAR,
  type PinEnv,
  readNodePin,
  satisfiesPin,
  withNodeBin,
} from '../node-pin.js';

const HOME = '/home/dev';

function pinEnv(over: Partial<PinEnv> = {}): PinEnv {
  return {
    exists: () => false,
    read: () => null,
    list: () => [],
    home: () => HOME,
    running: () => '24.9.0',
    variable: () => undefined,
    ...over,
  };
}

/** A version manager holding `versions` under `root`, with `bin` below each. */
function installed(root: string[], bin: string[], versions: string[]): Partial<PinEnv> {
  const dir = join(HOME, ...root);
  const paths = new Set(versions.map((v) => join(dir, v, ...bin, 'node')));
  const dirs = new Set(versions.map((v) => join(dir, v)));
  return {
    list: (d) => (d === dir ? versions : []),
    exists: (p) => paths.has(p) || dirs.has(p),
  };
}

describe('readNodePin', () => {
  test('reads .nvmrc, tolerating the `v` prefix and trailing newline', () => {
    const env = pinEnv({ read: (p) => (p.endsWith('.nvmrc') ? 'v22.22.3\n' : null) });
    expect(readNodePin('/repo', env)).toEqual({ file: '.nvmrc', version: '22.22.3' });
  });

  test('falls back to .node-version', () => {
    const env = pinEnv({ read: (p) => (p.endsWith('.node-version') ? '20.11.1' : null) });
    expect(readNodePin('/repo', env)).toEqual({ file: '.node-version', version: '20.11.1' });
  });

  test('.nvmrc wins when a repo carries both', () => {
    const env = pinEnv({ read: (p) => (p.endsWith('.nvmrc') ? '22' : '20') });
    expect(readNodePin('/repo', env)?.file).toBe('.nvmrc');
  });

  /**
   * `lts/*`, `lts/jod` and `node` are aliases a version manager resolves against
   * its own alias directory and its own idea of the current LTS. Guessing at
   * either would pick an interpreter the repo never named, so an alias reads as
   * no actionable pin — checkride then diagnoses rather than acts.
   */
  test.each(['lts/*', 'lts/jod', 'node', 'system', ''])('treats %j as no actionable pin', (raw) => {
    expect(readNodePin('/repo', pinEnv({ read: () => raw }))).toBeNull();
  });

  test('a repo with no pin file at all', () => {
    expect(readNodePin('/repo', pinEnv())).toBeNull();
  });
});

describe('satisfiesPin', () => {
  /** Every version manager reads a partial `.nvmrc` as "the newest you have". */
  test('a partial pin matches its whole line', () => {
    expect(satisfiesPin('22', '22.22.3')).toBe(true);
    expect(satisfiesPin('22.22', '22.22.3')).toBe(true);
  });

  test('a fully spelled pin matches only itself', () => {
    expect(satisfiesPin('22.22.3', '22.22.3')).toBe(true);
    expect(satisfiesPin('22.22.3', '22.22.4')).toBe(false);
  });

  /** The bug: `2` must not match `22.x`, and `22` must not match `2.x`. */
  test('matches whole segments, never string prefixes', () => {
    expect(satisfiesPin('2', '22.22.3')).toBe(false);
    expect(satisfiesPin('22', '2.2.2')).toBe(false);
  });
});

describe('findPinnedNode', () => {
  test.each([
    ['nvm', ['.nvm', 'versions', 'node'], ['bin']],
    ['fnm', ['.local', 'share', 'fnm', 'node-versions'], ['installation', 'bin']],
    ['fnm (legacy)', ['.fnm', 'node-versions'], ['installation', 'bin']],
    ['nodenv', ['.nodenv', 'versions'], ['bin']],
    ['asdf', ['.asdf', 'installs', 'nodejs'], ['bin']],
    ['volta', ['.volta', 'tools', 'image', 'node'], ['bin']],
    ['n', ['n', 'versions', 'node'], ['bin']],
  ])('finds an install under %s', (_name, root, bin) => {
    const env = pinEnv(installed(root, bin, ['22.22.3']));
    expect(findPinnedNode({ file: '.nvmrc', version: '22.22.3' }, env)).toEqual({
      bin: join(HOME, ...root, '22.22.3', ...bin),
      version: '22.22.3',
    });
  });

  test('handles the `v`-prefixed directory names nvm and fnm use', () => {
    const env = pinEnv(installed(['.nvm', 'versions', 'node'], ['bin'], ['v22.22.3']));
    expect(findPinnedNode({ file: '.nvmrc', version: '22.22.3' }, env)?.bin).toBe(
      join(HOME, '.nvm', 'versions', 'node', 'v22.22.3', 'bin'),
    );
  });

  test('a partial pin takes the newest install that satisfies it', () => {
    const env = pinEnv(installed(['.nvm', 'versions', 'node'], ['bin'], ['v22.9.0', 'v22.22.3', 'v22.10.1', 'v24.9.0']));
    // Segment-wise, not lexical: 22.22.3 beats 22.9.0.
    expect(findPinnedNode({ file: '.nvmrc', version: '22' }, env)?.version).toBe('22.22.3');
  });

  test('an install directory with no `node` in it does not count', () => {
    const env = pinEnv({
      list: () => ['v22.22.3'],
      exists: (p) => !p.endsWith('node'),
    });
    expect(findPinnedNode({ file: '.nvmrc', version: '22.22.3' }, env)).toBeNull();
  });

  test('no matching install anywhere', () => {
    const env = pinEnv(installed(['.nvm', 'versions', 'node'], ['bin'], ['v20.11.1']));
    expect(findPinnedNode({ file: '.nvmrc', version: '22.22.3' }, env)).toBeNull();
  });
});

describe('alignNode', () => {
  const pinned = (version: string, versions: string[]): PinEnv =>
    pinEnv({
      read: (p) => (p.endsWith('.nvmrc') ? version : null),
      ...installed(['.nvm', 'versions', 'node'], ['bin'], versions),
    });

  test('nothing to do when the running Node already satisfies the pin', () => {
    expect(alignNode('/repo', pinned('24', ['v24.9.0']))).toBeNull();
  });

  test('nothing to do when the repo pins nothing', () => {
    expect(alignNode('/repo', pinEnv())).toBeNull();
  });

  test('a divergence with an install resolves to that install', () => {
    expect(alignNode('/repo', pinned('22.22.3', ['v22.22.3']))).toEqual({
      pin: { file: '.nvmrc', version: '22.22.3' },
      running: '24.9.0',
      bin: join(HOME, '.nvm', 'versions', 'node', 'v22.22.3', 'bin'),
      version: '22.22.3',
    });
  });

  /**
   * The actionable failure: the repo names a Node nothing on this machine has.
   * An alignment is still returned, with no `bin` — the caller changes nothing
   * and has a cause to name instead of a red it cannot explain.
   */
  test('a divergence with no install still reports the divergence', () => {
    expect(alignNode('/repo', pinned('22.22.3', []))).toEqual({
      pin: { file: '.nvmrc', version: '22.22.3' },
      running: '24.9.0',
      bin: null,
      version: null,
    });
  });

  test(`${NODE_BIN_VAR}=off declines to align even when it could`, () => {
    const env = { ...pinned('22.22.3', ['v22.22.3']), variable: () => 'off' };
    expect(alignNode('/repo', env)).toBeNull();
  });

  /**
   * The wrapping point for a layout this module does not know. It is honored
   * before the pin is read and regardless of what it says: naming the directory
   * is a more specific statement of intent than any file in the repo, and a
   * hatch that only worked where checkride already succeeds would not be one.
   */
  test(`${NODE_BIN_VAR}=<dir> wins over discovery, pin or no pin`, () => {
    const env = { ...pinEnv(), variable: () => '/opt/node22/bin' };
    expect(alignNode('/repo', env)).toEqual({ pin: null, running: '24.9.0', bin: '/opt/node22/bin', version: null });
  });
});

describe('withNodeBin', () => {
  test('prepends, so every other tool still resolves as it did', () => {
    expect(withNodeBin({ PATH: '/usr/bin:/bin' }, '/opt/node/bin')).toEqual({ PATH: '/opt/node/bin:/usr/bin:/bin' });
  });

  test('an empty environment gets just the bin, with no stray separator', () => {
    expect(withNodeBin({}, '/opt/node/bin')).toEqual({ PATH: '/opt/node/bin' });
  });

  test('leaves everything else in the environment alone', () => {
    expect(withNodeBin({ PATH: '/bin', HOME: '/home/dev' }, '/opt/node/bin')['HOME']).toBe('/home/dev');
  });
});

/**
 * A stand-in for the standalone binary in a unit test: the one value
 * `src/channel.ts` hands every caller, `runtime()`, faked from a state the
 * test owns.
 *
 * `fakeSea()` hands back the state: set `binary` to make this process the
 * binary or the npm package, and put the embedded files in `assets`. Call it
 * in a `beforeEach` or in a test. The real runtime is back after each test
 * of a file that imports this helper.
 */

import { afterEach } from 'vitest';

import { binaryRuntime, npmRuntime, useRuntime } from '../../src/channel.js';

/** What the faked runtime answers from. */
type SeaState = { binary: boolean; readonly assets: Map<string, string> };

afterEach(() => {
  useRuntime(undefined);
});

/** Fake the runtime for this process, as the binary by default, until the test ends. */
export function fakeSea(binary = true): SeaState {
  const assets = new Map<string, string>();
  const asset = (key: string): string => {
    const text = assets.get(key);
    if (text === undefined) throw new Error(`asset not found: ${key}`);
    return text;
  };
  const use = (on: boolean): void => useRuntime(on ? binaryRuntime(asset) : npmRuntime());
  let on = binary;
  use(on);
  return {
    assets,
    get binary() {
      return on;
    },
    set binary(value: boolean) {
      on = value;
      use(on);
    },
  };
}

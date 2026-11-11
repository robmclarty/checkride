/**
 * A stand-in for the standalone binary in a unit test: `node:sea` as
 * `src/channel.ts` looks it up, answering from a state the test owns.
 *
 * `fakeSea()` replaces `process.getBuiltinModule` for `node:sea` alone and
 * hands back the state: set `binary` to make this process the binary or the
 * npm package, and put the embedded files in `assets`. Call it in a
 * `beforeEach`, and restore with `vi.restoreAllMocks()` in an `afterEach`.
 */

import { vi } from 'vitest';

/** What the faked `node:sea` answers from. */
type SeaState = { binary: boolean; assets: Map<string, string> };

/** Fake `node:sea` for this process, as the binary by default, until mocks are restored. */
export function fakeSea(binary = true): SeaState {
  const state: SeaState = { binary, assets: new Map() };
  const real = process.getBuiltinModule.bind(process);
  const module = {
    isSea: () => state.binary,
    getAsset: (key: string) => {
      const text = state.assets.get(key);
      if (text === undefined) throw new Error(`asset not found: ${key}`);
      return text;
    },
  };
  vi.spyOn(process, 'getBuiltinModule').mockImplementation((id: string) => (id === 'node:sea' ? module : real(id)));
  return state;
}

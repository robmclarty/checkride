/**
 * A recording stand-in for `node:fs` and `node:fs/promises`, for a test that
 * must show which paths the code under it touched: every function of the
 * real module, wrapped to note the path it was called with before it runs.
 *
 * A test file mocks both modules with {@link spied} and reads
 * {@link touched}:
 *
 *   vi.mock('node:fs', async (original) => {
 *     const { spied } = await import('…/fs-spy.js');
 *     return spied(await original());
 *   });
 *
 * and the same for `node:fs/promises`. The import sits inside the factory,
 * since a mock factory runs before the test file's own imports do.
 *
 * The test's own setup goes through the same stand-in, so it calls
 * {@link forget} once the fixture is on disk.
 */

import { Buffer } from 'node:buffer';

const paths: { call: string; path: string }[] = [];
const faults = new Map<string, NodeJS.ErrnoException>();

/** Every call so far, as the function's name and the path it was given. */
export function touched(): readonly { call: string; path: string }[] {
  return paths;
}

/** Forget the calls so far and every fault set. */
export function forget(): void {
  paths.length = 0;
  faults.clear();
}

/** Make `call` on `path` fail with the error code `code`, as a file this user may not read does. */
export function failOn(call: string, path: string, code: string): void {
  faults.set(`${call} ${path}`, Object.assign(new Error(`${code}: stand-in fault, ${call} '${path}'`), { code }));
}

/** The path a call was given, when its first argument is one. */
function pathOf(first: unknown): string | null {
  if (typeof first === 'string') return first;
  if (Buffer.isBuffer(first) || first instanceof URL) return first.toString();
  return null;
}

type Fn = (...args: unknown[]) => unknown;

/** `fn`, recording the path it is called with, and failing where a fault is set for it. */
function recording(call: string, fn: Fn): Fn {
  const wrapped: Fn = (...args) => {
    const path = pathOf(args[0]);
    if (path !== null) {
      paths.push({ call, path });
      const fault = faults.get(`${call} ${path}`);
      if (fault !== undefined) {
        // A promise API rejects; a sync one throws. The name says which this is.
        if (call.endsWith('Sync')) throw fault;
        return Promise.reject(fault);
      }
    }
    return fn(...args);
  };
  return Object.assign(wrapped, fn);
}

/** True for a value that can be called. */
function isFn(value: unknown): value is Fn {
  return typeof value === 'function';
}

/** `module`'s entries with each function recording, its `promises` and `default` objects included. Constructors are left as they are. */
function spiedEntries(module: object): Record<string, unknown> {
  const entries = Object.entries(module).map(([key, value]: [string, unknown]): [string, unknown] => {
    if (isFn(value) && /^[a-z]/.test(key)) return [key, recording(key, value)];
    if ((key === 'promises' || key === 'default') && typeof value === 'object' && value !== null) return [key, spiedEntries(value)];
    return [key, value];
  });
  return Object.fromEntries(entries);
}

/** `module` with each of its functions recording the path it is called with. */
export function spied<T extends object>(module: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stand-in holds every key of `module`, each a function of the same signature or the value itself.
  return spiedEntries(module) as T;
}

/**
 * The read/write pool.
 *
 * Connects as a Postgres role that may write. Importing this module is the
 * privileged act, so `fallow.toml` allows exactly one zone — `writers` — to do
 * it. Every other zone that tries is a boundary violation at build time.
 *
 * Keeping the privilege in a *module* rather than a parameter is what makes it
 * statically checkable: an import is visible to the dependency graph, a value
 * threaded through three call frames is not.
 */

import { drizzle } from 'drizzle-orm/pg-proxy';

/** Read/write handle. Only a domain's single writer module may import this. */
export const writeDb = drizzle(async () => ({ rows: [] }));

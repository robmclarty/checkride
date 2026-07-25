/**
 * The read-only pool.
 *
 * In production this connects as a Postgres role with no INSERT/UPDATE/DELETE
 * grant on anything. That role is the guarantee — it holds even for a query
 * this repository's static checks cannot see (raw SQL, a dynamic import, a
 * migration script someone ran by hand).
 *
 * The static rules in `fallow.toml` exist to make a violation a *build* error
 * instead of a runtime one. Same rule, enforced twice, at two very different
 * costs to find out.
 */

import { drizzle } from 'drizzle-orm/pg-proxy';

/**
 * Read-only handle. Every module allowed to read across domains gets this one.
 *
 * The callback stands in for a driver so the example needs no database; in a
 * real repo this is `drizzle(readOnlyPool)` over `node-postgres`.
 */
export const readDb = drizzle(async () => ({ rows: [] }));

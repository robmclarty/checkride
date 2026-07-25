/**
 * In-domain reads for orders. Uses the read-only pool, like every reader.
 *
 * Add `.insert(...)` here and the build fails twice over: the write pool isn't
 * importable from this zone, and `readers` is forbidden from calling `.insert`
 * at all — so even a handle smuggled in as a parameter is caught.
 */

import { eq } from 'drizzle-orm';

import { readDb } from '../../db/read-pool.js';
import { orders } from './schema.js';

/** Every order placed by one customer. */
export async function ordersForCustomer(customerId: string): Promise<unknown[]> {
  return readDb.select().from(orders).where(eq(orders.customerId, customerId));
}

/**
 * A cross-domain read-only module — the case that makes this design worth
 * enforcing rather than merely documenting.
 *
 * Reporting legitimately needs to join across domains, so this file is allowed
 * to import *any* domain's schema. What it may not do is write to them: the
 * `reports` zone can reach the read pool and nothing else, and calling
 * `.insert`/`.update`/`.delete` from here is forbidden outright.
 *
 * That is the pair worth noticing. "Read anything, write nothing" is a
 * privilege split, and it is expressed here as two lines of config rather than
 * as a separate service with its own deployment.
 */

import { eq } from 'drizzle-orm';

import { readDb } from '../db/read-pool.js';
import { customers } from '../domains/customers/schema.js';
import { orders } from '../domains/orders/schema.js';

/** Revenue by customer display name — reads two domains, writes neither. */
export async function revenueByCustomer(): Promise<unknown[]> {
  return readDb
    .select()
    .from(orders)
    .innerJoin(customers, eq(orders.customerId, customers.id));
}

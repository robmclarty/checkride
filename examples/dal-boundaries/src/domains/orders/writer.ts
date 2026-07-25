/**
 * The single writer for the orders domain.
 *
 * Two rules meet in this file, and each is enforced by a different mechanism:
 *
 *   1. Only `writers` may import the write pool — a fallow zone rule, because
 *      "who may import what" is a graph question.
 *   2. A writer may only touch *its own* domain's schema — a custom check,
 *      because "its own" is a relationship between two paths that no zone rule
 *      can express. Zones are a fixed list; domains are not.
 */

import { eq } from 'drizzle-orm';

import { writeDb } from '../../db/write-pool.js';
import { orders } from './schema.js';

/** Record a newly placed order. */
export async function placeOrder(id: string, customerId: string, totalCents: number): Promise<void> {
  await writeDb.insert(orders).values({ id, customerId, totalCents });
}

/** Adjust an order's total — still the only module allowed to do so. */
export async function repriceOrder(id: string, totalCents: number): Promise<void> {
  await writeDb.update(orders).set({ totalCents }).where(eq(orders.id, id));
}

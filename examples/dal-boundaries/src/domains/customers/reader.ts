/** In-domain reads for customers. */

import { eq } from 'drizzle-orm';

import { readDb } from '../../db/read-pool.js';
import { customers } from './schema.js';

/** One customer by id. */
export async function findCustomer(id: string): Promise<unknown[]> {
  return readDb.select().from(customers).where(eq(customers.id, id));
}

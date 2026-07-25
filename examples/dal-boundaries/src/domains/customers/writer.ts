/** The single writer for the customers domain. */

import { writeDb } from '../../db/write-pool.js';
import { customers } from './schema.js';

/** Register a new customer. */
export async function createCustomer(id: string, email: string, displayName: string): Promise<void> {
  await writeDb.insert(customers).values({ id, email, displayName });
}

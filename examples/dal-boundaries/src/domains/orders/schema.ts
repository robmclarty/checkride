/**
 * Tables owned by the orders domain.
 *
 * "Owned" is enforced, not aspirational: `scripts/check-table-ownership.mjs`
 * fails the build if any writer outside this folder imports this file.
 */

import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const orders = pgTable('orders', {
  id: text('id').primaryKey(),
  customerId: text('customer_id').notNull(),
  totalCents: integer('total_cents').notNull(),
  placedAt: timestamp('placed_at').notNull().defaultNow(),
});

/**
 * The composition root. Talks to domains through their public surfaces, and to
 * reporting directly. It holds no pool of its own — there is nothing for it to
 * import, because the privilege lives one layer down.
 */

import { createCustomer, findCustomer } from './domains/customers/index.js';
import { ordersForCustomer, placeOrder, repriceOrder } from './domains/orders/index.js';
import { revenueByCustomer } from './reports/monthly.js';

/** Onboard a customer and record their first order. */
export async function onboard(customerId: string, email: string, name: string): Promise<void> {
  await createCustomer(customerId, email, name);
  await placeOrder(`order-${customerId}`, customerId, 0);
}

/** Everything known about one customer: their record and their orders. */
export async function customerDetail(customerId: string): Promise<{ customer: unknown[]; orders: unknown[] }> {
  return {
    customer: await findCustomer(customerId),
    orders: await ordersForCustomer(customerId),
  };
}

/** Correct an order's total. Routed through the orders domain, as everything is. */
export async function correctOrderTotal(orderId: string, totalCents: number): Promise<void> {
  await repriceOrder(orderId, totalCents);
}

/** The monthly revenue report. */
export async function monthlyReport(): Promise<unknown[]> {
  return revenueByCustomer();
}

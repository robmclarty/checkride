/**
 * The composition root: the one place that may see every domain.
 *
 * Note what this file does *not* do — it doesn't let the domains see each
 * other. Billing needs a customer name for the invoice header, and rather than
 * billing importing identity, the app fetches it and passes it in. That is the
 * monolith's version of an orchestration layer, and it costs one function call
 * instead of one network hop.
 */

import { renderLine, type InvoiceLine } from './domains/billing/index.js';
import { findCustomer } from './domains/identity/index.js';

/** Render a complete invoice for one customer. */
export function renderInvoice(customerId: string, lines: readonly InvoiceLine[]): string {
  const customer = findCustomer(customerId);
  const header = customer ? `Invoice for ${customer.displayName}` : 'Invoice';
  const body = lines.map((line) => renderLine(line)).filter((rendered) => rendered !== null);

  return [header, ...body].join('\n');
}

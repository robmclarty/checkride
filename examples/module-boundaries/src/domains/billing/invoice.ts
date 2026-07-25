/**
 * Billing internals.
 *
 * Billing is allowed to read catalog (see fallow.toml), and does so through
 * catalog's public surface. Change this import to '../catalog/product.js' and
 * the `struct` check fails: allowed to depend is not the same as allowed to
 * reach inside.
 */

import { findProduct } from '../catalog/index.js';
import { formatCents } from '../../shared/index.js';

export type InvoiceLine = {
  sku: string;
  quantity: number;
};

/** Render an invoice line, or null when the SKU is not in the catalog. */
export function renderLine(line: InvoiceLine): string | null {
  const product = findProduct(line.sku);
  if (!product) return null;

  return `${line.quantity} × ${product.name} — ${formatCents(product.priceCents * line.quantity)}`;
}

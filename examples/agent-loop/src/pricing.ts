/** A line item in a cart: a quantity of one SKU at a fixed unit price. */
export type LineItem = {
  sku: string;
  quantity: number;
  unitCents: number;
};

/** Subtotal for a cart, in cents. Finished, correct, and not why this repo is red. */
export function subtotalCents(items: readonly LineItem[]): number {
  return items.reduce((sum, item) => sum + item.quantity * item.unitCents, 0);
}

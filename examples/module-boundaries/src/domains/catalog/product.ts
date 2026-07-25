/**
 * Catalog internals. Nothing outside this folder may import this file — not
 * because it is hidden, but because `rules/no-deep-sibling-import.yml` makes
 * reaching for it a build error.
 */

export type Product = {
  sku: string;
  name: string;
  priceCents: number;
};

const CATALOG: readonly Product[] = [
  { sku: 'DESK-1', name: 'Standing desk', priceCents: 89_900 },
  { sku: 'CHAIR-2', name: 'Task chair', priceCents: 34_900 },
];

/** Look up one product, or undefined when the SKU is unknown. */
export function findProduct(sku: string): Product | undefined {
  return CATALOG.find((product) => product.sku === sku);
}

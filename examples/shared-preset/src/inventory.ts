// SPDX-License-Identifier: Apache-2.0

/** A stock level for one SKU at one warehouse. */
export type StockLevel = {
  sku: string;
  warehouse: string;
  onHand: number;
};

/** Total units on hand for a SKU across every warehouse. */
export function totalOnHand(levels: readonly StockLevel[], sku: string): number {
  return levels.filter((level) => level.sku === sku).reduce((total, level) => total + level.onHand, 0);
}

import { subtotalCents, type LineItem } from './pricing.js';

/**
 * Half-finished work, of exactly the shape an agent leaves behind when it stops
 * early: a calculation started and never wired in, and a helper called but
 * never written.
 *
 * Two slots catch it, and they catch different things:
 *
 *   - `lint` (oxlint) flags `taxCents` — computed, then never used
 *   - `types` (tsc) flags `shippingCents` — it does not exist
 *
 * Fixing one leaves the pipeline red. That is the point: the exit code is the
 * verdict on the whole job, not on the last edit.
 */
export function totalCents(items: readonly LineItem[], destination: string): number {
  const taxCents = Math.round(subtotalCents(items) * 0.05);

  return subtotalCents(items) + shippingCents(destination);
}

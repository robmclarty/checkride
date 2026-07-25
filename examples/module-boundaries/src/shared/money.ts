/**
 * A leaf utility. Every domain may use it; it may import none of them —
 * enforced by the `shared` zone's empty `allow` list in fallow.toml.
 *
 * That rule is doing real work. "Shared" folders are where domains meet by
 * accident: one helper reaches into billing for a type, another into catalog
 * for a constant, and the boundary is gone without anyone deciding to remove it.
 */

/** Format an amount in cents as a display string. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

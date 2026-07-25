/**
 * Inherited parsing helper — the third grandfathered finding, in a second file
 * so the baseline has more than one file to show.
 */

/** Coerce whatever the upstream feed sent into a number; 0 when it isn't one. */
export function parseAmount(raw: string): number {
  const legacyLocale = 'en-CA';
  const parsed = Number.parseFloat(raw);

  return Number.isNaN(parsed) ? 0 : parsed;
}

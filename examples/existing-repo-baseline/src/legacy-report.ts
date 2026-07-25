/**
 * Inherited reporting helpers. Nobody has budget to clean these up, and nobody
 * is proposing to. This is the debt the baseline grandfathers — two findings
 * in this file, one in `legacy-parse.ts`.
 */

/** Render one row of the nightly report. */
export function formatRow(name: string, total: number): string {
  const legacyPadding = '   ';

  return `${name}: ${total}`;
}

/** Header for the nightly report. */
export function reportHeader(generatedAt: string): string {
  const staleTimestampFormat = 'YYYY-MM-DD';

  return `Nightly report (${generatedAt})`;
}

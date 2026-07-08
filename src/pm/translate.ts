/**
 * Exec-prefix translation.
 *
 * The adapter registry keeps its canonical `pnpm exec <tool>` form (D5); this
 * is the single seam that rewrites that prefix for whichever package manager a
 * repo actually uses. Only the `pnpm exec` prefix is translated — `pnpm audit`,
 * custom-check commands, and built-ins pass through untouched, so the default
 * pnpm run is byte-identical to before.
 */

import type { PackageManager } from './detect.js';

/** The exec command each non-pnpm PM uses in place of `pnpm exec`. */
const EXEC_COMMAND: Record<Exclude<PackageManager, 'pnpm'>, string> = {
  npm: 'npx',
  yarn: 'yarn',
  bun: 'bunx',
};

/**
 * Rewrite a canonical `pnpm exec <tool> …` invocation for `pm`. Anything that
 * is not a `pnpm exec` prefix (a `pnpm audit`, a custom check's own command, a
 * built-in) is returned unchanged, and so is every invocation under `pnpm`
 * itself — the default stays exactly as it was.
 */
export function translateExec(
  command: string,
  args: readonly string[],
  pm: PackageManager,
): { command: string; args: string[] } {
  const isExec = command === 'pnpm' && args[0] === 'exec';
  if (!isExec || pm === 'pnpm') return { command, args: [...args] };
  // Drop 'exec'; keep <tool> and its arguments, e.g. `npx oxlint --type-aware`.
  return { command: EXEC_COMMAND[pm], args: args.slice(1) };
}

/**
 * Can this adapter run under `pm`? Audit is package-manager-specific — its
 * flags and JSON shape don't port — so `pnpm audit` (the `security` slot) is
 * unavailable on a non-pnpm PM until a per-PM audit adapter lands (b5).
 * Everything else is PM-agnostic once its exec prefix is translated.
 */
export function isAvailableUnder(command: string, args: readonly string[], pm: PackageManager): boolean {
  if (command === 'pnpm' && args[0] === 'audit') return pm === 'pnpm';
  return true;
}

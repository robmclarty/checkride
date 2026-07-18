/**
 * Exec-prefix translation.
 *
 * The adapter registry keeps its canonical `pnpm exec <tool>` / `pnpm run
 * <script>` form (D5/D13); this is the single seam that rewrites that prefix for
 * whichever package manager a repo actually uses. Only the `pnpm exec` and `pnpm
 * run` prefixes are translated — `pnpm audit`, custom-check commands, and
 * built-ins pass through untouched, so the default pnpm run is byte-identical to
 * before.
 */

import type { PackageManager } from './detect.js';

/** The exec command each non-pnpm PM uses in place of `pnpm exec`. */
const EXEC_COMMAND: Record<Exclude<PackageManager, 'pnpm'>, string> = {
  npm: 'npx',
  yarn: 'yarn',
  bun: 'bunx',
};

/**
 * Rewrite a canonical `pnpm exec <tool> …` or `pnpm run <script>` invocation for
 * `pm`. Anything that is not one of those prefixes (a `pnpm audit`, a custom
 * check's own command, a built-in) is returned unchanged, and so is every
 * invocation under `pnpm` itself — the default stays exactly as it was.
 *
 * `exec` swaps the launcher and drops the keyword (`pnpm exec oxlint` → `npx
 * oxlint`); `run` keeps its keyword and only swaps the launcher, since all four
 * package managers spell it `<pm> run <script>` (`pnpm run build` → `npm run
 * build`).
 */
export function translateExec(
  command: string,
  args: readonly string[],
  pm: PackageManager,
): { command: string; args: string[] } {
  if (command !== 'pnpm' || pm === 'pnpm') return { command, args: [...args] };
  // Drop 'exec'; keep <tool> and its arguments, e.g. `npx oxlint --type-aware`.
  if (args[0] === 'exec') return { command: EXEC_COMMAND[pm], args: args.slice(1) };
  // `<pm> run <script>` is universal; only the launcher changes.
  if (args[0] === 'run') return { command: pm, args: [...args] };
  return { command, args: [...args] };
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

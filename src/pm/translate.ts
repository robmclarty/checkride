/**
 * Exec-prefix translation.
 *
 * The adapter registry keeps its canonical `pnpm exec <tool>` / `pnpm run
 * <script>` form; this is the single seam that rewrites that prefix for
 * whichever package manager a repo actually uses. Only the `pnpm exec` and `pnpm
 * run` prefixes are translated — `pnpm audit`, custom-check commands, and
 * built-ins pass through untouched. Under pnpm itself the prefix is unchanged
 * and only {@link VERIFY_DEPS_OFF} is prepended.
 */

import type { PackageManager } from './detect.js';

/** The exec command each non-pnpm PM uses in place of `pnpm exec`. */
const EXEC_COMMAND: Record<Exclude<PackageManager, 'pnpm'>, string> = {
  npm: 'npx',
  yarn: 'yarn',
  bun: 'bunx',
};

/**
 * pnpm verifies dependencies before `run`/`exec` and narrates it on **stdout** —
 * `Already up to date`, `Done in Xms using pnpm vN` — whenever no outer pnpm
 * process has already done so. That preamble lands ahead of the tool's own JSON,
 * which is why a direct `node dist/cli.js` failed `dead`/`dupes`/`health` with
 * "did not emit valid JSON" while the same gate under `pnpm run check` passed:
 * the outer pnpm had already verified, so the inner `exec` stayed quiet.
 *
 * The override is the only form that works. `--silent` and `--reporter=silent`
 * do not suppress it, the `npm_config_verify_deps_before_run` environment
 * variable is not read, and the flag must precede `exec` — after it, pnpm reads
 * it as the tool's argument and fails. Unknown config keys are accepted and
 * ignored by every pnpm in the supported range (`engines.pnpm >= 9`, verified
 * against 9, 10 and 11), so this is unconditional rather than version-gated.
 *
 * Belt and braces: `parseToolJson` tolerates a preamble anyway, because a
 * consumer's launcher is not checkride's to pin.
 */
const VERIFY_DEPS_OFF = '--config.verify-deps-before-run=false';

/**
 * Rewrite a canonical `pnpm exec <tool> …` or `pnpm run <script>` invocation for
 * `pm`. Anything that is not one of those prefixes (a `pnpm audit`, a custom
 * check's own command, a built-in) is returned unchanged, and so is every
 * invocation under `pnpm` itself — the default stays exactly as it was.
 *
 * `exec` swaps the launcher and drops the keyword (`pnpm exec oxlint` → `npx
 * oxlint`); `run` keeps its keyword and only swaps the launcher, since all four
 * package managers spell it `<pm> run <script>` (`pnpm run build` → `npm run
 * build`). Under pnpm the invocation is unchanged but for `VERIFY_DEPS_OFF`,
 * which keeps pnpm's dependency-check narration off the tool's stdout.
 */
export function translateExec(
  command: string,
  args: readonly string[],
  pm: PackageManager,
): { command: string; args: string[] } {
  if (command !== 'pnpm') return { command, args: [...args] };
  if (pm === 'pnpm') return { command, args: quieted(args) };
  // Drop 'exec'; keep <tool> and its arguments, e.g. `npx oxlint --type-aware`.
  if (args[0] === 'exec') return { command: EXEC_COMMAND[pm], args: args.slice(1) };
  // `<pm> run <script>` is universal; only the launcher changes.
  if (args[0] === 'run') return { command: pm, args: [...args] };
  return { command, args: [...args] };
}

/**
 * Prepend `VERIFY_DEPS_OFF` to the two pnpm subcommands that verify first.
 * `pnpm audit` and `pnpm pack` never do, so they are left exactly as written —
 * the flag is added where it changes something, not everywhere it is harmless.
 */
function quieted(args: readonly string[]): string[] {
  const verifies = args[0] === 'exec' || args[0] === 'run';
  return verifies ? [VERIFY_DEPS_OFF, ...args] : [...args];
}

/**
 * Can this adapter run under `pm`? Audit is package-manager-specific — its
 * flags and JSON shape don't port — so `pnpm audit` (the `security` slot) is
 * unavailable on a non-pnpm PM until a per-PM audit adapter lands. The
 * `pack` slot's built-in speaks only npm's and pnpm's `pack --dry-run --json`
 * (yarn/bun pack differently) — unavailable-until-adapter, same precedent.
 * Everything else is PM-agnostic once its exec prefix is translated.
 */
export function isAvailableUnder(command: string, args: readonly string[], pm: PackageManager): boolean {
  if (command === 'pnpm' && args[0] === 'audit') return pm === 'pnpm';
  if (command === 'pnpm' && args[0] === 'pack') return pm === 'pnpm' || pm === 'npm';
  return true;
}

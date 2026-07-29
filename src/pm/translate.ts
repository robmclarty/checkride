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

/**
 * What each non-pnpm PM uses in place of `pnpm exec`, and the flags that ride
 * along. `--no-install` is load-bearing: `npx` and `bunx` otherwise fetch a
 * missing tool from the registry and run it, and a check has no TTY to be
 * prompted through — so the gate would silently execute an unpinned `latest`.
 * `yarn` neither auto-installs nor accepts the flag.
 */
const EXEC: Record<Exclude<PackageManager, 'pnpm'>, { command: string; flags: readonly string[] }> = {
  npm: { command: 'npx', flags: ['--no-install'] },
  yarn: { command: 'yarn', flags: [] },
  bun: { command: 'bunx', flags: ['--no-install'] },
};

/**
 * Keeps pnpm's dependency-check narration (`Already up to date`) off **stdout**,
 * where it would land in front of a tool's JSON and make it unparseable.
 *
 * This exact spelling, in this position, is the only form that works — not
 * `--silent`, not the environment variable, and not after `exec`. Applied to
 * every supported pnpm rather than version-gated. The full account, including
 * the failure that found it, is in `docs/tools.md` §Launcher quirks; read it
 * before touching this line.
 */
const VERIFY_DEPS_OFF = '--config.verify-deps-before-run=false';

/**
 * Rewrite a canonical `pnpm exec <tool> …` or `pnpm run <script>` invocation for
 * `pm`. Anything that is not one of those prefixes (a `pnpm audit`, a custom
 * check's own command, a built-in) is returned unchanged, and so is every
 * invocation under `pnpm` itself — the default stays exactly as it was.
 *
 * `exec` swaps the launcher, drops the keyword, and prepends the launcher's own
 * flags (`pnpm exec oxlint` → `npx --no-install oxlint`); `run` keeps its
 * keyword and only swaps the launcher, since all four package managers spell it
 * `<pm> run <script>` (`pnpm run build` → `npm run build`). Under pnpm the
 * invocation is unchanged but for `VERIFY_DEPS_OFF`, which keeps pnpm's
 * dependency-check narration off the tool's stdout.
 */
export function translateExec(
  command: string,
  args: readonly string[],
  pm: PackageManager,
): { command: string; args: string[] } {
  if (command !== 'pnpm') return { command, args: [...args] };
  if (pm === 'pnpm') return { command, args: quieted(args) };
  // Drop 'exec'; keep <tool> and its arguments, e.g. `npx --no-install oxlint --type-aware`.
  if (args[0] === 'exec') return { command: EXEC[pm].command, args: [...EXEC[pm].flags, ...args.slice(1)] };
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

/**
 * Built-in `pack` check (ported from the interim `scripts/check-publish.mjs`
 * pack arm).
 *
 * Runs the detected package manager's tarball dry-run (`<pm> pack --dry-run
 * --json`, lifecycle scripts suppressed) and inspects the file list the way a
 * publish would ship it:
 *
 *   - every path the manifest promises (`exports`/`main`/`types`/`bin` targets,
 *     plus `README.md`) must be present — a miss means the package resolves to a
 *     file the tarball never included (D10);
 *   - no path may match the fixed deny list (TypeScript source, tests, `src/`,
 *     `docs/`, `scripts/`, `.check/` and kin), with a carve-out for `dist`
 *     declaration files (`*.d.{ts,mts,cts}` and their maps) which are legitimate
 *     shipped artifacts (Q8).
 *
 * The pack subprocess is spawned through the orchestrator's registering spawner
 * (injected as `spawn`), so its child joins `liveChecks` and inherits the
 * per-check timeout + SIGTERM→SIGKILL reaping like every other check (D16/C6).
 *
 * Returns a result the orchestrator persists to `.check/pack.json`:
 *   stdout `{ ok: true, files: [...] }`                        on success (exit 0)
 *   stdout `{ ok: false, missing: [...], forbidden: [...] }`   on a content miss (exit 1)
 *   stdout `{ ok: false, error, ... }`                         when pack itself failed or emitted malformed output (exit 1)
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CheckOutcome } from './links.js';
import type { PackageManager } from './pm/index.js';

/** A forbidden path in the tarball, tagged with the deny pattern it matched. */
type Forbidden = { path: string; pattern: string };

/** The pack subprocess spawner — same signature as the orchestrator's `spawnCheck`. */
export type PackSpawn = (
  command: string,
  args: string[],
  cwd: string,
  timeoutSec?: number,
) => Promise<CheckOutcome>;

/**
 * The pack invocation for `pm`, or `null` when the PM has no supported
 * `pack --dry-run --json` form (yarn/bun — unavailable-until-adapter, mirroring
 * the pnpm-only `security` slot; D10). Both supported managers emit npm's
 * `files[].path` shape (confirmed by the step-5 spike), and both must have
 * lifecycle scripts suppressed so a `"prepack": "<build>"` can't rewrite `dist/`
 * mid-wave-20 under smoke/snippets-dist (Q7) — npm spells that `--ignore-scripts`,
 * pnpm rejects that flag and spells it `--config.ignore-scripts=true`.
 */
export function packInvocation(pm: PackageManager): { command: string; args: string[] } | null {
  const base = ['pack', '--dry-run', '--json'];
  if (pm === 'npm') return { command: 'npm', args: [...base, '--ignore-scripts'] };
  if (pm === 'pnpm') return { command: 'pnpm', args: [...base, '--config.ignore-scripts=true'] };
  return null;
}

/** Strip a leading `./` so manifest targets and pack paths compare on equal footing. */
function normalize(target: string): string {
  return target.startsWith('./') ? target.slice(2) : target;
}

/**
 * Collect every concrete file target reachable from an `exports` value: recurse
 * through condition/subpath objects and gather the string leaves. Relative
 * (`./…`) targets only — bare condition strings like `"default"` are keys, never
 * values here — and wildcard entries (`./dist/*.js`) and `null` (a blocked
 * subpath) are skipped, since neither names a single required file.
 */
function collectExportTargets(node: unknown, acc: Set<string>): void {
  if (typeof node === 'string') {
    if (node.startsWith('./') && !node.includes('*')) acc.add(normalize(node));
    return;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectExportTargets(value, acc);
  }
}

/** Add a single string field (`main`/`types`/`typings`) if it names a concrete file. */
function addField(value: unknown, acc: Set<string>): void {
  if (typeof value === 'string' && value && !value.includes('*')) acc.add(normalize(value));
}

/**
 * The set of paths the tarball must contain, derived from the manifest (D10):
 * resolved `exports` targets, `main`, `types`/`typings`, `bin` targets — plus
 * `README.md`, which every publish is expected to ship.
 */
export function deriveRequired(manifest: Record<string, unknown>): Set<string> {
  const required = new Set<string>();
  collectExportTargets(manifest['exports'], required);
  addField(manifest['main'], required);
  addField(manifest['types'], required);
  addField(manifest['typings'], required);
  const bin = manifest['bin'];
  if (typeof bin === 'string') addField(bin, required);
  else if (bin && typeof bin === 'object') {
    for (const value of Object.values(bin)) addField(value, required);
  }
  required.add('README.md');
  return required;
}

/**
 * Fixed deny list (D10): paths that must never ship. A `dist` declaration file
 * is exempt (`isDistDeclaration` — the Q8 carve-out is applied before these), so
 * `\.ts$` here only ever bites real `.ts` source outside `dist`.
 */
const DENY: readonly { re: RegExp; label: string }[] = [
  { re: /\.ts$/, label: 'TypeScript source' },
  { re: /\.test\./, label: 'test file' },
  { re: /(^|\/)src(\/|$)/, label: 'src/' },
  { re: /(^|\/)test(\/|$)/, label: 'test/' },
  { re: /(^|\/)docs(\/|$)/, label: 'docs/' },
  { re: /(^|\/)scripts(\/|$)/, label: 'scripts/' },
  { re: /(^|\/)\.check(\/|$)/, label: '.check/' },
  { re: /(^|\/)\.stryker-tmp(\/|$)/, label: '.stryker-tmp/' },
];

/**
 * A `dist` declaration artifact — `dist/**​/*.d.{ts,mts,cts}` and their source
 * maps. These legitimately ship, so they are exempt from the deny list even
 * though `dist/index.d.ts` matches `\.ts$` (Q8).
 */
function isDistDeclaration(path: string): boolean {
  return /^dist\/.*\.d\.(ts|mts|cts)(\.map)?$/.test(path);
}

/**
 * Diff the packed file list against the required set and deny list. A required
 * path always wins over the deny list (you can't forbid a file you also
 * require), and a `dist` declaration is exempt via the carve-out.
 */
export function evaluatePack(
  filePaths: readonly string[],
  required: ReadonlySet<string>,
): { missing: string[]; forbidden: Forbidden[] } {
  const present = new Set(filePaths);
  const missing = [...required].filter((path) => !present.has(path));

  const forbidden: Forbidden[] = [];
  for (const path of filePaths) {
    if (required.has(path)) continue;
    if (isDistDeclaration(path)) continue;
    const rule = DENY.find((d) => d.re.test(path));
    if (rule) forbidden.push({ path, pattern: rule.re.source });
  }
  return { missing, forbidden };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read `obj[key]` off an unknown value without an unsafe assertion. */
function prop(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** Parse the `files[].path` array out of a `pack --dry-run --json` payload. */
function parsePackFiles(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = prop(entry, 'files');
  if (!Array.isArray(files)) throw new Error('pack output missing a `files` array');
  return files.map((f) => {
    const path = prop(f, 'path');
    return typeof path === 'string' ? path : '';
  });
}

function fail(stdout: string, stderr: string): CheckOutcome {
  return { ok: false, exit_code: 1, stdout, stderr };
}

/**
 * Run the `pack` check against `cwd`. Reads the manifest to derive the required
 * set, spawns the PM's pack dry-run through the injected `spawn`, then diffs the
 * tarball's file list. Never throws: a missing/unreadable manifest, a failed
 * pack subprocess, or malformed output all resolve to a failing outcome.
 */
export async function checkPack(opts: {
  cwd: string;
  pm: PackageManager;
  spawn: PackSpawn;
  timeoutSec?: number;
}): Promise<CheckOutcome> {
  const { cwd, pm, spawn, timeoutSec } = opts;

  const invocation = packInvocation(pm);
  if (!invocation) {
    // Availability is gated upstream (`isAvailableUnder`); this is a defensive guard.
    return fail(
      `${JSON.stringify({ ok: false, error: `pack is unavailable under ${pm}` }, null, 2)}\n`,
      `check-pack: pack --dry-run is unsupported under ${pm}\n`,
    );
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    if (!isRecord(parsed)) throw new Error('package.json is not an object');
    manifest = parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(
      `${JSON.stringify({ ok: false, error: `could not read package.json: ${message}` }, null, 2)}\n`,
      `check-pack: could not read package.json: ${message}\n`,
    );
  }

  const outcome = await spawn(invocation.command, invocation.args, cwd, timeoutSec);
  if (outcome.exit_code !== 0) {
    const detail = outcome.stderr.trim() || outcome.stdout.trim();
    return fail(
      `${JSON.stringify({ ok: false, error: `${invocation.command} pack --dry-run exited ${outcome.exit_code}` }, null, 2)}\n`,
      `check-pack: ${invocation.command} pack --dry-run exited ${outcome.exit_code}${detail ? `\n${detail}` : ''}\n`,
    );
  }

  let filePaths: string[];
  try {
    filePaths = parsePackFiles(outcome.stdout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(
      `${JSON.stringify({ ok: false, error: `pack JSON parse failed: ${message}` }, null, 2)}\n`,
      `check-pack: pack JSON parse failed: ${message}\n${outcome.stdout.slice(0, 500)}\n`,
    );
  }

  const { missing, forbidden } = evaluatePack(filePaths, deriveRequired(manifest));

  if (missing.length === 0 && forbidden.length === 0) {
    return {
      ok: true,
      exit_code: 0,
      stdout: `${JSON.stringify({ ok: true, files: filePaths }, null, 2)}\n`,
      stderr: `check-pack: ${filePaths.length} file(s) ship; required set present, no forbidden paths\n`,
    };
  }

  const lines: string[] = [];
  for (const path of missing) lines.push(`check-pack: missing required file: ${path}`);
  for (const f of forbidden) lines.push(`check-pack: forbidden path ${f.path} (matched /${f.pattern}/)`);
  return fail(
    `${JSON.stringify({ ok: false, missing, forbidden }, null, 2)}\n`,
    `${lines.join('\n')}\n`,
  );
}

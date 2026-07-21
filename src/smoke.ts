/**
 * Built-in `smoke` check — a **liveness** probe of the built package, not a
 * type check (runtime *shapes* stay attw's job; the slots don't overlap).
 *
 * It enumerates the manifest's `exports` subpaths (falling back to `main`),
 * writes a self-contained probe script under `.check/`, and spawns a fresh
 * `node` on it (never in-process — isolation, the per-check timeout, and the
 * orchestrator's SIGTERM→SIGKILL reaping all apply). The probe asserts,
 * for every literal subpath:
 *
 *   - the built entry `await import()`s without throwing, and (for a dual
 *     package, i.e. a subpath carrying an explicit `require` condition) also
 *     `require()`s cleanly — both through package **self-reference**
 *     (`import '<pkg>/<subpath>'`), exercising the real `exports`-map resolution
 *     a consumer would hit;
 *   - every **value** export named in the matching dist `.d.ts` is present at
 *     runtime. Export names come from a conservative, dependency-free `.d.ts`
 *     scanner ({@link scanValueExports}) that errs toward *under*-collection: a
 *     missed name is only a weaker assertion, never a false failure.
 *
 * Wildcard (`./*`), `null` (blocked), and `.json` data subpaths (notably the
 * near-universal `"./package.json"` export) carry no runtime module to probe, so
 * they are skipped and counted in the JSON output. A missing built artifact is
 * caught before spawning and reported with a "did `build` run?" hint.
 *
 * Returns a result the orchestrator persists to `.check/smoke.json`:
 *   stdout `{ ok: true,  results: [...], skipped: [...] }`   on success (exit 0)
 *   stdout `{ ok: false, results: [...], skipped: [...] }`   on an import/export miss (exit 1)
 *   stdout `{ ok: false, error, ... }`                       on a setup failure (bad manifest, missing dist, crashed probe)
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CheckOutcome } from './links.js';

/** The smoke probe spawner — same signature as the orchestrator's `spawnCheck`. */
export type SmokeSpawn = (
  command: string,
  args: string[],
  cwd: string,
  timeoutSec?: number,
) => Promise<CheckOutcome>;

/** A subpath skipped during enumeration, tagged with why it carries no required file. */
export type SmokeSkip = { subpath: string; reason: string };

/**
 * One enumerated `exports` subpath (or the `main` fallback). File paths are
 * manifest-relative with any leading `./` stripped, for on-disk existence and
 * `.d.ts` scanning; `specifier` is the package self-reference used by the probe
 * — `null` in `main`-fallback mode (no `exports` to self-resolve; the probe
 * imports the concrete file instead), or when the manifest has no `name`.
 */
export type SmokeTarget = {
  subpath: string;
  specifier: string | null;
  importFile: string | null;
  requireFile: string | null;
  typesFile: string | null;
  hasRequire: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read `obj[key]` as a non-empty string, else null. */
function strField(manifest: Record<string, unknown>, key: string): string | null {
  const value = manifest[key];
  return typeof value === 'string' && value ? value : null;
}

/** Strip a leading `./` so manifest targets compare/resolve on equal footing. */
function normalize(target: string): string {
  return target.startsWith('./') ? target.slice(2) : target;
}

function normalizeMaybe(target: string | null): string | null {
  return target === null ? null : normalize(target);
}

/**
 * Resolve a conditional `exports` value to its first string leaf, stepping only
 * through the named conditions (in priority order) and recursing into nested
 * condition objects. A bare string is unconditional and returns as-is; an
 * unrecognized shape returns null (skipped — conservative on exotic maps).
 */
function resolveConditional(node: unknown, conditions: readonly string[]): string | null {
  if (typeof node === 'string') return node;
  if (!isRecord(node)) return null;
  for (const cond of conditions) {
    if (cond in node) {
      const resolved = resolveConditional(node[cond], conditions);
      if (resolved !== null) return resolved;
    }
  }
  return null;
}

/**
 * Normalize the `exports` field to `[subpath, value]` entries. A subpath map
 * has keys starting with `.`; a bare string or a conditions-only object (no
 * `.`-keys) is the sugar for the `.` subpath.
 */
function exportEntries(exportsField: unknown): [string, unknown][] {
  if (typeof exportsField === 'string') return [['.', exportsField]];
  if (isRecord(exportsField)) {
    const keys = Object.keys(exportsField);
    if (keys.some((key) => key.startsWith('.'))) return keys.map((key) => [key, exportsField[key]]);
    return [['.', exportsField]];
  }
  return [];
}

/** The `.d.ts` target for a subpath: its `types` condition, or the top-level `types`/`typings` for `.`. */
function resolveTypesFile(value: unknown, manifest: Record<string, unknown>, subpath: string): string | null {
  const conditioned = isRecord(value) ? normalizeMaybe(resolveConditional(value, ['types', 'typings'])) : null;
  if (conditioned !== null) return conditioned;
  if (subpath === '.') return normalizeMaybe(strField(manifest, 'types') ?? strField(manifest, 'typings'));
  return null;
}

/**
 * The explicit `require`-condition target, or null. A dual package carries a
 * `require` condition; a bare-string target is single-format and must NOT be
 * require-probed (requiring an ESM file would throw — a false failure).
 */
function resolveRequireFile(value: unknown): string | null {
  const requireNode = isRecord(value) ? value['require'] : undefined;
  if (requireNode === undefined) return null;
  return normalizeMaybe(resolveConditional(requireNode, ['import', 'module', 'default', 'require']));
}

/** Turn one `exports` entry into a target to probe, or a skip with its reason. */
function entryToTarget(
  subpath: string,
  value: unknown,
  name: string | null,
  manifest: Record<string, unknown>,
): { target: SmokeTarget } | { skip: SmokeSkip } {
  if (subpath.includes('*')) return { skip: { subpath, reason: 'wildcard subpath' } };
  if (value === null) return { skip: { subpath, reason: 'null (blocked) subpath' } };
  const importFile = normalizeMaybe(resolveConditional(value, ['import', 'module', 'default']));
  if (importFile?.includes('*')) return { skip: { subpath, reason: 'wildcard target' } };
  const requireFile = resolveRequireFile(value);
  // A `.json` subpath — the near-universal `"./package.json": "./package.json"`,
  // plus any other data export — is not a runtime module: `import()`ing it needs
  // an `with { type: 'json' }` attribute the probe can't supply, and it carries
  // no value exports to assert. Skip it like a wildcard/null subpath.
  const probeTarget = importFile ?? requireFile;
  if (probeTarget?.endsWith('.json')) {
    return { skip: { subpath, reason: 'json data subpath' } };
  }
  const specifier = name === null ? null : subpath === '.' ? name : name + subpath.slice(1);
  return {
    target: {
      subpath,
      specifier,
      importFile,
      requireFile,
      typesFile: resolveTypesFile(value, manifest, subpath),
      hasRequire: requireFile !== null,
    },
  };
}

/** The single `main`-fallback target when a manifest has no `exports` field, or null when it has no `main`. */
function mainTarget(manifest: Record<string, unknown>): SmokeTarget | null {
  const main = strField(manifest, 'main');
  if (main === null) return null;
  const typesFile = normalizeMaybe(strField(manifest, 'types') ?? strField(manifest, 'typings'));
  return { subpath: '.', specifier: null, importFile: normalize(main), requireFile: null, typesFile, hasRequire: false };
}

/**
 * Enumerate the smoke targets from a manifest: every literal `exports`
 * subpath, or the `main` entry when there is no `exports` field. Wildcard and
 * `null` subpaths are skipped with a reason (they name no single file). The
 * self-reference `specifier` is derived from the package `name`.
 */
export function enumerateExports(manifest: Record<string, unknown>): {
  targets: SmokeTarget[];
  skipped: SmokeSkip[];
} {
  const exportsField = manifest['exports'];
  if (exportsField === undefined || exportsField === null) {
    const main = mainTarget(manifest);
    return { targets: main ? [main] : [], skipped: [] };
  }

  const name = strField(manifest, 'name');
  const targets: SmokeTarget[] = [];
  const skipped: SmokeSkip[] = [];
  for (const [subpath, value] of exportEntries(exportsField)) {
    const result = entryToTarget(subpath, value, name, manifest);
    if ('skip' in result) skipped.push(result.skip);
    else targets.push(result.target);
  }
  return { targets, skipped };
}

/**
 * Strip comments so an `export` inside a JSDoc block or `//` line can't be
 * mistaken for a real declaration. Block comments first (they can span lines),
 * then line comments.
 */
function stripComments(dts: string): string {
  return dts.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Only top-level (column-0) `export` declarations — never one nested inside a
 * `declare namespace { … }`, which is indented in `.d.ts` emit. `function`,
 * `const`, `class`, `enum` (optionally `abstract` for a class); the negative
 * lookahead drops `const enum` (a const enum has no runtime object).
 */
const DECL_RE = /^export\s+declare\s+(?:abstract\s+)?(?:function|const|class|enum)\s+(?!enum\b)([A-Za-z_$][\w$]*)/gm;

/** A top-level `export { … }` block (optionally `export type { … }`, which is type-only). */
const NAMED_RE = /^export\s+(type\s+)?\{([^}]*)\}/gm;

/**
 * The runtime name a single `export { … }` specifier binds, or null when it is
 * type-only (`type X`) or not a plain identifier. An alias (`foo as bar`)
 * resolves to the exported name (`bar`).
 */
function namedExportBinding(spec: string): string | null {
  const trimmed = spec.trim();
  if (trimmed === '' || /^type\s/.test(trimmed)) return null;
  const aliased = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
  const exported = aliased ? aliased[1] : trimmed;
  return exported !== undefined && /^[A-Za-z_$][\w$]*$/.test(exported) ? exported : null;
}

/**
 * Scan a dist `.d.ts` for the **value** exports a live module must expose:
 * `export declare function|const|class|enum` and the non-`type` specifiers of
 * `export { … }` (aliases resolve to the exported name). Type-only forms —
 * `export type`, `export interface`, `export type { … }`, and `{ type X }`
 * specifiers — are excluded, as are `const enum`s and anything nested in a
 * namespace. Conservative by design: it under-collects on exotic shapes rather
 * than assert a name that isn't a runtime value.
 */
export function scanValueExports(dts: string): string[] {
  const source = stripComments(dts);
  const names = new Set<string>();

  for (const match of source.matchAll(DECL_RE)) {
    if (match[1]) names.add(match[1]);
  }

  for (const match of source.matchAll(NAMED_RE)) {
    if (match[1]) continue; // `export type { … }` — the whole block is type-only.
    for (const spec of (match[2] ?? '').split(',')) {
      const binding = namedExportBinding(spec);
      if (binding !== null) names.add(binding);
    }
  }

  return [...names].toSorted();
}

/** One probe plan entry, embedded verbatim into the generated probe script. */
type ProbeEntry = { subpath: string; importArg: string; requireArg: string | null; expected: string[] };

/**
 * The generated probe's fixed body (see {@link checkSmoke}). String-concatenated
 * — no template literals — so it survives being emitted from inside one. Runs as
 * ESM (`.mjs`) for top-level `await import()`; `createRequire` covers the
 * `require` condition of a dual package in the same process.
 */
const PROBE_BODY = [
  "import { createRequire } from 'node:module';",
  'const require = createRequire(import.meta.url);',
  'const results = [];',
  'for (const t of TARGETS) {',
  '  const r = { subpath: t.subpath, ok: true, errors: [] };',
  '  let mod = null;',
  '  try { mod = await import(t.importArg); }',
  "  catch (err) { r.ok = false; r.errors.push('import failed: ' + (err && err.message ? err.message : String(err))); }",
  '  if (mod) {',
  '    const missing = t.expected.filter((n) => !(n in mod));',
  "    if (missing.length) { r.ok = false; r.errors.push('missing value export(s): ' + missing.join(', ')); }",
  '  }',
  '  if (t.requireArg) {',
  '    try {',
  '      const cjs = require(t.requireArg);',
  "      const obj = cjs && (typeof cjs === 'object' || typeof cjs === 'function') ? cjs : {};",
  '      const missing = t.expected.filter((n) => !(n in obj));',
  "      if (missing.length) { r.ok = false; r.errors.push('missing value export(s) via require: ' + missing.join(', ')); }",
  "    } catch (err) { r.ok = false; r.errors.push('require failed: ' + (err && err.message ? err.message : String(err))); }",
  '  }',
  '  results.push(r);',
  '}',
  'const ok = results.every((r) => r.ok);',
  "process.stdout.write(JSON.stringify({ ok, results }) + '\\n');",
  'if (!ok) {',
  "  for (const r of results) for (const e of r.errors) process.stderr.write('smoke: ' + r.subpath + ': ' + e + '\\n');",
  '  process.exit(1);',
  '}',
  '',
].join('\n');

function errorOutcome(error: string, stderrDetail?: string): CheckOutcome {
  return {
    ok: false,
    exit_code: 1,
    stdout: `${JSON.stringify({ ok: false, error }, null, 2)}\n`,
    stderr: `check-smoke: ${stderrDetail ?? error}\n`,
  };
}

/** Read and parse the manifest; a missing/unreadable/non-object file is a setup failure. */
async function readManifest(
  cwd: string,
): Promise<{ ok: true; manifest: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    if (!isRecord(parsed)) return { ok: false, error: 'package.json is not an object' };
    return { ok: true, manifest: parsed };
  } catch (err) {
    return { ok: false, error: `could not read package.json: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Build one probe entry for a target, reading its `.d.ts` for expected value names. */
async function planTarget(cwd: string, target: SmokeTarget): Promise<ProbeEntry> {
  const importArg =
    target.specifier ?? (target.importFile !== null ? pathToFileURL(join(cwd, target.importFile)).href : '');
  const requireArg = target.specifier !== null && target.hasRequire ? target.specifier : null;
  let expected: string[] = [];
  if (target.typesFile !== null && existsSync(join(cwd, target.typesFile))) {
    expected = scanValueExports(await readFile(join(cwd, target.typesFile), 'utf8'));
  }
  return { subpath: target.subpath, importArg, requireArg, expected };
}

/**
 * Run the `smoke` check against `cwd`. Reads the manifest, enumerates its
 * targets, verifies the built artifacts exist (a miss is reported with a "did
 * build run?" hint before anything is spawned), then writes and runs the probe
 * through the injected `spawn`. Never throws: every setup failure resolves to a
 * failing outcome.
 */
export async function checkSmoke(opts: {
  cwd: string;
  spawn: SmokeSpawn;
  timeoutSec?: number;
}): Promise<CheckOutcome> {
  const { cwd, spawn, timeoutSec } = opts;

  const read = await readManifest(cwd);
  if (!read.ok) return errorOutcome(read.error);

  const { targets, skipped } = enumerateExports(read.manifest);
  if (targets.length === 0) {
    return errorOutcome(
      'no exports/main entry to smoke-test',
      'no `exports` subpaths or `main` to import — nothing to smoke-test',
    );
  }

  // A required built entry that isn't on disk means the artifact checks are
  // running before a build produced `dist/` — the most common smoke failure.
  // Catch it here with a friendly hint rather than a raw import error.
  const missingDist = targets
    .filter((t) => t.importFile !== null && !existsSync(join(cwd, t.importFile)))
    .map((t) => t.importFile ?? '');
  if (missingDist.length > 0) {
    return errorOutcome(
      `built artifact(s) not found: ${missingDist.join(', ')}`,
      `built artifact(s) not found: ${missingDist.join(', ')} — did \`build\` run?`,
    );
  }

  const plan = await Promise.all(targets.map((t) => planTarget(cwd, t)));

  await mkdir(join(cwd, '.check'), { recursive: true });
  const probePath = join(cwd, '.check', 'smoke-probe.mjs');
  await writeFile(probePath, `const TARGETS = ${JSON.stringify(plan)};\n${PROBE_BODY}`);

  const outcome = await spawn('node', [probePath], cwd, timeoutSec);

  let payload: unknown = null;
  try {
    payload = JSON.parse(outcome.stdout);
  } catch {
    // Probe crashed before printing valid JSON — handled below.
  }

  if (isRecord(payload) && typeof payload['ok'] === 'boolean') {
    const results = payload['results'];
    const merged = `${JSON.stringify({ ok: payload['ok'], results, skipped }, null, 2)}\n`;
    if (payload['ok']) {
      return {
        ok: true,
        exit_code: 0,
        stdout: merged,
        stderr: `check-smoke: ${plan.length} subpath(s) imported cleanly, all scanned value exports present\n`,
      };
    }
    return { ok: false, exit_code: 1, stdout: merged, stderr: outcome.stderr || 'check-smoke: one or more subpaths failed\n' };
  }

  // No parseable verdict: the probe process itself failed (crash, timeout, spawn error).
  const detail = outcome.stderr.trim() || outcome.stdout.trim();
  return errorOutcome(
    `smoke probe failed (exit ${outcome.exit_code})`,
    `smoke probe failed (exit ${outcome.exit_code})${detail ? `\n${detail}` : ''}`,
  );
}

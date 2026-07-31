/**
 * `checkride init` — set up a project (new or existing, auto-detected).
 *
 * New-project mode generates a complete, green-out-of-the-box repo for one of
 * three shapes (flat / monorepo / hybrid); the shapes differ only in
 * tsconfig.json, fallow.toml, and pnpm-workspace.yaml. Existing-project mode is
 * additive: it inventories detectable tools, writes only what is missing
 * (checkride.config.json, the AGENTS stanza, the `check` alias) and never
 * touches an existing tool config.
 *
 * Generation, not transformation: every file is written once; the project owns
 * it afterward.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Adapter, Slot } from './adapters.js';
import { ADAPTERS, SLOTS } from './adapters.js';
import type { DocInput } from './snippets.js';
import { planSnippets, selectDocFiles } from './snippets.js';
import type { HookFile, HookName } from './agent-setup/index.js';
import { detectHarnesses, writeCursorSkills, writeHooks } from './agent-setup/index.js';
import type { HarnessName } from './gate.js';
import { BASELINE_FILE, isFingerprintable } from './baseline/index.js';
import { runBaseline } from './baseline-command.js';
import { configSchemaUrl, loadConfig, resolveChecks } from './config.js';
import type { Out } from './orchestrator.js';
import { runChecks, selectChecks } from './orchestrator.js';
import { detectPackageManager } from './pm/index.js';

export type Shape = 'flat' | 'monorepo' | 'hybrid';

export type InitOptions = {
  cwd?: string;
  shape?: Shape;
  name?: string;
  scope?: string | null;
  license?: string;
  author?: string | null;
  dryRun?: boolean;
  add?: string[] | null;
  checkrideSpec?: string;
  /**
   * Overwrite instead of refusing. Without it, `init` refuses (exit 2) rather
   * than clobber any file new mode would scaffold, or an AGENTS.md stanza
   * existing mode would refresh that carries local edits. Existing mode is
   * otherwise additive-only, so the flag reaches nothing else there.
   */
  force?: boolean;
  /**
   * Write the agent stop-gate hooks into each selected harness's config.
   * Opt-out: defaults to on; `--no-hook` sets it `false`.
   */
  hook?: boolean;
  /** Which hooks to write (`--hook <a,b>`). Omitted → all of them. */
  hooks?: readonly HookName[];
  /**
   * Hooks to tear out of an already-wired repo (`--remove-hook <a,b>`): the
   * config entry is stripped and the generated script deleted. Composes with
   * `hook: false` to remove without refreshing anything else.
   */
  removeHooks?: readonly HookName[];
  /** Which harnesses to write them for (`--harness <a,b>`). Omitted → detected. */
  harnesses?: readonly HarnessName[];
  stdout?: Out;
  slots?: readonly Slot[];
  adapters?: readonly Adapter[];
  /** Existing mode: returns the adopted slots whose check currently fails. */
  probeFailures?: (slots: string[], cwd: string) => Promise<string[]>;
  /**
   * Existing mode: grandfather current debt into `checkride.baseline.json`
   * instead of disabling failing slots (`--baseline`). A failing
   * fingerprintable slot stays enabled and is masked by the baseline; a failing
   * slot with no extractor still falls back to a `false` disable.
   */
  baseline?: boolean;
  /** Existing mode + `--baseline`: capture the committed baseline (injectable). */
  captureBaseline?: (cwd: string) => Promise<void>;
};

export type InitResult = {
  mode: 'new' | 'existing';
  shape: Shape | null;
  written: string[];
  /** Files deleted by `--remove-hook`. */
  removed: string[];
  skipped: string[];
  disabled: string[];
  /** Slots whose failing debt was grandfathered into the baseline (`--baseline`). */
  grandfathered: string[];
  exitCode: number;
};

const NULL_OUT: Out = { write: () => true };

/** Run the adopted checks once; a failing (non-skipped) check marks its slot. */
async function defaultProbe(slots: string[], cwd: string): Promise<string[]> {
  if (slots.length === 0) return [];
  const { summary } = await runChecks({ cwd, only: slots, json: true, stdout: NULL_OUT, stderr: NULL_OUT });
  return summary.checks.filter((c) => !c.ok && c.skipped !== true).map((c) => c.name);
}

export type InventoryEntry = { slot: string; status: 'adopted' | 'empty'; adapter: string | null };

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(HERE, '..', 'templates');

const STANZA_BEGIN_PREFIX = '<!-- checkride:begin';
const STANZA_END = '<!-- checkride:end -->';
/** The block, capturing its stamp (absent on stanzas written before v0.11.0) and its body. */
const STANZA_RE = /<!-- checkride:begin(?: hash=([0-9a-z]+))? -->([\s\S]*?)<!-- checkride:end -->/;
const STANZA_BEGIN_RE = /<!-- checkride:begin(?: hash=[0-9a-z]+)? -->/;

// ----------------------------------------------------------------------------
// AGENTS.md stanza (gate: idempotent)
// ----------------------------------------------------------------------------

/**
 * Compare two stanza bodies the way a reader would: line endings and trailing
 * whitespace are not edits. Deliberately minimal — one checkride version stamps
 * a block and a later one verifies that stamp, so every rule here has to keep
 * holding across versions or a pristine stanza starts reading as an edited one.
 */
function normalizeStanza(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

/**
 * The stamp written into the begin marker: a digest of the body checkride
 * generated. A later run recomputes it from what is on disk — a match means the
 * block is still checkride's own output and is safe to refresh; a mismatch means
 * someone edited it and refreshing would destroy their work.
 *
 * The `v1` prefix earns its place twice: it dates the normalization rules above
 * (change them and bump it, so old stamps read as unverifiable rather than
 * edited), and it guarantees the token contains a digit. cspell ignores words
 * with digits, so a digest that happened to come up all `a`-`f` cannot fail the
 * `spell` check of the repo checkride wrote it into.
 */
function stanzaStamp(body: string): string {
  return `v1${createHash('sha256').update(normalizeStanza(body)).digest('hex').slice(0, 16)}`;
}

/**
 * How the stanza on disk relates to the one checkride would write:
 *
 * - `absent` — no stanza yet; writing one takes nothing away.
 * - `pristine` — checkride's own output, untouched; refreshing it is lossless.
 * - `edited` — stamped, but the body no longer matches its stamp: a human or an
 *   agent customized it, and a blind refresh would silently discard that.
 * - `unstamped` — written before checkride stamped stanzas, and not identical to
 *   today's. An older version's wording and a customization are indistinguishable
 *   here, so it gets the same protection as `edited` — once.
 */
export type StanzaState = 'absent' | 'pristine' | 'edited' | 'unstamped';

/** Classify the stanza in `content` against the `body` checkride would write. */
export function inspectStanza(content: string, body: string): StanzaState {
  const match = STANZA_RE.exec(content);
  if (!match) {
    // A begin marker with no end is a stanza someone edited badly, not an absent
    // one: appending a second block would be the same data loss in another form.
    return content.includes(STANZA_BEGIN_PREFIX) ? 'edited' : 'absent';
  }
  const [, stamp, found = ''] = match;
  if (stamp === undefined) {
    return normalizeStanza(found) === normalizeStanza(body) ? 'pristine' : 'unstamped';
  }
  return stamp === stanzaStamp(found) ? 'pristine' : 'edited';
}

/** The agent-facing contract block, parameterized by the active checks. */
export function buildStanza(activeSlots: readonly string[]): string {
  return [
    '## Checkride: the definition of done',
    '',
    '`pnpm check` is the single source of truth for "done". Exit 0 means the work is',
    'complete; any other exit code means it is not. Never claim a task is finished while',
    '`pnpm check` is red.',
    '',
    'When it fails:',
    '',
    '1. Read `.check/summary.json` to see which check failed.',
    "2. Read that check's raw output (`.check/<slot>.json` or `.check/<slot>.stdout.txt`).",
    '3. Fix the root cause, then re-run.',
    '',
    '`pnpm exec checkride triage` runs this procedure in full and reads `.check/` for you',
    '(`/checkride:check` and `/checkride-check` are the same thing as a skill).',
    '',
    'Tight feedback loops: `pnpm check --bail`, `pnpm check --only types,lint`, and',
    '`pnpm check --changed`.',
    '',
    'If a stop-gate hook is configured (`.claude/settings.json` or `.cursor/hooks.json`),',
    'it runs the full `pnpm check` as the final gate — so while iterating, prefer the narrow',
    'commands above and let the hook run the authoritative pipeline once at the end rather',
    'than running the full check yourself every loop.',
    '',
    '### Baseline',
    '',
    'If `checkride.baseline.json` is present, checkride grandfathers the diagnostics it',
    'lists: a slot is green as long as only baselined findings remain, while a genuinely',
    'new diagnostic still fails it. Fixing a baselined finding prunes it from the file —',
    'the ratchet, so the baseline only ever shrinks. Never add to the baseline to make a',
    'check pass; fix the finding.',
    '',
    '### Module boundaries',
    '',
    'A module is a unit of encapsulation. A single file is a module; promote it to a',
    'folder with a barrel `index.ts` when it grows internals worth hiding. A folder',
    "module's `index.ts` is its only public surface — re-exports only, no logic. Import",
    "siblings through `'../<sibling>/index.js'`, never their internals.",
    '',
    'Named exports only; no classes; `.js` extensions on relative imports.',
    '',
    `Active checks in this repo: ${activeSlots.join(', ')}.`,
  ].join('\n');
}

/**
 * Insert or refresh the checkride stanza in an AGENTS.md body. Idempotent:
 * applying twice yields identical output. It rewrites the marked region without
 * looking at what was there — callers gate on {@link inspectStanza} first.
 */
export function applyStanza(content: string, body: string): string {
  // A replacer function, not the string: a `$&` in the stanza would otherwise be
  // read as a backreference.
  const block = `${STANZA_BEGIN_PREFIX} hash=${stanzaStamp(body)} -->\n\n${body}\n\n${STANZA_END}`;
  if (STANZA_RE.test(content)) {
    return content.replace(STANZA_RE, () => block);
  }
  if (STANZA_BEGIN_RE.test(content)) {
    // A begin marker with no end: replace the marker in place rather than
    // appending a second block, which would leave two begins and make the next
    // refresh swallow everything between them. What followed the orphaned marker
    // stays where it is — now outside the markers, so nothing rewrites it again.
    return content.replace(STANZA_BEGIN_RE, () => block);
  }
  if (content.trim().length === 0) {
    return `${block}\n`;
  }
  return `${content.replace(/\s*$/, '')}\n\n${block}\n`;
}

// ----------------------------------------------------------------------------
// Inventory (gate: adoption inventory)
// ----------------------------------------------------------------------------

/** For each default (non-opt-in) slot, report whether a tool config is present. */
export function inventory(input: {
  cwd?: string;
  slots?: readonly Slot[];
  adapters?: readonly Adapter[];
  fileExists?: (file: string) => boolean;
}): InventoryEntry[] {
  const slots = (input.slots ?? SLOTS).filter((s) => !s.optIn);
  const resolved = resolveChecks({
    slots,
    adapters: input.adapters ?? ADAPTERS,
    config: null,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.fileExists !== undefined ? { fileExists: input.fileExists } : {}),
  });
  return resolved.map((r) => ({
    slot: r.slot,
    status: r.adapter ? 'adopted' : 'empty',
    adapter: r.adapter?.name ?? null,
  }));
}

// ----------------------------------------------------------------------------
// Generation helpers
// ----------------------------------------------------------------------------

function readTemplate(rel: string): string {
  return readFileSync(join(TEMPLATES_DIR, rel), 'utf8');
}

function render(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? '');
}

function constName(name: string): string {
  const id = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return id.length > 0 ? id : 'APP';
}

function productVersion(): string {
  try {
    const raw = readFileSync(join(TEMPLATES_DIR, '..', 'package.json'), 'utf8');
    const pkg: { version?: string } = JSON.parse(raw);
    return pkg.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

function collectDevDeps(
  adapters: readonly Adapter[],
  slots: readonly Slot[],
  checkrideSpec: string,
): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const slot of slots) {
    if (slot.optIn) continue;
    const adapter = adapters.find((a) => a.slot === slot.name);
    if (adapter) Object.assign(deps, adapter.devDeps);
  }
  deps['checkride'] = checkrideSpec;
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(deps).toSorted()) sorted[key] = deps[key] ?? '';
  return sorted;
}

function rootPackageJson(
  fullName: string,
  license: string,
  author: string | null,
  devDeps: Record<string, string>,
  workspace: boolean,
): string {
  const pkg = {
    name: fullName,
    version: '0.1.0',
    description: '',
    license,
    ...(author ? { author } : {}),
    type: 'module',
    ...(workspace ? { private: true } : {}),
    engines: { node: '>=22.18.0', pnpm: '>=9.0.0' },
    scripts: {
      check: 'checkride',
      'check:all': 'checkride --all',
      'check:json': 'checkride --json',
      'check:bail': 'checkride --bail',
      'check:changed': 'checkride --changed',
      'check:fix': 'checkride fix',
      doctor: 'checkride doctor',
      test: 'vitest run',
      'test:watch': 'vitest',
      build: 'tsc --build',
      types: 'tsc --build',
    },
    devDependencies: devDeps,
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function packageJsonFor(pkgName: string): string {
  const pkg = {
    name: pkgName,
    version: '0.0.0',
    private: true,
    type: 'module',
    exports: { '.': './src/index.ts' },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

const PACKAGE_TSCONFIG = `${JSON.stringify(
  {
    extends: '../../tsconfig.base.json',
    compilerOptions: { rootDir: './src', outDir: './dist' },
    include: ['src/**/*'],
    exclude: ['dist', 'node_modules'],
  },
  null,
  2,
)}\n`;

function sourceModule(value: string): string {
  const id = constName(value);
  return `export const ${id} = '${value}';\n`;
}

function smokeTest(value: string): string {
  const id = constName(value);
  return [
    "import { expect, test } from 'vitest';",
    '',
    "import { " + id + " } from './index.js';",
    '',
    `test('${value} smoke', () => {`,
    `  expect(${id}).toBe('${value}');`,
    '});',
    '',
  ].join('\n');
}

function readme(name: string): string {
  return [
    `# ${name}`,
    '',
    'A TypeScript project verified by checkride.',
    '',
    '```bash',
    'pnpm check        # run the full pipeline; exit 0 = done',
    '```',
    '',
    'See [AGENTS.md](./AGENTS.md) for the contract agents follow in this repository.',
    '',
  ].join('\n');
}

function claudeMd(): string {
  return [
    '# CLAUDE.md',
    '',
    'Claude Code-specific notes. See [AGENTS.md](./AGENTS.md) for the full contract.',
    '',
  ].join('\n');
}

function agentsMd(activeSlots: readonly string[]): string {
  const intro = ['# AGENTS.md', '', 'Instructions for any coding agent working in this repository.', ''].join('\n');
  return applyStanza(intro, buildStanza(activeSlots));
}

const MIT = (year: number, holder: string): string =>
  [
    'MIT License',
    '',
    `Copyright (c) ${year} ${holder}`,
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'in the Software without restriction, including without limitation the rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all',
    'copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
    'SOFTWARE.',
    '',
  ].join('\n');

function licenseText(license: string, holder: string): string {
  const year = new Date().getFullYear();
  if (license === 'MIT') return MIT(year, holder);
  return `${license} License\n\nCopyright (c) ${year} ${holder}\n`;
}

function cspellWithName(name: string, scope: string | null): string {
  const base: { words?: string[] } & Record<string, unknown> = JSON.parse(readTemplate('shared/cspell.json'));
  const words = new Set(base.words ?? []);
  for (const token of `${name} ${scope ?? ''}`.split(/[^A-Za-z0-9]+/)) {
    if (token.length > 1) words.add(token);
  }
  base.words = [...words].toSorted();
  return `${JSON.stringify(base, null, 2)}\n`;
}

// ----------------------------------------------------------------------------
// Writers
// ----------------------------------------------------------------------------

type Writer = {
  cwd: string;
  dryRun: boolean;
  written: string[];
  /** Files this run deleted (`--remove-hook`), kept apart so a removal never reads as a write. */
  removed: string[];
};

async function put(w: Writer, relPath: string, content: string): Promise<void> {
  w.written.push(relPath);
  if (w.dryRun) return;
  const target = join(w.cwd, relPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function writeSharedStatic(w: Writer): Promise<void> {
  const map: [string, string][] = [
    ['shared/tsconfig.base.json', 'tsconfig.base.json'],
    ['shared/oxlintrc.json', '.oxlintrc.json'],
    ['shared/markdownlint-cli2.jsonc', '.markdownlint-cli2.jsonc'],
    ['shared/sgconfig.yml', 'sgconfig.yml'],
    ['shared/vitest.config.ts.template', 'vitest.config.ts'],
    ['shared/gitignore', '.gitignore'],
    ['shared/npmrc', '.npmrc'],
  ];
  // Independent writes to distinct paths — run them concurrently.
  await Promise.all(map.map(([from, to]) => put(w, to, readTemplate(from))));
  const rules = ['no-class.yml', 'no-default-export.yml', 'no-deep-sibling-import.yml', 'require-js-extension.yml'];
  await Promise.all(rules.map((rule) => put(w, join('rules', rule), readTemplate(join('shared', 'rules', rule)))));
}

async function writePackage(w: Writer, dir: string, pkgName: string, value: string): Promise<void> {
  await put(w, join(dir, 'package.json'), packageJsonFor(pkgName));
  await put(w, join(dir, 'tsconfig.json'), PACKAGE_TSCONFIG);
  await put(w, join(dir, 'src', 'index.ts'), sourceModule(value));
  await put(w, join(dir, 'src', 'index.test.ts'), smokeTest(value));
}

/** The hook-writing slice of the init/agent-setup options. */
type HookSelection = {
  hook?: boolean;
  hooks?: readonly HookName[];
  removeHooks?: readonly HookName[];
  harnesses?: readonly HarnessName[];
};

/**
 * Write/refresh the agent hooks unless opted out (`hook === false`), remove any
 * named for removal, for the selected harnesses (default: detected) and the
 * repo's detected package manager. Records each file when it changed, else a
 * no-op note in `skipped` when one is provided.
 *
 * `--no-hook` and `--remove-hook` compose rather than conflict: the first says
 * "write nothing", the second "take this one out", and together they mean
 * "remove the gate and leave the rest of the setup untouched" — which is the
 * whole point of being able to drop a hook after the fact.
 */
async function writeHook(w: Writer, options: HookSelection, skipped?: string[]): Promise<void> {
  const remove = options.removeHooks ?? [];
  if (options.hook === false && remove.length === 0) return;
  const hooks = options.hook === false ? [] : options.hooks;
  const result = await writeHooks(w.cwd, {
    dryRun: w.dryRun,
    ...(hooks ? { hooks } : {}),
    ...(remove.length > 0 ? { remove } : {}),
    ...(options.harnesses ? { harnesses: options.harnesses } : {}),
  });
  record(w, result.files, skipped);
}

/**
 * Write the bundled skills for every selected harness that cannot install them
 * as a plugin. Only Cursor needs this today; Claude Code gets the same two
 * skills from `.claude-plugin/`, installed once for every repo.
 *
 * Unlike the hooks this is not covered by `--no-hook`: that flag turns off the
 * mechanical gate, and a skill gates nothing.
 */
async function writeSkills(w: Writer, options: HookSelection, skipped?: string[]): Promise<void> {
  const harnesses = options.harnesses ?? detectHarnesses(w.cwd);
  if (!harnesses.includes('cursor')) return;
  record(w, await writeCursorSkills(w.cwd, { dryRun: w.dryRun }), skipped);
}

/**
 * Fold a writer's file list into the run's written/removed/skipped report. A
 * deleted file is a change, but not a *write* — counting it as one would have
 * `--remove-hook gate` report that it wrote a file it actually took away.
 */
function record(w: Writer, files: readonly HookFile[], skipped?: string[]): void {
  for (const f of files) {
    if (!f.changed) skipped?.push(`${f.path} (${f.removed === true ? 'absent' : 'unchanged'})`);
    else if (f.removed === true) w.removed.push(f.path);
    else w.written.push(f.path);
  }
}

// ----------------------------------------------------------------------------
// New-project mode
// ----------------------------------------------------------------------------

const DEFAULT_ACTIVE_SLOTS = ['types', 'lint', 'struct', 'dead', 'test', 'docs', 'links', 'spell'];

/** The derived inputs a new-project scaffold is generated from. */
type NewScaffold = {
  shape: Shape;
  name: string;
  scope: string | null;
  license: string;
  author: string | null;
  fullName: string;
  adapters: readonly Adapter[];
  slots: readonly Slot[];
  checkrideSpec: string;
};

/** Emit every scaffold file for the shape into `w` (records paths; obeys dryRun). */
async function writeNewScaffold(w: Writer, s: NewScaffold): Promise<void> {
  await writeSharedStatic(w);
  await put(w, 'tsconfig.json', render(readTemplate(join(s.shape, 'tsconfig.json')), { name: s.name }));
  await put(w, 'fallow.toml', render(readTemplate(join(s.shape, 'fallow.toml')), { name: s.name }));
  await put(w, 'pnpm-workspace.yaml', render(readTemplate(join(s.shape, 'pnpm-workspace.yaml')), { name: s.name }));

  await put(w, 'cspell.json', cspellWithName(s.name, s.scope));
  await put(w, 'package.json', rootPackageJson(s.fullName, s.license, s.author, collectDevDeps(s.adapters, s.slots, s.checkrideSpec), s.shape !== 'flat'));
  await put(w, 'LICENSE', licenseText(s.license, s.author ?? s.fullName));
  await put(w, 'README.md', readme(s.name));
  await put(w, 'AGENTS.md', agentsMd(DEFAULT_ACTIVE_SLOTS));
  await put(w, 'CLAUDE.md', claudeMd());

  if (s.shape === 'flat') {
    await put(w, join('src', 'index.ts'), sourceModule(s.name));
    await put(w, join('src', 'index.test.ts'), smokeTest(s.name));
  } else if (s.shape === 'monorepo') {
    await writePackage(w, join('libs', 'core'), s.scope ? `${s.scope}/core` : 'core', 'core');
    await writePackage(w, join('apps', s.name), s.fullName, s.name);
  } else {
    await put(w, join('src', 'index.ts'), sourceModule(s.name));
    await put(w, join('src', 'index.test.ts'), smokeTest(s.name));
    await writePackage(w, join('packages', 'core'), s.scope ? `${s.scope}/core` : 'core', 'core');
  }
}

/**
 * Plan the scaffold on a dry writer and return the paths that already exist on
 * disk — the files `init` would clobber. The Stop hook is excluded: it merges
 * into `.claude/settings.json` idempotently rather than overwriting.
 */
async function planCollisions(s: NewScaffold, cwd: string): Promise<string[]> {
  const plan: Writer = { cwd, dryRun: true, written: [], removed: [] };
  await writeNewScaffold(plan, s);
  return plan.written.filter((rel) => existsSync(join(cwd, rel)));
}

/** Resolve the project name, scope, and derived scoped `fullName` for a new project. */
function resolveProjectName(
  options: InitOptions,
  cwd: string,
): { name: string; scope: string | null; fullName: string } {
  const name = options.name ?? (basename(cwd) || 'app');
  const scope = options.scope ?? null;
  return { name, scope, fullName: scope ? `${scope}/${name}` : name };
}

/** Resolve the options for a new-project scaffold, applying every default. */
function resolveNewScaffold(options: InitOptions, cwd: string): NewScaffold {
  const { name, scope, fullName } = resolveProjectName(options, cwd);
  return {
    shape: options.shape ?? 'flat',
    name,
    scope,
    license: options.license ?? 'MIT',
    author: options.author ?? null,
    fullName,
    adapters: options.adapters ?? ADAPTERS,
    slots: options.slots ?? SLOTS,
    // Exact pin, no caret: pre-1.0 minors are breaking (docs/contract.md pin policy).
    checkrideSpec: options.checkrideSpec ?? productVersion(),
  };
}

/**
 * Overwrite protection: unless `force`, refuse rather than clobber any file
 * the scaffold would write. Planning on a dry writer first means a collision
 * bails before a single real byte is written — the refusal writes nothing.
 */
async function assertNoCollisions(scaffold: NewScaffold, cwd: string, force: boolean): Promise<void> {
  if (force) return;
  const collisions = await planCollisions(scaffold, cwd);
  if (collisions.length > 0) {
    throw new Error(
      `init: refusing to overwrite ${collisions.length} existing file(s) (pass --force to overwrite):\n` +
        collisions.map((c) => `  ${c}`).join('\n'),
    );
  }
}

/** Print the new-project summary and next steps. */
function reportNew(stdout: Out, shape: Shape, w: Writer, cwd: string): void {
  stdout.write(`checkride init: generated a ${shape} project (${w.written.length} files)${w.dryRun ? ' [dry run]' : ''}.\n`);
  // A fresh project has no lockfile/field yet, so this resolves to `pnpm`,
  // matching the generated scripts.
  const pm = detectPackageManager({ cwd });
  stdout.write(`  next: ${pm} install && ${pm} run check\n`);
}

async function initNew(options: InitOptions, cwd: string): Promise<InitResult> {
  const scaffold = resolveNewScaffold(options, cwd);
  await assertNoCollisions(scaffold, cwd, options.force ?? false);

  const w: Writer = { cwd, dryRun: options.dryRun ?? false, written: [], removed: [] };
  await writeNewScaffold(w, scaffold);

  // Claude Code Stop hook (opt-out). A fresh project has no PM lockfile
  // yet, so it resolves to the `pnpm` default — matching the generated scripts.
  await writeHook(w, options);
  await writeSkills(w, options);

  if (options.stdout) reportNew(options.stdout, scaffold.shape, w, cwd);
  return {
    mode: 'new',
    shape: scaffold.shape,
    written: w.written,
    removed: w.removed,
    skipped: [],
    disabled: [],
    grandfathered: [],
    exitCode: 0,
  };
}

// ----------------------------------------------------------------------------
// Existing-project mode
// ----------------------------------------------------------------------------

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Publish-ready bundle: the library path scaffolds the opt-in artifact
// checks into `checkride.config.json` so a buildable library orders itself out
// of the box (build → pack/smoke/attw/publint/snippets).
// ----------------------------------------------------------------------------

/**
 * The publish-ready bundle, in wave order. Each slot's value is the adapter
 * `init` writes into `checks`; `build` and `snippets` are gated (see
 * {@link planPublishBundle}). publint/attw/pack/smoke each resolve to the
 * same-named adapter, so their config value is just the slot name.
 */
const PUBLISH_BUNDLE_SLOTS = ['build', 'publint', 'attw', 'pack', 'smoke', 'snippets'] as const;

/** `--add` values that expand to the whole bundle. */
const PUBLISH_BUNDLE_ALIASES: ReadonlySet<string> = new Set(['publish', 'bundle']);

/** Printed (and recorded in `skipped`) when snippets is requested but no tagged fence exists. */
const SNIPPETS_POINTER =
  'snippets-dist: no tagged fences found — add a `<!-- snippet: check -->` marker above a ' +
  'ts/typescript fence in README.md or docs/*.md to enable the doc-snippet typecheck';

type InitManifest = { scripts: ReadonlySet<string>; isLibrary: boolean };

/**
 * Read package.json for the library path: its script names, and whether it is a
 * publishable library (declares an `exports`/`main` entry and is not private).
 */
function readInitManifest(cwd: string): InitManifest {
  try {
    const pkg: { scripts?: Record<string, string>; exports?: unknown; main?: unknown; private?: boolean } =
      JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const hasEntry = pkg.exports !== undefined || (typeof pkg.main === 'string' && pkg.main.length > 0);
    return { scripts: new Set(Object.keys(pkg.scripts ?? {})), isLibrary: hasEntry && pkg.private !== true };
  } catch {
    return { scripts: new Set(), isLibrary: false };
  }
}

/**
 * True when README.md or a non-recursive docs/*.md carries at least one tagged
 * snippet fence — the signal that gates scaffolding `snippets-dist`.
 * Reuses the snippets module's pure discovery/plan primitives so the detection
 * matches what the slot itself checks.
 */
async function hasTaggedSnippets(cwd: string): Promise<boolean> {
  let docsEntries: string[] = [];
  try {
    docsEntries = await readdir(join(cwd, 'docs'));
  } catch {
    // No docs/ directory — README.md alone can still carry a tagged fence.
  }
  const docs: DocInput[] = [];
  for (const relPath of selectDocFiles(docsEntries)) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of docs; sequential keeps it simple.
    const text = await readIfExists(join(cwd, relPath));
    if (text !== null) docs.push({ relPath, text });
  }
  return planSnippets(docs).checked > 0;
}

type PublishBundle = {
  /** slot -> adapter entries to merge into `checks`. */
  checks: Record<string, string>;
  /** The pointer to surface when snippets was requested but no tagged fence exists. */
  snippetsPointer: string | null;
};

/**
 * Fold the requested publish slots into config entries, gating `build` on a
 * build script and `snippets` (→ `snippets-dist`) on a tagged fence — the
 * two slots that would otherwise stand down as a skip (`build`) or hard-error on
 * zero snippets (`snippets`).
 */
function planPublishBundle(
  requested: ReadonlySet<string>,
  hasBuildScript: boolean,
  taggedSnippets: boolean,
): PublishBundle {
  const checks: Record<string, string> = {};
  let snippetsPointer: string | null = null;
  for (const slot of PUBLISH_BUNDLE_SLOTS) {
    if (!requested.has(slot)) continue;
    if (slot === 'build') {
      if (hasBuildScript) checks['build'] = 'build';
    } else if (slot === 'snippets') {
      if (taggedSnippets) checks['snippets'] = 'snippets-dist';
      else snippetsPointer = SNIPPETS_POINTER;
    } else {
      checks[slot] = slot; // publint / attw / pack / smoke — adapter name == slot name.
    }
  }
  return { checks, snippetsPointer };
}

/**
 * Partition the `--add` list and the library signal into (a) the publish slots
 * to scaffold into `checks` and (b) the file-scaffold `--add` names left for
 * {@link addConfigs}. The library path — a buildable, publishable package —
 * requests the whole bundle; `--add` requests a named publish slot, or the
 * whole bundle via the `publish`/`bundle` alias.
 */
function splitAdd(add: readonly string[], manifest: InitManifest): {
  publishRequested: Set<string>;
  fileAdds: string[];
} {
  const publishRequested = new Set<string>();
  const fileAdds: string[] = [];
  if (manifest.isLibrary && manifest.scripts.has('build')) {
    for (const slot of PUBLISH_BUNDLE_SLOTS) publishRequested.add(slot);
  }
  const bundleNames: ReadonlySet<string> = new Set(PUBLISH_BUNDLE_SLOTS);
  for (const name of add) {
    if (PUBLISH_BUNDLE_ALIASES.has(name)) for (const slot of PUBLISH_BUNDLE_SLOTS) publishRequested.add(slot);
    else if (bundleNames.has(name)) publishRequested.add(name);
    else fileAdds.push(name);
  }
  return { publishRequested, fileAdds };
}

/**
 * The stanza's active-check list: the selection a default `checkride` run
 * makes, resolved config-aware from disk. `inventory()` is the wrong input
 * here — it has detection semantics and never reads checkride.config.json, so
 * it under-reports the gate (opt-in slots the config opts in, custom checks)
 * to the exact audience the stanza exists to inform. Mirrors `doctor`'s
 * `defaultActive` derivation.
 */
function activeCheckSlots(cwd: string, slots: readonly Slot[], adapters: readonly Adapter[]): string[] {
  const resolved = resolveChecks({ slots, adapters, config: loadConfig(cwd), cwd });
  return selectChecks(resolved, {})
    .filter((r) => r.adapter !== null)
    .map((r) => r.slot);
}

const STANZA_REFUSALS: Record<'edited' | 'unstamped', string> = {
  edited: 'it has been edited since checkride wrote it',
  unstamped: "it predates checkride's stanza stamp, so an older version's wording and your own edits are indistinguishable",
};

/**
 * Refuse to refresh a stanza that is not checkride's own output, so a repo's
 * edge-case additions survive the next `init`/`agent-setup` instead of being
 * silently overwritten. `opts.force` overrides.
 *
 * Called before either entry point writes anything, so a refusal leaves the repo
 * exactly as it found it (the same rule `assertNoCollisions` follows in new
 * mode). That ordering costs one thing: in existing mode the config is written
 * *after* this runs, so `body` here is derived from the config as it is on disk
 * now. Only the `unstamped` comparison uses `body` at all, so the worst case is
 * a one-time over-refusal on a legacy stanza in a repo whose active checks this
 * run is about to change — recoverable with `--force`. A stamped stanza is
 * verified against its own stamp and is unaffected.
 */
async function assertStanzaUnedited(cwd: string, body: string, opts: { force?: boolean }): Promise<void> {
  if (opts.force === true) return;
  const existing = await readIfExists(join(cwd, 'AGENTS.md'));
  if (existing === null) return;
  const state = inspectStanza(existing, body);
  if (state === 'absent' || state === 'pristine') return;
  const remedy =
    state === 'edited'
      ? 'Move your additions outside the markers — checkride never rewrites what is outside them — or re-run with --force to discard them and refresh.'
      : 'If you have not edited it, re-run with --force: the refreshed stanza carries a stamp, and later runs tell an edit from a refresh on their own.';
  throw new Error(
    `refusing to overwrite the checkride stanza in AGENTS.md: ${STANZA_REFUSALS[state]}.\n  ${remedy}`,
  );
}

/**
 * Write (or refresh) the AGENTS.md stanza for `slots`, idempotently: it writes
 * only when the applied stanza differs from the current file, records the outcome
 * on `w`/`skipped`, and honours dry-run. Shared by `initExisting` and
 * `runAgentSetup` (both create-or-refresh the same stanza).
 *
 * It rewrites the marked region unconditionally; whether that is allowed is
 * {@link assertStanzaUnedited}'s call, made before either caller writes anything.
 */
async function writeAgentsStanza(
  w: Writer,
  cwd: string,
  slots: readonly string[],
  skipped: string[],
): Promise<void> {
  const agentsPath = join(cwd, 'AGENTS.md');
  const existing = await readIfExists(agentsPath);
  const nextAgents = applyStanza(existing ?? '', buildStanza(slots));
  if (nextAgents !== existing) {
    if (!w.dryRun) await writeFile(agentsPath, nextAgents);
    w.written.push(existing === null ? 'AGENTS.md' : 'AGENTS.md (refreshed stanza)');
  } else {
    skipped.push('AGENTS.md (stanza unchanged)');
  }
}

// Blessed-default config files `--add <slot>` scaffolds for an empty slot.
// Shape-specific slots (types, dead) use the flat variant — existing repos
// adopting checkride incrementally are overwhelmingly single-package.
const ADD_CONFIGS: Record<string, [string, string][]> = {
  types: [['shared/tsconfig.base.json', 'tsconfig.base.json'], ['flat/tsconfig.json', 'tsconfig.json']],
  format: [['shared/prettierrc.json', '.prettierrc.json']],
  lint: [['shared/oxlintrc.json', '.oxlintrc.json']],
  struct: [
    ['shared/sgconfig.yml', 'sgconfig.yml'],
    ['shared/rules/no-class.yml', 'rules/no-class.yml'],
    ['shared/rules/no-default-export.yml', 'rules/no-default-export.yml'],
    ['shared/rules/no-deep-sibling-import.yml', 'rules/no-deep-sibling-import.yml'],
    ['shared/rules/require-js-extension.yml', 'rules/require-js-extension.yml'],
  ],
  dead: [['flat/fallow.toml', 'fallow.toml']],
  // dupes/health are the same fallow tool + config as `dead`, just other slots.
  dupes: [['flat/fallow.toml', 'fallow.toml']],
  health: [['flat/fallow.toml', 'fallow.toml']],
  test: [['shared/vitest.config.ts.template', 'vitest.config.ts']],
  docs: [['shared/markdownlint-cli2.jsonc', '.markdownlint-cli2.jsonc']],
  spell: [['shared/cspell.json', 'cspell.json']],
};

/** `--add <slots>`: scaffold blessed-default configs for the named empty slots. */
async function addConfigs(w: Writer, add: readonly string[], skipped: string[]): Promise<void> {
  for (const slot of add) {
    const files = ADD_CONFIGS[slot];
    if (!files) {
      skipped.push(`--add ${slot} (no blessed config to scaffold)`);
      continue;
    }
    for (const [from, to] of files) {
      if (existsSync(join(w.cwd, to))) skipped.push(`${to} (exists)`);
      // oxlint-disable-next-line no-await-in-loop -- one-shot `--add` scaffolding: writes are independent and perf-irrelevant, kept sequential for a deterministic progress list.
      else await put(w, to, readTemplate(from));
    }
  }
}

/** Add the `check: checkride` alias to an existing package.json (never overwrites). */
async function addCheckAlias(w: Writer, skipped: string[]): Promise<void> {
  const pkgPath = join(w.cwd, 'package.json');
  const raw = await readIfExists(pkgPath);
  if (raw === null) return;
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    // Name the file so a malformed consumer package.json reads as
    // `invalid package.json: <reason>`, not a bare SyntaxError stack
    // (mirrors `invalidConfig` in `config.ts`).
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid package.json: ${reason}`, { cause: err });
  }
  if (pkg.scripts?.['check']) {
    skipped.push('package.json (check script exists)');
    return;
  }
  pkg.scripts = { ...pkg.scripts, check: 'checkride' };
  if (!w.dryRun) await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  w.written.push('package.json (added check script)');
}

/**
 * Classify each failing adopted slot. `--baseline` grandfathers a
 * failing *fingerprintable* slot (kept enabled; the baseline masks its debt and
 * the ratchet carries the cleanup); a failing slot with no extractor can't be
 * grandfathered, so it still falls back to a `false` disable. Without
 * `--baseline`, every failing slot is disabled (re-enable as you fix).
 */
function resolveAdoptionPlan(
  adopted: readonly InventoryEntry[],
  failing: ReadonlySet<string>,
  useBaseline: boolean,
): { grandfathered: string[]; disabled: string[] } {
  const grandfathered = useBaseline
    ? adopted
        .filter((i) => failing.has(i.slot) && i.adapter !== null && isFingerprintable(i.adapter))
        .map((i) => i.slot)
    : [];
  const grandfatheredSet = new Set(grandfathered);
  const disabled = adopted
    .filter((i) => failing.has(i.slot) && !grandfatheredSet.has(i.slot))
    .map((i) => i.slot);
  return { grandfathered, disabled };
}

/** Capture a fresh baseline when any slot was grandfathered (a no-op on dry-run). */
async function captureBaselineIfNeeded(
  options: InitOptions,
  cwd: string,
  grandfathered: readonly string[],
  dryRun: boolean,
): Promise<void> {
  if (grandfathered.length === 0 || dryRun) return;
  const capture = options.captureBaseline ?? ((at: string) => runBaseline({ cwd: at }).then(() => undefined));
  await capture(cwd);
}

/**
 * Write checkride.config.json for the adopted tools (disabled failures as
 * `false`) plus the publish-ready bundle; never clobber an existing one.
 */
async function writeExistingConfig(
  w: Writer,
  cwd: string,
  adopted: readonly InventoryEntry[],
  disabledSet: ReadonlySet<string>,
  bundleChecks: Record<string, string>,
  skipped: string[],
): Promise<void> {
  if (existsSync(join(cwd, 'checkride.config.json'))) {
    skipped.push('checkride.config.json (exists)');
    return;
  }
  const checks: Record<string, string | false> = {};
  for (const i of adopted) {
    if (disabledSet.has(i.slot)) checks[i.slot] = false;
    else if (i.adapter) checks[i.slot] = i.adapter;
  }
  // The opt-in publish bundle follows the adopted default slots; explicit
  // entries opt these slots into the run (the library orders itself).
  for (const [slot, adapter] of Object.entries(bundleChecks)) checks[slot] = adapter;
  const config = { $schema: configSchemaUrl(productVersion()), checks };
  await put(w, 'checkride.config.json', `${JSON.stringify(config, null, 2)}\n`);
}

/** Ensure `.check/` is gitignored: create the file, append to it, or note it's already there. */
async function ensureGitignore(w: Writer, cwd: string, skipped: string[]): Promise<void> {
  const gitignorePath = join(cwd, '.gitignore');
  const gi = await readIfExists(gitignorePath);
  if (gi === null) {
    await put(w, '.gitignore', '.check/\n');
  } else if (!/^\.check\/?\s*$/m.test(gi)) {
    if (!w.dryRun) await writeFile(gitignorePath, `${gi.replace(/\s*$/, '')}\n.check/\n`);
    w.written.push('.gitignore (appended .check/)');
  } else {
    skipped.push('.gitignore (.check/ already ignored)');
  }
}

/** Write the CLAUDE.md pointer if absent. */
async function writeClaudePointer(w: Writer, cwd: string, skipped: string[]): Promise<void> {
  if (existsSync(join(cwd, 'CLAUDE.md'))) {
    skipped.push('CLAUDE.md (exists)');
    return;
  }
  await put(w, 'CLAUDE.md', claudeMd());
}

/** Print the existing-repo adoption summary (adopted count + grandfathered/disabled slots). */
function reportExisting(
  stdout: Out,
  adopted: readonly InventoryEntry[],
  w: Writer,
  grandfathered: readonly string[],
  disabled: readonly string[],
): void {
  stdout.write(
    `checkride init: adopted ${adopted.length} slot(s); wrote ${w.written.length} file(s)${w.dryRun ? ' [dry run]' : ''}.\n`,
  );
  if (grandfathered.length > 0) {
    stdout.write(`  grandfathered failing slots into ${BASELINE_FILE}: ${grandfathered.join(', ')}\n`);
  }
  if (disabled.length > 0) {
    stdout.write(`  disabled failing slots (enable as you fix): ${disabled.join(', ')}\n`);
  }
}

/**
 * Plan the publish-ready bundle for existing-repo init. Only meaningful
 * when a config will actually be written: `writeExistingConfig` never clobbers an
 * existing `checkride.config.json`, so an existing config means the bundle has
 * nowhere to land. The bundle is scaffolded *enabled* — not probed/disabled like
 * adopted tools — because it is an ordered pipeline (build → artifacts) the user
 * opts into by naming it.
 */
async function planInitBundle(
  publishRequested: ReadonlySet<string>,
  manifest: InitManifest,
  cwd: string,
): Promise<PublishBundle> {
  if (existsSync(join(cwd, 'checkride.config.json'))) return { checks: {}, snippetsPointer: null };
  const wantsSnippets = publishRequested.has('snippets');
  return planPublishBundle(
    publishRequested,
    manifest.scripts.has('build'),
    wantsSnippets ? await hasTaggedSnippets(cwd) : false,
  );
}

/** Append the enabled publish-bundle slots (and any snippets pointer) to the summary. */
function reportInitBundle(stdout: Out, bundle: PublishBundle): void {
  const enabled = Object.keys(bundle.checks);
  if (enabled.length > 0) stdout.write(`  enabled publish bundle: ${enabled.join(', ')}\n`);
  if (bundle.snippetsPointer) stdout.write(`  ${bundle.snippetsPointer}\n`);
}

async function initExisting(options: InitOptions, cwd: string): Promise<InitResult> {
  const adapters = options.adapters ?? ADAPTERS;
  const slots = options.slots ?? SLOTS;
  const manifest = readInitManifest(cwd);
  const w: Writer = { cwd, dryRun: options.dryRun ?? false, written: [], removed: [] };
  const skipped: string[] = [];

  // Before the first write: a stanza this repo has customized stops the run
  // rather than being clobbered by the refresh below.
  await assertStanzaUnedited(cwd, buildStanza(activeCheckSlots(cwd, slots, adapters)), options);

  // Route --add: publish slots (and the library path) opt into the bundle; the
  // rest scaffold blessed configs before inventory, so they're detected this run.
  const { publishRequested, fileAdds } = splitAdd(options.add ?? [], manifest);
  await addConfigs(w, fileAdds, skipped);

  const items = inventory({ cwd, slots, adapters });
  const adopted = items.filter((i) => i.status === 'adopted');

  // Run each adopted check once to see what currently fails.
  const probe = options.probeFailures ?? defaultProbe;
  const failing = new Set(await probe(adopted.map((i) => i.slot), cwd));

  const { grandfathered, disabled } = resolveAdoptionPlan(adopted, failing, options.baseline ?? false);
  await captureBaselineIfNeeded(options, cwd, grandfathered, w.dryRun);

  // Publish-ready bundle: planned only when a config will be written.
  const bundle = await planInitBundle(publishRequested, manifest, cwd);
  if (bundle.snippetsPointer) skipped.push(bundle.snippetsPointer);

  await writeExistingConfig(w, cwd, adopted, new Set(disabled), bundle.checks, skipped);
  await ensureGitignore(w, cwd, skipped);
  // package.json: add the `check: checkride` alias if missing.
  await addCheckAlias(w, skipped);
  // AGENTS.md stanza (create or refresh, idempotent), derived from the config
  // written above so it reports the gate as configured, not as detected.
  await writeAgentsStanza(w, cwd, activeCheckSlots(cwd, slots, adapters), skipped);
  await writeClaudePointer(w, cwd, skipped);
  // Claude Code Stop hook (opt-out), using the repo's detected PM.
  await writeHook(w, options, skipped);
  await writeSkills(w, options, skipped);

  if (options.stdout) {
    reportExisting(options.stdout, adopted, w, grandfathered, disabled);
    reportInitBundle(options.stdout, bundle);
  }
  return {
    mode: 'existing',
    shape: null,
    written: w.written,
    removed: w.removed,
    skipped,
    disabled,
    grandfathered,
    exitCode: 0,
  };
}

// ----------------------------------------------------------------------------
// Entry
// ----------------------------------------------------------------------------

/** Detect new vs existing by the presence of a package.json. */
export function detectMode(cwd: string): 'new' | 'existing' {
  return existsSync(join(cwd, 'package.json')) ? 'existing' : 'new';
}

/** Run `checkride init` against `cwd`. */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd();
  return detectMode(cwd) === 'existing' ? initExisting(options, cwd) : initNew(options, cwd);
}

export type AgentSetupOptions = {
  cwd?: string;
  dryRun?: boolean;
  /** Write the agent hooks (opt-out; `--no-hook`). Defaults to on. */
  hook?: boolean;
  /** Which hooks to write (`--hook <a,b>`). Omitted → all of them. */
  hooks?: readonly HookName[];
  /**
   * Hooks to tear out (`--remove-hook <a,b>`): the config entry is stripped and
   * the generated script deleted. With `hook: false` it removes those and
   * refreshes nothing else.
   */
  removeHooks?: readonly HookName[];
  /** Which harnesses to write them for (`--harness <a,b>`). Omitted → detected. */
  harnesses?: readonly HarnessName[];
  /**
   * Refresh the AGENTS.md stanza even when it carries local edits. Without it a
   * customized stanza stops the run (exit 2) instead of being overwritten.
   */
  force?: boolean;
  stdout?: Out;
  slots?: readonly Slot[];
  adapters?: readonly Adapter[];
};

export type AgentSetupResult = {
  written: string[];
  /** Files deleted by `--remove-hook`. */
  removed: string[];
  skipped: string[];
  exitCode: number;
};

/**
 * `checkride agent-setup` — wire the agent contract into an *existing* repo
 * without a full `init`: the `check` alias the hook resolves to, the AGENTS.md
 * stanza (the human-readable contract), the stop-gate hooks for every detected
 * harness (the mechanical gate), and the skills a harness cannot get from the
 * bundled plugin. Every write is additive and idempotent — a second run is a
 * no-op — and the hooks are opt-out (`hook: false`).
 */
export async function runAgentSetup(options: AgentSetupOptions): Promise<AgentSetupResult> {
  const cwd = options.cwd ?? process.cwd();
  const slots = options.slots ?? SLOTS;
  const adapters = options.adapters ?? ADAPTERS;
  const w: Writer = { cwd, dryRun: options.dryRun ?? false, written: [], removed: [] };
  const skipped: string[] = [];
  const stanzaSlots = activeCheckSlots(cwd, slots, adapters);

  // Before the first write: a stanza this repo has customized stops the run
  // rather than being clobbered by the refresh below.
  await assertStanzaUnedited(cwd, buildStanza(stanzaSlots), options);

  // The `check` alias the hook's `<pm> run check` resolves to (never clobbers).
  await addCheckAlias(w, skipped);

  // AGENTS.md stanza for the checks the default run selects (create or refresh).
  await writeAgentsStanza(w, cwd, stanzaSlots, skipped);

  await writeHook(w, options, skipped);
  await writeSkills(w, options, skipped);

  if (options.stdout) {
    const removed = w.removed.length > 0 ? `, removed ${w.removed.length}` : '';
    options.stdout.write(
      `checkride agent-setup: wrote ${w.written.length} file(s)${removed}${w.dryRun ? ' [dry run]' : ''}.\n`,
    );
  }
  return { written: w.written, removed: w.removed, skipped, exitCode: 0 };
}

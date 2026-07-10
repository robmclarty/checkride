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

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Adapter, Slot } from './adapters.js';
import { ADAPTERS, SLOTS } from './adapters.js';
import { CLAUDE_SETTINGS_FILE, writeStopHook } from './agent-setup/index.js';
import { BASELINE_FILE, isFingerprintable, runBaseline } from './baseline/index.js';
import { configSchemaUrl, resolveChecks } from './config.js';
import type { Out } from './orchestrator.js';
import { runChecks } from './orchestrator.js';

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
   * Write the Claude Code Stop hook to `.claude/settings.json` (step 12).
   * Opt-out: defaults to on; `--no-hook` sets it `false`.
   */
  hook?: boolean;
  stdout?: Out;
  slots?: readonly Slot[];
  adapters?: readonly Adapter[];
  /** Existing mode: returns the adopted slots whose check currently fails. */
  probeFailures?: (slots: string[], cwd: string) => Promise<string[]>;
  /**
   * Existing mode: grandfather current debt into `checkride.baseline.json`
   * instead of disabling failing slots (`--baseline`, step 6 / c10). A failing
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

const STANZA_BEGIN = '<!-- checkride:begin -->';
const STANZA_END = '<!-- checkride:end -->';

// ----------------------------------------------------------------------------
// AGENTS.md stanza (gate: idempotent)
// ----------------------------------------------------------------------------

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    'Tight feedback loops: `pnpm check --bail`, `pnpm check --only types,lint`, and',
    '`pnpm check --changed`.',
    '',
    'If a Claude Code Stop hook is configured (`.claude/settings.json`), it runs the full',
    '`pnpm check` as the final gate — so while iterating, prefer the narrow commands above',
    'and let the hook run the authoritative pipeline once at the end rather than running',
    'the full check yourself every loop.',
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
 * applying twice yields identical output.
 */
export function applyStanza(content: string, body: string): string {
  const block = `${STANZA_BEGIN}\n\n${body}\n\n${STANZA_END}`;
  const re = new RegExp(`${escapeRegex(STANZA_BEGIN)}[\\s\\S]*?${escapeRegex(STANZA_END)}`);
  if (re.test(content)) {
    return content.replace(re, block);
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
  for (const [from, to] of map) await put(w, to, readTemplate(from));
  for (const rule of ['no-class.yml', 'no-default-export.yml', 'no-deep-sibling-import.yml', 'require-js-extension.yml']) {
    await put(w, join('rules', rule), readTemplate(join('shared', 'rules', rule)));
  }
}

async function writePackage(w: Writer, dir: string, pkgName: string, value: string): Promise<void> {
  await put(w, join(dir, 'package.json'), packageJsonFor(pkgName));
  await put(w, join(dir, 'tsconfig.json'), PACKAGE_TSCONFIG);
  await put(w, join(dir, 'src', 'index.ts'), sourceModule(value));
  await put(w, join(dir, 'src', 'index.test.ts'), smokeTest(value));
}

/**
 * Write/refresh the Claude Code Stop hook unless opted out (`hook === false`),
 * using the repo's detected package manager (b7). Records the file when it
 * changed, else a no-op note in `skipped` when one is provided.
 */
async function writeHook(w: Writer, hook: boolean | undefined, skipped?: string[]): Promise<void> {
  if (hook === false) return;
  const result = await writeStopHook(w.cwd, { dryRun: w.dryRun });
  if (result.changed) w.written.push(result.path);
  else skipped?.push(`${CLAUDE_SETTINGS_FILE} (Stop hook unchanged)`);
}

// ----------------------------------------------------------------------------
// New-project mode
// ----------------------------------------------------------------------------

const DEFAULT_ACTIVE_SLOTS = ['types', 'lint', 'struct', 'dead', 'test', 'docs', 'links', 'spell'];

async function initNew(options: InitOptions, cwd: string): Promise<InitResult> {
  const shape: Shape = options.shape ?? 'flat';
  const name = options.name ?? (basename(cwd) || 'app');
  const scope = options.scope ?? null;
  const license = options.license ?? 'MIT';
  const author = options.author ?? null;
  const fullName = scope ? `${scope}/${name}` : name;
  const adapters = options.adapters ?? ADAPTERS;
  const slots = options.slots ?? SLOTS;
  const checkrideSpec = options.checkrideSpec ?? `^${productVersion()}`;

  const w: Writer = { cwd, dryRun: options.dryRun ?? false, written: [] };

  await writeSharedStatic(w);
  await put(w, 'tsconfig.json', render(readTemplate(join(shape, 'tsconfig.json')), { name }));
  await put(w, 'fallow.toml', render(readTemplate(join(shape, 'fallow.toml')), { name }));
  await put(w, 'pnpm-workspace.yaml', render(readTemplate(join(shape, 'pnpm-workspace.yaml')), { name }));

  await put(w, 'cspell.json', cspellWithName(name, scope));
  await put(w, 'package.json', rootPackageJson(fullName, license, author, collectDevDeps(adapters, slots, checkrideSpec), shape !== 'flat'));
  await put(w, 'LICENSE', licenseText(license, author ?? fullName));
  await put(w, 'README.md', readme(name));
  await put(w, 'AGENTS.md', agentsMd(DEFAULT_ACTIVE_SLOTS));
  await put(w, 'CLAUDE.md', claudeMd());

  if (shape === 'flat') {
    await put(w, join('src', 'index.ts'), sourceModule(name));
    await put(w, join('src', 'index.test.ts'), smokeTest(name));
  } else if (shape === 'monorepo') {
    await writePackage(w, join('libs', 'core'), scope ? `${scope}/core` : 'core', 'core');
    await writePackage(w, join('apps', name), fullName, name);
  } else {
    await put(w, join('src', 'index.ts'), sourceModule(name));
    await put(w, join('src', 'index.test.ts'), smokeTest(name));
    await writePackage(w, join('packages', 'core'), scope ? `${scope}/core` : 'core', 'core');
  }

  // Claude Code Stop hook (opt-out; step 12). A fresh project has no PM lockfile
  // yet, so it resolves to the `pnpm` default — matching the generated scripts.
  await writeHook(w, options.hook);

  if (options.stdout) {
    options.stdout.write(`checkride init: generated a ${shape} project (${w.written.length} files)${w.dryRun ? ' [dry run]' : ''}.\n`);
  }
  return { mode: 'new', shape, written: w.written, skipped: [], disabled: [], grandfathered: [], exitCode: 0 };
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
      else await put(w, to, readTemplate(from));
    }
  }
}

/** Add the `check: checkride` alias to an existing package.json (never overwrites). */
async function addCheckAlias(w: Writer, skipped: string[]): Promise<void> {
  const pkgPath = join(w.cwd, 'package.json');
  const raw = await readIfExists(pkgPath);
  if (raw === null) return;
  const pkg: { scripts?: Record<string, string> } = JSON.parse(raw);
  if (pkg.scripts?.['check']) {
    skipped.push('package.json (check script exists)');
    return;
  }
  pkg.scripts = { ...pkg.scripts, check: 'checkride' };
  if (!w.dryRun) await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  w.written.push('package.json (added check script)');
}

async function initExisting(options: InitOptions, cwd: string): Promise<InitResult> {
  const adapters = options.adapters ?? ADAPTERS;
  const slots = options.slots ?? SLOTS;
  const w: Writer = { cwd, dryRun: options.dryRun ?? false, written: [] };
  const skipped: string[] = [];

  // --add scaffolds blessed configs for empty slots before inventory, so the
  // additions are detected and adopted in this same run.
  await addConfigs(w, options.add ?? [], skipped);

  const items = inventory({ cwd, slots, adapters });
  const adopted = items.filter((i) => i.status === 'adopted');

  // Run each adopted check once to see what currently fails.
  const probe = options.probeFailures ?? defaultProbe;
  const failing = new Set(await probe(adopted.map((i) => i.slot), cwd));

  // Adoption path for the failures. `--baseline` (step 6 / c10) grandfathers a
  // failing *fingerprintable* slot into checkride.baseline.json and keeps it
  // enabled — the baseline masks its current debt on the next run, so it's the
  // ratchet, not a disabled slot, that carries the cleanup. A failing slot with
  // no extractor can't be grandfathered, so it still falls back to a `false`
  // disable. Without `--baseline`, every failing slot is disabled (the original
  // step-3 behavior): the first `pnpm check` is green-ish, re-enable as you fix.
  const useBaseline = options.baseline ?? false;
  const grandfathered = useBaseline
    ? adopted.filter((i) => failing.has(i.slot) && i.adapter !== null && isFingerprintable(i.adapter)).map((i) => i.slot)
    : [];
  const grandfatheredSet = new Set(grandfathered);
  if (grandfathered.length > 0 && !w.dryRun) {
    const capture = options.captureBaseline ?? ((at: string) => runBaseline({ cwd: at }).then(() => undefined));
    await capture(cwd);
  }
  const disabled = adopted.filter((i) => failing.has(i.slot) && !grandfatheredSet.has(i.slot)).map((i) => i.slot);
  const disabledSet = new Set(disabled);

  // checkride.config.json reflecting adopted tools (and disabled failures). Never
  // overwrite an existing one.
  const configPath = join(cwd, 'checkride.config.json');
  if (!existsSync(configPath)) {
    const checks: Record<string, string | false> = {};
    for (const i of adopted) {
      if (disabledSet.has(i.slot)) checks[i.slot] = false;
      else if (i.adapter) checks[i.slot] = i.adapter;
    }
    const config = { $schema: configSchemaUrl(productVersion()), checks };
    await put(w, 'checkride.config.json', `${JSON.stringify(config, null, 2)}\n`);
  } else {
    skipped.push('checkride.config.json (exists)');
  }

  // .gitignore: ensure .check/ is ignored (append, never clobber).
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

  // package.json: add the `check: checkride` alias (decision 8) if missing.
  await addCheckAlias(w, skipped);

  // AGENTS.md stanza (create or refresh, idempotent).
  const agentsPath = join(cwd, 'AGENTS.md');
  const existing = await readIfExists(agentsPath);
  const stanza = buildStanza(adopted.map((i) => i.slot));
  const nextAgents = applyStanza(existing ?? '', stanza);
  if (nextAgents !== existing) {
    if (!w.dryRun) await writeFile(agentsPath, nextAgents);
    w.written.push(existing === null ? 'AGENTS.md' : 'AGENTS.md (refreshed stanza)');
  } else {
    skipped.push('AGENTS.md (stanza unchanged)');
  }

  // CLAUDE.md pointer if absent.
  const claudePath = join(cwd, 'CLAUDE.md');
  if (!existsSync(claudePath)) {
    await put(w, 'CLAUDE.md', claudeMd());
  } else {
    skipped.push('CLAUDE.md (exists)');
  }

  // Claude Code Stop hook (opt-out; step 12), using the repo's detected PM (b7).
  await writeHook(w, options.hook, skipped);

  if (options.stdout) {
    options.stdout.write(
      `checkride init: adopted ${adopted.length} slot(s); wrote ${w.written.length} file(s)${w.dryRun ? ' [dry run]' : ''}.\n`,
    );
    if (grandfathered.length > 0) {
      options.stdout.write(`  grandfathered failing slots into ${BASELINE_FILE}: ${grandfathered.join(', ')}\n`);
    }
    if (disabled.length > 0) {
      options.stdout.write(`  disabled failing slots (enable as you fix): ${disabled.join(', ')}\n`);
    }
  }
  return { mode: 'existing', shape: null, written: w.written, skipped, disabled, grandfathered, exitCode: 0 };
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
  /** Write the Claude Code Stop hook (opt-out; `--no-hook`). Defaults to on. */
  hook?: boolean;
  stdout?: Out;
  slots?: readonly Slot[];
  adapters?: readonly Adapter[];
};

export type AgentSetupResult = { written: string[]; skipped: string[]; exitCode: number };

/**
 * `checkride agent-setup` — wire the agent contract into an *existing* repo
 * without a full `init`: the `check` alias the hook resolves to, the AGENTS.md
 * stanza (the human-readable contract), and the Claude Code Stop hook (the
 * mechanical gate). Every write is additive and idempotent — a second run is a
 * no-op — and the hook is opt-out (`hook: false`).
 */
export async function runAgentSetup(options: AgentSetupOptions): Promise<AgentSetupResult> {
  const cwd = options.cwd ?? process.cwd();
  const slots = options.slots ?? SLOTS;
  const adapters = options.adapters ?? ADAPTERS;
  const w: Writer = { cwd, dryRun: options.dryRun ?? false, written: [] };
  const skipped: string[] = [];

  // The `check` alias the hook's `<pm> run check` resolves to (never clobbers).
  await addCheckAlias(w, skipped);

  // AGENTS.md stanza for the currently-adopted slots (create or refresh).
  const adopted = inventory({ cwd, slots, adapters }).filter((i) => i.status === 'adopted');
  const agentsPath = join(cwd, 'AGENTS.md');
  const existing = await readIfExists(agentsPath);
  const nextAgents = applyStanza(existing ?? '', buildStanza(adopted.map((i) => i.slot)));
  if (nextAgents !== existing) {
    if (!w.dryRun) await writeFile(agentsPath, nextAgents);
    w.written.push(existing === null ? 'AGENTS.md' : 'AGENTS.md (refreshed stanza)');
  } else {
    skipped.push('AGENTS.md (stanza unchanged)');
  }

  await writeHook(w, options.hook, skipped);

  if (options.stdout) {
    options.stdout.write(
      `checkride agent-setup: wrote ${w.written.length} file(s)${w.dryRun ? ' [dry run]' : ''}.\n`,
    );
  }
  return { written: w.written, skipped, exitCode: 0 };
}

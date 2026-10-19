/**
 * `checkride init` — set up a project (new or existing, auto-detected).
 *
 * New-project mode generates a complete, green-out-of-the-box repo for one of
 * three shapes (flat / monorepo / hybrid); the shapes differ only in
 * tsconfig.json, fallow.toml, and pnpm-workspace.yaml. Existing-project mode,
 * for a root with a `package.json` or another shipped pack's marker such as a
 * `go.mod`, is additive: it inventories detectable tools, writes only what is
 * missing (checkride.config.json, the AGENTS stanza, the `check` alias) and
 * never touches an existing tool config.
 *
 * Generation, not transformation: every file is written once; the project owns
 * it afterward.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { Adapter, Slot } from './adapters.js';
import { ADAPTERS, SLOTS } from './adapters.js';
import type { DocInput } from './snippets.js';
import { planSnippets, selectDocFiles } from './snippets.js';
import type { HookFile, HookName } from './agent-setup/index.js';
import { detectHarnesses, writeCursorSkills, writeHooks } from './agent-setup/index.js';
import type { HarnessName } from './gate.js';
import { BASELINE_FILE, isFingerprintable } from './baseline/index.js';
import { runBaseline } from './baseline-command.js';
import type { CustomCheck, SlotConfig } from './config.js';
import { configSchemaUrl, configuredBy, loadConfig, resolveChecks } from './config.js';
import type { Out } from './orchestrator/index.js';
import { runChecks, selectChecks } from './orchestrator/index.js';
import type { EntryLike, PackageManager } from './launch/index.js';
import { detectPackageManager, entryCheckride, entryText, resolveEntry } from './launch/index.js';
import { PACKS } from './packs/index.js';
import { readResource } from './resources.js';
import { readRawConfig, writeTargetChange } from './target-files.js';
import type { ProposedTarget, TargetChange } from './targets/index.js';
import { addTarget, checkName, discoverTargets, implicitPack, isImplicit, liftDiscovered, markerAt } from './targets/index.js';

/**
 * A new project's shape: `flat`, `monorepo` or `hybrid` for `ts`, `module` or
 * `workspace` for `go`, and `crate` or `workspace` for `rust`.
 */
export type Shape = 'flat' | 'monorepo' | 'hybrid' | 'module' | 'workspace' | 'crate';

/** The language a new project is scaffolded for (`--lang`). */
export type Lang = 'ts' | 'go' | 'rust';

/** The shapes each language takes, its default first. */
export const LANG_SHAPES: Readonly<Record<Lang, readonly Shape[]>> = {
  ts: ['flat', 'monorepo', 'hybrid'],
  go: ['module', 'workspace'],
  rust: ['crate', 'workspace'],
};

export type InitOptions = {
  cwd?: string;
  /** New mode: the language to scaffold (`--lang`). Omitted, `ts`. */
  lang?: Lang;
  /** New mode: one of {@link LANG_SHAPES} for the language. Omitted, its first. */
  shape?: Shape;
  /** New mode, `go`: the module path (`--module`). Omitted, `example.com/<name>`. */
  module?: string;
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
  /**
   * Discovery for existing mode (R11.4); injectable so tests can propose
   * targets a real tree's packs can't yet. Defaults to `discoverTargets`.
   */
  discoverTargets?: (cwd: string) => Promise<ProposedTarget[]>;
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

const STANZA_BEGIN_PREFIX = '<!-- checkride:begin';
const STANZA_END = '<!-- checkride:end -->';
/** The block, capturing its stamp (absent on stanzas written before v0.10.1) and its body. */
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
 * A stanza body without its trailing generated `Active checks in this repo: …`
 * line — the part that is pure wording, identical in every repo running a given
 * checkride version.
 *
 * The active-checks line is what makes two stanzas from the same release differ,
 * so a registry of released wordings has to compare everything but that. If the
 * line is missing, or something follows it inside the markers, nothing is
 * stripped and the digest simply fails to match — which is the safe answer.
 */
function stanzaPreamble(body: string): string {
  return normalizeStanza(normalizeStanza(body).replace(/\nActive checks in this repo:[^\n]*$/, ''));
}

/**
 * The wording of every stanza checkride released before it stamped them, keyed
 * by {@link stanzaPreamble} digest. Four distinct texts across v0.1.1–v0.10.0.
 *
 * This is what makes the stamp's arrival a non-event for repos that never
 * touched their stanza. Without it, every upgrading repo looked `unstamped` —
 * an older version's wording is not distinguishable from a customization by
 * comparison alone — so the first run after upgrading refused and wrote
 * *nothing*, hooks and config included. That is how the 0.10.1 gate-timeout fix
 * failed to reach the repos that most needed it: the guard protecting AGENTS.md
 * prose was also withholding a fix for a gate that had silently stopped gating.
 *
 * Recognizing the wording collapses that to the case it was always meant to
 * cover. A pre-stamp stanza whose preamble is one of these is checkride's own
 * output, untouched, and refreshing it loses nothing; one that has been edited
 * still fails to match and is still refused.
 *
 * The list is closed. Every release from 0.10.1 stamps what it writes, so no
 * future version can add an unstamped wording — nothing here needs maintaining.
 */
const LEGACY_STANZA_PREAMBLES: ReadonlySet<string> = new Set([
  'v16da2ec6a25e24085', // v0.1.1–v0.1.6
  'v190c2d48a280ff92c', // v0.2.0–v0.7.0
  'v1d4b4eaeeccb5faa2', // v0.8.0–v0.9.6
  'v17a3a1a85e3c3123e', // v0.10.0 (0.10.1 shares the wording but stamps it)
]);

/**
 * How the stanza on disk relates to the one checkride would write:
 *
 * - `absent` — no stanza yet; writing one takes nothing away.
 * - `pristine` — checkride's own output, untouched; refreshing it is lossless.
 *   Either it carries a stamp that still matches, or it predates stamping and
 *   its wording is one checkride shipped (see {@link LEGACY_STANZA_PREAMBLES}).
 * - `edited` — stamped, but the body no longer matches its stamp: a human or an
 *   agent customized it, and a blind refresh would silently discard that.
 * - `unstamped` — predates stamping and matches no wording checkride released,
 *   so it has been edited too; same protection as `edited`, and the message says
 *   so differently because the evidence is weaker.
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
    if (normalizeStanza(found) === normalizeStanza(body)) return 'pristine';
    return LEGACY_STANZA_PREAMBLES.has(stanzaStamp(stanzaPreamble(found))) ? 'pristine' : 'unstamped';
  }
  return stamp === stanzaStamp(found) ? 'pristine' : 'edited';
}

/**
 * The `struct` slot's section: where the boundary rules live, not what they say.
 *
 * checkride ships opinionated ast-grep defaults (`no-class.yml` and friends),
 * but it does not own the repo's architecture, and the stanza is the one place
 * a repo cannot talk back — editing it blocks the next refresh. So this points
 * at the rule files and stops. A repo that allows classes, default exports, or
 * bundler-style extensionless imports deletes those rules and this stays true.
 */
function structSection(): string[] {
  return [
    '### Module boundaries',
    '',
    'The `struct` check runs whatever ast-grep rules `sgconfig.yml` points at',
    "(`rules/` by default). Those files are this repo's boundary convention —",
    'read them rather than assuming one.',
    '',
  ];
}

/**
 * The `prose` slot's voice section, present only when the repo names an
 * `exemplars` directory in its config. The instruction runs one way — read and
 * imitate, never edit — because the exemplars are the repo's hand-written voice
 * reference, the fresh human signal that keeps generated prose from converging
 * on the model's own register. A generated "improvement" to one would replace
 * the original with a copy, which is the drift the directory exists to prevent.
 */
function proseSection(exemplars: string): string[] {
  return [
    '### Prose voice',
    '',
    'Before writing or editing prose (markdown, doc comments), read the exemplars in',
    `\`${exemplars}\` and imitate their voice — sentence rhythm, word choice, register.`,
    'They are hand-written and human-owned: never edit, rewrite, or add to them, and',
    'never generate new ones. When your draft and an exemplar disagree about how a',
    'sentence should sound, the exemplar wins.',
    '',
  ];
}

/**
 * The agent-facing contract block, parameterized by the active checks and the
 * repo's entry command (R6.6): its package manager's `check` script, or, in a
 * repo with no `package.json`, the checkride `mise.toml` pins or the one on
 * `PATH`. A bare package manager stands for its `check` script.
 *
 * The entry command is not cosmetic. The stanza is a list of commands an agent
 * is told to run, and `pnpm check` in an npm repo, or in a Go repo with no
 * `package.json` at all, is an instruction that cannot succeed — the agent
 * either invents a substitute or reports the pipeline as broken. Everything
 * here routes through {@link entryText}/{@link entryCheckride} for that
 * reason; nothing spells a launcher literally. The skills read their commands
 * from this stanza.
 *
 * The gate profile is deliberately *not* a parameter. A repo can add `gate` to
 * checkride.config.json without re-running `agent-setup`, so a stanza naming a
 * specific profile would go stale in exactly the direction that costs something
 * — telling an agent the hook covered everything when it no longer does. The
 * paragraph points at the gate's verdict instead, which is generated per run and
 * states the narrowing itself (see `gate.ts`'s `profileClause`).
 */
export function buildStanza(
  activeSlots: readonly string[],
  entry: EntryLike = 'pnpm',
  proseExemplars: string | null = null,
): string {
  const check = entryText(entry);
  const triage = entryCheckride(entry, ['triage']);
  return [
    '## Checkride: the definition of done',
    '',
    `\`${check}\` is the single source of truth for "done". Exit 0 means the work is`,
    'complete; any other exit code means it is not. Never claim a task is finished while',
    `\`${check}\` is red.`,
    '',
    'When it fails:',
    '',
    '1. Read `.check/summary.json` to see which check failed.',
    "2. Read that check's raw output: `.check/<slot>.json` or `.jsonl`, `.check/<slot>.stdout.txt`,",
    '   or `.check/<slot>.stderr.txt`, where a check refused before it ran says why. A',
    "   target's check writes under `.check/<target>/` instead.",
    '3. Fix the root cause, then re-run.',
    '',
    `\`${triage}\` runs this procedure in full and reads \`.check/\` for you`,
    '(`/checkride:check` and `/checkride-check` are the same thing as a skill).',
    '',
    `Tight feedback loops: \`${check} --bail\`, \`${check} --only types,lint\`, and`,
    `\`${check} --changed\`.`,
    '',
    'If a stop-gate hook is configured (`.claude/settings.json` or `.cursor/hooks.json`),',
    'it runs the check when a turn ends — so while iterating, prefer the narrow commands',
    "above rather than running the full check yourself every loop. Read the gate's verdict",
    'rather than assuming it covered everything: a repo can narrow the gate with `gate` in',
    '`checkride.config.json`, and a narrowed one names its narrowing (`only …`, `without …`,',
    '`affected-only`) in every verdict. That green is not the "done" defined above; run',
    `\`${check}\` in full before you claim the work is finished.`,
    '',
    '### Baseline',
    '',
    'If `checkride.baseline.json` is present, checkride grandfathers the diagnostics it',
    'lists: a slot is green as long as only baselined findings remain, while a genuinely',
    'new diagnostic still fails it. Fixing a baselined finding prunes it from the file —',
    'the ratchet, so the baseline only ever shrinks. Never add to the baseline to make a',
    'check pass; fix the finding.',
    '',
    ...(activeSlots.includes('struct') ? structSection() : []),
    ...(proseExemplars !== null ? proseSection(proseExemplars) : []),
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
  // An inactive slot isn't one this repo runs, so it's neither adopted nor empty.
  return resolved.filter((r) => r.inactive !== true).map((r) => ({
    slot: r.slot,
    status: r.adapter ? 'adopted' : 'empty',
    adapter: r.adapter?.name ?? null,
  }));
}

// ----------------------------------------------------------------------------
// Generation helpers
// ----------------------------------------------------------------------------

/** A scaffold template, by its path under `templates/` (`ts/shared/oxlintrc.json`). */
function readTemplate(rel: string): string {
  return readResource(`templates/${rel}`);
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
    const raw = readResource('package.json');
    const pkg: { version?: string } = JSON.parse(raw);
    return pkg.version ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

/** The version-pinned `$schema` URL a generated `checkride.config.json` names. */
export function generatedSchemaUrl(): string {
  return configSchemaUrl(productVersion());
}

/** A generated `checkride.config.json`, in either mode: the version-pinned `$schema` pointer, then `checks`. */
function configFile(checks: Record<string, SlotConfig>): string {
  return `${JSON.stringify({ $schema: generatedSchemaUrl(), checks }, null, 2)}\n`;
}

/** The root package.json's devDependencies: every scaffolded adapter's, plus checkride itself. */
function collectDevDeps(scaffolded: readonly Adapter[], checkrideSpec: string): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const adapter of scaffolded) Object.assign(deps, adapter.devDeps);
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

/** The starter module's file stem: kebab-case, and never the barrel's own `index`. */
function moduleStem(value: string): string {
  const stem = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return stem.length > 0 && stem !== 'index' ? stem : 'app';
}

function sourceModule(value: string): string {
  const id = constName(value);
  return `export const ${id} = '${value}';\n`;
}

function barrel(value: string): string {
  return `export { ${constName(value)} } from './${moduleStem(value)}.js';\n`;
}

function smokeTest(value: string): string {
  const id = constName(value);
  return [
    "import { expect, test } from 'vitest';",
    '',
    "import { " + id + " } from '../index.js';",
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
  const base: { words?: string[] } & Record<string, unknown> = JSON.parse(readTemplate('repo/shared/cspell.json'));
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
  // `pack` refuses a `.ts` file or a `.test.` name in this package's tarball,
  // so those templates take another name here and get their real one on write.
  const map: [string, string][] = [
    ['ts/shared/tsconfig.base.json', 'tsconfig.base.json'],
    ['ts/shared/tsconfig-test.json', 'tsconfig.test.json'],
    ['ts/shared/oxlintrc.json', '.oxlintrc.json'],
    ['repo/shared/markdownlint-cli2.jsonc', '.markdownlint-cli2.jsonc'],
    ['repo/shared/sgconfig.yml', 'sgconfig.yml'],
    ['ts/shared/vitest.config.ts.template', 'vitest.config.ts'],
    ['ts/shared/gitignore', '.gitignore'],
    ['ts/shared/npmrc', '.npmrc'],
  ];
  // Independent writes to distinct paths — run them concurrently.
  await Promise.all(map.map(([from, to]) => put(w, to, readTemplate(from))));
  // The style rules, then the layout and barrel rules: where a test lives, and
  // what an index.ts may hold. New mode only; existing mode's `struct` ships one.
  const rules = [
    'no-class.yml',
    'no-default-export.yml',
    'no-deep-sibling-import.yml',
    'require-js-extension.yml',
    'colocate-unit-tests.yml',
    'tests-dir-is-src-only.yml',
    'test-dir-layout.yml',
    'no-spec-suffix.yml',
    'src-never-imports-test.yml',
    'no-logic-in-barrel.yml',
  ];
  await Promise.all(rules.map((rule) => put(w, join('rules', rule), readTemplate(`ts/shared/rules/${rule}`))));
}

/**
 * Write a `src/` that obeys the rules it ships with: the value in a named
 * module, a barrel that only re-exports it, and the smoke test in `__tests__/`.
 */
async function writeStarter(w: Writer, dir: string, value: string): Promise<void> {
  const stem = moduleStem(value);
  await put(w, join(dir, 'src', `${stem}.ts`), sourceModule(value));
  await put(w, join(dir, 'src', 'index.ts'), barrel(value));
  await put(w, join(dir, 'src', '__tests__', `${stem}.test.ts`), smokeTest(value));
}

async function writePackage(w: Writer, dir: string, pkgName: string, value: string): Promise<void> {
  await put(w, join(dir, 'package.json'), packageJsonFor(pkgName));
  await put(w, join(dir, 'tsconfig.json'), PACKAGE_TSCONFIG);
  await writeStarter(w, dir, value);
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

/**
 * The adapter new mode sets up for each default slot: the first the registry
 * lists for it, the blessed default whose config file the scaffold writes
 * (`links` needs none). The root package.json pins their devDependencies,
 * `checkride.config.json` names them, and the AGENTS.md stanza lists every
 * check the config names, so the three can't disagree about what a new
 * project runs.
 */
function scaffoldedAdapters(adapters: readonly Adapter[], slots: readonly Slot[]): Adapter[] {
  // A slot that needs a config key the scaffold doesn't write (`unclaimed`
  // needs `targets`) is inactive here, and naming it would force it on.
  return slots
    .filter((slot) => slot.optIn !== true && slot.activeWith === undefined)
    .flatMap((slot) => adapters.find((a) => a.slot === slot.name) ?? []);
}

/**
 * The one check new mode writes that fills no slot. The scaffold's
 * `tsconfig.json` covers `src/` alone, and vitest runs a test without
 * type-checking it, so a type error in a test under `test/` would pass every
 * slot. This runs tsc over `tsconfig.test.json`, which takes in `src/` and
 * `test/` in every package and leaves out `test/fixtures/`, as every tool the
 * scaffold configures does.
 */
const TYPECHECK_TESTS: CustomCheck = {
  command: 'pnpm',
  args: ['exec', 'tsc', '-p', 'tsconfig.test.json'],
  description: 'Type-check the tests outside src/',
  note: 'tsconfig.json covers src/ alone, and vitest runs a test without type-checking it, so this is what type-checks test/.',
};

/**
 * The `checks` new mode writes: every scaffolded slot naming its adapter, as
 * existing mode names the tools it adopts, then `typecheck-tests`. Each slot
 * then runs because the config says so, not because detection found its file:
 * a tool added later for one of these slots doesn't take it over, and a
 * deleted tool config doesn't drop its check from the run.
 */
function newChecks(scaffolded: readonly Adapter[]): Record<string, SlotConfig> {
  return { ...Object.fromEntries(scaffolded.map((a) => [a.slot, a.name])), 'typecheck-tests': TYPECHECK_TESTS };
}

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
  const scaffolded = scaffoldedAdapters(s.adapters, s.slots);
  const checks = newChecks(scaffolded);
  await writeSharedStatic(w);
  await put(w, 'tsconfig.json', render(readTemplate(`ts/${s.shape}/tsconfig.json`), { name: s.name }));
  await put(w, 'fallow.toml', render(readTemplate(`ts/${s.shape}/fallow.toml`), { name: s.name }));
  await put(w, 'pnpm-workspace.yaml', render(readTemplate(`ts/${s.shape}/pnpm-workspace.yaml`), { name: s.name }));

  await put(w, 'cspell.json', cspellWithName(s.name, s.scope));
  await put(w, 'package.json', rootPackageJson(s.fullName, s.license, s.author, collectDevDeps(scaffolded, s.checkrideSpec), s.shape !== 'flat'));
  await put(w, 'checkride.config.json', configFile(checks));
  await put(w, 'LICENSE', licenseText(s.license, s.author ?? s.fullName));
  await put(w, 'README.md', readme(s.name));
  await put(w, 'AGENTS.md', agentsMd(Object.keys(checks)));
  await put(w, 'CLAUDE.md', claudeMd());

  if (s.shape === 'flat') {
    await writeStarter(w, '', s.name);
  } else if (s.shape === 'monorepo') {
    await writePackage(w, join('libs', 'core'), s.scope ? `${s.scope}/core` : 'core', 'core');
    await writePackage(w, join('apps', s.name), s.fullName, s.name);
  } else {
    await writeStarter(w, '', s.name);
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
  // matching the generated scripts. Announced anyway, in the same line the
  // existing-repo path and `agent-setup` print, so every path reads alike.
  const pm = detectPackageManager({ cwd });
  stdout.write(`  package manager: ${pm} (detected)\n`);
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
// New-project mode for another language (`--lang go|rust`)
// ----------------------------------------------------------------------------

/** The target a `--lang go|rust` scaffold declares: the whole project, at its root. */
const LANG_TARGET = 'app';

/** A file a language scaffold writes: where, and the template it renders. */
type LangFile = { to: string; from: string };

/** What a language scaffold writes beyond the shared files, and the setup it needs. */
type LangPlan = {
  files: readonly LangFile[];
  /** The target's checks: each default slot the pack fills, by its blessed adapter. */
  checks: Record<string, SlotConfig>;
  /** The steps that need the network, printed after the scaffold. */
  setup: readonly string[];
};

/** The repo-scope slots a Node-free scaffold names, with the binary each runs. */
const NODE_FREE_REPO_CHECKS: Record<string, SlotConfig> = { struct: 'ast-grep', docs: 'rumdl', links: 'links', spell: 'typos' };

/**
 * The mise steps every language scaffold's setup opens with. mise loads a
 * `mise.toml` that sets a tool option only once it's trusted, and checkride's
 * `allow_low_downloads` is one (D80), so until `mise trust` runs, no check
 * mise pins can run either.
 */
const MISE_SETUP: readonly string[] = ['mise trust', 'mise install'];

/** The tested deadcode a Go scaffold's setup declares as a `go.mod` tool. */
const DEADCODE_TOOL = 'golang.org/x/tools/cmd/deadcode@v0.52.0';

/** The files, checks and setup of each `--lang go|rust` shape. */
function langPlan(lang: Exclude<Lang, 'ts'>, shape: Shape, name: string): LangPlan {
  if (lang === 'go') {
    const checks = { types: 'go-build', lint: 'golangci-lint', dead: 'deadcode', test: 'go-test' };
    if (shape === 'workspace') {
      return {
        files: [
          { to: 'go.work', from: 'go/workspace/go.work' },
          { to: 'core/go.mod', from: 'go/workspace/core.go.mod' },
          { to: 'core/greet/greet.go', from: 'go/module/greet.go' },
          { to: 'core/greet/greet_test.go', from: 'go/module/greet_test.go' },
          { to: 'cli/go.mod', from: 'go/workspace/cli.go.mod' },
          { to: 'cli/main.go', from: 'go/workspace/main.go' },
        ],
        checks,
        setup: [...MISE_SETUP, `go get -C core -tool ${DEADCODE_TOOL}`],
      };
    }
    return {
      files: [
        { to: 'go.mod', from: 'go/module/go.mod' },
        { to: join('cmd', name, 'main.go'), from: 'go/module/main.go' },
        { to: 'internal/greet/greet.go', from: 'go/module/greet.go' },
        { to: 'internal/greet/greet_test.go', from: 'go/module/greet_test.go' },
      ],
      checks,
      setup: [...MISE_SETUP, `go get -tool ${DEADCODE_TOOL}`],
    };
  }
  const checks = { types: 'cargo-check', lint: 'clippy', dead: 'cargo-machete', test: 'nextest', snippets: 'cargo-doctest' };
  const shared = [
    { to: 'rust-toolchain.toml', from: 'rust/shared/rust-toolchain.toml' },
    { to: 'rustfmt.toml', from: 'rust/shared/rustfmt.toml' },
    { to: '.config/nextest.toml', from: 'rust/shared/nextest.toml' },
  ];
  const files = shape === 'workspace'
    ? [
        { to: 'Cargo.toml', from: 'rust/workspace/Cargo.toml' },
        { to: 'crates/core/Cargo.toml', from: 'rust/workspace/core.Cargo.toml' },
        { to: 'crates/core/src/lib.rs', from: 'rust/crate/lib.rs' },
        { to: 'crates/cli/Cargo.toml', from: 'rust/workspace/cli.Cargo.toml' },
        { to: 'crates/cli/src/main.rs', from: 'rust/workspace/main.rs' },
      ]
    : [
        { to: 'Cargo.toml', from: 'rust/crate/Cargo.toml' },
        { to: 'src/lib.rs', from: 'rust/crate/lib.rs' },
        { to: 'src/main.rs', from: 'rust/crate/main.rs' },
      ];
  return { files: [...shared, ...files], checks, setup: [...MISE_SETUP, 'cargo fetch'] };
}

/** Each `[tools]` key and its raw value in a `mise.toml` fragment, in order. */
function toolLines(text: string): [string, string][] {
  return text.split('\n').flatMap((line) => {
    const match = /^\s*("[^"]+"|[\w.-]+)\s*=\s*(.+?)\s*$/.exec(line);
    return match?.[1] !== undefined && match[2] !== undefined ? [[match[1], match[2]] as [string, string]] : [];
  });
}

/**
 * The root `mise.toml` a language scaffold writes (R11.6): checkride itself,
 * as `npm:checkride` at this release with `node` beside it until a binary
 * ships (D46), then the pack's tools and the repo pack's Node-free ones, each
 * at the version it was tested with. A key a later fragment repeats keeps the
 * first one's version. checkride's entry sets `allow_low_downloads`, without
 * which mise's npm backend refuses a package under 1000 weekly downloads (D80).
 */
function langMiseToml(lang: Exclude<Lang, 'ts'>): string {
  const own = `[tools]\nnode = "22.18.0"\n"npm:checkride" = { version = "${productVersion()}", allow_low_downloads = true }\n`;
  const tools = new Map<string, string>();
  for (const fragment of [own, readTemplate(`${lang}/shared/mise.toml`), readTemplate('repo/shared/mise.toml')]) {
    for (const [key, value] of toolLines(fragment)) if (!tools.has(key)) tools.set(key, value);
  }
  return `[tools]\n${[...tools].map(([key, value]) => `${key} = ${value}`).join('\n')}\n`;
}

/**
 * The `checkride.config.json` a language scaffold writes: one target, `app`,
 * at the root, naming each slot the pack fills by default, the Node-free
 * repo slots beside it, and `requirePins`, since a new project starts pinned
 * (D41).
 */
function langConfigFile(lang: Exclude<Lang, 'ts'>, checks: Record<string, SlotConfig>): string {
  const config = {
    $schema: generatedSchemaUrl(),
    requirePins: true,
    targets: { [LANG_TARGET]: { lang, root: '.', checks } },
    checks: NODE_FREE_REPO_CHECKS,
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** The names a language scaffold's checks run under: the target's, then the repo's. */
function langCheckNames(checks: Record<string, SlotConfig>): string[] {
  return [...Object.keys(checks).map((slot) => `${LANG_TARGET}:${slot}`), ...Object.keys(NODE_FREE_REPO_CHECKS)];
}

/** A language scaffold's README, which names the command the gate runs. */
function langReadme(name: string, lang: Exclude<Lang, 'ts'>): string {
  const language = lang === 'go' ? 'Go' : 'Rust';
  return [
    `# ${name}`,
    '',
    `A ${language} project verified by checkride.`,
    '',
    '```bash',
    'mise exec -- checkride   # run the full pipeline; exit 0 = done',
    '```',
    '',
    'See [AGENTS.md](./AGENTS.md) for the contract agents follow in this repository.',
    '',
  ].join('\n');
}

/** The derived inputs a language scaffold is generated from. */
type LangScaffold = { lang: Exclude<Lang, 'ts'>; shape: Shape; name: string; license: string; author: string | null; vars: Record<string, string> };

/** Resolve a language scaffold's inputs, applying every default. */
function resolveLangScaffold(options: InitOptions, cwd: string): LangScaffold {
  const lang = options.lang === 'go' ? 'go' : 'rust';
  const { name } = resolveProjectName(options, cwd);
  const shape = options.shape ?? LANG_SHAPES[lang][0] ?? 'module';
  const vars = { name, module: options.module ?? `example.com/${name}`, crate: name.replaceAll('-', '_') };
  return { lang, shape, name, license: options.license ?? 'MIT', author: options.author ?? null, vars };
}

/** Emit every file of a language scaffold into `w`. */
async function writeLangScaffold(w: Writer, s: LangScaffold): Promise<string[]> {
  const plan = langPlan(s.lang, s.shape, s.name);
  // The workspace's library crate is `<name>-core`, so its doctest names that crate.
  const crate = s.shape === 'workspace' && s.lang === 'rust' ? `${s.vars['crate'] ?? ''}_core` : (s.vars['crate'] ?? '');
  await Promise.all(plan.files.map((f) => put(w, f.to, render(readTemplate(f.from), { ...s.vars, crate }))));
  const rules = s.lang === 'go' ? ['go-no-dot-import', 'go-no-import-alias', 'go-no-init-func'] : ['rust-no-glob-reexport', 'rust-no-glob-import'];
  await Promise.all(rules.map((rule) => put(w, join('rules', s.lang, `${rule}.yml`), readTemplate(`${s.lang}/shared/rules/${s.lang}/${rule}.yml`))));
  if (s.lang === 'go') await put(w, '.golangci.yml', readTemplate('go/shared/golangci.yml'));
  await put(w, '.gitignore', readTemplate(`${s.lang}/shared/gitignore`));
  await put(w, 'sgconfig.yml', readTemplate('repo/shared/sgconfig.yml'));
  await put(w, '.rumdl.toml', readTemplate('repo/shared/rumdl.toml'));
  await put(w, '_typos.toml', readTemplate('repo/shared/typos.toml'));
  await put(w, 'mise.toml', langMiseToml(s.lang));
  await put(w, 'checkride.config.json', langConfigFile(s.lang, plan.checks));
  await put(w, 'LICENSE', licenseText(s.license, s.author ?? s.name));
  await put(w, 'README.md', langReadme(s.name, s.lang));
  const intro = ['# AGENTS.md', '', 'Instructions for any coding agent working in this repository.', ''].join('\n');
  await put(w, 'AGENTS.md', applyStanza(intro, buildStanza(langCheckNames(plan.checks), { kind: 'mise' })));
  await put(w, 'CLAUDE.md', claudeMd());
  return [...plan.setup, 'mise exec -- checkride'];
}

/**
 * New mode for Go or Rust (R7.5): the shape's files, the pack's configs and
 * dialect rules, a `mise.toml` pinning checkride and every binary tool, and a
 * config naming each slot with `requirePins`. It writes no `package.json`, and
 * prints the setup that needs the network, such as `go get -tool`, which
 * checkride never runs itself.
 */
async function initNewLang(options: InitOptions, cwd: string): Promise<InitResult> {
  const scaffold = resolveLangScaffold(options, cwd);
  if (!(options.force ?? false)) {
    const plan: Writer = { cwd, dryRun: true, written: [], removed: [] };
    await writeLangScaffold(plan, scaffold);
    const collisions = plan.written.filter((rel) => existsSync(join(cwd, rel)));
    if (collisions.length > 0) {
      throw new Error(`init: refusing to overwrite ${collisions.length} existing file(s) (pass --force to overwrite):\n${collisions.map((c) => `  ${c}`).join('\n')}`);
    }
  }
  const w: Writer = { cwd, dryRun: options.dryRun ?? false, written: [], removed: [] };
  const next = await writeLangScaffold(w, scaffold);
  await writeHook(w, options);
  await writeSkills(w, options);
  if (options.stdout) {
    options.stdout.write(`checkride init: generated a ${scaffold.lang} ${scaffold.shape} project (${w.written.length} files)${w.dryRun ? ' [dry run]' : ''}.\n`);
    options.stdout.write(`  next, with the network:\n${next.map((step) => `    ${step}\n`).join('')}`);
  }
  return { mode: 'new', shape: scaffold.shape, written: w.written, removed: w.removed, skipped: [], disabled: [], grandfathered: [], exitCode: 0 };
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
  // A target's check is named `<target>:<slot>`, as `--only` takes it.
  return selectChecks(resolved, {})
    .filter((r) => r.adapter !== null)
    .map(checkName);
}

/**
 * The voice-exemplars directory the repo's config names on its `prose` entry,
 * or `null`. Read fresh at every stanza build rather than threaded from a
 * caller, so the stanza and the config it describes cannot drift apart within
 * one run — `initExisting` writes config between its stanza guard and its
 * stanza write.
 */
function proseExemplarsDir(cwd: string): string | null {
  const entry = loadConfig(cwd)?.checks?.['prose'];
  return entry && typeof entry === 'object' && 'use' in entry && typeof entry.exemplars === 'string'
    ? entry.exemplars
    : null;
}

const STANZA_REFUSALS: Record<'edited' | 'unstamped', string> = {
  edited: 'it has been edited since checkride wrote it',
  unstamped:
    'it predates the stanza stamp and matches no wording checkride has released, so it has been changed since it was written',
};

/**
 * Refuse to refresh a stanza that is not checkride's own output, so a repo's
 * edge-case additions survive the next `init`/`agent-setup` instead of being
 * silently overwritten. `opts.force` overrides.
 *
 * Called before either entry point writes anything, so a refusal leaves the repo
 * exactly as it found it (the same rule `assertNoCollisions` follows in new
 * mode). In existing mode that puts it ahead of the config write, so `body` here
 * reflects the config as it is on disk now rather than as this run will leave
 * it — which no longer costs anything: a stamped stanza is checked against its
 * own stamp, and an unstamped one against a registry of released wordings that
 * ignores the active-checks line entirely. Neither reads `body`'s slot list.
 *
 * Hook management deliberately does not come through here — see the `hooks`
 * command, which never touches AGENTS.md and so has nothing to refuse.
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
  pm: PackageManager,
  skipped: string[],
): Promise<void> {
  const agentsPath = join(cwd, 'AGENTS.md');
  const existing = await readIfExists(agentsPath);
  const nextAgents = applyStanza(existing ?? '', buildStanza(slots, resolveEntry(cwd, pm), proseExemplarsDir(cwd)));
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
  types: [['ts/shared/tsconfig.base.json', 'tsconfig.base.json'], ['ts/flat/tsconfig.json', 'tsconfig.json']],
  format: [['ts/shared/prettierrc.json', '.prettierrc.json']],
  lint: [['ts/shared/oxlintrc.json', '.oxlintrc.json']],
  // `struct` scaffolds the boundary rule and stops. New-mode `init` writes all
  // ten (`writeSharedStatic`), and that is a different bargain: there checkride
  // is creating the package, so its house style has nobody to override. Here the
  // repo already exists and has already decided. `no-class`, `no-default-export`
  // and `require-js-extension` are style and module-system opinions — a repo
  // with classes, default exports, or bundler resolution goes red on adoption
  // for writing the code it always wrote, which reads as checkride being broken.
  // The six layout and barrel rules are the same kind of call, about where tests
  // live and what an `index.ts` may hold.
  // `no-deep-sibling-import` is the one that makes `struct` the slot it is, and
  // failing it means what it says. The other nine stay one copy away, as
  // `docs/deep-modules.md` says.
  struct: [
    ['repo/shared/sgconfig.yml', 'sgconfig.yml'],
    ['ts/shared/rules/no-deep-sibling-import.yml', 'rules/no-deep-sibling-import.yml'],
  ],
  dead: [['ts/flat/fallow.toml', 'fallow.toml']],
  // dupes/health are the same fallow tool + config as `dead`, just other slots.
  dupes: [['ts/flat/fallow.toml', 'fallow.toml']],
  health: [['ts/flat/fallow.toml', 'fallow.toml']],
  test: [['ts/shared/vitest.config.ts.template', 'vitest.config.ts']],
  docs: [['repo/shared/markdownlint-cli2.jsonc', '.markdownlint-cli2.jsonc']],
  spell: [['repo/shared/cspell.json', 'cspell.json']],
  // `prose` is the one slot whose config alone scaffolds nothing usable: vale's
  // .vale.ini is a pointer at a StylesPath, and an empty StylesPath lints
  // nothing. The rules are the deliverable, so they come with it. They are the
  // repo's from the moment they land — plain YAML, no `vale sync`, no upstream
  // to track — which is also why `struct`'s restraint does not apply here:
  // ast-grep's extra rules assert what the repo's code already is, while these
  // assert nothing about code at all, and a prose rule the author disagrees
  // with is deleted in one line.
  prose: [
    ['repo/shared/vale.ini', '.vale.ini'],
    ['repo/shared/styles/Repo/Drift.yml', '.vale/styles/Repo/Drift.yml'],
    ['repo/shared/styles/Repo/Latin.yml', '.vale/styles/Repo/Latin.yml'],
    ['repo/shared/styles/Repo/LyHyphen.yml', '.vale/styles/Repo/LyHyphen.yml'],
    ['repo/shared/styles/Repo/Minted.yml', '.vale/styles/Repo/Minted.yml'],
    ['repo/shared/styles/Repo/ThereIs.yml', '.vale/styles/Repo/ThereIs.yml'],
    ['repo/shared/styles/Repo/Weasel.yml', '.vale/styles/Repo/Weasel.yml'],
  ],
};

/**
 * The blessed configs `--add` scaffolds for a pack whose target-scope slots
 * aren't the ts pack's, by pack, then slot. A slot missing here scaffolds
 * `ADD_CONFIGS`' entry unless that entry is the ts pack's own, so a python
 * root's `docs` still gets the repo pack's markdownlint config.
 */
const PACK_ADD_CONFIGS: Readonly<Record<string, Record<string, [string, string][]>>> = {
  // One ruff.toml configures both ruff check and ruff format.
  python: {
    lint: [['python/shared/ruff.toml', 'ruff.toml']],
    format: [['python/shared/ruff.toml', 'ruff.toml']],
    types: [['python/shared/mypy.ini', 'mypy.ini']],
    test: [['python/shared/pytest.ini', 'pytest.ini']],
  },
  terraform: {
    lint: [['terraform/shared/tflint.hcl', '.tflint.hcl']],
  },
};

/** The files `--add <slot>` scaffolds in a root of `pack`, and whether they're that pack's own, or `undefined` when there are none. */
function addConfigsFor(pack: string, slot: string): { files: [string, string][]; own: boolean } | undefined {
  const own = PACK_ADD_CONFIGS[pack]?.[slot];
  if (own !== undefined) return { files: own, own: true };
  const shared = ADD_CONFIGS[slot];
  return shared === undefined || (pack !== PACKS.ts.name && addsTsOnly(slot)) ? undefined : { files: shared, own: false };
}

/**
 * The config that already configures `slot`'s blessed tool in a root of
 * `pack` at `dir`, such as `pyproject.toml: [tool.ruff]`, or `null`. A new
 * file there would hide that config, as a `ruff.toml` hides the table.
 */
function configuredAt(dir: string, pack: string, slot: string): string | null {
  const blessed = Object.values(PACKS).find((p) => p.name === pack)?.adapters.find((a) => a.slot === slot);
  return blessed === undefined ? null : configuredBy(blessed, dir);
}

/**
 * What `--add <slot>` does in a root of `pack` at `dir`: the files to write,
 * or why it writes none, `configured` when that's because the root
 * configures the slot's tool already. A pack's own configs stand down there.
 */
function slotPlan(dir: string, pack: string, slot: string): { files: [string, string][]; own: boolean } | { skip: string; configured: boolean } {
  const configs = addConfigsFor(pack, slot);
  if (configs === undefined) return { skip: `--add ${slot} (no blessed config to scaffold)`, configured: false };
  const by = configs.own ? configuredAt(dir, pack, slot) : null;
  return by === null ? configs : { skip: `--add ${slot} (${by} configures it already)`, configured: true };
}

/** Write one slot's files, never over one that's there, and a pack's own file once however many slots share it. */
async function writeSlotFiles(w: Writer, configs: { files: [string, string][]; own: boolean }, skipped: string[]): Promise<void> {
  for (const [from, to] of configs.files) {
    if (configs.own && w.written.includes(to)) continue;
    if (existsSync(join(w.cwd, to))) skipped.push(`${to} (exists)`);
    // oxlint-disable-next-line no-await-in-loop -- one-shot `--add` scaffolding: writes are independent and perf-irrelevant, kept sequential for a deterministic progress list.
    else await put(w, to, readTemplate(from));
  }
}

/**
 * `--add <slots>`: scaffold blessed-default configs for the named empty slots
 * in a root of `pack`, adding to `configured` each slot left because the root
 * configures its tool already.
 */
async function addConfigs(
  w: Writer,
  add: readonly string[],
  skipped: string[],
  opts: { pack?: string; configured?: string[] } = {},
): Promise<void> {
  const pack = opts.pack ?? PACKS.ts.name;
  for (const slot of add) {
    const plan = slotPlan(w.cwd, pack, slot);
    if ('skip' in plan) {
      skipped.push(plan.skip);
      if (plan.configured) opts.configured?.push(plan.skip);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one-shot `--add` scaffolding, kept sequential so a file two slots share is written once.
    await writeSlotFiles(w, plan, skipped);
  }
}

/**
 * Scaffold `--add`'s blessed-default configs for `slots` into `dir`, a
 * target's root as well as the repo's, for a root of `pack`, never over a
 * file that's there. Returns what it wrote and what it left, each relative
 * to `dir`, and, of what it left, the slots whose tool the root configures
 * already.
 */
export async function scaffoldSlotConfigs(
  dir: string,
  slots: readonly string[],
  opts: { dryRun: boolean; pack?: string },
): Promise<{ written: string[]; skipped: string[]; configured: string[] }> {
  const w: Writer = { cwd: dir, dryRun: opts.dryRun, written: [], removed: [] };
  const skipped: string[] = [];
  const configured: string[] = [];
  await addConfigs(w, slots, skipped, { ...(opts.pack !== undefined ? { pack: opts.pack } : {}), configured });
  return { written: w.written, skipped, configured };
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
  await put(w, 'checkride.config.json', configFile(checks));
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

/**
 * Print the existing-repo adoption summary: the adopted count, the package
 * manager the alias/stanza/hooks were spelled for (`doctor`'s wording, so one
 * string to pin), and the grandfathered/disabled slots.
 */
function reportExisting(
  stdout: Out,
  pm: PackageManager,
  adopted: readonly InventoryEntry[],
  w: Writer,
  grandfathered: readonly string[],
  disabled: readonly string[],
): void {
  stdout.write(
    `checkride init: adopted ${adopted.length} slot(s); wrote ${w.written.length} file(s)${w.dryRun ? ' [dry run]' : ''}.\n`,
  );
  // A root with no package.json, such as a Go module's, has no package
  // manager in play, and detection would only name its pnpm default.
  if (existsSync(join(w.cwd, 'package.json'))) stdout.write(`  package manager: ${pm} (detected)\n`);
  if (grandfathered.length > 0) {
    stdout.write(`  grandfathered failing slots into ${BASELINE_FILE}: ${grandfathered.join(', ')}\n`);
  }
  if (disabled.length > 0) {
    stdout.write(`  disabled failing slots (enable as you fix): ${disabled.join(', ')}\n`);
  }
}

/** What existing-mode discovery proposed and changed, or `null` when the repo stays as it is. */
type Discovery = { proposed: ProposedTarget[]; changes: string[] };

/** The target-scope slots, whose top-level entries a converted repo's root target takes. */
const TARGET_SLOTS: ReadonlySet<string> = new Set(SLOTS.filter((s) => s.scope !== 'repo').map((s) => s.name));

/**
 * `raw` with `proposed` declared one by one, as `target add` declares each:
 * the root target first, so it takes the implicit target over rather than
 * nesting beside one, and otherwise the implicit target named `app`.
 */
function addedInOrder(raw: Record<string, unknown>, proposed: readonly ProposedTarget[], pack: string): TargetChange {
  const ordered = proposed.toSorted((a, b) => Number(b.root === '.') - Number(a.root === '.'));
  // Existing mode starts from a root that marks a pack, so its implicit target is always kept.
  const rules = { rootName: ordered[0]?.root === '.' ? ordered[0].name : 'app', implicitPack: pack, targetSlots: TARGET_SLOTS, marked: true };
  let change: TargetChange = { config: raw, renames: new Map(), changes: [] };
  for (const target of ordered) {
    const next = addTarget(change.config, target, rules);
    change = { config: next.config, renames: new Map([...change.renames, ...next.renames]), changes: [...change.changes, ...next.changes] };
  }
  return change;
}

/**
 * True when naming the implicit target, rooted at `.`, would nest one of
 * `proposed` of its own pack, which two targets of one pack can't do (V4).
 * Discovery proposes no root target of `pack` exactly when an inner root of
 * it won, as a `go.work` below a root `go.mod`.
 */
function nestsImplicit(proposed: readonly ProposedTarget[], pack: string): boolean {
  const ofPack = proposed.filter((t) => t.lang === pack);
  return ofPack.length > 0 && ofPack.every((t) => t.root !== '.');
}

/**
 * Existing mode's discovery (R11.4, R7.5): when the repo's files propose more
 * than its one implicit target, declare them, converting the config the way
 * `target add` does (the root target, of the pack the root marks (R2.1),
 * takes the top-level slot entries and the baseline's entries), unless
 * `--dry-run`. Where an inner root of the root's pack won, no target sits at
 * the root to take those entries, so they're dropped, as `--discover` drops
 * them, and each is printed. A config that already declares targets has made
 * its choice, and is left alone.
 */
async function applyDiscovery(w: Writer, cwd: string, options: InitOptions): Promise<Discovery | null> {
  const raw = readRawConfig(cwd, () => ({}));
  if (raw['targets'] !== undefined) return null;
  const proposed = await (options.discoverTargets ?? discoverTargets)(cwd);
  const pack = implicitPack(markerAt(cwd));
  if (isImplicit(proposed, pack)) return null;
  // Where an inner root won, the root is no target's, as `--discover` reads it.
  const change = nestsImplicit(proposed, pack)
    ? liftDiscovered(raw, proposed, { implicitPack: pack, targetSlots: TARGET_SLOTS })
    : addedInOrder(raw, proposed, pack);
  const files = await writeTargetChange(cwd, change, { dryRun: w.dryRun, command: 'init' });
  w.written.push(...files.files.map((file) => `${file} (targets)`));
  return { proposed, changes: [...change.changes, ...files.changes] };
}

/** Print the `targets` block discovery proposed, and each change it made, or would have. */
function reportDiscovery(stdout: Out, discovery: Discovery | null, dryRun: boolean): void {
  if (discovery === null) return;
  const block = Object.fromEntries(discovery.proposed.map(({ name, lang, root }) => [name, { lang, root }]));
  const json = `"targets": ${JSON.stringify(block, null, 2)}`.split('\n').map((line) => `    ${line}`).join('\n');
  stdout.write(`  discovered targets${dryRun ? ' (not written: --dry-run)' : ''}:\n${json}\n`);
  for (const line of discovery.changes) stdout.write(`    ${line}\n`);
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
  const pm = detectPackageManager({ cwd });

  // Before the first write: a stanza this repo has customized stops the run
  // rather than being clobbered by the refresh below.
  await assertStanzaUnedited(
    cwd,
    buildStanza(activeCheckSlots(cwd, slots, adapters), resolveEntry(cwd, pm), proseExemplarsDir(cwd)),
    options,
  );

  // Route --add: publish slots (and the library path) opt into the bundle; the
  // rest scaffold blessed configs before inventory, so they're detected this run.
  const { publishRequested, fileAdds } = splitAdd(options.add ?? [], manifest);
  await addConfigs(w, fileAdds, skipped, { pack: implicitPack(markerAt(cwd)) });

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
  const discovery = await applyDiscovery(w, cwd, options);
  await ensureGitignore(w, cwd, skipped);
  // package.json: add the `check: checkride` alias if missing.
  await addCheckAlias(w, skipped);
  // AGENTS.md stanza (create or refresh, idempotent), derived from the config
  // written above so it reports the gate as configured, not as detected.
  await writeAgentsStanza(w, cwd, activeCheckSlots(cwd, slots, adapters), pm, skipped);
  await writeClaudePointer(w, cwd, skipped);
  // Claude Code Stop hook (opt-out), using the repo's detected PM.
  await writeHook(w, options, skipped);
  await writeSkills(w, options, skipped);

  if (options.stdout) {
    reportExisting(options.stdout, pm, adopted, w, grandfathered, disabled);
    reportDiscovery(options.stdout, discovery, w.dryRun);
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

/**
 * The root file that makes `cwd` an existing project for init to adopt: a
 * `package.json`, or a root marker of another pack that ships, such as a
 * `go.mod` or a `Cargo.toml` (R2.1). `null` for a directory init scaffolds a
 * new project into.
 */
function existingMarker(cwd: string): string | null {
  const others = Object.values(PACKS).filter((p) => p.name !== PACKS.ts.name).flatMap((p) => p.markers);
  const marker = ['package.json', ...others].find(markerAt(cwd));
  // A glob marker names a kind of file: `*.tf` reads as a `.tf file`.
  return marker === undefined ? null : marker.startsWith('*') ? `${marker.slice(1)} file` : marker;
}

/** Detect new vs existing: existing when the root holds a `package.json` or another shipped pack's marker. */
export function detectMode(cwd: string): 'new' | 'existing' {
  return existingMarker(cwd) === null ? 'new' : 'existing';
}

/**
 * The usage error for a `--lang` and `--shape` pair that doesn't go
 * together, or a `--lang` other than `ts` where `marker` puts init in
 * existing mode, which reads the repo's languages for itself; `null` when
 * they fit.
 */
function langProblem(options: InitOptions, marker: string | null): string | null {
  const lang = options.lang ?? 'ts';
  const shapes = LANG_SHAPES[lang];
  if (options.shape !== undefined && !shapes.includes(options.shape)) {
    return `init: --lang ${lang} takes --shape ${shapes.join(' | ')}, not '${options.shape}'`;
  }
  if (marker !== null && lang !== 'ts') {
    return `init: --lang ${lang} scaffolds a new project, and this directory has a ${marker}; run it in an empty directory`;
  }
  return null;
}

/** Whether `--add <name>` scaffolds or enables something only the ts pack runs: a `templates/ts/` config, or the publish bundle. */
function addsTsOnly(name: string): boolean {
  if (PUBLISH_BUNDLE_ALIASES.has(name) || (PUBLISH_BUNDLE_SLOTS as readonly string[]).includes(name)) return true;
  return (ADD_CONFIGS[name] ?? []).some(([from]) => from.startsWith('ts/'));
}

/**
 * The usage error for an `--add` in a root whose implicit pack (R2.1) isn't
 * `ts`, when it names a slot whose blessed config is the ts pack's: an
 * `.oxlintrc.json` or a `tsconfig.json` beside a `go.mod` configures a tool
 * the root's pack never runs. `null` when every name fits, as it always does
 * in a new project's empty directory, whose pack is `ts`.
 */
function addProblem(options: InitOptions, cwd: string): string | null {
  const pack = implicitPack(markerAt(cwd));
  const own = PACK_ADD_CONFIGS[pack] ?? {};
  const refused = pack === PACKS.ts.name ? [] : (options.add ?? []).filter((name) => !Object.hasOwn(own, name) && addsTsOnly(name));
  if (refused.length === 0) return null;
  const fits = Object.keys(ADD_CONFIGS).filter((name) => Object.hasOwn(own, name) || !addsTsOnly(name));
  return `init: --add ${refused.join(', ')} scaffolds the ts pack's config, and this root's pack is ${pack}; --add takes ${fits.join(', ')} here`;
}

/** Run `checkride init` against `cwd`. */
export async function runInit(options: InitOptions): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd();
  const marker = existingMarker(cwd);
  const problem = langProblem(options, marker) ?? addProblem(options, cwd);
  if (problem !== null) throw new Error(problem);
  if (marker !== null) return initExisting(options, cwd);
  return (options.lang ?? 'ts') === 'ts' ? initNew(options, cwd) : initNewLang(options, cwd);
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
  const pm = detectPackageManager({ cwd });

  // Before the first write: a stanza this repo has customized stops the run
  // rather than being clobbered by the refresh below.
  await assertStanzaUnedited(cwd, buildStanza(stanzaSlots, resolveEntry(cwd, pm), proseExemplarsDir(cwd)), options);

  // The `check` alias the hook's `<pm> run check` resolves to (never clobbers).
  await addCheckAlias(w, skipped);

  // AGENTS.md stanza for the checks the default run selects (create or refresh).
  await writeAgentsStanza(w, cwd, stanzaSlots, pm, skipped);

  await writeHook(w, options, skipped);
  await writeSkills(w, options, skipped);

  if (options.stdout) {
    const removed = w.removed.length > 0 ? `, removed ${w.removed.length}` : '';
    options.stdout.write(
      `checkride agent-setup: wrote ${w.written.length} file(s)${removed}${w.dryRun ? ' [dry run]' : ''}.\n`,
    );
    options.stdout.write(`  package manager: ${pm} (detected)\n`);
  }
  return { written: w.written, removed: w.removed, skipped, exitCode: 0 };
}

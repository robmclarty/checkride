import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ADAPTERS, SLOTS } from '../adapters.js';
import { CLAUDE_SETTINGS_FILE, GATE_SCRIPT_FILE, runHooks } from '../agent-setup/index.js';
import { runBaseline } from '../baseline-command.js';
import type { CheckrideConfig, ResolvedCheck } from '../config.js';
import { configSchemaUrl, loadConfig, resolveChecks } from '../config.js';
import { applyStanza, buildStanza, detectMode, inspectStanza, inventory, runAgentSetup, runInit } from '../init.js';
import type { CheckRunner } from '../orchestrator/index.js';
import { selectChecks } from '../orchestrator/index.js';
import { RELEASED_STANZAS } from './fixtures/released-stanzas.js';

/** A capturing stdout for the few tests that read init's summary lines. */
function sink(): { write: (text: string) => boolean; text: () => string } {
  const chunks: string[] = [];
  return { write: (text) => { chunks.push(text); return true; }, text: () => chunks.join('') };
}

describe('AGENTS stanza (idempotency)', () => {
  const body = buildStanza(['types', 'lint', 'spell']);

  test('inserts a stanza into existing content', () => {
    const out = applyStanza('# AGENTS.md\n\nintro\n', body);
    expect(out).toMatch(/<!-- checkride:begin hash=v1[0-9a-f]{16} -->/);
    expect(out).toContain('<!-- checkride:end -->');
    expect(out.startsWith('# AGENTS.md')).toBe(true);
  });

  test('creates a body when content is empty', () => {
    const out = applyStanza('', body);
    expect(out.startsWith('<!-- checkride:begin hash=')).toBe(true);
  });

  test('applying twice is a no-op (refresh in place)', () => {
    const once = applyStanza('# AGENTS.md\n\nintro\n', body);
    expect(applyStanza(once, body)).toBe(once);

    const fromEmpty = applyStanza('', body);
    expect(applyStanza(fromEmpty, body)).toBe(fromEmpty);
  });

  test('names the fuller path without displacing the prose procedure', () => {
    // The stanza lands in repos that will never install the plugin, so the
    // standalone procedure stays primary and the reader is one added line.
    expect(body).toContain('1. Read `.check/summary.json` to see which check failed.');
    expect(body).toContain("2. Read that check's raw output");
    expect(body).toContain('3. Fix the root cause, then re-run.');
    // The command works in every harness; the two skill spellings are asides.
    expect(body).toContain('`pnpm exec checkride triage` runs this procedure in full');
  });

  test('names both harnesses’ gate config, since the stanza is harness-neutral', () => {
    expect(body).toContain('.claude/settings.json');
    expect(body).toContain('.cursor/hooks.json');
    // AGENTS.md is the one contract file every harness reads; it must not
    // assume the reader is Claude Code.
    expect(body).not.toContain('Claude Code');
  });

  test('never promises the gate ran everything, since a profile can narrow it', () => {
    // A repo can set `gate` in checkride.config.json, and then the hook's green
    // covers a subset. The stanza is written once and the config moves on
    // without it, so it must not name a profile or call any gate run
    // authoritative — it points at the verdict, which is generated per run and
    // names its narrowing when there was one.
    expect(body).toContain('names its narrowing');
    expect(body).toContain('`pnpm check` in full before you claim');
    expect(body).not.toMatch(/authoritative|runs the full `pnpm check` as the final gate/);
  });

  test('prescribes no house style: struct points at the rules, it does not restate them', () => {
    // The stanza is the one region a repo cannot edit back, so it must not
    // dictate architecture. checkride's ast-grep defaults ban classes and
    // default exports; a repo that wants either just deletes those rule files,
    // and the stanza has to stay true when it does.
    const struct = buildStanza(['types', 'struct']);
    expect(struct).toContain('### Module boundaries');
    expect(struct).toContain('whatever ast-grep rules `sgconfig.yml` points at');
    for (const s of [struct, body]) {
      expect(s).not.toMatch(/no classes|Named exports only|barrel `index\.ts`/);
    }
  });

  test('omits the struct section entirely when struct is not an active check', () => {
    expect(body).not.toContain('### Module boundaries');
    expect(body).not.toContain('sgconfig.yml');
  });

  test('names the voice exemplars, read-and-imitate but never edit, when config carries them', () => {
    // The exemplars are hand-written anchor texts — the human original the
    // stanza tells sessions to copy. An agent "improving" one would replace
    // that original with model output, so the instruction must run one way.
    const voiced = buildStanza(['types', 'prose'], 'pnpm', 'docs/voice');
    expect(voiced).toContain('### Prose voice');
    expect(voiced).toContain('`docs/voice`');
    expect(voiced).toContain('never edit, rewrite, or add to them');
    // Without a configured directory the section has nothing to point at.
    expect(buildStanza(['types', 'prose'])).not.toContain('### Prose voice');
  });

  test('spells every command for the repo’s package manager, not pnpm’s', () => {
    // The stanza is a list of commands an agent is told to run. `pnpm check` in
    // an npm repo is an instruction that cannot succeed, so the agent either
    // invents a substitute or reports the pipeline as broken.
    const npm = buildStanza(['types'], 'npm');
    expect(npm).not.toContain('pnpm');
    expect(npm).toContain('`npm run check` is the single source of truth');
    expect(npm).toContain('`npm run check --bail`');
    expect(npm).toContain('`npx --no-install checkride triage` runs this procedure');

    // `yarn check` is Yarn 1's integrity checker, not the repo's script.
    expect(buildStanza(['types'], 'yarn')).toContain('`yarn run check` is red');
    expect(buildStanza(['types'], 'bun')).toContain('`bun run check` is red');
    // pnpm's shorthand is real, and stays the default for callers without a repo.
    expect(buildStanza(['types'], 'pnpm')).toContain('`pnpm check` is red');
    expect(buildStanza(['types'])).toBe(buildStanza(['types'], 'pnpm'));
  });

  test('in a repo with no package.json, every command runs the checkride mise pins, or the one on PATH (R6.6)', () => {
    const pinned = buildStanza(['types'], { kind: 'mise' });
    expect(pinned).toContain('`mise exec -- checkride` is the single source of truth');
    expect(pinned).toContain('`mise exec -- checkride --bail`');
    expect(pinned).toContain('`mise exec -- checkride triage` runs this procedure');
    const bare = buildStanza(['types'], { kind: 'path' });
    expect(bare).toContain('`checkride` is the single source of truth');
    expect(bare).toContain('`checkride triage` runs this procedure');
    expect(bare).not.toMatch(/pnpm|npx/);
  });

  test('names a target’s checks the way --only takes them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'checkride-stanza-targets-'));
    try {
      await mkdir(join(dir, 'apps', 'web'), { recursive: true });
      await writeFile(join(dir, 'apps', 'web', '.oxlintrc.json'), '{}');
      await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ targets: { web: { lang: 'ts', root: 'apps/web' } } }));
      await runAgentSetup({ cwd: dir });
      expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toContain('Active checks in this repo: web:lint, links, unclaimed.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('refreshes only the marked region, leaving the rest untouched', () => {
    const original = applyStanza('# Title\n\nkeep me\n', buildStanza(['types']));
    const refreshed = applyStanza(original, buildStanza(['types', 'lint']));
    expect(refreshed).toContain('keep me');
    expect(refreshed).toContain('types, lint');
    expect(refreshed.match(/checkride:begin/g)).toHaveLength(1);
  });
});

/** A stanza as checkride wrote it before v0.10.1: same markers, no hash. */
function legacy(text: string): string {
  return `<!-- checkride:begin -->\n\n${text}\n\n<!-- checkride:end -->\n`;
}

describe('AGENTS stanza (edit detection)', () => {
  const body = buildStanza(['types', 'lint']);
  const stanza = applyStanza('# AGENTS.md\n\nintro\n', body);

  test('a file with no stanza is absent, and checkride’s own output is pristine', () => {
    expect(inspectStanza('# AGENTS.md\n\nintro\n', body)).toBe('absent');
    expect(inspectStanza('', body)).toBe('absent');
    expect(inspectStanza(stanza, body)).toBe('pristine');
  });

  test('a stanza whose active-check line moved on is still pristine', () => {
    // The stamp travels with the block, so a refresh that would *change* the
    // stanza is not an edit — only a change already on disk is.
    expect(inspectStanza(stanza, buildStanza(['types', 'lint', 'spell']))).toBe('pristine');
  });

  test('an addition inside the markers reads as edited', () => {
    const edited = stanza.replace('### Baseline', '### This repo\n\nSkip `spell` on vendored files.\n\n### Baseline');
    expect(inspectStanza(edited, body)).toBe('edited');
  });

  test('edits outside the markers are not edits: that is where customization belongs', () => {
    expect(inspectStanza(`${stanza}\n## Repo-specific\n\nanything at all\n`, body)).toBe('pristine');
    expect(inspectStanza(`## First\n\nmine\n\n${stanza}`, body)).toBe('pristine');
  });

  test('reformatting is not an edit: line endings and trailing spaces are ignored', () => {
    expect(inspectStanza(stanza.replace(/\n/g, '\r\n'), body)).toBe('pristine');
    expect(inspectStanza(stanza.replace(/\n/g, '   \n'), body)).toBe('pristine');
  });

  test('a stanza with no end marker reads as edited, not absent', () => {
    // Treating it as absent would append a second block — the same data loss.
    expect(inspectStanza(stanza.replace('<!-- checkride:end -->', ''), body)).toBe('edited');
  });

  test('refreshing over an orphaned begin marker leaves one block, not two', () => {
    // Only reachable under --force, and the outcome has to stay coherent: two
    // begin markers would make the *next* refresh treat everything between the
    // first begin and the last end as checkride's, and swallow it.
    const orphaned = `${stanza.replace('<!-- checkride:end -->', '')}\n## Mine\n\nkeep me\n`;
    const refreshed = applyStanza(orphaned, body);
    expect(refreshed.match(/checkride:begin/g)).toHaveLength(1);
    expect(refreshed).toContain('keep me');
    expect(inspectStanza(refreshed, body)).toBe('pristine');
  });

  test('an unstamped stanza matching today’s text is pristine', () => {
    expect(inspectStanza(legacy(body), body)).toBe('pristine');
    expect(inspectStanza(legacy(`${body}\n\nSkip \`spell\` on vendored files.`), body)).toBe('unstamped');
  });

  describe('legacy wording registry', () => {
    /**
     * Every pre-stamp release is a stanza sitting in a real repo right now.
     * Before the registry, upgrading made all of them look `unstamped`, and the
     * refusal that followed wrote *nothing* — which is how 0.10.1's gate-timeout
     * fix failed to reach the repos whose gate had stopped gating.
     */
    test('recognizes every wording checkride shipped, whatever the repo’s active checks', () => {
      expect(RELEASED_STANZAS).toHaveLength(4);
      for (const { range, body: released } of RELEASED_STANZAS) {
        expect(inspectStanza(legacy(released), body), range).toBe('pristine');
        // The fixture is captured with `types, lint`; a real repo has its own.
        const other = released.replace(/^Active checks in this repo:.*$/m, 'Active checks in this repo: spell, docs, links.');
        expect(other).not.toBe(released);
        expect(inspectStanza(legacy(other), body), `${range} (other slots)`).toBe('pristine');
      }
    });

    test('still refuses a legacy stanza someone edited', () => {
      const released = RELEASED_STANZAS[2]?.body ?? '';
      const edited = released.replace('### Baseline', '### This repo\n\nSkip `spell` on vendored files.\n\n### Baseline');
      expect(inspectStanza(legacy(edited), body)).toBe('unstamped');
      // Appending inside the markers puts text after the active-checks line, so
      // nothing is stripped and the preamble digest cannot match by accident.
      expect(inspectStanza(legacy(`${released}\n\nAnd one more rule.`), body)).toBe('unstamped');
    });

    test('agent-setup still refuses an edited stanza, hook flags and all', async () => {
      // The other half of the `hooks` command's reason for existing: this run is
      // still blocked, which is why hook management needed its own door out.
      const dir = await mkdtemp(join(tmpdir(), 'checkride-refuse-'));
      try {
        await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo' }));
        await runAgentSetup({ cwd: dir });
        const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
        await writeFile(join(dir, 'AGENTS.md'), agents.replace('### Baseline', '### Mine\n\nkeep\n\n### Baseline'));
        await expect(runAgentSetup({ cwd: dir, removeHooks: ['gate'] })).rejects.toThrow('refusing to overwrite');
        // The refusal is a full stop: the hook it was asked to remove is intact.
        expect(existsSync(join(dir, GATE_SCRIPT_FILE))).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    /**
     * The `unstamped` half of the same pairing, and the state a consumer on an
     * older or forked checkride actually lands in. `agent-setup` refuses it and
     * — by contract — writes nothing, which before the `hooks` command meant a
     * repo could not uninstall its own gate: `--remove-hook` threw on the stanza
     * guard and the scripts had to be deleted by hand.
     *
     * Uninstalling the gate must never require permission to rewrite the repo's
     * contract file. (`agent-setup/__tests__/command.test.ts` holds the other
     * side: that `hooks` leaves this AGENTS.md byte-identical.)
     */
    test('hooks removes the gate from a repo agent-setup refuses for an unstamped stanza', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'checkride-unstamped-'));
      try {
        await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo' }));
        await runAgentSetup({ cwd: dir });
        const unstamped = legacy('## Checkride: the definition of done\n\nA wording checkride never shipped.');
        await writeFile(join(dir, 'AGENTS.md'), unstamped);
        expect(inspectStanza(unstamped, buildStanza(['types', 'lint']))).toBe('unstamped');

        await expect(runAgentSetup({ cwd: dir, removeHooks: ['gate'] })).rejects.toThrow('refusing to overwrite');
        expect(existsSync(join(dir, GATE_SCRIPT_FILE))).toBe(true);

        // The door out: hook management does not go through the stanza guard.
        await runHooks({ cwd: dir, action: 'remove', hooks: ['gate'] });
        expect(existsSync(join(dir, GATE_SCRIPT_FILE))).toBe(false);
        expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(unstamped);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('a recognized legacy stanza refreshes and comes back stamped', () => {
      // The point of recognizing it: the run proceeds, and the next one needs no
      // registry at all because what it wrote carries its own stamp.
      const released = RELEASED_STANZAS[2]?.body ?? '';
      const refreshed = applyStanza(`# AGENTS.md\n\nintro\n\n${legacy(released)}`, body);
      expect(refreshed).toContain('<!-- checkride:begin hash=v1');
      expect(refreshed).toContain('intro');
      expect(refreshed.match(/checkride:begin/g)).toHaveLength(1);
      expect(inspectStanza(refreshed, body)).toBe('pristine');
    });
  });
});

describe('adoption inventory', () => {
  test('reports adopted vs empty per default slot', () => {
    const items = inventory({ fileExists: (f) => f === 'tsconfig.json' || f === 'biome.json' });
    const bySlot = new Map(items.map((i) => [i.slot, i]));
    expect(bySlot.get('types')).toMatchObject({ status: 'adopted', adapter: 'tsc' });
    expect(bySlot.get('lint')).toMatchObject({ status: 'adopted', adapter: 'biome' });
    expect(bySlot.get('struct')?.status).toBe('empty');
    expect(bySlot.get('links')?.status).toBe('adopted'); // built-in, always available
    expect(bySlot.has('mutation')).toBe(false); // opt-in slots are excluded
  });
});

describe('detectMode', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-mode-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('new when there is no package.json', () => {
    expect(detectMode(dir)).toBe('new');
  });
  test('existing when package.json is present', async () => {
    await writeFile(join(dir, 'package.json'), '{}');
    expect(detectMode(dir)).toBe('existing');
  });
  test.each(['go.mod', 'go.work', 'Cargo.toml', 'pyproject.toml', 'setup.cfg', 'setup.py'])('existing when another shipped pack marks the root with %s', async (marker) => {
    await writeFile(join(dir, marker), '');
    expect(detectMode(dir)).toBe('existing');
  });
  test('new when only a pack that has not shipped marks the root', async () => {
    await writeFile(join(dir, '.terraform.lock.hcl'), '');
    expect(detectMode(dir)).toBe('new');
  });
});

/** The ast-grep rules new mode ships: four style rules, then the six layout and barrel rules. */
const NEW_MODE_RULES = [
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

describe('new-project generation (flat)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-new-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('writes a complete flat project', async () => {
    const result = await runInit({ cwd: dir, shape: 'flat', name: 'demo', checkrideSpec: '^0.1.0' });
    expect(result.mode).toBe('new');
    expect(result.shape).toBe('flat');
    for (const f of ['package.json', 'tsconfig.json', 'tsconfig.base.json', 'tsconfig.test.json', 'fallow.toml', 'pnpm-workspace.yaml', '.oxlintrc.json', 'cspell.json', 'vitest.config.ts', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'LICENSE', 'src/index.ts', 'src/demo.ts', 'src/__tests__/demo.test.ts', 'rules/no-class.yml']) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    // colocate-unit-tests would fail the scaffold's own struct check on a loose test.
    expect(existsSync(join(dir, 'src', 'index.test.ts'))).toBe(false);
    const pkg: { scripts: Record<string, string>; devDependencies: Record<string, string> } =
      JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(pkg.scripts['check']).toBe('checkride');
    expect(pkg.devDependencies['checkride']).toBe('^0.1.0');
    expect(pkg.devDependencies['oxlint']).toBeDefined();

    const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('Active checks in this repo: types, lint, struct, dead, test, docs, links, spell, typecheck-tests.');
    expect(agents).toContain('`pnpm exec checkride triage` runs this procedure in full');
  });

  test.each(['flat', 'monorepo', 'hybrid'] as const)('ships all ten rules, verbatim from the templates (%s)', async (shape) => {
    await runInit({ cwd: dir, shape, name: 'demo', scope: '@demo', checkrideSpec: '^0.1.0' });
    expect((await readdir(join(dir, 'rules'))).toSorted()).toEqual(NEW_MODE_RULES.toSorted());
    const templates = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'ts', 'shared', 'rules');
    for (const rule of NEW_MODE_RULES) {
      expect(await readFile(join(dir, 'rules', rule), 'utf8'), rule).toBe(await readFile(join(templates, rule), 'utf8'));
    }
  });

  test.each(['flat', 'monorepo', 'hybrid'] as const)('writes a config naming every slot the scaffold enables, then typecheck-tests (%s)', async (shape) => {
    await runInit({ cwd: dir, shape, name: 'demo', scope: '@demo', checkrideSpec: '^0.1.0' });
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const own: { version: string } = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    const slots = {
      types: 'tsc',
      lint: 'oxlint',
      struct: 'ast-grep',
      dead: 'fallow',
      test: 'vitest',
      docs: 'markdownlint-cli2',
      links: 'links',
      spell: 'cspell',
    };
    expect(JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8'))).toEqual({
      $schema: configSchemaUrl(own.version),
      checks: {
        ...slots,
        'typecheck-tests': {
          command: 'pnpm',
          args: ['exec', 'tsc', '-p', 'tsconfig.test.json'],
          description: 'Type-check the tests outside src/',
          note: expect.any(String),
        },
      },
    });
    expect(await readFile(join(dir, 'tsconfig.test.json'), 'utf8')).toBe(
      await readFile(join(repoRoot, 'templates', 'ts', 'shared', 'tsconfig-test.json'), 'utf8'),
    );

    // Detection alone would run exactly these slots off the scaffold's own
    // files, and with the config each one runs because the config names it.
    const defaultRun = (config: CheckrideConfig | null): ResolvedCheck[] =>
      selectChecks(resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, cwd: dir }), {});
    expect(Object.fromEntries(defaultRun(null).map((r) => [r.slot, r.adapter?.name]))).toEqual(slots);
    expect(Object.fromEntries(defaultRun(loadConfig(dir)).map((r) => [r.slot, r.origin]))).toEqual({
      ...Object.fromEntries(Object.keys(slots).map((slot) => [slot, 'config'])),
      'typecheck-tests': 'custom',
    });
  });

  test.each(['flat', 'monorepo', 'hybrid'] as const)('the stanza lists every check the config names, so agent-setup finds it current (%s)', async (shape) => {
    await runInit({ cwd: dir, shape, name: 'demo', scope: '@demo', checkrideSpec: '^0.1.0' });
    const setup = await runAgentSetup({ cwd: dir, hook: false });
    expect(setup.written).toEqual([]);
    expect(setup.skipped).toContain('AGENTS.md (stanza unchanged)');
  });

  test('default checkride spec pins the exact product version (no caret)', async () => {
    await runInit({ cwd: dir, shape: 'flat', name: 'demo' });
    const pkg: { devDependencies: Record<string, string> } =
      JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const own: { version: string } = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['checkride']).toBe(own.version);
  });

  test('--dry-run writes nothing', async () => {
    const result = await runInit({ cwd: dir, shape: 'flat', name: 'demo', dryRun: true });
    expect(result.written.length).toBeGreaterThan(10);
    expect(existsSync(join(dir, 'package.json'))).toBe(false);
  });

  test('generates a monorepo with an app and a lib package', async () => {
    const result = await runInit({ cwd: dir, shape: 'monorepo', name: 'demo', scope: '@demo', checkrideSpec: '^0.1.0' });
    expect(result.shape).toBe('monorepo');
    for (const f of ['apps/demo/src/index.ts', 'apps/demo/src/demo.ts', 'apps/demo/src/__tests__/demo.test.ts', 'apps/demo/package.json', 'apps/demo/tsconfig.json', 'libs/core/src/index.ts', 'libs/core/src/core.ts', 'libs/core/src/__tests__/core.test.ts', 'libs/core/package.json']) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    const appPkg: { name: string } = JSON.parse(await readFile(join(dir, 'apps', 'demo', 'package.json'), 'utf8'));
    expect(appPkg.name).toBe('@demo/demo');
    // root tsconfig is the solution config referencing the packages
    const tsconfig = await readFile(join(dir, 'tsconfig.json'), 'utf8');
    expect(tsconfig).toContain('./apps/demo');
  });

  test('generates a hybrid project with a root app plus a package', async () => {
    const result = await runInit({ cwd: dir, shape: 'hybrid', name: 'demo', checkrideSpec: '^0.1.0' });
    expect(result.shape).toBe('hybrid');
    for (const f of ['src/index.ts', 'src/demo.ts', 'src/__tests__/demo.test.ts', 'packages/core/src/index.ts', 'packages/core/src/core.ts', 'packages/core/src/__tests__/core.test.ts', 'packages/core/package.json']) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
  });

  test('refuses to overwrite existing files (exit 2), listing every collision and writing nothing', async () => {
    await writeFile(join(dir, 'README.md'), '# keep me\n');
    await writeFile(join(dir, '.gitignore'), 'node_modules\n');

    await expect(
      runInit({ cwd: dir, shape: 'flat', name: 'demo' }),
    ).rejects.toThrow(/refusing to overwrite[\s\S]*README\.md[\s\S]*\.gitignore|refusing to overwrite[\s\S]*\.gitignore[\s\S]*README\.md/);

    // Nothing else was scaffolded, and the colliding files are untouched.
    expect(existsSync(join(dir, 'package.json'))).toBe(false);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('# keep me\n');
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n');
  });

  test('refuses to overwrite a checkride.config.json that is already there', async () => {
    const mine = '{ "checks": { "spell": false } }\n';
    await writeFile(join(dir, 'checkride.config.json'), mine);
    await expect(runInit({ cwd: dir, shape: 'flat', name: 'demo' })).rejects.toThrow(
      /refusing to overwrite 1 existing file[\s\S]*checkride\.config\.json/,
    );
    expect(await readFile(join(dir, 'checkride.config.json'), 'utf8')).toBe(mine);
    expect(existsSync(join(dir, 'package.json'))).toBe(false);
  });

  test('--force overwrites existing files and generates the project', async () => {
    await writeFile(join(dir, 'README.md'), '# stale\n');
    const result = await runInit({ cwd: dir, shape: 'flat', name: 'demo', force: true, checkrideSpec: '^0.1.0' });
    expect(result.mode).toBe('new');
    expect(existsSync(join(dir, 'package.json'))).toBe(true);
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toContain('# demo');
  });

  test('the value lives in a named module, the barrel only re-exports it, and the smoke test imports the barrel', async () => {
    await runInit({ cwd: dir, shape: 'flat', name: 'my-app' });
    const src = await readFile(join(dir, 'src', 'my-app.ts'), 'utf8');
    const barrel = await readFile(join(dir, 'src', 'index.ts'), 'utf8');
    const spec = await readFile(join(dir, 'src', '__tests__', 'my-app.test.ts'), 'utf8');
    expect(src).toBe("export const MY_APP = 'my-app';\n");
    expect(barrel).toBe("export { MY_APP } from './my-app.js';\n");
    expect(spec).toContain("import { MY_APP } from '../index.js';");
    expect(spec).toContain("expect(MY_APP).toBe('my-app');");
  });

  test.each([
    ['My Cool App', 'my-cool-app'],
    ['index', 'app'],
    ['___', 'app'],
  ])('names the starter module safely for %j', async (name, stem) => {
    await runInit({ cwd: dir, shape: 'flat', name });
    expect(existsSync(join(dir, 'src', `${stem}.ts`))).toBe(true);
    expect(existsSync(join(dir, 'src', '__tests__', `${stem}.test.ts`))).toBe(true);
    expect(await readFile(join(dir, 'src', 'index.ts'), 'utf8')).toContain(`from './${stem}.js';`);
  });
});

const noFailures = (): Promise<string[]> => Promise.resolve([]);

/** Discovery proposing a bash target ahead of the root one, as a repo's packs can't yet. */
const scriptsFirst = (): Promise<{ name: string; lang: string; root: string }[]> =>
  Promise.resolve([{ name: 'scripts', lang: 'bash', root: 'scripts' }, { name: 'app', lang: 'ts', root: '.' }]);

/** Discovery proposing only a bash target, as a repo whose root no ts target claims would. */
const scriptsOnly = (): Promise<{ name: string; lang: string; root: string }[]> =>
  Promise.resolve([{ name: 'scripts', lang: 'bash', root: 'scripts' }]);

describe('existing-project adoption (idempotent)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-existing-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('announces the detected package manager as the first line under the headline', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await writeFile(join(dir, 'package-lock.json'), '{}');
    const out = sink();
    await runInit({ cwd: dir, probeFailures: noFailures, stdout: out });
    const lines = out.text().split('\n');
    expect(lines[0]).toMatch(/^checkride init: adopted \d+ slot\(s\); wrote \d+ file\(s\)\.$/);
    expect(lines[1]).toBe('  package manager: npm (detected)');
  });

  test('discovery that proposes only the root target keeps the repo implicit, and says nothing (R11.4)', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await mkdir(join(dir, 'scripts'));
    await writeFile(join(dir, 'scripts', 'deploy.sh'), '#!/bin/sh\n');
    const out = sink();
    await runInit({ cwd: dir, probeFailures: noFailures, stdout: out });
    expect(JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8'))).not.toHaveProperty('targets');
    expect(out.text()).not.toContain('discovered targets');
  });

  test('discovered targets are printed and written, the root target taking the adopted entries and the baseline’s keys', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await writeFile(join(dir, '.oxlintrc.json'), '{}');
    await mkdir(join(dir, 'scripts'));
    await writeFile(join(dir, 'checkride.baseline.json'), JSON.stringify({ schema_version: 1, slots: { lint: ['a.ts:no-x:bad'] } }));
    const out = sink();
    const result = await runInit({ cwd: dir, probeFailures: noFailures, stdout: out, discoverTargets: scriptsFirst });
    const cfg = JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8')) as Record<string, unknown>;
    expect(cfg['targets']).toEqual({
      app: { lang: 'ts', root: '.', checks: { lint: 'oxlint' } },
      scripts: { lang: 'bash', root: 'scripts' },
    });
    expect((cfg['checks'] as Record<string, unknown>)['lint']).toBeUndefined();
    expect(JSON.parse(await readFile(join(dir, 'checkride.baseline.json'), 'utf8')).slots).toEqual({ 'app:lint': ['a.ts:no-x:bad'] });
    expect(out.text()).toMatch(/discovered targets:\n {4}"targets": \{\n {6}"scripts": \{/);
    expect(out.text()).toContain('checkride.baseline.json: lint renamed app:lint (1 key)');
    expect(result.written).toContain('checkride.config.json (targets)');
    // The stanza lists the checks as the config now names them.
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toContain('app:lint');
  });

  test('--dry-run prints the discovered targets and writes nothing, and a config that already declares targets is left alone', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await mkdir(join(dir, 'scripts'));
    const out = sink();
    await runInit({ cwd: dir, probeFailures: noFailures, stdout: out, discoverTargets: scriptsFirst, dryRun: true });
    expect(out.text()).toContain('discovered targets (not written: --dry-run):');
    expect(existsSync(join(dir, 'checkride.config.json'))).toBe(false);

    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ targets: { web: { lang: 'ts', root: '.' } } }));
    const kept = sink();
    await runInit({ cwd: dir, probeFailures: noFailures, stdout: kept, discoverTargets: scriptsFirst });
    expect(kept.text()).not.toContain('discovered targets');
    expect(JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8'))).toEqual({ targets: { web: { lang: 'ts', root: '.' } } });
  });

  test('a go.mod root with no package.json adopts the go pack’s tools, and writes no package.json (R2.1)', async () => {
    await writeFile(join(dir, 'go.mod'), 'module example.com/legacy\n\ngo 1.24\n');
    await writeFile(join(dir, '.golangci.yml'), 'version: "2"\n');
    const result = await runInit({ cwd: dir, probeFailures: noFailures, hook: false });
    expect(result.mode).toBe('existing');
    const cfg = JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8')) as { checks: Record<string, unknown> };
    expect(cfg.checks).toMatchObject({ types: 'go-build', lint: 'golangci-lint', test: 'go-test' });
    expect(cfg).not.toHaveProperty('targets');
    expect(existsSync(join(dir, 'package.json'))).toBe(false);
  });

  test('a go.mod root with no package.json announces no package manager', async () => {
    await writeFile(join(dir, 'go.mod'), 'module example.com/legacy\n\ngo 1.24\n');
    const out = sink();
    await runInit({ cwd: dir, probeFailures: noFailures, hook: false, stdout: out });
    expect(out.text()).toMatch(/^checkride init: adopted \d+ slot\(s\)/);
    expect(out.text()).not.toContain('package manager');
  });

  test('--add refuses a ts pack config in a go.mod root, and writes nothing', async () => {
    await writeFile(join(dir, 'go.mod'), 'module example.com/legacy\n\ngo 1.24\n');
    await expect(runInit({ cwd: dir, add: ['spell', 'lint', 'publish'], probeFailures: noFailures, hook: false })).rejects.toThrow(
      "init: --add lint, publish scaffolds the ts pack's config, and this root's pack is go; --add takes docs, spell, prose here",
    );
    expect(await readdir(dir)).toEqual(['go.mod']);
  });

  test('--add scaffolds a repo-scope config in a go.mod root', async () => {
    await writeFile(join(dir, 'go.mod'), 'module example.com/legacy\n\ngo 1.24\n');
    await runInit({ cwd: dir, add: ['spell'], probeFailures: noFailures, hook: false });
    expect(existsSync(join(dir, 'cspell.json'))).toBe(true);
  });

  test('--add keeps scaffolding the ts pack’s configs where a package.json sits beside a go.mod', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await writeFile(join(dir, 'go.mod'), 'module example.com/legacy\n\ngo 1.24\n');
    await runInit({ cwd: dir, add: ['lint'], probeFailures: noFailures, hook: false });
    expect(existsSync(join(dir, '.oxlintrc.json'))).toBe(true);
  });

  test('discovery beside a go.mod root converts the implicit target as a go one', async () => {
    await writeFile(join(dir, 'go.mod'), 'module example.com/legacy\n\ngo 1.24\n');
    await mkdir(join(dir, 'scripts'));
    await runInit({ cwd: dir, probeFailures: noFailures, hook: false, discoverTargets: scriptsOnly });
    const cfg = JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8')) as Record<string, unknown>;
    expect(cfg['targets']).toEqual({
      app: { lang: 'go', root: '.', checks: { types: 'go-build', test: 'go-test' } },
      scripts: { lang: 'bash', root: 'scripts' },
    });
  });

  test('adopts detected tools and refreshes idempotently', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await writeFile(join(dir, 'tsconfig.json'), '{}');
    await writeFile(join(dir, '.oxlintrc.json'), '{}');

    const first = await runInit({ cwd: dir, probeFailures: noFailures });
    expect(first.mode).toBe('existing');
    const cfg: { checks: Record<string, string | false> } = JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8'));
    expect(cfg.checks['types']).toBe('tsc');
    expect(cfg.checks['lint']).toBe('oxlint');
    const agents1 = await readFile(join(dir, 'AGENTS.md'), 'utf8');

    const second = await runInit({ cwd: dir, probeFailures: noFailures });
    const agents2 = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents2).toBe(agents1);
    expect(second.skipped).toContain('AGENTS.md (stanza unchanged)');
    expect(second.skipped).toContain('checkride.config.json (exists)');
  });

  test('disables a slot whose check fails and reports it (step 3)', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await writeFile(join(dir, 'tsconfig.json'), '{}');
    await writeFile(join(dir, '.oxlintrc.json'), '{}');

    const result = await runInit({
      cwd: dir,
      probeFailures: (slots) => Promise.resolve(slots.includes('lint') ? ['lint'] : []),
    });
    expect(result.disabled).toContain('lint');
    const cfg: { checks: Record<string, string | false> } = JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8'));
    expect(cfg.checks['lint']).toBe(false);
    expect(cfg.checks['types']).toBe('tsc');
  });

  test('--baseline grandfathers fingerprintable failures and only disables the rest (c10)', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await writeFile(join(dir, 'tsconfig.json'), '{}'); // types → tsc (no fingerprint extractor)
    await writeFile(join(dir, '.oxlintrc.json'), '{}'); // lint → oxlint (fingerprintable)

    let captured = false;
    const result = await runInit({
      cwd: dir,
      baseline: true,
      probeFailures: () => Promise.resolve(['types', 'lint']),
      captureBaseline: () => { captured = true; return Promise.resolve(); },
    });

    expect(captured).toBe(true);
    expect(result.grandfathered).toEqual(['lint']); // masked by the baseline, stays enabled
    expect(result.disabled).toEqual(['types']); // no extractor → still falls back to `false`
    const cfg = JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8')) as { checks: Record<string, string | false> };
    expect(cfg.checks['lint']).toBe('oxlint');
    expect(cfg.checks['types']).toBe(false);
  });

  test('--baseline does not capture when nothing fingerprintable is failing', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await writeFile(join(dir, 'tsconfig.json'), '{}'); // only a non-fingerprintable slot

    let captured = false;
    const result = await runInit({
      cwd: dir,
      baseline: true,
      probeFailures: () => Promise.resolve(['types']),
      captureBaseline: () => { captured = true; return Promise.resolve(); },
    });

    expect(captured).toBe(false); // no fingerprintable debt → no baseline written
    expect(result.grandfathered).toEqual([]);
    expect(result.disabled).toEqual(['types']);
  });

  test('--baseline grandfathers failing markdown instead of disabling docs (D32)', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await writeFile(join(dir, '.markdownlint-cli2.jsonc'), '{}'); // docs → markdownlint-cli2
    // markdownlint-cli2 0.23.3's real report, on stderr where it prints it (D49).
    const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
    const stderr = await readFile(join(fixtures, 'findings-markdownlint-cli2.stderr.txt'), 'utf8');
    const runner: CheckRunner = (r) =>
      Promise.resolve(r.slot === 'docs' ? { ok: false, exit_code: 1, stdout: '', stderr } : { ok: true, exit_code: 0, stdout: '', stderr: '' });

    const result = await runInit({
      cwd: dir,
      baseline: true,
      probeFailures: () => Promise.resolve(['docs']),
      captureBaseline: (at) => runBaseline({ cwd: at, runner, stderr: { write: () => true } }).then(() => undefined),
    });

    expect(result.grandfathered).toEqual(['docs']);
    expect(result.disabled).toEqual([]);
    const cfg = JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8')) as { checks: Record<string, string | false> };
    expect(cfg.checks['docs']).toBe('markdownlint-cli2');
    const baseline = JSON.parse(await readFile(join(dir, 'checkride.baseline.json'), 'utf8')) as { slots: Record<string, string[]> };
    expect(baseline.slots['docs']).toHaveLength(9); // its ten findings less the one warning
  });

  test('--baseline --dry-run reports grandfathering but never writes the baseline', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await writeFile(join(dir, '.oxlintrc.json'), '{}'); // lint → oxlint (fingerprintable)

    let captured = false;
    const result = await runInit({
      cwd: dir,
      baseline: true,
      dryRun: true,
      probeFailures: () => Promise.resolve(['lint']),
      captureBaseline: () => { captured = true; return Promise.resolve(); },
    });

    expect(captured).toBe(false); // a dry run must not capture
    expect(existsSync(join(dir, 'checkride.baseline.json'))).toBe(false);
    expect(result.grandfathered).toEqual(['lint']); // still reported, like every other dry-run write
  });

  test('appends .check/ to an existing .gitignore, then skips once present', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await writeFile(join(dir, '.gitignore'), 'node_modules\n');

    const first = await runInit({ cwd: dir, probeFailures: noFailures });
    expect(first.written).toContain('.gitignore (appended .check/)');
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n.check/\n');

    const second = await runInit({ cwd: dir, probeFailures: noFailures });
    expect(second.skipped).toContain('.gitignore (.check/ already ignored)');
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n.check/\n');
  });

  test('creates a .gitignore with .check/ when the repo has none', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));

    const result = await runInit({ cwd: dir, probeFailures: noFailures });
    expect(result.written).toContain('.gitignore');
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('.check/\n');
  });

  test('adds the check alias to an existing package.json, preserving scripts', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy', scripts: { build: 'tsc' } }));
    const result = await runInit({ cwd: dir, probeFailures: noFailures });
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['check']).toBe('checkride');
    expect(pkg.scripts['build']).toBe('tsc');
    expect(result.written).toContain('package.json (added check script)');
  });

  test('never overwrites an existing check script', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy', scripts: { check: 'make verify' } }));
    const result = await runInit({ cwd: dir, probeFailures: noFailures });
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['check']).toBe('make verify');
    expect(result.skipped).toContain('package.json (check script exists)');
  });

  test('throws a friendly error naming the file on a malformed package.json', async () => {
    await writeFile(join(dir, 'package.json'), '{ not valid json');
    await expect(runInit({ cwd: dir, probeFailures: noFailures })).rejects.toThrow('invalid package.json');
  });

  test('--add scaffolds blessed configs for empty slots', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    const result = await runInit({ cwd: dir, add: ['lint', 'spell'], probeFailures: noFailures });
    expect(existsSync(join(dir, '.oxlintrc.json'))).toBe(true);
    expect(existsSync(join(dir, 'cspell.json'))).toBe(true);
    // the just-added lint slot is now adopted (detected) in the written config
    const cfg = JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8')) as { checks: Record<string, string | false> };
    expect(cfg.checks['lint']).toBe('oxlint');
    expect(result.written.some((f) => f.includes('.oxlintrc.json'))).toBe(true);
  });

  test('--add format scaffolds the blessed prettier config', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    const result = await runInit({ cwd: dir, add: ['format'], probeFailures: noFailures });
    expect(existsSync(join(dir, '.prettierrc.json'))).toBe(true);
    expect(result.written.some((f) => f.includes('.prettierrc.json'))).toBe(true);
    // format is opt-in: scaffolding its config does not enable it in checks.
    const cfg = JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8')) as { checks: Record<string, unknown> };
    expect(cfg.checks['format']).toBeUndefined();
  });

  test('--add struct scaffolds the boundary rule, not checkride’s style opinions', async () => {
    // An existing repo has already chosen whether it uses classes, default
    // exports, and NodeNext extensions. Handing it three rules that say
    // otherwise turns adoption into a wall of findings about code it always
    // wrote. The boundary rule is the one that makes `struct` the slot it is.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await runInit({ cwd: dir, add: ['struct'], probeFailures: noFailures });
    expect(existsSync(join(dir, 'sgconfig.yml'))).toBe(true);
    expect(existsSync(join(dir, 'rules/no-deep-sibling-import.yml'))).toBe(true);
    for (const r of ['no-class.yml', 'no-default-export.yml', 'require-js-extension.yml']) {
      expect(existsSync(join(dir, 'rules', r)), r).toBe(false);
    }
  });

  test('--add prose scaffolds a vale config that points at the style it also writes', async () => {
    // The pair is the point: .vale.ini is nothing but a pointer at a
    // StylesPath, and vale run against an empty one reports nothing at all —
    // a green check that checked no prose. Assert the pointer resolves.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    const result = await runInit({ cwd: dir, add: ['prose'], probeFailures: noFailures });

    const ini = await readFile(join(dir, '.vale.ini'), 'utf8');
    const stylesPath = /^StylesPath\s*=\s*(\S+)$/m.exec(ini)?.[1];
    expect(stylesPath).toBe('.vale/styles');
    for (const rule of ['Drift.yml', 'Latin.yml', 'LyHyphen.yml', 'Minted.yml', 'ThereIs.yml', 'Weasel.yml']) {
      expect(existsSync(join(dir, stylesPath ?? '', 'Repo', rule)), rule).toBe(true);
    }
    expect(result.written).toContain('.vale.ini');

    // cspell owns spelling (D2) and the vocabulary file is the same wordlist
    // through another door (D17); both stay off, or adopting `prose` hands the
    // repo a second dictionary to maintain.
    expect(ini).toMatch(/^Vale\.Spelling\s*=\s*NO$/m);
    expect(ini).toMatch(/^Vale\.Terms\s*=\s*NO$/m);
    // The subjective rule ships in the style but disabled in the config.
    expect(ini).toMatch(/^Repo\.Weasel\s*=\s*NO$/m);

    // prose is opt-in: scaffolding its config does not enable it in checks.
    const cfg = JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8')) as { checks: Record<string, unknown> };
    expect(cfg.checks['prose']).toBeUndefined();
  });

  test('--add never clobbers a config that already exists', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await writeFile(join(dir, '.oxlintrc.json'), '{"sentinel":true}');
    const result = await runInit({ cwd: dir, add: ['lint'], probeFailures: noFailures });
    expect(await readFile(join(dir, '.oxlintrc.json'), 'utf8')).toContain('sentinel');
    expect(result.skipped).toContain('.oxlintrc.json (exists)');
  });

  test('init writes the agent hooks, and --no-hook skips them', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    const withHook = await runInit({ cwd: dir, probeFailures: noFailures });
    expect(withHook.written).toContain(CLAUDE_SETTINGS_FILE);
    expect(withHook.written).toContain(GATE_SCRIPT_FILE);
    const settings = JSON.parse(await readFile(join(dir, CLAUDE_SETTINGS_FILE), 'utf8')) as {
      hooks: { Stop: { hooks: { command: string }[] }[] };
    };
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toContain(GATE_SCRIPT_FILE);
    expect(await readFile(join(dir, GATE_SCRIPT_FILE), 'utf8')).toContain('checkride gate --harness claude');

    await rm(join(dir, '.claude'), { recursive: true, force: true });
    const noHook = await runInit({ cwd: dir, hook: false, probeFailures: noFailures });
    expect(noHook.written).not.toContain(CLAUDE_SETTINGS_FILE);
    expect(existsSync(join(dir, CLAUDE_SETTINGS_FILE))).toBe(false);
  });
});

const TAGGED_README = [
  '# lib', '', 'Docs with a checked snippet:', '',
  '<!-- snippet: check -->',
  '```ts',
  'export const x: number = 1;',
  '```', '',
].join('\n');

const library = (): string =>
  JSON.stringify({ name: 'lib', exports: { '.': './dist/index.js' }, scripts: { build: 'tsc -b' } });

const hasSnippetsPointer = (result: { skipped: string[] }): boolean =>
  result.skipped.some((s) => s.includes('<!-- snippet: check -->'));

describe('publish-ready bundle (existing mode, step 9)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-bundle-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const bundleChecks = async (): Promise<Record<string, string | false>> =>
    (JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8')) as { checks: Record<string, string | false> }).checks;

  test('the library path scaffolds the whole bundle when a build script and tagged fences are present', async () => {
    await writeFile(join(dir, 'package.json'), library());
    await writeFile(join(dir, 'README.md'), TAGGED_README);

    const result = await runInit({ cwd: dir, probeFailures: noFailures });
    const checks = await bundleChecks();
    expect(checks['build']).toBe('build');
    expect(checks['publint']).toBe('publint');
    expect(checks['attw']).toBe('attw');
    expect(checks['pack']).toBe('pack');
    expect(checks['smoke']).toBe('smoke');
    expect(checks['snippets']).toBe('snippets-dist');
    expect(hasSnippetsPointer(result)).toBe(false);
  });

  test('snippets-dist is withheld and a pointer reported when no tagged fence exists (Q12)', async () => {
    await writeFile(join(dir, 'package.json'), library());
    await writeFile(join(dir, 'README.md'), '# lib\n\nNo tagged snippets here.\n');

    const result = await runInit({ cwd: dir, probeFailures: noFailures });
    const checks = await bundleChecks();
    expect(checks['snippets']).toBeUndefined();
    expect(checks['pack']).toBe('pack'); // the rest of the bundle still lands
    expect(hasSnippetsPointer(result)).toBe(true);
  });

  test('a library with no build script is not auto-scaffolded (the pipeline needs a build)', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'lib', exports: { '.': './dist/index.js' } }));
    await runInit({ cwd: dir, probeFailures: noFailures });
    const checks = await bundleChecks();
    expect(checks['build']).toBeUndefined();
    expect(checks['pack']).toBeUndefined();
    expect(checks['publint']).toBeUndefined();
  });

  test('a non-library (no exports/main) gets no bundle', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app', scripts: { build: 'tsc' } }));
    await runInit({ cwd: dir, probeFailures: noFailures });
    const checks = await bundleChecks();
    expect(checks['build']).toBeUndefined();
    expect(checks['pack']).toBeUndefined();
  });

  test('--add publish scaffolds the (gated) bundle on any repo', async () => {
    // No exports → not auto-detected, but --add opts in explicitly.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app', scripts: { build: 'tsc' } }));
    const result = await runInit({ cwd: dir, add: ['publish'], probeFailures: noFailures });
    const checks = await bundleChecks();
    expect(checks['build']).toBe('build');
    expect(checks['pack']).toBe('pack');
    expect(checks['smoke']).toBe('smoke');
    expect(checks['snippets']).toBeUndefined(); // no tagged fence
    expect(hasSnippetsPointer(result)).toBe(true);
  });

  test('--add naming a single publish slot enables only that slot', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
    await runInit({ cwd: dir, add: ['pack'], probeFailures: noFailures });
    const checks = await bundleChecks();
    expect(checks['pack']).toBe('pack');
    expect(checks['publint']).toBeUndefined();
    expect(checks['build']).toBeUndefined();
  });
});

describe('runAgentSetup (existing repo, no full init)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-agent-setup-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('announces the detected package manager under the headline', async () => {
    // The `packageManager` field path this time, so both detection branches are covered.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy', packageManager: 'yarn@4.9.1' }));
    const out = sink();
    await runAgentSetup({ cwd: dir, stdout: out });
    const lines = out.text().split('\n');
    expect(lines[0]).toMatch(/^checkride agent-setup: wrote \d+ file\(s\)\.$/);
    expect(lines[1]).toBe('  package manager: yarn (detected)');
  });

  test('writes the check alias, AGENTS stanza, and Stop hook; second run is a no-op', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await writeFile(join(dir, 'tsconfig.json'), '{}');

    const first = await runAgentSetup({ cwd: dir });
    expect(first.written).toContain('AGENTS.md');
    expect(first.written).toContain(CLAUDE_SETTINGS_FILE);
    expect(first.written).toContain('package.json (added check script)');
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['check']).toBe('checkride');
    const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('<!-- checkride:begin hash=');
    expect(agents).toContain('`pnpm exec checkride triage` runs this procedure in full');

    const second = await runAgentSetup({ cwd: dir });
    expect(second.written).toEqual([]);
    expect(second.skipped).toContain('AGENTS.md (stanza unchanged)');
    expect(second.skipped).toContain(`${CLAUDE_SETTINGS_FILE} (unchanged)`);
    expect(second.skipped).toContain(`${GATE_SCRIPT_FILE} (unchanged)`);
  });

  test('stanza reports the configured gate, not detection: opted-in slots and custom checks appear', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'legacy', scripts: { build: 'tsc --build' } }),
    );
    await writeFile(join(dir, 'tsconfig.json'), '{}');
    await writeFile(join(dir, 'biome.json'), '{}');
    await writeFile(
      join(dir, 'checkride.config.json'),
      JSON.stringify({
        checks: {
          format: 'biome-format',
          build: 'build',
          'typecheck-tests': { command: 'pnpm', args: ['exec', 'tsc', '-p', 'tsconfig.test.json'] },
        },
      }),
    );

    await runAgentSetup({ cwd: dir });
    const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    const activeLine = agents.split('\n').find((line) => line.startsWith('Active checks in this repo:'));
    // `format` and `build` are opt-in slots the config opts in; `typecheck-tests`
    // is a non-catalogue custom check. inventory() sees none of the three.
    expect(activeLine).toContain('format');
    expect(activeLine).toContain('build');
    expect(activeLine).toContain('typecheck-tests');
    // Detection still contributes: tsconfig.json → types runs and is reported.
    expect(activeLine).toContain('types');
    // An opt-in slot the config does NOT name stays out of the reported gate.
    expect(activeLine).not.toContain('mutation');
  });

  test('threads the configured prose exemplars into the written stanza', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await writeFile(
      join(dir, 'checkride.config.json'),
      JSON.stringify({ checks: { prose: { use: 'vale', exemplars: 'docs/voice' } } }),
    );

    await runAgentSetup({ cwd: dir, hook: false });
    const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('### Prose voice');
    expect(agents).toContain('`docs/voice`');

    // Idempotent like every stanza write: same config, same stanza, no rewrite.
    const second = await runAgentSetup({ cwd: dir, hook: false });
    expect(second.skipped).toContain('AGENTS.md (stanza unchanged)');
  });

  test('refuses to overwrite a customized stanza, and writes nothing at all', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await runAgentSetup({ cwd: dir, hook: false });

    const custom = (await readFile(join(dir, 'AGENTS.md'), 'utf8')).replace(
      '### Baseline',
      '### This repo\n\n`spell` skips vendored files; see docs/spelling.md.\n\n### Baseline',
    );
    await writeFile(join(dir, 'AGENTS.md'), custom);

    await expect(runAgentSetup({ cwd: dir })).rejects.toThrow(/refusing to overwrite the checkride stanza/);
    // The refusal is a full stop, not a skip: the hooks it would also have
    // written stay unwritten, so the repo is exactly as the run found it.
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(custom);
    expect(existsSync(join(dir, CLAUDE_SETTINGS_FILE))).toBe(false);
  });

  test('--force overwrites a customized stanza', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await runAgentSetup({ cwd: dir, hook: false });
    const original = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    await writeFile(join(dir, 'AGENTS.md'), original.replace('### Baseline', '### Mine\n\nkeep me\n\n### Baseline'));

    const result = await runAgentSetup({ cwd: dir, hook: false, force: true });
    expect(result.written).toContain('AGENTS.md (refreshed stanza)');
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(original);
  });

  test('a dry run refuses too, so the plan matches what the real run would do', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await runAgentSetup({ cwd: dir, hook: false });
    const custom = (await readFile(join(dir, 'AGENTS.md'), 'utf8')).replace('### Baseline', '### Mine\n\nx\n\n### Baseline');
    await writeFile(join(dir, 'AGENTS.md'), custom);

    await expect(runAgentSetup({ cwd: dir, dryRun: true })).rejects.toThrow(/--force/);
  });

  test('the refusal survives a round trip through disk: a stamped stanza re-reads as pristine', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    await writeFile(join(dir, 'AGENTS.md'), '# AGENTS.md\n\nhouse rules\n');
    await runAgentSetup({ cwd: dir, hook: false });
    // Untouched between runs: the second run refreshes rather than refusing,
    // which is the property the stamp exists to preserve.
    const second = await runAgentSetup({ cwd: dir, hook: false });
    expect(second.skipped).toContain('AGENTS.md (stanza unchanged)');
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toContain('house rules');
  });

  test('--no-hook writes the stanza but not the Stop hook', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    const result = await runAgentSetup({ cwd: dir, hook: false });
    expect(result.written).toContain('AGENTS.md');
    expect(existsSync(join(dir, CLAUDE_SETTINGS_FILE))).toBe(false);
    expect(existsSync(join(dir, GATE_SCRIPT_FILE))).toBe(false);
  });
});

describe('new-project generation for another language (--lang)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-new-lang-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const version = async (): Promise<string> => (JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;

  test.each([
    ['go', 'module', ['go.mod', 'cmd/demo/main.go', 'internal/greet/greet.go', 'internal/greet/greet_test.go', '.golangci.yml']],
    ['go', 'workspace', ['go.work', 'core/go.mod', 'core/greet/greet.go', 'core/greet/greet_test.go', 'cli/go.mod', 'cli/main.go', '.golangci.yml']],
    ['rust', 'crate', ['Cargo.toml', 'src/lib.rs', 'src/main.rs', 'rust-toolchain.toml', 'rustfmt.toml', '.config/nextest.toml']],
    ['rust', 'workspace', ['Cargo.toml', 'crates/core/Cargo.toml', 'crates/core/src/lib.rs', 'crates/cli/Cargo.toml', 'crates/cli/src/main.rs', 'rust-toolchain.toml']],
  ] as const)('writes the %s %s shape with no package.json', async (lang, shape, files) => {
    const result = await runInit({ cwd: dir, lang, shape, name: 'demo' });
    expect(result).toMatchObject({ mode: 'new', shape, exitCode: 0 });
    for (const f of [...files, 'mise.toml', 'checkride.config.json', 'sgconfig.yml', '.rumdl.toml', '_typos.toml', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'LICENSE']) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    expect(existsSync(join(dir, 'package.json'))).toBe(false);
  });

  test('a go config names every default slot of the go and repo packs, with requirePins, in one root target', async () => {
    await runInit({ cwd: dir, lang: 'go', name: 'demo' });
    const config = JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8')) as Record<string, unknown>;
    expect(config).toEqual({
      $schema: configSchemaUrl(await version()),
      requirePins: true,
      targets: { app: { lang: 'go', root: '.', checks: { types: 'go-build', lint: 'golangci-lint', dead: 'deadcode', test: 'go-test' } } },
      checks: { struct: 'ast-grep', docs: 'rumdl', links: 'links', spell: 'typos' },
    });
  });

  test("a rust config names snippets too, which opts the doctests in, since nextest doesn't run them", async () => {
    await runInit({ cwd: dir, lang: 'rust', name: 'demo' });
    const config = JSON.parse(await readFile(join(dir, 'checkride.config.json'), 'utf8')) as { targets: { app: { checks: Record<string, string> } } };
    expect(config.targets.app.checks).toEqual({ types: 'cargo-check', lint: 'clippy', dead: 'cargo-machete', test: 'nextest', snippets: 'cargo-doctest' });
  });

  test('mise.toml pins npm:checkride at this release with node beside it, then each binary tool at its tested version (D46)', async () => {
    await runInit({ cwd: dir, lang: 'go', name: 'demo' });
    expect(await readFile(join(dir, 'mise.toml'), 'utf8')).toBe([
      '[tools]',
      'node = "22.18.0"',
      `"npm:checkride" = "${await version()}"`,
      'go = "1.27.2"',
      'golangci-lint = "2.14.0"',
      'ast-grep = "0.45.3"',
      'rumdl = "0.2.79"',
      'typos = "1.51.1"',
      '',
    ].join('\n'));
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir);
    await runInit({ cwd: dir, lang: 'rust', name: 'demo' });
    const rustMise = await readFile(join(dir, 'mise.toml'), 'utf8');
    expect(rustMise).toContain('"ubi:bnjbvr/cargo-machete" = "0.9.2"');
    expect(rustMise).toContain('"aqua:nextest-rs/nextest/cargo-nextest" = "0.9.148"');
    // rust-toolchain.toml pins the toolchain, so mise.toml leaves it alone.
    expect(rustMise).not.toMatch(/^rust =/m);
  });

  test('ships the dialect rules, verbatim from the templates', async () => {
    await runInit({ cwd: dir, lang: 'go', name: 'demo' });
    const goRules = ['go-no-dot-import.yml', 'go-no-import-alias.yml', 'go-no-init-func.yml'];
    expect((await readdir(join(dir, 'rules', 'go'))).toSorted()).toEqual(goRules);
    for (const rule of goRules) {
      expect(await readFile(join(dir, 'rules', 'go', rule), 'utf8')).toBe(await readFile(join(repoRoot, 'templates', 'go', 'shared', 'rules', 'go', rule), 'utf8'));
    }
  });

  test('names the module --module gives, and example.com/<name> without it', async () => {
    await runInit({ cwd: dir, lang: 'go', name: 'demo', module: 'github.com/acme/demo' });
    expect(await readFile(join(dir, 'go.mod'), 'utf8')).toBe('module github.com/acme/demo\n\ngo 1.24\n');
    expect(await readFile(join(dir, 'cmd', 'demo', 'main.go'), 'utf8')).toContain('"github.com/acme/demo/internal/greet"');
  });

  test("runs the gate through mise's checkride, and prints the setup that needs the network", async () => {
    const out = sink();
    await runInit({ cwd: dir, lang: 'go', shape: 'workspace', name: 'demo', stdout: out });
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toContain('`mise exec -- checkride` is the single source of truth for "done"');
    expect(out.text()).toContain('go get -C core -tool golang.org/x/tools/cmd/deadcode@v0.52.0');
    expect(out.text()).toContain('mise install');
  });

  test.each([
    [{ lang: 'go', shape: 'crate' }, "--lang go takes --shape module | workspace, not 'crate'"],
    [{ lang: 'rust', shape: 'module' }, "--lang rust takes --shape crate | workspace, not 'module'"],
    [{ lang: 'ts', shape: 'workspace' }, "--lang ts takes --shape flat | monorepo | hybrid, not 'workspace'"],
  ] as const)('rejects a shape its language does not take: %o', async (options, message) => {
    await expect(runInit({ cwd: dir, name: 'demo', ...options })).rejects.toThrow(message);
    expect(await readdir(dir)).toEqual([]);
  });

  test('refuses --lang go where a package.json puts init in existing mode', async () => {
    await writeFile(join(dir, 'package.json'), '{}');
    await expect(runInit({ cwd: dir, lang: 'go' })).rejects.toThrow('--lang go scaffolds a new project, and this directory has a package.json');
  });

  test('refuses --lang go where a go.mod puts init in existing mode, --force or not', async () => {
    await writeFile(join(dir, 'go.mod'), 'module mine\n');
    await expect(runInit({ cwd: dir, lang: 'go', name: 'demo', force: true })).rejects.toThrow('--lang go scaffolds a new project, and this directory has a go.mod');
    expect(await readFile(join(dir, 'go.mod'), 'utf8')).toBe('module mine\n');
  });

  test('refuses to overwrite a file it would write, unless --force', async () => {
    await writeFile(join(dir, '.golangci.yml'), 'version: "2"\n');
    await expect(runInit({ cwd: dir, lang: 'go', name: 'demo' })).rejects.toThrow('refusing to overwrite 1 existing file(s)');
    expect(await readFile(join(dir, '.golangci.yml'), 'utf8')).toBe('version: "2"\n');
    await runInit({ cwd: dir, lang: 'go', name: 'demo', force: true });
    expect(await readFile(join(dir, '.golangci.yml'), 'utf8')).not.toBe('version: "2"\n');
  });

  test('--dry-run plans every file and writes none', async () => {
    const result = await runInit({ cwd: dir, lang: 'rust', name: 'demo', dryRun: true, hook: false });
    expect(result.written).toContain('Cargo.toml');
    expect(await readdir(dir)).toEqual([]);
  });

  test('the written config resolves: a go target whose checks run under its pack', async () => {
    await runInit({ cwd: dir, lang: 'go', name: 'demo', hook: false });
    const config = loadConfig(dir);
    const names = resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, cwd: dir }).filter((r) => r.adapter !== null && r.skip === null).map((r) => [r.target ?? '', r.slot, r.adapter?.name]);
    expect(names).toEqual(expect.arrayContaining([['app', 'types', 'go-build'], ['app', 'dead', 'deadcode'], ['', 'docs', 'rumdl'], ['', 'spell', 'typos']]));
  });
});

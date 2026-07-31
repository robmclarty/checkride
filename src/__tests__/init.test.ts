import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { CLAUDE_SETTINGS_FILE, GATE_SCRIPT_FILE } from '../agent-setup/index.js';
import { applyStanza, buildStanza, detectMode, inspectStanza, inventory, runAgentSetup, runInit } from '../init.js';

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

  test('refreshes only the marked region, leaving the rest untouched', () => {
    const original = applyStanza('# Title\n\nkeep me\n', buildStanza(['types']));
    const refreshed = applyStanza(original, buildStanza(['types', 'lint']));
    expect(refreshed).toContain('keep me');
    expect(refreshed).toContain('types, lint');
    expect(refreshed.match(/checkride:begin/g)).toHaveLength(1);
  });
});

/** A stanza as checkride wrote it before v0.11.0: same markers, no hash. */
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

  test('an unstamped stanza is pristine only when it matches today’s text', () => {
    expect(inspectStanza(legacy(body), body)).toBe('pristine');
    expect(inspectStanza(legacy(`${body}\n\nSkip \`spell\` on vendored files.`), body)).toBe('unstamped');
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
});

describe('new-project generation (flat)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-new-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('writes a complete flat project', async () => {
    const result = await runInit({ cwd: dir, shape: 'flat', name: 'demo', checkrideSpec: '^0.1.0' });
    expect(result.mode).toBe('new');
    expect(result.shape).toBe('flat');
    for (const f of ['package.json', 'tsconfig.json', 'tsconfig.base.json', 'fallow.toml', 'pnpm-workspace.yaml', '.oxlintrc.json', 'cspell.json', 'vitest.config.ts', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'LICENSE', 'src/index.ts', 'src/index.test.ts', 'rules/no-class.yml']) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    const pkg: { scripts: Record<string, string>; devDependencies: Record<string, string> } =
      JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(pkg.scripts['check']).toBe('checkride');
    expect(pkg.devDependencies['checkride']).toBe('^0.1.0');
    expect(pkg.devDependencies['oxlint']).toBeDefined();

    const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('Active checks in this repo: types, lint, struct, dead, test, docs, links, spell.');
    expect(agents).toContain('`pnpm exec checkride triage` runs this procedure in full');
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
    for (const f of ['apps/demo/src/index.ts', 'apps/demo/src/index.test.ts', 'apps/demo/package.json', 'apps/demo/tsconfig.json', 'libs/core/src/index.ts', 'libs/core/package.json']) {
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
    for (const f of ['src/index.ts', 'src/index.test.ts', 'packages/core/src/index.ts', 'packages/core/package.json']) {
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

  test('--force overwrites existing files and generates the project', async () => {
    await writeFile(join(dir, 'README.md'), '# stale\n');
    const result = await runInit({ cwd: dir, shape: 'flat', name: 'demo', force: true, checkrideSpec: '^0.1.0' });
    expect(result.mode).toBe('new');
    expect(existsSync(join(dir, 'package.json'))).toBe(true);
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toContain('# demo');
  });

  test('the generated smoke test asserts on the module constant', async () => {
    await runInit({ cwd: dir, shape: 'flat', name: 'my-app' });
    const src = await readFile(join(dir, 'src', 'index.ts'), 'utf8');
    const spec = await readFile(join(dir, 'src', 'index.test.ts'), 'utf8');
    expect(src).toContain("export const MY_APP = 'my-app';");
    expect(spec).toContain("import { MY_APP } from './index.js';");
    expect(spec).toContain("expect(MY_APP).toBe('my-app');");
  });
});

const noFailures = (): Promise<string[]> => Promise.resolve([]);

describe('existing-project adoption (idempotent)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-existing-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

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

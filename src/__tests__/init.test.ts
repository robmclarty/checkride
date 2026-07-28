import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  applyHooks,
  CLAUDE_SETTINGS_FILE,
  GATE_SCRIPT_FILE,
  gateScript,
  HOOK_NAMES,
  PROTECT_SCRIPT_FILE,
  protectScript,
  writeHooks,
} from '../agent-setup/index.js';
import { applyStanza, buildStanza, detectMode, inventory, runAgentSetup, runInit } from '../init.js';

describe('AGENTS stanza (idempotency)', () => {
  const body = buildStanza(['types', 'lint', 'spell']);

  test('inserts a stanza into existing content', () => {
    const out = applyStanza('# AGENTS.md\n\nintro\n', body);
    expect(out).toContain('<!-- checkride:begin -->');
    expect(out).toContain('<!-- checkride:end -->');
    expect(out.startsWith('# AGENTS.md')).toBe(true);
  });

  test('creates a body when content is empty', () => {
    const out = applyStanza('', body);
    expect(out.startsWith('<!-- checkride:begin -->')).toBe(true);
  });

  test('applying twice is a no-op (refresh in place)', () => {
    const once = applyStanza('# AGENTS.md\n\nintro\n', body);
    expect(applyStanza(once, body)).toBe(once);

    const fromEmpty = applyStanza('', body);
    expect(applyStanza(fromEmpty, body)).toBe(fromEmpty);
  });

  test('names the plugin skill as the fuller path without displacing the prose procedure', () => {
    // The stanza lands in repos that will never install the plugin, so the
    // standalone procedure stays primary and the skill is exactly one added line.
    expect(body).toContain('1. Read `.check/summary.json` to see which check failed.');
    expect(body).toContain("2. Read that check's raw output");
    expect(body).toContain('3. Fix the root cause, then re-run.');
    const naming = body.split('\n').filter((line) => line.includes('/checkride:check'));
    expect(naming).toEqual(['With the checkride plugin installed, `/checkride:check` runs this procedure in full.']);
  });

  test('refreshes only the marked region, leaving the rest untouched', () => {
    const original = applyStanza('# Title\n\nkeep me\n', buildStanza(['types']));
    const refreshed = applyStanza(original, buildStanza(['types', 'lint']));
    expect(refreshed).toContain('keep me');
    expect(refreshed).toContain('types, lint');
    expect(refreshed.match(/checkride:begin/g)).toHaveLength(1);
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
    expect(agents).toContain('`/checkride:check` runs this procedure in full.');
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

  test('init writes the Claude Code hooks, and --no-hook skips them', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    const withHook = await runInit({ cwd: dir, probeFailures: noFailures });
    expect(withHook.written).toContain(CLAUDE_SETTINGS_FILE);
    expect(withHook.written).toContain(GATE_SCRIPT_FILE);
    const settings = JSON.parse(await readFile(join(dir, CLAUDE_SETTINGS_FILE), 'utf8')) as {
      hooks: { Stop: { hooks: { command: string }[] }[] };
    };
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toContain(GATE_SCRIPT_FILE);
    expect(await readFile(join(dir, GATE_SCRIPT_FILE), 'utf8')).toContain('pnpm run check --strict --digest');

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

describe('hooks (applyHooks / gateScript)', () => {
  test('gate script runs the detected PM with --strict --digest and blocks with exit 2', () => {
    // npm alone needs `--` to pass flags through to the script.
    expect(gateScript('npm')).toContain('npm run check -- --strict --digest');
    for (const pm of ['pnpm', 'yarn', 'bun'] as const) {
      expect(gateScript(pm)).toContain(`${pm} run check --strict --digest`);
    }
    expect(gateScript('pnpm')).toContain('exit 2');
  });

  test('gate guidance points at the digest when present, summary otherwise, and names the skill', () => {
    const script = gateScript('pnpm');
    // The sentinel substring is stable — migration detection keys on it.
    expect(script).toContain('checkride: the gate is red');
    expect(script).toContain('.check/digest.md');
    expect(script).toContain('.check/summary.json');
    expect(script).toContain('/checkride:check');
  });

  test('settings entry is a stable one-liner invoking the checkride-owned script', () => {
    const next = applyHooks({}, ['gate']);
    const command = next.hooks?.Stop?.[0]?.hooks?.[0]?.command;
    expect(command).toContain(GATE_SCRIPT_FILE);
    // PM-independent: the PM lives in the script, so the settings entry never
    // changes when the PM does — that is what makes a refresh lossless.
    expect(command).not.toContain('run check');
  });

  test('applying twice is a no-op (deep equal)', () => {
    const once = applyHooks({ hooks: { Stop: [] } }, HOOK_NAMES);
    expect(applyHooks(once, HOOK_NAMES)).toEqual(once);
  });

  test('the protect hook is a PreToolUse deny on the edit tools, and only those', () => {
    const next = applyHooks({}, ['protect']);
    const group = next.hooks?.PreToolUse?.[0];
    // Edit tools only: Read is deliberately absent — the stanza's procedure
    // and the plugin skills read .check artifacts, so a read-deny would break
    // checkride's own triage flow.
    expect(group?.matcher).toBe('Edit|Write|NotebookEdit');
    expect(group?.hooks?.[0]?.command).toContain(PROTECT_SCRIPT_FILE);
    expect(protectScript()).toContain('checkride.baseline.json');
    expect(protectScript()).toContain('.check');
  });

  test('the dirty hook is a PostToolUse edit-marker with the edit-tool matcher', () => {
    const next = applyHooks({}, ['dirty']);
    const group = next.hooks?.PostToolUse?.[0];
    expect(group?.matcher).toBe('Edit|Write|NotebookEdit');
    expect(group?.hooks?.[0]?.command).toContain('.check/.dirty');
    // The gate is untouched: selecting only `dirty` writes no Stop group.
    expect(next.hooks?.Stop).toBeUndefined();
  });

  test('gate script guards on the marker by default, and clears it after green', () => {
    const script = gateScript('pnpm');
    expect(script).toContain('[ -f .check/.dirty ] || exit 0');
    expect(script).toContain('rm -f .check/.dirty');
  });

  test('a gate-only selection writes an unconditional script (no marker, no guard)', () => {
    const script = gateScript('pnpm', { dirtyGuard: false });
    expect(script).not.toContain('.check/.dirty');
  });

  test('preserves unrelated settings keys and other Stop groups', () => {
    const settings = {
      permissions: { allow: ['Bash'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] },
    };
    const next = applyHooks(settings, ['gate']);
    expect(next['permissions']).toEqual({ allow: ['Bash'] });
    expect(next.hooks?.Stop).toHaveLength(2);
    expect(next.hooks?.Stop?.[0]?.hooks?.[0]?.command).toBe('echo other');
  });

  test('migrates the legacy inline command in place (no duplicate group)', () => {
    const inline =
      "pnpm run check || { echo 'checkride: the gate is red — read .check/summary.json, fix the failing slot, then finish (do not stop while checkride is red).' >&2; exit 2; }";
    const legacy = { hooks: { Stop: [{ hooks: [{ type: 'command', command: inline }] }] } };
    const next = applyHooks(legacy, ['gate']);
    expect(next.hooks?.Stop).toHaveLength(1);
    expect(next.hooks?.Stop?.[0]?.hooks).toHaveLength(1);
    expect(next.hooks?.Stop?.[0]?.hooks?.[0]?.command).toContain(GATE_SCRIPT_FILE);
    expect(next.hooks?.Stop?.[0]?.hooks?.[0]?.command).not.toContain('pnpm run check');
  });
});

/** A PreToolUse hook payload for the protect script, as Claude Code sends it. */
function call(toolInput: Record<string, string>): string {
  return JSON.stringify({ tool_name: 'Edit', tool_input: toolInput });
}

describe('writeHooks', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-hook-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('creates the settings file and gate script, then a second run is a no-op', async () => {
    const first = await writeHooks(dir);
    expect(first.files.map((f) => f.path)).toEqual([CLAUDE_SETTINGS_FILE, GATE_SCRIPT_FILE, PROTECT_SCRIPT_FILE]);
    expect(first.files.every((f) => f.changed)).toBe(true);
    expect(existsSync(join(dir, CLAUDE_SETTINGS_FILE))).toBe(true);
    expect(existsSync(join(dir, GATE_SCRIPT_FILE))).toBe(true);
    const second = await writeHooks(dir);
    expect(second.files.every((f) => !f.changed)).toBe(true);
  });

  test('the script uses the detected package manager (npm lockfile → npm run check)', async () => {
    await writeFile(join(dir, 'package-lock.json'), '{}');
    await writeHooks(dir);
    const script = await readFile(join(dir, GATE_SCRIPT_FILE), 'utf8');
    expect(script).toContain('npm run check');
  });

  test('merges into an existing settings file, preserving other keys', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(
      join(dir, CLAUDE_SETTINGS_FILE),
      JSON.stringify({ model: 'sonnet', hooks: { PreToolUse: [{ matcher: 'Bash' }] } }),
    );
    await writeHooks(dir, { hooks: ['gate'] });
    const settings = JSON.parse(await readFile(join(dir, CLAUDE_SETTINGS_FILE), 'utf8')) as {
      model: string;
      hooks: { PreToolUse: unknown[]; Stop: unknown[] };
    };
    expect(settings.model).toBe('sonnet');
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  test('migrates a settings file carrying the inline form, replacing, never duplicating', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    const inline = "pnpm run check || { echo 'checkride: the gate is red — read .check/summary.json.' >&2; exit 2; }";
    await writeFile(
      join(dir, CLAUDE_SETTINGS_FILE),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: inline }] }] } }),
    );
    await writeHooks(dir);
    const settings = JSON.parse(await readFile(join(dir, CLAUDE_SETTINGS_FILE), 'utf8')) as {
      hooks: { Stop: { hooks: { command: string }[] }[] };
    };
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0]?.hooks).toHaveLength(1);
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toContain(GATE_SCRIPT_FILE);
  });

  test('dryRun computes without writing', async () => {
    const result = await writeHooks(dir, { dryRun: true });
    expect(result.files.every((f) => f.changed)).toBe(true);
    expect(existsSync(join(dir, CLAUDE_SETTINGS_FILE))).toBe(false);
    expect(existsSync(join(dir, GATE_SCRIPT_FILE))).toBe(false);
    expect(existsSync(join(dir, PROTECT_SCRIPT_FILE))).toBe(false);
  });

  test('throws a friendly error naming the file on a malformed settings.json', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(join(dir, CLAUDE_SETTINGS_FILE), '{ not valid json');
    await expect(writeHooks(dir)).rejects.toThrow('invalid .claude/settings.json');
  });

  test('gate script behavior: no marker → skip; green → clears marker; red → exit 2, marker stays', async () => {
    const sh = promisify(execFile);
    const script = join(dir, GATE_SCRIPT_FILE);
    const marker = join(dir, '.check', '.dirty');
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
    // `true`/`false` ignore the --strict --digest args the gate appends.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { check: 'true' } }));
    await writeHooks(dir, { pm: 'pnpm' });

    // Marker absent: the gate skips without running the pipeline.
    await sh('sh', [script], { env });

    // Marker present + green check: gate passes and clears the marker.
    await mkdir(join(dir, '.check'), { recursive: true });
    await writeFile(marker, '');
    await sh('sh', [script], { env });
    expect(existsSync(marker)).toBe(false);

    // Marker present + red check: gate blocks with exit 2 and the marker survives.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { check: 'false' } }));
    await writeFile(marker, '');
    await expect(sh('sh', [script], { env })).rejects.toMatchObject({ code: 2 });
    expect(existsSync(marker)).toBe(true);
  }, 30000);

  test('protect script behavior: denies baseline and .check edits, allows the rest, fails open', async () => {
    await writeHooks(dir);
    const script = join(dir, PROTECT_SCRIPT_FILE);
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
    const status = (stdin: string): number => {
      try {
        execFileSync('node', [script], { input: stdin, env, stdio: ['pipe', 'pipe', 'pipe'] });
        return 0;
      } catch (err) {
        return (err as { status?: number }).status ?? -1;
      }
    };

    expect(status(call({ file_path: join(dir, 'checkride.baseline.json') }))).toBe(2);
    expect(status(call({ file_path: join(dir, '.check', 'summary.json') }))).toBe(2);
    expect(status(call({ notebook_path: join(dir, '.check', 'notes.ipynb') }))).toBe(2);
    expect(status(call({ file_path: join(dir, 'src', 'index.ts') }))).toBe(0);
    // A file merely *named* like the baseline elsewhere in the tree is allowed.
    expect(status(call({ file_path: join(dir, 'fixtures', 'checkride.baseline.json') }))).toBe(0);
    // Malformed input fails open: a broken hook must not brick every edit.
    expect(status('not json')).toBe(0);
    expect(status(JSON.stringify({ tool_name: 'Edit' }))).toBe(0);
  }, 30000);
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
    expect(agents).toContain('<!-- checkride:begin -->');
    expect(agents).toContain('`/checkride:check` runs this procedure in full.');

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

  test('--no-hook writes the stanza but not the Stop hook', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    const result = await runAgentSetup({ cwd: dir, hook: false });
    expect(result.written).toContain('AGENTS.md');
    expect(existsSync(join(dir, CLAUDE_SETTINGS_FILE))).toBe(false);
    expect(existsSync(join(dir, GATE_SCRIPT_FILE))).toBe(false);
  });
});

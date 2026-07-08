import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { applyStopHook, CLAUDE_SETTINGS_FILE, stopHookCommand, writeStopHook } from '../agent-setup/index.js';
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

  test('init writes the Claude Code Stop hook, and --no-hook skips it', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    const withHook = await runInit({ cwd: dir, probeFailures: noFailures });
    expect(withHook.written).toContain(CLAUDE_SETTINGS_FILE);
    const settings = JSON.parse(await readFile(join(dir, CLAUDE_SETTINGS_FILE), 'utf8')) as {
      hooks: { Stop: { hooks: { command: string }[] }[] };
    };
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toContain('pnpm run check');

    await rm(join(dir, '.claude'), { recursive: true, force: true });
    const noHook = await runInit({ cwd: dir, hook: false, probeFailures: noFailures });
    expect(noHook.written).not.toContain(CLAUDE_SETTINGS_FILE);
    expect(existsSync(join(dir, CLAUDE_SETTINGS_FILE))).toBe(false);
  });
});

describe('Stop hook (applyStopHook / stopHookCommand)', () => {
  test('command runs the detected PM and blocks with exit 2', () => {
    expect(stopHookCommand('pnpm')).toContain('pnpm run check');
    expect(stopHookCommand('npm')).toContain('npm run check');
    expect(stopHookCommand('yarn')).toContain('yarn run check');
    expect(stopHookCommand('bun')).toContain('bun run check');
    expect(stopHookCommand('npm')).toContain('exit 2');
  });

  test('adds a Stop group to empty settings', () => {
    const next = applyStopHook({}, stopHookCommand('pnpm'));
    expect(next.hooks?.Stop?.[0]?.hooks?.[0]?.command).toContain('pnpm run check');
  });

  test('applying twice is a no-op (deep equal)', () => {
    const cmd = stopHookCommand('pnpm');
    const once = applyStopHook({ hooks: { Stop: [] } }, cmd);
    expect(applyStopHook(once, cmd)).toEqual(once);
  });

  test('preserves unrelated settings keys and other Stop groups', () => {
    const settings = {
      permissions: { allow: ['Bash'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] },
    };
    const next = applyStopHook(settings, stopHookCommand('pnpm'));
    expect(next['permissions']).toEqual({ allow: ['Bash'] });
    expect(next.hooks?.Stop).toHaveLength(2);
    expect(next.hooks?.Stop?.[0]?.hooks?.[0]?.command).toBe('echo other');
  });

  test('refreshes the command in place when the PM changes (no duplicate group)', () => {
    const first = applyStopHook({}, stopHookCommand('pnpm'));
    const second = applyStopHook(first, stopHookCommand('npm'));
    expect(second.hooks?.Stop).toHaveLength(1);
    expect(second.hooks?.Stop?.[0]?.hooks?.[0]?.command).toContain('npm run check');
    expect(second.hooks?.Stop?.[0]?.hooks?.[0]?.command).not.toContain('pnpm run check');
  });
});

describe('writeStopHook', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'checkride-hook-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  test('creates the settings file, then a second run is a no-op', async () => {
    const first = await writeStopHook(dir);
    expect(first.changed).toBe(true);
    expect(existsSync(join(dir, CLAUDE_SETTINGS_FILE))).toBe(true);
    const second = await writeStopHook(dir);
    expect(second.changed).toBe(false);
  });

  test('uses the detected package manager (npm lockfile → npm run check)', async () => {
    await writeFile(join(dir, 'package-lock.json'), '{}');
    await writeStopHook(dir);
    const settings = JSON.parse(await readFile(join(dir, CLAUDE_SETTINGS_FILE), 'utf8')) as {
      hooks: { Stop: { hooks: { command: string }[] }[] };
    };
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toContain('npm run check');
  });

  test('merges into an existing settings file, preserving other keys', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(
      join(dir, CLAUDE_SETTINGS_FILE),
      JSON.stringify({ model: 'sonnet', hooks: { PreToolUse: [{ matcher: 'Bash' }] } }),
    );
    await writeStopHook(dir);
    const settings = JSON.parse(await readFile(join(dir, CLAUDE_SETTINGS_FILE), 'utf8')) as {
      model: string;
      hooks: { PreToolUse: unknown[]; Stop: unknown[] };
    };
    expect(settings.model).toBe('sonnet');
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  test('dryRun computes without writing', async () => {
    const result = await writeStopHook(dir, { dryRun: true });
    expect(result.changed).toBe(true);
    expect(existsSync(join(dir, CLAUDE_SETTINGS_FILE))).toBe(false);
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
    expect(agents).toContain('<!-- checkride:begin -->');

    const second = await runAgentSetup({ cwd: dir });
    expect(second.written).toEqual([]);
    expect(second.skipped).toContain('AGENTS.md (stanza unchanged)');
    expect(second.skipped).toContain(`${CLAUDE_SETTINGS_FILE} (Stop hook unchanged)`);
  });

  test('--no-hook writes the stanza but not the Stop hook', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'legacy' }));
    const result = await runAgentSetup({ cwd: dir, hook: false });
    expect(result.written).toContain('AGENTS.md');
    expect(existsSync(join(dir, CLAUDE_SETTINGS_FILE))).toBe(false);
  });
});

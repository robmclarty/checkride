import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ADAPTERS, SLOTS } from '../adapters.js';
import type { Adapter } from '../adapters.js';
import { runCli } from '../cli.js';
import type { CheckrideConfig, CustomCheck, ResolvedCheck, SlotConfig, UseConfig } from '../config.js';
import { CONFIG_KEYS, configSchemaUrl, configuredSlots, loadConfig, loadConfigFile, resolveChecks } from '../config.js';
import { isRecord } from '../json.js';
import { PACKS } from '../packs/index.js';
import { configProblem } from '../targets/index.js';

const never = (): boolean => false;
const present = (...files: string[]) => (f: string): boolean => files.includes(f);

type Manifest = { scripts: ReadonlySet<string>; deps: ReadonlySet<string> };
/** package.json signals for `detectScript`/`detectDeps` detection. */
const manifest = (opts: { scripts?: string[]; deps?: string[] } = {}): Manifest => ({
  scripts: new Set(opts.scripts ?? []),
  deps: new Set(opts.deps ?? []),
});
const NO_MANIFEST = manifest();

function resolveSlot(
  slotName: string,
  config: CheckrideConfig | null,
  fileExists: (f: string) => boolean,
  pkg: Manifest = NO_MANIFEST,
) {
  const slots = SLOTS.filter((s) => s.name === slotName);
  const [resolved] = resolveChecks({ slots, adapters: ADAPTERS, config, fileExists, manifest: pkg });
  if (!resolved) throw new Error(`no resolution for ${slotName}`);
  return resolved;
}

describe('detection (no config)', () => {
  test('picks the blessed adapter when its config file is present', () => {
    const r = resolveSlot('lint', null, present('.oxlintrc.json'));
    expect(r.adapter?.name).toBe('oxlint');
    expect(r.skip).toBeNull();
  });

  test('skips a slot with no detectable tool', () => {
    const r = resolveSlot('lint', null, never);
    expect(r.adapter).toBeNull();
    expect(r.skip).toBe('no tool detected for slot');
  });

  test('a built-in (empty detect) is always available', () => {
    const r = resolveSlot('links', null, never);
    expect(r.adapter?.name).toBe('links');
  });

  test('propagates opt-in from the slot catalogue', () => {
    const r = resolveSlot('mutation', null, never);
    expect(r.optIn).toBe(true);
    expect(r.skip).toBe('no tool detected for slot');
  });

  test('detection alone does not mark an opt-in slot explicit', () => {
    const r = resolveSlot('format', null, present('.prettierrc.json'));
    expect(r.adapter?.name).toBe('prettier');
    expect(r.explicit).toBeFalsy();
  });

  test('publint/attw stand down (skip, not fail) when their tool is not installed', () => {
    for (const slot of ['publint', 'attw']) {
      const r = resolveSlot(slot, null, never);
      expect(r.adapter).toBeNull();
      expect(r.skip).toBe('no tool detected for slot');
    }
  });

  test('publint/attw detect via their installed dependency', () => {
    const p = resolveSlot('publint', null, never, manifest({ deps: ['publint'] }));
    expect(p.adapter?.name).toBe('publint');
    expect(p.detectedVia).toBe("dependency 'publint'");
    const a = resolveSlot('attw', null, never, manifest({ deps: ['@arethetypeswrong/cli'] }));
    expect(a.adapter?.name).toBe('attw');
  });

  test('naming publint in config forces it to run even without the dep (explicit ask)', () => {
    const r = resolveSlot('publint', { checks: { publint: 'publint' } }, never);
    expect(r.adapter?.name).toBe('publint');
    expect(r.skip).toBeNull();
  });
});

describe('detection widening (detectScript / detectDeps — D18)', () => {
  test('build detects via scripts.build and names the signal', () => {
    const r = resolveSlot('build', null, never, manifest({ scripts: ['build'] }));
    expect(r.adapter?.name).toBe('build');
    expect(r.skip).toBeNull();
    expect(r.detectedVia).toBe('scripts.build');
  });

  test('an opted-in build with no build script stands down as a skip, never red', () => {
    const r = resolveSlot('build', null, never, manifest({ scripts: ['test'] }));
    expect(r.adapter).toBeNull();
    expect(r.skip).toBe("no 'build' script in package.json");
  });

  test('a build named explicitly in config still stands down when scriptless (preset-safe)', () => {
    const r = resolveSlot('build', { checks: { build: 'build' } }, never, manifest({ scripts: [] }));
    expect(r.adapter).toBeNull();
    expect(r.skip).toBe("no 'build' script in package.json");
    // …but runs when the script is present.
    const ok = resolveSlot('build', { checks: { build: 'build' } }, never, manifest({ scripts: ['build'] }));
    expect(ok.adapter?.name).toBe('build');
  });

  test('detectDeps activates a configless-capable slot when the package is installed', () => {
    const r = resolveSlot('lint', null, never, manifest({ deps: ['oxlint'] }));
    expect(r.adapter?.name).toBe('oxlint');
    expect(r.detectedVia).toBe("dependency 'oxlint'");
  });

  test('a detect file wins over (and is named ahead of) the dep signal', () => {
    const r = resolveSlot('lint', null, present('.oxlintrc.json'), manifest({ deps: ['oxlint'] }));
    expect(r.adapter?.name).toBe('oxlint');
    expect(r.detectedVia).toBe('.oxlintrc.json');
  });

  test('neither a detect file nor a dep leaves the slot undetected', () => {
    const r = resolveSlot('lint', null, never, manifest({ deps: ['unrelated'] }));
    expect(r.adapter).toBeNull();
    expect(r.skip).toBe('no tool detected for slot');
  });

  test('a signal-free adapter (built-in) stays always-available regardless of manifest', () => {
    const r = resolveSlot('links', null, never, NO_MANIFEST);
    expect(r.adapter?.name).toBe('links');
    // "always available" is not surfaced as a detection signal.
    expect(r.detectedVia).toBeUndefined();
  });
});

/** The provenance fields of one resolved check. */
function provenance(r: ResolvedCheck): { origin: ResolvedCheck['origin']; detectedBy: string | undefined } {
  return { origin: r.origin, detectedBy: r.detectedBy };
}

describe('provenance (origin and detectedBy per resolution arm, S21)', () => {
  test('a detect file names itself', () => {
    const r = resolveSlot('lint', null, present('.oxlintrc.json'), manifest({ deps: ['oxlint'] }));
    expect(provenance(r)).toEqual({ origin: 'detected', detectedBy: '.oxlintrc.json' });
  });

  test('a dependency signal names package.json and the dep', () => {
    const r = resolveSlot('lint', null, never, manifest({ deps: ['oxlint'] }));
    expect(provenance(r)).toEqual({ origin: 'detected', detectedBy: 'package.json: oxlint' });
  });

  test('a script signal names package.json and the script', () => {
    const r = resolveSlot('build', null, never, manifest({ scripts: ['build'] }));
    expect(provenance(r)).toEqual({ origin: 'detected', detectedBy: 'package.json: scripts.build' });
  });

  test('a signal-free adapter is built-in, with no signal to name', () => {
    const r = resolveSlot('links', null, never);
    expect(provenance(r)).toEqual({ origin: 'built-in', detectedBy: undefined });
  });

  test('every config arm is config: a name, a { use } entry, a { command } entry and an opt-in-only entry', () => {
    const entries: Record<string, SlotConfig> = {
      name: 'oxlint',
      use: { use: 'oxlint', args: ['lint'] },
      command: { command: 'node', args: ['lint.js'] },
      configuredNotOptedIn: { use: 'oxlint', optIn: true },
    };
    for (const [arm, entry] of Object.entries(entries)) {
      // A detect file is present too, so config has to beat detection to read `config`.
      const r = resolveSlot('lint', { checks: { lint: entry } }, present('.oxlintrc.json'));
      expect(provenance(r), arm).toEqual({ origin: 'config', detectedBy: undefined });
    }
  });

  test('a config-only custom check is custom', () => {
    const resolved = resolveChecks({
      slots: [],
      adapters: ADAPTERS,
      config: { checks: { licenses: { command: 'node', args: ['licenses.js'] } } },
      fileExists: never,
    });
    expect(resolved.map((r) => [r.slot, r.origin])).toEqual([['licenses', 'custom']]);
  });

  test('a check that resolved to no adapter carries no provenance', () => {
    const skips = [
      resolveSlot('lint', null, never),
      resolveSlot('lint', { checks: { lint: false } }, present('.oxlintrc.json')),
      resolveSlot('lint', { checks: { lint: 'nope' } }, never),
      // Named in config, then stood down for want of its script.
      resolveSlot('build', { checks: { build: 'build' } }, never, manifest({ scripts: [] })),
    ];
    for (const r of skips) {
      expect(r.adapter).toBeNull();
      expect(r).not.toHaveProperty('origin');
      expect(r).not.toHaveProperty('detectedBy');
      expect(r).not.toHaveProperty('detectedVia');
    }
    const [custom] = resolveChecks({
      slots: [],
      adapters: ADAPTERS,
      config: { checks: { gated: { command: 'node', detect: ['gated.json'] } } },
      fileExists: never,
    });
    expect(custom?.skip).toBe('no detect file present');
    expect(custom).not.toHaveProperty('origin');
  });
});

describe('config resolution', () => {
  test('false disables the slot even when a tool is present', () => {
    const r = resolveSlot('lint', { checks: { lint: false } }, present('.oxlintrc.json'));
    expect(r.skip).toBe('disabled in checkride.config.json');
  });

  test('a string selects an adapter, beating detection', () => {
    const r = resolveSlot('lint', { checks: { lint: 'oxlint' } }, never);
    expect(r.adapter?.name).toBe('oxlint');
  });

  test('an unknown adapter name is skipped with a reason', () => {
    const r = resolveSlot('lint', { checks: { lint: 'no-such-linter' } }, never);
    expect(r.adapter).toBeNull();
    expect(r.skip).toContain("'no-such-linter' is not in the registry");
  });

  test('{ use } applies overrides on top of the adapter', () => {
    const r = resolveSlot(
      'test',
      { checks: { test: { use: 'vitest', changedArgs: ['--changed', 'main'] } } },
      never,
    );
    expect(r.adapter?.name).toBe('vitest');
    expect(r.adapter?.changedArgs).toEqual(['--changed', 'main']);
  });

  test('{ use } overrides exactly the provided fields, keeping the rest', () => {
    const full = resolveSlot(
      'test',
      {
        checks: {
          test: {
            use: 'vitest',
            command: 'bun', args: ['x'], outputFile: 'o.json',
            changedArgs: ['c'], fixArgs: ['f'], description: 'D',
          },
        },
      },
      never,
    );
    expect(full.adapter).toMatchObject({
      command: 'bun', args: ['x'], outputFile: 'o.json',
      changedArgs: ['c'], fixArgs: ['f'], description: 'D',
    });

    const partial = resolveSlot('test', { checks: { test: { use: 'vitest' } } }, never);
    expect(partial.adapter?.command).toBe('pnpm');
    expect(partial.adapter?.description).toBe('Vitest tests with coverage');
    expect(partial.adapter?.args).toContain('vitest');
  });

  test('{ use } carries a timeout override onto the adapter', () => {
    const r = resolveSlot('test', { checks: { test: { use: 'vitest', timeout: 30 } } }, never);
    expect(r.adapter?.timeout).toBe(30);
  });

  test('a custom check carries its timeout', () => {
    const r = resolveSlot('lint', { checks: { lint: { command: 'node', args: ['x'], timeout: 5 } } }, never);
    expect(r.adapter?.timeout).toBe(5);
  });

  test('{ command } custom check fills defaults and respects overrides', () => {
    const withDefaults = resolveSlot('lint', { checks: { lint: { command: 'node', args: ['x.mjs'] } } }, never);
    expect(withDefaults.adapter).toMatchObject({
      command: 'node', name: 'custom:lint', description: 'Custom lint check', args: ['x.mjs'], outputFile: null,
    });
    expect(withDefaults.adapter?.changedArgs).toBeUndefined();

    const over = resolveSlot(
      'lint',
      {
        checks: {
          lint: {
            command: 'node', name: 'lic', description: 'D',
            args: ['a'], outputFile: 'o.json', changedArgs: ['c'], fixArgs: ['f'],
          },
        },
      },
      never,
    );
    expect(over.adapter).toMatchObject({
      name: 'lic', description: 'D', args: ['a'], outputFile: 'o.json', changedArgs: ['c'], fixArgs: ['f'],
    });
  });

  test('exposes the config type surface', () => {
    const disabled: SlotConfig = false;
    const custom: CustomCheck = { command: 'node', args: ['check-licenses.mjs'] };
    const use: UseConfig = { use: 'vitest', changedArgs: ['--changed', 'main'] };
    expect([disabled, custom.command, use.use]).toEqual([false, 'node', 'vitest']);
  });

  test('naming an opt-in slot marks it explicit (opts it into the default run)', () => {
    const r = resolveSlot('format', { checks: { format: 'prettier' } }, never);
    expect(r.adapter?.name).toBe('prettier');
    expect(r.optIn).toBe(true);
    expect(r.explicit).toBe(true);
  });

  test('optIn:true configures an opt-in slot without opting it in (clears explicit)', () => {
    const r = resolveSlot(
      'attw',
      { checks: { attw: { use: 'attw', optIn: true } } },
      never,
    );
    expect(r.adapter?.name).toBe('attw');
    expect(r.optIn).toBe(true);
    expect(r.explicit).toBe(false);
  });

  test('optIn:false forces a named opt-in slot into the default run', () => {
    const r = resolveSlot(
      'format',
      { checks: { format: { use: 'prettier', optIn: false } } },
      never,
    );
    expect(r.optIn).toBe(false);
    expect(r.explicit).toBe(true);
  });

  test('optIn:true demotes a normally-default slot to full-sweep-only', () => {
    const r = resolveSlot('lint', { checks: { lint: { use: 'oxlint', optIn: true } } }, present('.oxlintrc.json'));
    expect(r.adapter?.name).toBe('oxlint');
    expect(r.optIn).toBe(true);
    expect(r.explicit).toBe(false);
  });

  test('a custom check with optIn:true is held out of the default run', () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: { checks: { integration: { command: 'node', args: ['it.mjs'], optIn: true } } },
      fileExists: never,
    });
    const integration = resolved.find((r) => r.slot === 'integration');
    expect(integration?.adapter?.command).toBe('node');
    expect(integration?.optIn).toBe(true);
    expect(integration?.explicit).toBeFalsy();
  });

  test('a non-boolean optIn is a friendly config error', () => {
    expect(() =>
      resolveSlot('attw', { checks: { attw: { use: 'attw', optIn: 'yes' } as unknown as UseConfig } }, never),
    ).toThrow(/'attw' optIn must be a boolean/);
  });

  test('attw profile appends --profile <name> to the invocation', () => {
    const r = resolveSlot('attw', { checks: { attw: { use: 'attw', profile: 'esm-only' } } }, never);
    expect(r.adapter?.args).toEqual(['exec', 'attw', '--pack', '.', '--format', 'json', '--profile', 'esm-only']);
  });

  test('attw profile appends to overridden args too', () => {
    const r = resolveSlot(
      'attw',
      { checks: { attw: { use: 'attw', args: ['exec', 'attw', '--pack', '.'], profile: 'node16' } } },
      never,
    );
    expect(r.adapter?.args).toEqual(['exec', 'attw', '--pack', '.', '--profile', 'node16']);
  });

  test('profile is a no-op on a non-attw slot', () => {
    const r = resolveSlot('lint', { checks: { lint: { use: 'oxlint', profile: 'esm-only' } } }, present('.oxlintrc.json'));
    expect(r.adapter?.args).toEqual(['exec', 'oxlint', '--type-aware', '--format=json']);
  });

  test('a non-string profile is a friendly config error', () => {
    expect(() =>
      resolveSlot('attw', { checks: { attw: { use: 'attw', profile: 7 } as unknown as UseConfig } }, never),
    ).toThrow(/'attw' profile must be a string/);
  });

  test('prose exemplars is carried onto the adapter', () => {
    const r = resolveSlot('prose', { checks: { prose: { use: 'vale', exemplars: 'docs/voice' } } }, never);
    expect(r.adapter?.name).toBe('vale');
    expect(r.adapter?.options?.prose?.exemplars).toBe('docs/voice');
  });

  test('exemplars is a no-op on a non-prose slot', () => {
    const r = resolveSlot(
      'lint',
      { checks: { lint: { use: 'oxlint', exemplars: 'docs/voice' } } },
      present('.oxlintrc.json'),
    );
    expect(r.adapter?.options).toBeUndefined();
  });

  test('a non-string exemplars is a friendly config error', () => {
    expect(() =>
      resolveSlot('prose', { checks: { prose: { use: 'vale', exemplars: 7 } as unknown as UseConfig } }, never),
    ).toThrow(/'prose' exemplars must be a string/);
  });

  test('links exclude and allowlist are carried onto the adapter', () => {
    const r = resolveSlot(
      'links',
      { checks: { links: { use: 'links', exclude: ['docs', '.ridgeline'], allowlist: ['^foo/'] } } },
      never,
    );
    expect(r.adapter?.options).toEqual({ links: { exclude: ['docs', '.ridgeline'], allowlist: ['^foo/'] } });
  });

  test('links exclude and allowlist are validated but not carried on a non-links slot', () => {
    const r = resolveSlot(
      'lint',
      { checks: { lint: { use: 'oxlint', exclude: ['docs'], allowlist: ['^foo/'] } } },
      present('.oxlintrc.json'),
    );
    expect(r.adapter?.options).toBeUndefined();
    expect(() =>
      resolveSlot('lint', { checks: { lint: { use: 'oxlint', allowlist: ['('] } } }, present('.oxlintrc.json')),
    ).toThrow(/'lint' allowlist entry "\(" is not a valid regular expression/);
  });

  test('a non-array links exclude is a friendly config error', () => {
    expect(() =>
      resolveSlot('links', { checks: { links: { use: 'links', exclude: 'docs' } as unknown as UseConfig } }, never),
    ).toThrow(/'links' exclude must be an array of strings/);
  });

  test('an invalid allowlist regex is a friendly config error', () => {
    expect(() =>
      resolveSlot('links', { checks: { links: { use: 'links', allowlist: ['('] } } }, never),
    ).toThrow(/allowlist entry "\(" is not a valid regular expression/);
  });

  test('a custom check on a non-catalogue name is appended', () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: { checks: { licenses: { command: 'node', args: ['check-licenses.mjs'] } } },
      fileExists: never,
    });
    const licenses = resolved.find((r) => r.slot === 'licenses');
    expect(licenses?.adapter?.command).toBe('node');
    expect(licenses?.optIn).toBe(false);
  });

  test('a custom check with no order defaults to the "any" wave, not last (D2)', () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: { checks: { licenses: { command: 'node', args: ['x.mjs'] } } },
      fileExists: never,
    });
    const licenses = resolved.find((r) => r.slot === 'licenses');
    expect(licenses?.order).toBe('any');
    const names = resolved.map((r) => r.slot);
    const at = names.indexOf('licenses');
    // In the 'any' group: after the plain catalogue members (for example spell), but
    // ahead of the wave-20 artifact slots and the 'single' mutation.
    expect(at).toBeGreaterThan(names.indexOf('spell'));
    expect(at).toBeLessThan(names.indexOf('publint'));
    expect(at).toBeLessThan(names.indexOf('attw'));
    expect(at).toBeLessThan(names.indexOf('mutation'));
  });

  test('order:last restores the pre-wave trailing placement', () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: { checks: { licenses: { command: 'node', args: ['x.mjs'], order: 'last' } } },
      fileExists: never,
    });
    expect(resolved.at(-1)?.slot).toBe('licenses');
  });

  test('order:first runs a custom check ahead of every catalogue slot', () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: { checks: { tidy: { command: 'biome', args: ['format', '--write'], order: 'first' } } },
      fileExists: never,
    });
    expect(resolved[0]?.slot).toBe('tidy');
    expect(resolved.findIndex((r) => r.slot === 'tidy'))
      .toBeLessThan(resolved.findIndex((r) => r.slot === SLOTS[0]?.name));
  });

  test('order:first leads and order:last trails, around the catalogue', () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: {
        checks: {
          tidy: { command: 'biome', args: ['format', '--write'], order: 'first' },
          licenses: { command: 'node', args: ['x.mjs'], order: 'last' },
        },
      },
      fileExists: never,
    });
    const names = resolved.map((r) => r.slot);
    expect(names[0]).toBe('tidy');
    expect(names.at(-1)).toBe('licenses');
  });

  test('custom checks preserve config key order within a group', () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: {
        checks: {
          tidy: { command: 'a', order: 'first' },
          notice: { command: 'b', order: 'first' },
        },
      },
      fileExists: never,
    });
    const firsts = resolved.slice(0, 2).map((r) => r.slot);
    expect(firsts).toEqual(['tidy', 'notice']);
  });

  test('a custom check with detect is skipped when no marker file is present', () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: { checks: { licenses: { command: 'node', args: ['x.mjs'], detect: ['foo.config.js'] } } },
      fileExists: never,
    });
    const licenses = resolved.find((r) => r.slot === 'licenses');
    expect(licenses?.adapter).toBeNull();
    expect(licenses?.skip).toBe('no detect file present');
  });

  test('a custom check with detect is active when a marker file is present', () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: { checks: { licenses: { command: 'node', args: ['x.mjs'], detect: ['foo.config.js'] } } },
      fileExists: present('foo.config.js'),
    });
    const licenses = resolved.find((r) => r.slot === 'licenses');
    expect(licenses?.skip).toBeNull();
    expect(licenses?.adapter?.command).toBe('node');
  });

  test('detect does not gate a custom check that fills a catalogue slot', () => {
    const r = resolveSlot(
      'lint',
      { checks: { lint: { command: 'node', args: ['x'], detect: ['foo.config.js'] } } },
      never,
    );
    expect(r.skip).toBeNull();
    expect(r.adapter?.command).toBe('node');
  });
});

describe('effective order (precedence: config > adapter > slot > any)', () => {
  const orderedAdapter: Adapter = {
    name: 'tool', slot: 'lint', description: 'ordered tool', detect: [],
    command: 'x', args: [], outputFile: null, order: 7, devDeps: {},
  };

  test('omitted at every level resolves to any', () => {
    expect(resolveSlot('lint', { checks: { lint: 'oxlint' } }, never).order).toBe('any');
  });

  test('the slot default applies when nothing overrides it', () => {
    expect(resolveSlot('mutation', { checks: { mutation: 'stryker' } }, never).order).toBe('single');
    expect(resolveSlot('publint', { checks: { publint: 'publint' } }, never).order).toBe(20);
  });

  test('an adapter order beats the slot default', () => {
    // `detect: []` makes the adapter always available, so detection picks it.
    const [r] = resolveChecks({
      slots: [{ name: 'lint', order: 3 }],
      adapters: [orderedAdapter],
      config: null,
      fileExists: () => true,
    });
    expect(r?.order).toBe(7);
  });

  test('a config order beats both the adapter and the slot', () => {
    const [r] = resolveChecks({
      slots: [{ name: 'lint', order: 3 }],
      adapters: [orderedAdapter],
      config: { checks: { lint: { use: 'tool', order: 'first' } } },
      fileExists: never,
    });
    expect(r?.order).toBe('first');
  });

  test('a custom check carries its config order, else defaults to any', () => {
    expect(resolveSlot('lint', { checks: { lint: { command: 'node', order: 5 } } }, never).order).toBe(5);
    expect(resolveSlot('lint', { checks: { lint: { command: 'node' } } }, never).order).toBe('any');
  });
});

describe('group sort (D1 sequence)', () => {
  test('numeric waves sort ascending, decimals sequencing within a wave', () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: {
        checks: {
          w2: { command: 'x', order: 2 },
          w1b: { command: 'x', order: 1.2 },
          w1a: { command: 'x', order: 1 },
        },
      },
      fileExists: never,
    });
    const names = resolved.map((r) => r.slot);
    expect(names.indexOf('w1a')).toBeLessThan(names.indexOf('w1b'));
    expect(names.indexOf('w1b')).toBeLessThan(names.indexOf('w2'));
  });

  test('duplicate numeric values share one wave, preserving config-key order', () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: { checks: { a: { command: 'x', order: 5 }, b: { command: 'x', order: 5 } } },
      fileExists: never,
    });
    const names = resolved.map((r) => r.slot);
    // Same wave, adjacent, first-configured first: nothing sorts between them.
    expect(names.indexOf('b') - names.indexOf('a')).toBe(1);
  });

  test('the full sequence is firsts, the numeric line, singles, lasts', () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: {
        checks: {
          lead: { command: 'x', order: 'first' },
          wave: { command: 'x', order: 10 },
          solo: { command: 'x', order: 'single' },
          trail: { command: 'x', order: 'last' },
        },
      },
      fileExists: never,
    });
    const names = resolved.map((r) => r.slot);
    expect(names[0]).toBe('lead');
    expect(names.indexOf('lead')).toBeLessThan(names.indexOf('wave'));
    expect(names.indexOf('wave')).toBeLessThan(names.indexOf('solo'));
    expect(names.indexOf('solo')).toBeLessThan(names.indexOf('trail'));
    expect(names.at(-1)).toBe('trail');
  });

  test("'middle' schedules in the main group, ahead of numeric waves and singles", () => {
    const resolved = resolveChecks({
      slots: SLOTS,
      adapters: ADAPTERS,
      config: { checks: { mid: { command: 'x', order: 'middle' } } },
      fileExists: never,
    });
    const names = resolved.map((r) => r.slot);
    expect(names.indexOf('mid')).toBeLessThan(names.indexOf('publint'));
    expect(names.indexOf('mid')).toBeLessThan(names.indexOf('mutation'));
  });
});

describe('order validation', () => {
  test('a non-keyword string order is a friendly config error', () => {
    expect(() =>
      resolveSlot(
        'test',
        { checks: { test: { use: 'vitest', order: 'sideways' } } } as unknown as CheckrideConfig,
        never,
      ),
    ).toThrow(/invalid checkride\.config\.json: .*order must be/);
  });

  test('a non-finite numeric order is rejected', () => {
    expect(() =>
      resolveSlot(
        'lint',
        { checks: { lint: { command: 'node', order: Number.POSITIVE_INFINITY } } },
        never,
      ),
    ).toThrow(/order must be/);
  });

  test('a non-number, non-string order is rejected', () => {
    expect(() =>
      resolveSlot(
        'lint',
        { checks: { lint: { command: 'node', order: true } } } as unknown as CheckrideConfig,
        never,
      ),
    ).toThrow(/order must be/);
  });
});

/**
 * `description` is the string a run prints beside a check; `note` is for
 * whoever reads the config next. Keeping them apart is the whole feature —
 * a note that reaches the status line is a note that will not be written.
 */
describe('note (internal documentation)', () => {
  test('never reaches the adapter, so no renderer can find it', () => {
    const resolved = resolveSlot(
      'lint',
      {
        checks: {
          lint: {
            command: 'node',
            description: 'Lint the sources',
            note: 'Pinned to node because oxlint 1.74 mis-parses our decorators; revisit after 2.0.',
          },
        },
      },
      never,
    );
    expect(resolved.adapter?.description).toBe('Lint the sources');
    expect(JSON.stringify(resolved)).not.toContain('mis-parses');
  });

  test('rides on an adapter override too, and is still dropped', () => {
    const resolved = resolveSlot(
      'test',
      { checks: { test: { use: 'vitest', note: 'why we keep the default args' } } },
      never,
    );
    expect(resolved.adapter?.name).toBe('vitest');
    expect(JSON.stringify(resolved)).not.toContain('why we keep');
  });

  test('a config-only custom check carries one as well', () => {
    const [resolved] = resolveChecks({
      slots: [],
      adapters: ADAPTERS,
      config: { checks: { licenses: { command: 'node', args: ['scripts/licenses.js'], note: 'legal asked' } } },
      fileExists: never,
    });
    expect(resolved?.slot).toBe('licenses');
    expect(JSON.stringify(resolved)).not.toContain('legal asked');
  });

  /** Never read is not never checked: a typo here should surface, not vanish. */
  test('a non-string note is a friendly config error naming the check', () => {
    expect(() =>
      resolveSlot('lint', { checks: { lint: { command: 'node', note: 42 } } } as unknown as CheckrideConfig, never),
    ).toThrow(/invalid checkride\.config\.json: 'lint' note must be a string/);
  });
});

/** Resolve one config-only custom check named `licenses` from a raw (possibly invalid) entry. */
function resolveCustom(entry: unknown) {
  return resolveChecks({
    slots: [],
    adapters: ADAPTERS,
    config: { checks: { licenses: entry } } as unknown as CheckrideConfig,
    fileExists: never,
  })[0];
}

describe('skipExitCode (a custom check skipping itself)', () => {
  test('a config-only custom check carries its skipExitCode onto the resolved check', () => {
    expect(resolveCustom({ command: 'node', skipExitCode: 77 })?.skipExitCode).toBe(77);
  });

  test('a custom check filling a catalogue slot carries it too', () => {
    expect(resolveSlot('test', { checks: { test: { command: 'node', skipExitCode: 77 } } }, never).skipExitCode).toBe(77);
  });

  test('absent stays absent, on custom checks and adapter-backed slots alike', () => {
    expect(resolveCustom({ command: 'node' })).not.toHaveProperty('skipExitCode');
    expect(resolveSlot('lint', null, present('.oxlintrc.json'))).not.toHaveProperty('skipExitCode');
  });

  test('accepts the ends of the range', () => {
    expect(resolveCustom({ command: 'node', skipExitCode: 1 })?.skipExitCode).toBe(1);
    expect(resolveCustom({ command: 'node', skipExitCode: 255 })?.skipExitCode).toBe(255);
  });

  test('rejects 0, out-of-range values and non-integers with a friendly error naming the check', () => {
    for (const bad of [0, 256, -1, 1.5, '77', null]) {
      expect(() => resolveCustom({ command: 'node', skipExitCode: bad })).toThrow(
        /invalid checkride\.config\.json: 'licenses' skipExitCode must be an integer from 1 to 255/,
      );
    }
  });

  test('a bad value surfaces even when the check stands down for a missing detect file', () => {
    expect(() => resolveCustom({ command: 'node', detect: ['absent.json'], skipExitCode: 0 })).toThrow(
      /'licenses' skipExitCode must be an integer/,
    );
  });

  test('a { use } entry rejects it: only a custom check can skip itself', () => {
    expect(() =>
      resolveSlot('test', { checks: { test: { use: 'vitest', skipExitCode: 77 } } }, never),
    ).toThrow(/'test' skipExitCode applies only to a custom check/);
  });
});

function sink(): { write: (text: string) => boolean; text: () => string } {
  const lines: string[] = [];
  return { write: (text: string) => { lines.push(text); return true; }, text: () => lines.join('') };
}

describe('targets and packs (the R2.3 rules, S3)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-targets-'));
    for (const sub of ['apps/web/admin', 'apps/webapp', 'apps/api', 'scripts']) await mkdir(join(dir, sub), { recursive: true });
    await writeFile(join(dir, 'README.md'), '# fixture\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (config: unknown, file = 'checkride.config.json'): Promise<void> =>
    writeFile(join(dir, file), JSON.stringify(config));
  const web = { lang: 'ts', root: 'apps/web' };
  const problem = (config: Record<string, unknown>): string | null => configProblem(config, { cwd: dir, layer: 'repo' });
  const defaults = (config: Record<string, unknown>): string | null => configProblem(config, { cwd: dir, layer: 'defaults' });

  /**
   * For each rule the loader holds, a config that breaks it and nothing else,
   * and the words its message carries. V11 reads a defaults file, which no
   * command loads yet, so its case calls the rules directly below.
   */
  const RULES: readonly {
    rule: string;
    config: Record<string, unknown>;
    base?: Record<string, unknown>;
    message: RegExp;
  }[] = [
    { rule: 'V1', config: { targets: { Web: web } }, message: /target name "Web" must start with a lowercase letter/ },
    { rule: 'V2', config: { targets: { lint: web } }, message: /target name 'lint' is reserved: it's a slot's name/ },
    {
      rule: 'V3',
      config: { targets: { web: { lang: 'ts', root: 'apps/nope' } } },
      message: /targets\.web\.root "apps\/nope" doesn't exist in the repo/,
    },
    {
      rule: 'V4',
      config: { targets: { web, admin: { lang: 'ts', root: 'apps/web/admin' } } },
      message: /ts target 'admin' sits inside 'web' \('apps\/web\/admin' is under 'apps\/web'\)/,
    },
    {
      rule: 'V5',
      config: { targets: { web: { ...web, include: ['**/*.ts'] } } },
      message: /targets\.web sets include, but ts checks its root rather than a list of files/,
    },
    {
      rule: 'V6',
      config: { targets: { web }, checks: { lint: 'biome' } },
      message: /checks\.lint names "biome", but once targets are declared .*: move it to packs\.ts\.checks\.lint \(targets web\)/,
    },
    {
      rule: 'V7',
      base: { targets: { web } },
      config: { extends: './base.json' },
      message: /extends "\.\/base\.json" declares targets \(in checkride\.config\.json\): a preset can't know/,
    },
    {
      rule: 'V8',
      config: { schemas: [{ files: ['data/*.json'], schema: 'https://example.com/s.json' }] },
      message: /schemas\[0\]\.schema "https:\/\/example\.com\/s\.json" is a URL, and a check never fetches/,
    },
    { rule: 'V9', config: { targets: {} }, message: /targets is empty: declare at least one target/ },
    {
      rule: 'V10',
      config: { packs: { java: { checks: { lint: 'checkstyle' } } } },
      message: /packs has 'java', which isn't a pack \(packs: ts, bash, go, rust, python, terraform\)/,
    },
    {
      rule: 'V12',
      config: { checks: { licenses: { command: 'node', static: true } } },
      message: /'licenses' sets static, which only a defaults file may set/,
    },
  ];

  async function writeCase(c: (typeof RULES)[number]): Promise<void> {
    if (c.base) await write(c.base, 'base.json');
    await write(c.config);
  }

  test.each(RULES)('$rule: the loader names the problem', async (c) => {
    await writeCase(c);
    expect(() => loadConfig(dir)).toThrow(c.message);
  });

  test.each(RULES)('$rule: a run exits 2 with that message before anything runs', async (c) => {
    await writeCase(c);
    const err = sink();
    expect(await runCli(['--only', 'links'], { cwd: dir, stdout: sink(), stderr: err })).toBe(2);
    expect(err.text()).toMatch(/^checkride: invalid checkride\.config\.json: /);
    expect(err.text()).toMatch(c.message);
    expect(existsSync(join(dir, '.check'))).toBe(false);
  });

  test("V11: a defaults file can't declare targets, though a repo's config can", () => {
    expect(defaults({ targets: { web } })).toMatch(/^a defaults file can't declare targets/);
    expect(problem({ targets: { web } })).toBeNull();
  });

  test('V1 to V12 each have their own message', async () => {
    const messages: string[] = [];
    for (const c of RULES) {
      await writeCase(c);
      try {
        loadConfig(dir);
      } catch (err) {
        messages.push(err instanceof Error ? err.message : String(err));
      }
    }
    messages.push(defaults({ targets: { web } }) ?? '');
    expect(messages).toHaveLength(12);
    expect(new Set(messages).size).toBe(12);
  });

  test('a config declaring targets, packs and their companion keys loads as written', async () => {
    const config = {
      changedBase: 'origin/develop',
      requirePins: true,
      unclaimed: { ignore: ['vendor-tools/**'] },
      targets: {
        web: { lang: 'ts', root: './apps/web/', note: 'the storefront', checks: { lint: 'biome', e2e: { command: 'node' } } },
        api: { lang: 'ts', root: 'apps/api', checks: { test: { use: 'jest', timeout: 0 } } },
      },
      packs: { ts: { note: 'every ts target', checks: { types: 'tsc', format: false, audit: { command: 'node', skipExitCode: 77 } } } },
      checks: { lint: { optIn: false, timeout: 120, order: 'first', note: 'tuned' }, test: false, spell: 'cspell', licenses: { command: 'node' } },
    };
    await write(config);
    expect(loadConfig(dir)).toEqual(config);
  });

  test('a top-level entry for a target-scope slot is unrestricted without targets', async () => {
    await write({ checks: { lint: 'biome', test: { use: 'vitest', args: ['run'] } }, packs: { ts: { checks: { lint: 'oxlint' } } } });
    expect(loadConfig(dir)?.checks?.['lint']).toBe('biome');
  });

  test('V2 reserves schema and unclaimed before either slot exists, and every custom check name', () => {
    expect(problem({ targets: { schema: web } })).toMatch(/target name 'schema' is reserved/);
    expect(problem({ targets: { unclaimed: web } })).toMatch(/target name 'unclaimed' is reserved/);
    expect(problem({ targets: { licenses: web }, checks: { licenses: { command: 'node' } } })).toMatch(
      /target name 'licenses' is taken by the custom check checks\.licenses/,
    );
  });

  test('V2 reserves doc-snippets, the directory the snippets check keeps its scratch in', () => {
    expect(problem({ targets: { 'doc-snippets': web } })).toMatch(
      /target name 'doc-snippets' is reserved: the snippets check keeps its scratch files in \.check\/doc-snippets\/, where this target's artifacts would land/,
    );
  });

  test("V2 holds a target's name apart from every custom check, a target's or a pack's included", () => {
    const api = { lang: 'ts', root: 'apps/api' };
    expect(problem({ targets: { web, api: { ...api, checks: { web: { command: 'node' } } } } })).toMatch(
      /target name 'web' is taken by the custom check targets\.api\.checks\.web, and a token like --only web has to mean one thing/,
    );
    expect(problem({ targets: { web: { ...web, checks: { web: { command: 'node' } } } } })).toMatch(
      /taken by the custom check targets\.web\.checks\.web/,
    );
    expect(problem({ targets: { web }, packs: { ts: { checks: { web: { command: 'node' } } } } })).toMatch(
      /target name 'web' is taken by the custom check packs\.ts\.checks\.web/,
    );
    expect(problem({ targets: { web, api: { ...api, checks: { e2e: { command: 'node' } } } } })).toBeNull();
  });

  test('V1 holds names to a lowercase word of 32 characters at most', () => {
    expect(problem({ targets: { 'web-2': web } })).toBeNull();
    expect(problem({ targets: { [`a${'b'.repeat(31)}`]: web } })).toBeNull();
    for (const name of [`a${'b'.repeat(32)}`, '2web', '-web', 'web_2', 'wéb', '']) {
      expect(problem({ targets: { [name]: web } }), name).toMatch(/must start with a lowercase letter/);
    }
  });

  test('V3 normalizes a root, and rejects one that is absolute, climbs out, is missing or is a file', () => {
    for (const root of ['.', './', 'apps/web/', './apps//web', 'apps/web/admin']) {
      expect(problem({ targets: { web: { lang: 'ts', root } } }), root).toBeNull();
    }
    const at = (root: unknown): string | null => problem({ targets: { web: { lang: 'ts', root } } });
    expect(at('/etc')).toMatch(/targets\.web\.root "\/etc" is absolute/);
    expect(at('apps/../apps/web')).toMatch(/has a '\.\.' segment/);
    expect(at('..')).toMatch(/has a '\.\.' segment/);
    expect(at('README.md')).toMatch(/targets\.web\.root "README\.md" is a file, not a directory/);
    expect(at('')).toMatch(/targets\.web\.root must be a directory relative to the repo root \(got ""\)/);
    expect(at(7)).toMatch(/\(got 7\)/);
    expect(problem({ targets: { web: { lang: 'ts' } } })).toMatch(/targets\.web has no root/);
  });

  test('V4 rejects two targets of one pack on one root, and one at the repo root over another', () => {
    expect(problem({ targets: { web, site: { lang: 'ts', root: './apps/web/' } } })).toMatch(
      /ts targets 'web' and 'site' share the root 'apps\/web'/,
    );
    expect(problem({ targets: { web, root: { lang: 'ts', root: '.' } } })).toMatch(/ts target 'web' sits inside 'root'/);
    // Siblings with a shared prefix don't nest.
    expect(problem({ targets: { web, webapp: { lang: 'ts', root: 'apps/webapp' } } })).toBeNull();
  });

  /** A pack that checks a file list, the way R11.2 says a bash pack will. */
  const shell: { name: string; adapters: Adapter[] } = {
    name: 'sh',
    adapters: [
      {
        name: 'shellcheck',
        slot: 'lint',
        description: 'ShellCheck',
        detect: [],
        command: 'shellcheck',
        args: ['{files}'],
        outputFile: null,
        devDeps: {},
      },
    ],
  };
  const withShell = (config: Record<string, unknown>): string | null =>
    configProblem(config, { cwd: dir, layer: 'repo', packs: [...Object.values(PACKS), shell] });

  test('V4 lets targets of different packs nest', () => {
    expect(withShell({ targets: { web, tools: { lang: 'sh', root: 'apps' } } })).toBeNull();
    expect(withShell({ targets: { web, tools: { lang: 'sh', root: 'apps/web' } } })).toBeNull();
  });

  test('V5 lets a file-list pack take include and exclude, as globs', () => {
    expect(withShell({ targets: { tools: { lang: 'sh', root: 'scripts', include: ['**/*.sh'], exclude: ['vendor/**'] } } })).toBeNull();
    expect(withShell({ targets: { tools: { lang: 'sh', root: 'scripts', exclude: '**/*.sh' } } })).toMatch(
      /targets\.tools\.exclude must be an array of globs/,
    );
    expect(problem({ targets: { web: { ...web, exclude: ['x'] } } })).toMatch(/targets\.web sets exclude, but ts checks its root/);
  });

  test('V6 allows false and scheduling keys at the top level, and names every pack that fills the slot', () => {
    expect(problem({ targets: { web }, checks: { lint: false, test: { optIn: true, timeout: 0, order: 3, note: 'n' } } })).toBeNull();
    expect(problem({ targets: { web }, checks: { links: 'links', licenses: { command: 'node' } } })).toBeNull();
    expect(problem({ targets: { web }, checks: { test: { use: 'vitest', timeout: 0 } } })).toMatch(
      /checks\.test sets use, but once targets are declared a top-level target-scope slot may set only optIn, timeout, order, note/,
    );
    expect(problem({ targets: { web }, checks: { types: { command: 'node', args: ['x'] } } })).toMatch(/checks\.types sets command, args/);
    expect(
      withShell({ targets: { web, api: { lang: 'ts', root: 'apps/api' }, tools: { lang: 'sh', root: 'scripts' } }, checks: { lint: 'biome' } }),
    ).toMatch(/move it to packs\.ts\.checks\.lint \(targets web, api\) or packs\.sh\.checks\.lint \(targets tools\), or into one target's checks/);
  });

  test('V7 catches targets in a preset of a preset, naming the file that extends it', async () => {
    await write({ targets: { web } }, 'grandparent.json');
    await write({ extends: './grandparent.json' }, 'parent.json');
    await write({ extends: './parent.json' });
    expect(() => loadConfig(dir)).toThrow(/extends "\.\/grandparent\.json" declares targets \(in \S*parent\.json\)/);
  });

  test('V7 leaves packs in a preset alone', async () => {
    await write({ packs: { ts: { checks: { lint: 'biome' } } } }, 'base.json');
    await write({ extends: './base.json', targets: { web } });
    expect(loadConfig(dir)?.packs).toEqual({ ts: { checks: { lint: 'biome' } } });
  });

  test('V8 takes a bundled id or a repo-relative path, and nothing fetched or absolute', () => {
    expect(problem({ schemas: [{ files: ['a.json'], schema: 'checkride:agent-skill' }, { files: ['b.yml'], schema: 'schemas/b.json' }] })).toBeNull();
    expect(problem({ schemas: [{ files: ['a.json'], schema: 'HTTP://example.com/s.json' }] })).toMatch(/is a URL/);
    expect(problem({ schemas: [{ files: ['a.json'], schema: '/etc/s.json' }] })).toMatch(/schemas\[0\]\.schema "\/etc\/s\.json" is absolute/);
    expect(problem({ schemas: [{ files: ['a.json'] }] })).toMatch(/schemas\[0\]\.schema must name a bundled checkride:<id> schema/);
    expect(problem({ schemas: { files: ['a.json'] } })).toMatch(/schemas must be an array of rules/);
  });

  test('V10 holds each packs block and each target to its own pack’s adapters', () => {
    expect(problem({ packs: { ts: { checks: { lint: 'golangci-lint' } } } })).toMatch(
      /packs\.ts\.checks\.lint names 'golangci-lint', which isn't a ts adapter \(ts fills lint with oxlint, biome, eslint\)/,
    );
    expect(problem({ packs: { ts: { checks: { test: { use: 'pytest' } } } } })).toMatch(/packs\.ts\.checks\.test names 'pytest'/);
    expect(problem({ targets: { web: { ...web, checks: { lint: 'shellcheck' } } } })).toMatch(
      /targets\.web\.checks\.lint names 'shellcheck', which isn't a ts adapter/,
    );
    expect(problem({ packs: { ts: { checks: { links: false } } } })).toMatch(
      /packs\.ts\.checks\.links configures links, a repo-scope slot that runs once for the whole repo/,
    );
    expect(problem({ targets: { web: { ...web, checks: { unclaimed: false } } } })).toMatch(/configures unclaimed, a repo-scope slot/);
    expect(problem({ packs: { repo: {} } })).toMatch(/packs has 'repo', which isn't a pack/);
    expect(problem({ packs: { ts: { check: {} } } })).toMatch(/packs\.ts has an unknown key 'check' \(expected checks, note\)/);
  });

  test('V12 lets a defaults file vouch with static, and holds skipExitCode to command entries everywhere', () => {
    expect(defaults({ checks: { licenses: { command: 'node', static: true }, lint: { use: 'oxlint', static: false } } })).toBeNull();
    expect(defaults({ checks: { licenses: { command: 'node', static: 'yes' } } })).toMatch(/'licenses' static must be true or false/);
    expect(problem({ packs: { ts: { checks: { lint: { use: 'oxlint', static: true } } } } })).toMatch(
      /'packs\.ts\.checks\.lint' sets static/,
    );
    expect(problem({ targets: { web: { ...web, checks: { gen: { command: 'node', skipExitCode: 0 } } } } })).toMatch(
      /'targets\.web\.checks\.gen' skipExitCode must be an integer from 1 to 255 \(got 0\)/,
    );
    expect(problem({ checks: { lint: { optIn: true, skipExitCode: 77 } } })).toMatch(
      /'lint' skipExitCode applies only to a custom check \(\{ command \}\)$/,
    );
  });

  test('a target names a pack, holds only known keys, and its note is a string', () => {
    expect(problem({ targets: { web: { root: 'apps/web' } } })).toMatch(/targets\.web has no lang: name its pack \(packs: ts, bash, go, rust, python, terraform\)/);
    expect(problem({ targets: { web: { lang: 'cobol', root: 'apps/web' } } })).toMatch(/targets\.web\.lang "cobol" isn't a pack/);
    expect(problem({ targets: { web: { lang: 'repo', root: 'apps/web' } } })).toMatch(/targets\.web\.lang "repo" isn't a pack/);
    expect(problem({ targets: { web: { ...web, rot: '.' } } })).toMatch(/targets\.web has an unknown key 'rot'/);
    expect(problem({ targets: { web: { ...web, note: 3 } } })).toMatch(/'targets\.web' note must be a string/);
    expect(problem({ targets: { web: 'apps/web' } })).toMatch(/targets\.web must be an object with lang and root/);
    expect(problem({ targets: ['web'] })).toMatch(/targets must be an object of named targets/);
  });

  test('requirePins is a boolean, and unclaimed holds only an ignore list', () => {
    expect(problem({ requirePins: 'yes' })).toMatch(/requirePins must be true or false \(got "yes"\)/);
    expect(problem({ unclaimed: ['x'] })).toMatch(/unclaimed must be an object/);
    expect(problem({ unclaimed: { ignore: 'x' } })).toMatch(/unclaimed\.ignore must be an array of globs/);
    expect(problem({ unclaimed: { ignored: ['x'] } })).toMatch(/unclaimed has an unknown key 'ignored' \(expected ignore\)/);
  });

  test('gate holds only its own keys: lists of check names, a boolean, a preflight path and a note', () => {
    expect(problem({ gate: { only: ['types'], skip: [], changed: true, preflight: 'gate.sh', note: 'fast' } })).toBeNull();
    expect(problem({ gate: 'fast' })).toMatch(/gate must be an object \(got "fast"\)/);
    expect(problem({ gate: { only: 'lint' } })).toMatch(/gate\.only must be a list of check names \(got "lint"\)/);
    expect(problem({ gate: { skip: [1] } })).toMatch(/gate\.skip must be a list of check names \(got \[1\]\)/);
    expect(problem({ gate: { changed: 'true' } })).toMatch(/gate\.changed must be true or false \(got "true"\)/);
    expect(problem({ gate: { preflight: ['gate.sh'] } })).toMatch(/gate\.preflight must be a path \(got \["gate\.sh"\]\)/);
    expect(problem({ gate: { note: 3 } })).toMatch(/'gate' note must be a string/);
    expect(problem({ gate: { onlyy: ['lint'] } })).toMatch(/gate has an unknown key 'onlyy' \(expected only, skip, changed, preflight, note\)/);
  });

  test('--config reads target roots against the repo, not the config file’s directory', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'checkride-outside-'));
    try {
      const path = join(outside, 'review.json');
      await writeFile(path, JSON.stringify({ targets: { web } }));
      expect(loadConfigFile(path, dir).targets).toEqual({ web });
      expect(() => loadConfigFile(path, outside)).toThrow(/targets\.web\.root "apps\/web" doesn't exist in the repo/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('configuredSlots reads what a validated config names, and stays null on a broken one', async () => {
    await write({ targets: { web }, checks: { spell: false, lint: false, licenses: { command: 'node' } } });
    expect(configuredSlots(dir)).toEqual(['licenses']);
    await write({ targets: {} });
    expect(configuredSlots(dir)).toBeNull();
  });
});

describe('published JSON Schema', () => {
  const schemaPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'schema',
    'checkride.config.schema.json',
  );
  // ajv is CJS whose runtime `module.exports` is the constructor, but its ESM
  // `.d.ts` declares a default export that NodeNext + verbatimModuleSyntax types
  // as the module namespace (not constructable). Vitest's interop hands us the
  // real constructor at runtime; cast through a minimal structural type so tsc
  // agrees on the surface we actually use.
  type Validator = (data: unknown) => boolean;
  type AjvCtor = new (opts?: { strict?: boolean; allErrors?: boolean }) => {
    compile: (schema: unknown) => Validator;
  };
  const schema: unknown = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const validate = new (Ajv as unknown as AjvCtor)({ strict: false, allErrors: true }).compile(schema);

  test('the top-level keys checkride reads are exactly the schema root’s', () => {
    const root = schema as { properties: Record<string, unknown> };
    expect([...CONFIG_KEYS].toSorted()).toEqual(Object.keys(root.properties).toSorted());
  });

  test('validates a representative config exercising every branch', () => {
    const config: CheckrideConfig = {
      $schema: configSchemaUrl('0.1.6'),
      note: 'Presets live in @acme/checkride-preset; this file only holds the deviations.',
      timeout: 600,
      checks: {
        lint: 'biome', // string: pick an alternate adapter
        spell: false, // false: disable a slot
        test: { use: 'vitest', timeout: 0, changedArgs: ['--changed', 'origin/master'] },
        format: 'prettier', // opt-in slot enabled by naming it
        attw: { use: 'attw', profile: 'esm-only', optIn: true }, // configure without opting in
        links: { use: 'links', exclude: ['docs', '.ridgeline'], allowlist: ['^foo/'] },
        tidy: { command: 'pnpm', args: ['exec', 'biome', 'format', '--write'], order: 'first' },
        licenses: { command: 'node', args: ['scripts/check-licenses.mjs'], optIn: true },
        docs: { use: 'markdownlint-cli2', description: 'Markdown lint', note: 'why, for maintainers' },
      },
    };
    expect(validate(config)).toBe(true);
  });

  test('rejects a non-string note, at the root and on a check', () => {
    expect(validate({ note: 42 })).toBe(false);
    expect(validate({ checks: { lint: { use: 'oxlint', note: ['a', 'b'] } } })).toBe(false);
    expect(validate({ checks: { lint: { command: 'node', note: null } } })).toBe(false);
  });

  test('rejects a non-boolean optIn', () => {
    expect(validate({ checks: { attw: { use: 'attw', optIn: 'yes' } } })).toBe(false);
  });

  test('rejects a links exclude that is not an array of strings', () => {
    expect(validate({ checks: { links: { use: 'links', exclude: 'docs' } } })).toBe(false);
  });

  test('the empty config is valid', () => {
    expect(validate({})).toBe(true);
  });

  test('rejects a non-string/object/false slot value', () => {
    expect(validate({ checks: { lint: 123 } })).toBe(false);
  });

  test('rejects an unknown top-level key', () => {
    expect(validate({ nonsense: true })).toBe(false);
  });

  test('rejects an unknown field inside a { use } override', () => {
    expect(validate({ checks: { test: { use: 'vitest', bogus: 1 } } })).toBe(false);
  });

  test('accepts an entry that only tunes a detected slot, and nothing more without use or command', () => {
    expect(validate({ checks: { lint: { optIn: true, timeout: 60, order: 'first', note: 'why' } } })).toBe(true);
    expect(validate({ checks: { lint: { timeout: 60, args: ['--quiet'] } } })).toBe(false);
  });

  test('rejects a custom check with no command', () => {
    expect(validate({ checks: { licenses: { args: ['x'] } } })).toBe(false);
  });

  test('accepts a custom check with a detect list', () => {
    expect(validate({ checks: { licenses: { command: 'node', detect: ['foo.config.js'] } } })).toBe(
      true,
    );
  });

  test('rejects a detect that is not an array of strings', () => {
    expect(validate({ checks: { licenses: { command: 'node', detect: 'foo.config.js' } } })).toBe(
      false,
    );
  });

  test('accepts order keywords and numbers on a custom check', () => {
    expect(validate({ checks: { a: { command: 'node', order: 'middle' } } })).toBe(true);
    expect(validate({ checks: { a: { command: 'node', order: 'single' } } })).toBe(true);
    expect(validate({ checks: { a: { command: 'node', order: 20 } } })).toBe(true);
    expect(validate({ checks: { a: { command: 'node', order: 1.5 } } })).toBe(true);
  });

  test('accepts order on a { use } override', () => {
    expect(validate({ checks: { test: { use: 'vitest', order: 'first' } } })).toBe(true);
    expect(validate({ checks: { test: { use: 'vitest', order: 20 } } })).toBe(true);
  });

  test('rejects an unknown order keyword', () => {
    expect(validate({ checks: { a: { command: 'node', order: 'sideways' } } })).toBe(false);
  });

  test('accepts a custom check skipExitCode from 1 to 255', () => {
    for (const code of [1, 77, 255]) {
      expect(validate({ checks: { a: { command: 'node', skipExitCode: code } } })).toBe(true);
    }
  });

  test('rejects a skipExitCode of 0, out of range, or not an integer', () => {
    for (const code of [0, 256, -1, 1.5, '77']) {
      expect(validate({ checks: { a: { command: 'node', skipExitCode: code } } })).toBe(false);
    }
  });

  test('rejects skipExitCode on a { use } override', () => {
    expect(validate({ checks: { test: { use: 'vitest', skipExitCode: 77 } } })).toBe(false);
  });

  test('accepts extends as a string and as an array of strings', () => {
    expect(validate({ extends: './base.json' })).toBe(true);
    expect(validate({ extends: ['@acme/preset', './base.json'] })).toBe(true);
  });

  test('rejects a non-string/array extends', () => {
    expect(validate({ extends: 123 })).toBe(false);
    expect(validate({ extends: [1, 2] })).toBe(false);
  });

  test('accepts targets, packs, requirePins and unclaimed', () => {
    const config: CheckrideConfig = {
      requirePins: false,
      unclaimed: { ignore: ['tools/legacy/**'] },
      targets: {
        web: { lang: 'ts', root: 'apps/web', note: 'storefront', checks: { lint: 'biome', e2e: { command: 'node' } } },
        'api-2': { lang: 'ts', root: '.' },
      },
      packs: { ts: { note: 'all ts', checks: { test: { use: 'vitest', timeout: 0 }, format: false } } },
      checks: { lint: { optIn: true, timeout: 60 } },
    };
    expect(validate(config)).toBe(true);
  });

  test('rejects what V1, V2, V3 and V9 rule out, where a schema can say it', () => {
    const at = (name: string, root = 'apps/web'): boolean => validate({ targets: { [name]: { lang: 'ts', root } } });
    expect(at('Web')).toBe(false);
    expect(at(`a${'b'.repeat(32)}`)).toBe(false);
    for (const slot of ['lint', 'links', 'schema', 'unclaimed']) expect(at(slot), slot).toBe(false);
    for (const root of ['/abs', '..', '../x', 'a/../b', 'a/..', '']) expect(at('web', root), root).toBe(false);
    for (const root of ['.', 'a..b', 'apps/web', './apps']) expect(at('web', root), root).toBe(true);
    expect(validate({ targets: {} })).toBe(false);
  });

  test('rejects an unknown pack, a target missing lang or root, and unknown keys in the new blocks', () => {
    expect(validate({ targets: { web: { lang: 'cobol', root: '.' } } })).toBe(false);
    expect(validate({ targets: { web: { root: '.' } } })).toBe(false);
    expect(validate({ targets: { web: { lang: 'ts' } } })).toBe(false);
    expect(validate({ targets: { web: { lang: 'ts', root: '.', rot: '.' } } })).toBe(false);
    expect(validate({ packs: { java: {} } })).toBe(false);
    expect(validate({ packs: { ts: { check: {} } } })).toBe(false);
    expect(validate({ requirePins: 'yes' })).toBe(false);
    expect(validate({ unclaimed: { ignore: 'x' } })).toBe(false);
    expect(validate({ unclaimed: { ignored: [] } })).toBe(false);
  });

  test('accepts the schemas rules the loader accepts, and rejects what V8 rules out', () => {
    const rules: CheckrideConfig['schemas'] = [
      { files: ['skills/*/SKILL.md'], schema: 'checkride:agent-skill', format: 'frontmatter', note: 'why' },
      { files: ['data/*.json'], schema: 'schemas/data.json' },
    ];
    expect(validate({ schemas: rules })).toBe(true);
    expect(validate({ schemas: [] })).toBe(true);
    for (const ref of ['https://example.com/s.json', 'HTTP://example.com/s.json', '/etc/s.json', '']) {
      expect(validate({ schemas: [{ files: ['a.json'], schema: ref }] }), ref).toBe(false);
    }
    expect(validate({ schemas: [{ files: ['a.json'] }] })).toBe(false);
    expect(validate({ schemas: [{ files: ['a.json'], schema: 'a.json', format: 'toml' }] })).toBe(false);
    expect(validate({ schemas: { files: ['a.json'], schema: 'a.json' } })).toBe(false);
  });

  /** A definition's `enum`, read out of the schema file. */
  const definitionEnum = (path: readonly string[]): unknown => {
    let node: unknown = schema;
    for (const key of ['definitions', ...path]) node = isRecord(node) ? node[key] : undefined;
    return isRecord(node) ? node['enum'] : undefined;
  };

  test('the pack names it accepts are the language packs PACKS holds', () => {
    const languagePacks = Object.keys(PACKS).filter((name) => name !== 'repo');
    expect(definitionEnum(['packName'])).toEqual(languagePacks);
  });

  test('the target names it reserves are every slot name, unclaimed included, plus schema and doc-snippets', () => {
    expect(definitionEnum(['targetName', 'not'])).toEqual([...SLOTS.map((s) => s.name), 'schema', 'doc-snippets']);
  });
});

describe('loadConfig', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-cfg-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('returns null when no config file exists', () => {
    expect(loadConfig(dir)).toBeNull();
  });

  test('an unknown top-level key warns, naming the file that holds it, the repo’s or a preset’s, and the config still loads', async () => {
    await writeFile(join(dir, 'base.json'), JSON.stringify({ timeout: 60, gaet: { only: ['lint'] } }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ extends: './base.json', check: { lint: false } }));
    const warned: string[] = [];
    expect(loadConfig(dir, (message) => warned.push(message))).toMatchObject({ timeout: 60 });
    expect(warned).toHaveLength(2);
    expect(warned[0]).toBe(
      'checkride: checkride.config.json has an unknown top-level key "check", which nothing reads (the keys are $schema, note, extends, timeout, changedBase, requirePins, unclaimed, schemas, targets, packs, gate, checks)',
    );
    expect(warned[1]).toMatch(/^checkride: \S*base\.json has an unknown top-level key "gaet", which nothing reads/);
    // Without a hook it stays silent, as every caller but a run, fix and doctor wants.
    expect(() => loadConfig(dir)).not.toThrow();
  });

  test('a --config file’s unknown key names that file', async () => {
    const path = join(dir, 'review.json');
    await writeFile(path, JSON.stringify({ check: {} }));
    const warned: string[] = [];
    loadConfigFile(path, dir, (message) => warned.push(message));
    expect(warned).toEqual([expect.stringMatching(new RegExp(`^checkride: ${path.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')} has an unknown top-level key "check"`))]);
  });

  test('reads and parses checkride.config.json', async () => {
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ checks: { spell: false } }));
    expect(loadConfig(dir)).toEqual({ checks: { spell: false } });
  });

  test('throws a friendly error on malformed JSON', async () => {
    await writeFile(join(dir, 'checkride.config.json'), '{ not valid json');
    expect(() => loadConfig(dir)).toThrow('invalid checkride.config.json');
  });

  test('extends a base by relative path, local keys winning', async () => {
    await writeFile(
      join(dir, 'base.json'),
      JSON.stringify({ timeout: 600, checks: { lint: 'eslint', spell: 'cspell' } }),
    );
    await writeFile(
      join(dir, 'checkride.config.json'),
      JSON.stringify({ extends: './base.json', checks: { lint: 'biome' } }),
    );
    // local `lint` overrides the base; base `spell`/`timeout` are inherited; `extends` is folded away.
    expect(loadConfig(dir)).toEqual({
      timeout: 600,
      checks: { lint: 'biome', spell: 'cspell' },
    });
  });

  test('deep-merges a slot entry, replacing arrays rather than concatenating', async () => {
    await writeFile(
      join(dir, 'base.json'),
      JSON.stringify({ checks: { test: { use: 'vitest', changedArgs: ['--changed', 'main'] } } }),
    );
    await writeFile(
      join(dir, 'checkride.config.json'),
      JSON.stringify({ extends: './base.json', checks: { test: { changedArgs: ['--changed', 'dev'] } } }),
    );
    // `use` survives from the base; the child's `changedArgs` array replaces (not concatenates).
    expect(loadConfig(dir)).toEqual({
      checks: { test: { use: 'vitest', changedArgs: ['--changed', 'dev'] } },
    });
  });

  test('resolves extends from an installed package (main entry)', async () => {
    const pkgDir = join(dir, 'node_modules', '@acme', 'preset');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@acme/preset', version: '1.0.0', main: 'checkride.config.json' }),
    );
    await writeFile(join(pkgDir, 'checkride.config.json'), JSON.stringify({ checks: { spell: false } }));
    await writeFile(
      join(dir, 'checkride.config.json'),
      JSON.stringify({ extends: '@acme/preset', checks: { lint: 'biome' } }),
    );
    expect(loadConfig(dir)).toEqual({ checks: { spell: false, lint: 'biome' } });
  });

  test('merges an extends array left-to-right, local winning last', async () => {
    await writeFile(join(dir, 'a.json'), JSON.stringify({ checks: { lint: 'eslint', spell: 'cspell' } }));
    await writeFile(join(dir, 'b.json'), JSON.stringify({ checks: { lint: 'oxlint', docs: false } }));
    await writeFile(
      join(dir, 'checkride.config.json'),
      JSON.stringify({ extends: ['./a.json', './b.json'], checks: { lint: 'biome' } }),
    );
    // b beats a (oxlint over eslint), then local beats both (biome); other keys accumulate.
    expect(loadConfig(dir)).toEqual({
      checks: { lint: 'biome', spell: 'cspell', docs: false },
    });
  });

  test('a base may itself extend another base', async () => {
    await writeFile(join(dir, 'grandparent.json'), JSON.stringify({ timeout: 300, checks: { spell: 'cspell' } }));
    await writeFile(
      join(dir, 'parent.json'),
      JSON.stringify({ extends: './grandparent.json', checks: { lint: 'eslint' } }),
    );
    await writeFile(
      join(dir, 'checkride.config.json'),
      JSON.stringify({ extends: './parent.json', checks: { lint: 'biome' } }),
    );
    expect(loadConfig(dir)).toEqual({
      timeout: 300,
      checks: { spell: 'cspell', lint: 'biome' },
    });
  });

  test('throws a friendly error when an extends target is missing', async () => {
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ extends: './nope.json' }));
    expect(() => loadConfig(dir)).toThrow('invalid checkride.config.json');
  });

  /** The tool each lint and test check resolves to, by check name, for the repo at `dir`. */
  const toolsOf = (config: CheckrideConfig | null): Record<string, string | null> =>
    Object.fromEntries(
      resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config, cwd: dir })
        .filter((c) => c.slot === 'lint' || c.slot === 'test')
        .map((c) => [c.target === undefined ? c.slot : `${c.target}:${c.slot}`, c.adapter?.name ?? null]),
    );

  test('a preset’s pick the root’s pack has no adapter for moves to the pack that has one, leaving the root its own tool', async () => {
    await writeFile(join(dir, 'go.mod'), 'module example.com/app\n\ngo 1.24\n');
    await writeFile(join(dir, '.golangci.yml'), 'version: "2"\n');
    await writeFile(join(dir, 'preset.json'), JSON.stringify({ checks: { lint: 'oxlint', spell: false } }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ extends: './preset.json' }));
    const config = loadConfig(dir);
    // The repo-scope entry stays at the top level; the ts pick lands on ts checks alone.
    expect(config).toEqual({ checks: { spell: false }, packs: { ts: { checks: { lint: 'oxlint' } } } });
    expect(toolsOf(config)).toMatchObject({ lint: 'golangci-lint', test: 'go-test' });
  });

  test('a preset’s pick for another pack leaves a ts root’s own tool alone', async () => {
    await writeFile(join(dir, 'package.json'), '{}');
    await writeFile(join(dir, '.oxlintrc.json'), '{}');
    await writeFile(join(dir, 'preset.json'), JSON.stringify({ checks: { lint: 'golangci-lint' } }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ extends: './preset.json' }));
    const config = loadConfig(dir);
    expect(config).toEqual({ checks: {}, packs: { go: { checks: { lint: 'golangci-lint' } } } });
    expect(toolsOf(config)).toMatchObject({ lint: 'oxlint' });
  });

  test('with targets, a preset’s top-level picks land on each pack’s targets instead of breaking V6', async () => {
    await mkdir(join(dir, 'web'));
    await writeFile(join(dir, 'web', 'package.json'), '{}');
    await mkdir(join(dir, 'api'));
    await writeFile(join(dir, 'api', 'go.mod'), 'module example.com/api\n\ngo 1.24\n');
    await writeFile(join(dir, 'api', '.golangci.yml'), 'version: "2"\n');
    await writeFile(
      join(dir, 'preset.json'),
      JSON.stringify({ checks: { lint: 'oxlint', test: { use: 'vitest', timeout: 0 } }, packs: { ts: { checks: { test: 'jest' } } } }),
    );
    const targets = { web: { lang: 'ts', root: 'web' }, api: { lang: 'go', root: 'api' } };
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ extends: './preset.json', targets }));
    const config = loadConfig(dir);
    // The preset's own pack block beats a pick moved into it.
    expect(config?.packs).toEqual({ ts: { checks: { lint: 'oxlint', test: 'jest' } } });
    expect(toolsOf(config)).toMatchObject({ 'web:lint': 'oxlint', 'api:lint': 'golangci-lint', 'web:test': 'jest', 'api:test': 'go-test' });
  });

  test('the repo’s own top-level pick keeps the rules it always has, once targets are declared', async () => {
    await mkdir(join(dir, 'web'));
    await writeFile(join(dir, 'web', 'package.json'), '{}');
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ checks: { lint: 'oxlint' }, targets: { web: { lang: 'ts', root: 'web' } } }));
    expect(() => loadConfig(dir)).toThrow(/checks\.lint names "oxlint", but once targets are declared/);
  });

  test('throws a friendly error on a circular extends chain', async () => {
    await writeFile(join(dir, 'a.json'), JSON.stringify({ extends: './b.json' }));
    await writeFile(join(dir, 'b.json'), JSON.stringify({ extends: './a.json' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ extends: './a.json' }));
    expect(() => loadConfig(dir)).toThrow(/invalid checkride\.config\.json: circular extends/);
  });
});

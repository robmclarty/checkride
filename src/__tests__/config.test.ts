import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ADAPTERS, SLOTS } from '../adapters.js';
import type { Adapter } from '../adapters.js';
import type { CheckrideConfig, CustomCheck, SlotConfig, UseConfig } from '../config.js';
import { configSchemaUrl, loadConfig, resolveChecks } from '../config.js';

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
    // In the 'any' group: after the plain catalogue members (e.g. spell), but
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
        { checks: { lint: { command: 'node', order: Number.POSITIVE_INFINITY } } } as unknown as CheckrideConfig,
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

  test('validates a representative config exercising every branch', () => {
    const config: CheckrideConfig = {
      $schema: configSchemaUrl('0.1.6'),
      timeout: 600,
      checks: {
        lint: 'biome', // string: pick an alternate adapter
        spell: false, // false: disable a slot
        test: { use: 'vitest', timeout: 0, changedArgs: ['--changed', 'origin/master'] },
        format: 'prettier', // opt-in slot enabled by naming it
        tidy: { command: 'pnpm', args: ['exec', 'biome', 'format', '--write'], order: 'first' },
        licenses: { command: 'node', args: ['scripts/check-licenses.mjs'] },
      },
    };
    expect(validate(config)).toBe(true);
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

  test('accepts extends as a string and as an array of strings', () => {
    expect(validate({ extends: './base.json' })).toBe(true);
    expect(validate({ extends: ['@acme/preset', './base.json'] })).toBe(true);
  });

  test('rejects a non-string/array extends', () => {
    expect(validate({ extends: 123 })).toBe(false);
    expect(validate({ extends: [1, 2] })).toBe(false);
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

  test('throws a friendly error on a circular extends chain', async () => {
    await writeFile(join(dir, 'a.json'), JSON.stringify({ extends: './b.json' }));
    await writeFile(join(dir, 'b.json'), JSON.stringify({ extends: './a.json' }));
    await writeFile(join(dir, 'checkride.config.json'), JSON.stringify({ extends: './a.json' }));
    expect(() => loadConfig(dir)).toThrow(/invalid checkride\.config\.json: circular extends/);
  });
});

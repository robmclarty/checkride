import { describe, expect, test } from 'vitest';

import { ADAPTERS, SCHEMA_VERSION, SLOTS } from '../adapters.js';

describe('registry invariants', () => {
  test('schema version is 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  test('every adapter targets a catalogue slot', () => {
    const slotNames = new Set(SLOTS.map((s) => s.name));
    for (const adapter of ADAPTERS) {
      expect(slotNames.has(adapter.slot)).toBe(true);
    }
  });

  test('the first adapter for each slot is the blessed default', () => {
    const blessed: Record<string, string> = {
      types: 'tsc', format: 'prettier', lint: 'oxlint', struct: 'ast-grep', dead: 'fallow',
      dupes: 'fallow', health: 'fallow', test: 'vitest',
      docs: 'markdownlint-cli2', links: 'links', spell: 'cspell', mutation: 'stryker', security: 'pnpm-audit',
      publint: 'publint', attw: 'attw',
    };
    for (const slot of SLOTS) {
      const first = ADAPTERS.find((a) => a.slot === slot.name);
      expect(first?.name).toBe(blessed[slot.name]);
    }
  });

  test('alternates are wired after the blessed default for swappable slots', () => {
    const names = (slot: string): string[] => ADAPTERS.filter((a) => a.slot === slot).map((a) => a.name);
    expect(names('format')).toEqual(['prettier', 'biome-format']);
    expect(names('lint')).toEqual(['oxlint', 'biome', 'eslint']);
    expect(names('dead')).toEqual(['fallow', 'knip']);
    expect(names('test')).toEqual(['vitest', 'jest']);
  });

  test('the three fallow analyses fill dead/dupes/health, each checkride-gated', () => {
    const fallow = ADAPTERS.filter((a) => a.name === 'fallow');
    expect(fallow.map((a) => a.slot)).toEqual(['dead', 'dupes', 'health']);
    for (const a of fallow) {
      expect(a.gate).toBe('fallow');
      expect(a.detect).toEqual(['fallow.toml']);
      expect(a.args).toContain('--format');
      expect(a.devDeps).toEqual({ fallow: '3.5.0' });
    }
    // dupes/health are opt-in so adopting checkride never fails a repo on
    // duplication/complexity it never signed up for.
    for (const name of ['dupes', 'health']) {
      expect(SLOTS.find((s) => s.name === name)?.optIn).toBe(true);
    }
  });

  test('format is an opt-in slot positioned before lint', () => {
    const names = SLOTS.map((s) => s.name);
    expect(SLOTS.find((s) => s.name === 'format')?.optIn).toBe(true);
    expect(names.indexOf('format')).toBeLessThan(names.indexOf('lint'));
  });

  test('opt-in slots are format + fallow dupes/health + the trailing mutation/security/publint/attw', () => {
    expect(SLOTS.filter((s) => s.optIn).map((s) => s.name)).toEqual([
      'format', 'dupes', 'health', 'mutation', 'security', 'publint', 'attw',
    ]);
    expect(SLOTS.slice(-2).map((s) => s.name)).toEqual(['publint', 'attw']);
  });

  test('the library-publishing slots are opt-in with JSON-capturing attw', () => {
    for (const name of ['publint', 'attw']) {
      expect(SLOTS.find((s) => s.name === name)?.optIn).toBe(true);
    }
    const attw = ADAPTERS.find((a) => a.name === 'attw');
    expect(attw?.slot).toBe('attw');
    expect(attw?.args).toEqual(['exec', 'attw', '--pack', '.', '--format', 'json']);
    expect(attw?.outputFile).toBe('attw.json');
    const publint = ADAPTERS.find((a) => a.name === 'publint');
    expect(publint?.slot).toBe('publint');
    expect(publint?.args).toEqual(['exec', 'publint']);
  });

  test('the blessed format adapter wires a prettier --check with a --write fix', () => {
    const prettier = ADAPTERS.find((a) => a.name === 'prettier');
    expect(prettier?.slot).toBe('format');
    expect(prettier?.detect).toContain('.prettierrc.json');
    expect(prettier?.args).toEqual(['exec', 'prettier', '--check', '.']);
    expect(prettier?.fixArgs).toEqual(['exec', 'prettier', '--write', '.']);
  });

  test('the links adapter is the only built-in', () => {
    const builtins = ADAPTERS.filter((a) => a.builtin);
    expect(builtins.map((a) => a.name)).toEqual(['links']);
  });

  test('D4 wave defaults: mutation runs single, publint/attw share wave 20, the rest default to any', () => {
    const orderOf = (name: string) => SLOTS.find((s) => s.name === name)?.order;
    expect(orderOf('mutation')).toBe('single');
    expect(orderOf('publint')).toBe(20);
    expect(orderOf('attw')).toBe(20);
    // Every other catalogue slot omits `order`, i.e. defers to the 'any' default.
    const carriesOrder = new Set(['mutation', 'publint', 'attw']);
    for (const slot of SLOTS) {
      if (!carriesOrder.has(slot.name)) expect(slot.order).toBeUndefined();
    }
  });

  test('no adapter pins its own order yet (adapter-level override arrives with snippets)', () => {
    for (const adapter of ADAPTERS) expect(adapter.order).toBeUndefined();
  });
});

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
      types: 'tsc', format: 'prettier', lint: 'oxlint', struct: 'ast-grep', dead: 'fallow', test: 'vitest',
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

  test('format is an opt-in slot positioned before lint', () => {
    const names = SLOTS.map((s) => s.name);
    expect(SLOTS.find((s) => s.name === 'format')?.optIn).toBe(true);
    expect(names.indexOf('format')).toBeLessThan(names.indexOf('lint'));
  });

  test('opt-in slots are format (leading) plus the trailing mutation/security/publint/attw', () => {
    expect(SLOTS.filter((s) => s.optIn).map((s) => s.name)).toEqual([
      'format', 'mutation', 'security', 'publint', 'attw',
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
});

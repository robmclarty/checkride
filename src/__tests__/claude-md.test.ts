import { describe, expect, test } from 'vitest';

import { AGENTS_IMPORT, claudeMd, claudeMdEdit, hasStanza, importsAgents, loadsStanza } from '../claude-md.js';

/** The pointer every release before the import wrote, byte for byte. */
const LEGACY = '# CLAUDE.md\n\nClaude Code-specific notes. See [AGENTS.md](./AGENTS.md) for the full contract.\n';

describe('importsAgents', () => {
  test('an @AGENTS.md line imports it, as does ./ and, from .claude/, ../', () => {
    expect(importsAgents('# Notes\n\n@AGENTS.md\n')).toBe(true);
    expect(importsAgents('Read @./AGENTS.md first.')).toBe(true);
    expect(importsAgents('@../AGENTS.md\n', '.claude')).toBe(true);
  });

  test('a link or a sentence naming AGENTS.md is not an import', () => {
    expect(importsAgents('See [AGENTS.md](./AGENTS.md) for the full contract.')).toBe(false);
    expect(importsAgents('Read AGENTS.md before anything else.')).toBe(false);
  });

  test('an import inside a fence or a code span is text, as Claude Code reads it', () => {
    expect(importsAgents('```md\n@AGENTS.md\n```\n')).toBe(false);
    expect(importsAgents('~~~\n@AGENTS.md\n~~~\n')).toBe(false);
    expect(importsAgents('Write `@AGENTS.md` to import it.')).toBe(false);
    expect(importsAgents('```\nx\n```\n\n@AGENTS.md\n')).toBe(true);
  });

  test('another file, an absolute path or a home path names some other AGENTS.md', () => {
    expect(importsAgents('@docs/AGENTS.md')).toBe(false);
    expect(importsAgents('@/AGENTS.md')).toBe(false);
    expect(importsAgents('@~/AGENTS.md')).toBe(false);
    expect(importsAgents('@AGENTS.md', '.claude')).toBe(false);
    expect(importsAgents('mail me@AGENTS.md')).toBe(false);
  });

  test('CRLF line endings read the same', () => {
    expect(importsAgents('# Notes\r\n\r\n@AGENTS.md\r\n')).toBe(true);
    expect(importsAgents('```\r\n@AGENTS.md\r\n```\r\n')).toBe(false);
  });
});

describe('loadsStanza', () => {
  test('a CLAUDE.md that is AGENTS.md through a symlink reads as the stanza, which loads it', () => {
    const agents = '# AGENTS.md\n\n<!-- checkride:begin hash=v1abc -->\n\nbody\n\n<!-- checkride:end -->\n';
    expect(hasStanza(agents)).toBe(true);
    expect(loadsStanza(agents)).toBe(true);
    expect(loadsStanza('# CLAUDE.md\n')).toBe(false);
  });
});

describe('claudeMd', () => {
  test('imports AGENTS.md first, so Claude reads it before any note', () => {
    const lines = claudeMd().split('\n');
    expect(lines.slice(0, 3)).toEqual(['# CLAUDE.md', '', AGENTS_IMPORT]);
    expect(importsAgents(claudeMd())).toBe(true);
  });
});

describe('claudeMdEdit', () => {
  test('a file that already loads AGENTS.md needs nothing', () => {
    expect(claudeMdEdit(claudeMd())).toBeNull();
    expect(claudeMdEdit('# Ours\n\n@AGENTS.md\n\nMore notes.\n')).toBeNull();
  });

  test('the pointer an earlier checkride wrote is replaced whole, CRLF and trailing spaces included', () => {
    expect(claudeMdEdit(LEGACY)).toMatchObject({ content: claudeMd(), change: 'refreshed pointer' });
    expect(claudeMdEdit(`${LEGACY.replace(/\n/g, '  \r\n')}\r\n`)?.content).toBe(claudeMd());
  });

  test('any other file keeps every byte and gains one import line at its end', () => {
    const ours = '# Ours\n\nUse tabs.\n\n\n';
    const edit = claudeMdEdit(ours);
    expect(edit).toMatchObject({ change: 'added @AGENTS.md import' });
    expect(edit?.content).toBe('# Ours\n\nUse tabs.\n\n@AGENTS.md\n');
    expect(claudeMdEdit(edit?.content ?? '')).toBeNull();
  });

  test('a CRLF file gets its import in CRLF, and an empty file just the import', () => {
    expect(claudeMdEdit('# Ours\r\n')?.content).toBe('# Ours\r\n\r\n@AGENTS.md\r\n');
    expect(claudeMdEdit('')?.content).toBe('@AGENTS.md\n');
  });

  test('a file that links to AGENTS.md still gets the import: a link loads nothing', () => {
    const linked = 'Read [AGENTS.md](./AGENTS.md) for the universal contract.\n';
    expect(claudeMdEdit(linked)?.content).toBe(`${linked}\n@AGENTS.md\n`);
  });
});

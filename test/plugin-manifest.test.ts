/**
 * Guards on the bundled Claude Code plugin manifest.
 *
 * The package root doubles as a plugin root: `.claude-plugin/plugin.json` names
 * the plugin, and the plugin's name is what sets the `/checkride:` command
 * namespace. That puts two version numbers in one package and two spellings of
 * the shipped file set in one manifest, either of which drifts silently — a
 * stale `plugin.json` version installs fine, and a `files` array that forgets
 * the plugin tree publishes a tarball where the plugin simply is not there.
 * These tests turn both silences into a failure.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Read and parse a JSON file at the repo root; a parse failure fails the caller. */
function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, relative), 'utf8')) as Record<string, unknown>;
}

describe('the bundled plugin manifest', () => {
  test('parses, and its name is the `/checkride:` command namespace', () => {
    expect(readJson('.claude-plugin/plugin.json')['name']).toBe('checkride');
  });

  /**
   * Nothing installs a mismatch loudly, so the mismatch has to be caught here.
   * `/version` bumps both numbers in the same commit — see
   * `.claude/skills/version/SKILL.md` step 8.
   */
  test('carries the same version as package.json', () => {
    const manifest = readJson('.claude-plugin/plugin.json');
    expect(manifest['version']).toBe(readJson('package.json')['version']);
  });

  test('ships in the published tarball, via package.json `files`', () => {
    expect(readJson('package.json')['files']).toEqual(
      expect.arrayContaining(['.claude-plugin', 'skills']),
    );
  });
});

/**
 * The npm package imports none of the `schema` slot's libraries. They are
 * optional peers a repo installs, loaded from that repo by path, so a static
 * or dynamic import of `ajv`, `yaml` or `jsonc-parser` anywhere in what ships
 * would fail in every install that left them out, and would hand a bundler of
 * the programmatic API a module it can't resolve. Only the standalone
 * binary's own wiring, under `build/sea/`, imports them, and that never
 * ships.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, test } from 'vitest';

import { CHECKOUT } from '../helpers/schema-libraries.js';

/** An import, a re-export, a dynamic import or a require of one of the three, or of a path inside one. */
const IMPORTS_LIBRARY = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"](?:ajv|yaml|jsonc-parser)(?:\/[^'"]*)?['"]/;

/** Every file under `dir` that `keep` keeps, as paths from the checkout's root. */
function filesUnder(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(join(CHECKOUT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(CHECKOUT, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter(keep);
}

/** The files among `files` that import one of the three libraries. */
const importing = (files: readonly string[]): string[] => files.filter((file) => IMPORTS_LIBRARY.test(readFileSync(join(CHECKOUT, file), 'utf8')));

describe("the schema slot's libraries stay out of the package", () => {
  test('the pattern sees each form an import takes', () => {
    for (const line of ["import Ajv from 'ajv';", 'import * as y from "yaml";', "const j = require('jsonc-parser');", "await import('ajv/dist/2020.js')", "export { parse } from 'yaml';", "import 'ajv';"]) {
      expect(IMPORTS_LIBRARY.test(line), line).toBe(true);
    }
    for (const line of ["const name = 'ajv';", "import { x } from './yaml.js';", "installCommand(pm, 'yaml@^2')", "import { a } from 'ajv-formats';"]) {
      expect(IMPORTS_LIBRARY.test(line), line).toBe(false);
    }
  });

  test('no shipped source file imports one', () => {
    const sources = filesUnder('src', (path) => path.endsWith('.ts') && !path.includes('/__tests__/'));
    expect(sources.length).toBeGreaterThan(100);
    expect(importing(sources)).toEqual([]);
  });

  test('no file of the built dist/ imports one, in its JavaScript or its declarations', () => {
    // `pnpm check` and `prepublishOnly` build before they test, so the package that would be packed is on disk.
    if (!existsSync(join(CHECKOUT, 'dist'))) return;
    const built = filesUnder('dist', (path) => /\.(?:js|d\.ts)$/.test(path) && !path.includes('/__tests__/'));
    expect(built.length).toBeGreaterThan(100);
    expect(importing(built)).toEqual([]);
  });

  test("the binary's wiring is where they are imported, and the package's files leave it out", () => {
    expect(importing(['build/sea/schema-libraries.mjs'])).toEqual(['build/sea/schema-libraries.mjs']);
    const manifest = JSON.parse(readFileSync(join(CHECKOUT, 'package.json'), 'utf8')) as { files: string[] };
    expect(manifest.files).not.toContain('build');
    expect(manifest.files.some((entry) => entry.startsWith('build'))).toBe(false);
  });
});

/**
 * A plain custom check: no `order`, no `detect`, so it runs after the built-in
 * catalogue with everything else that has no opinion about when it goes.
 *
 * It reads each installed direct dependency's own package.json and fails on any
 * license outside the allowlist.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ALLOWED = new Set(['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause']);

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const direct = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });

const violations = [];
let inspected = 0;

for (const name of direct) {
  const path = join('node_modules', name, 'package.json');

  // A dependency that isn't on disk is not this check's problem to report —
  // `pnpm install` already failed loudly if it mattered.
  if (!existsSync(path)) continue;

  const { license } = JSON.parse(await readFile(path, 'utf8'));
  inspected += 1;
  if (!ALLOWED.has(license)) violations.push(`${name}: ${license ?? '(none declared)'}`);
}

if (violations.length > 0) {
  console.error('Disallowed licenses:');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`${inspected} dependency license(s) allowed`);

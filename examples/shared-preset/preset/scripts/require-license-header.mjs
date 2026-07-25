/**
 * The strict tier's extra rule. A repo gets this one only by extending
 * `@acme/checkride-preset/strict.json` on top of the base preset — which is how
 * one preset package serves a fleet with more than one standard.
 */

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const HEADER = 'SPDX-License-Identifier:';

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

const missing = [];

for (const path of sourceFiles('src')) {
  const head = (await readFile(path, 'utf8')).slice(0, 200);
  if (!head.includes(HEADER)) missing.push(path);
}

if (missing.length > 0) {
  console.error(`Missing an "${HEADER}" header:`);
  for (const path of missing) console.error(`  ${path}`);
  process.exit(1);
}

console.log('every source file carries a license header');

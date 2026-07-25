/**
 * An org-wide rule, shipped inside the preset package rather than copied into
 * every repo. The check that invokes it points at this path under
 * `node_modules/`, so updating the rule is a preset release — not a pull
 * request against every repo in the fleet.
 */

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MARKER = /\b(TODO|FIXME)\b/;

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

const offenders = [];

for (const path of sourceFiles('src')) {
  const lines = (await readFile(path, 'utf8')).split('\n');
  lines.forEach((line, index) => {
    if (MARKER.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim()}`);
  });
}

if (offenders.length > 0) {
  console.error('TODO/FIXME comments are not allowed in shipped source:');
  for (const offender of offenders) console.error(`  ${offender}`);
  process.exit(1);
}

console.log('no TODO/FIXME comments found');

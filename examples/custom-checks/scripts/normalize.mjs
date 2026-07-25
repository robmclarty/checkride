/**
 * The `order: "first"` check: a bespoke formatter that normalizes the tree
 * before the linters and tests look at it.
 *
 * It rewrites every `data/*.json` file in canonical form (2-space indent, one
 * trailing newline). Committed files are already canonical, so a normal run is
 * a no-op — which is the point of running it first: everything downstream sees
 * the same bytes regardless of how the last edit was formatted.
 */

import { readdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DATA_DIR = 'data';

let rewritten = 0;

for (const name of readdirSync(DATA_DIR).filter((file) => file.endsWith('.json'))) {
  const path = join(DATA_DIR, name);
  const original = await readFile(path, 'utf8');

  let canonical;
  try {
    canonical = `${JSON.stringify(JSON.parse(original), null, 2)}\n`;
  } catch (error) {
    console.error(`${path}: not valid JSON — ${error.message}`);
    process.exit(1);
  }

  if (canonical !== original) {
    await writeFile(path, canonical);
    console.log(`normalized ${path}`);
    rewritten += 1;
  }
}

console.log(rewritten === 0 ? 'all fixtures already canonical' : `normalized ${rewritten} file(s)`);

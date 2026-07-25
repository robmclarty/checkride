/**
 * The `detect`-gated check that *fires*: `openapi.json` exists, so this runs.
 *
 * It asserts the API document and the code agree — every route the app declares
 * in `src/routes.ts` has a matching path in the spec. That is the sort of rule
 * no off-the-shelf linter knows about, which is exactly when a custom check
 * earns its place.
 */

import { readFile } from 'node:fs/promises';

const spec = JSON.parse(await readFile('openapi.json', 'utf8'));
const source = await readFile('src/routes.ts', 'utf8');

const failures = [];

if (typeof spec.openapi !== 'string') failures.push('openapi.json: missing an "openapi" version string');
if (typeof spec.info?.title !== 'string') failures.push('openapi.json: missing info.title');

const documented = new Set(Object.keys(spec.paths ?? {}));
const served = [...source.matchAll(/path:\s*'([^']+)'/g)].map((match) => match[1]);

for (const path of served) {
  if (!documented.has(path)) failures.push(`src/routes.ts serves ${path}, which openapi.json does not document`);
}

for (const path of documented) {
  if (!served.includes(path)) failures.push(`openapi.json documents ${path}, which src/routes.ts does not serve`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(`openapi.json and src/routes.ts agree on ${served.length} route(s)`);

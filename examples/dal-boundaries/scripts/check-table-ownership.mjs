/**
 * The rule fallow's zones cannot express: **a domain's writer may only write
 * that domain's tables.**
 *
 * Zone rules answer "may zone A import zone B?" — a question about two fixed
 * names. Table ownership is a question about a *relationship*: may
 * `domains/orders/writer.ts` import `domains/customers/schema.ts`? Both files
 * are in zones (`writers`, `schemas`) whose import rule already says yes,
 * because a writer must be able to import some schema. Which one is exactly
 * what the zone cannot see.
 *
 * So it goes here, in twenty lines of path arithmetic. Two invariants:
 *
 *   1. A writer imports only its own domain's schema.
 *   2. A domain has exactly one writer — the "single writer" in single-writer.
 *
 * Both scale with convention rather than configuration: add a domain folder
 * and it is covered, with nothing to remember.
 */

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DOMAINS_DIR = join('src', 'domains');

/** Every `../<domain>/schema.js` or `./schema.js` specifier a file imports. */
const SCHEMA_IMPORT = /from\s+'([^']*\/)?schema\.js'/g;

/** The domain a schema specifier points at, given the importing domain. */
function targetDomain(specifier, importingDomain) {
  // './schema.js' -> own domain. '../customers/schema.js' -> customers.
  const match = /\.\.\/([^/]+)\/schema\.js$/.exec(specifier);
  return match ? match[1] : importingDomain;
}

const domains = readdirSync(DOMAINS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const violations = [];

for (const domain of domains) {
  const writers = readdirSync(join(DOMAINS_DIR, domain)).filter((file) => /^writer\b.*\.ts$/.test(file));

  if (writers.length === 0) {
    violations.push(`${domain}: no writer.ts — every domain needs exactly one writer`);
    continue;
  }
  if (writers.length > 1) {
    violations.push(`${domain}: ${writers.length} writers (${writers.join(', ')}) — a domain may have only one`);
  }

  for (const writer of writers) {
    const path = join(DOMAINS_DIR, domain, writer);
    const source = await readFile(path, 'utf8');

    for (const [, prefix = ''] of source.matchAll(SCHEMA_IMPORT)) {
      const target = targetDomain(`${prefix}schema.js`, domain);
      if (target !== domain) {
        violations.push(
          `${path} imports the ${target} domain's schema — only the ${target} domain's writer may write those tables`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Table ownership violations:');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`${domains.length} domain(s): each has one writer, touching only its own tables`);

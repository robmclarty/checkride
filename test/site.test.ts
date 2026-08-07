/**
 * The site (`site/*.html`) is hand-built prose over inline dc scripts, and it
 * is not consumed by any tool the pipeline runs — which is exactly how it
 * silently fell four commands behind the CLI once. These tests put it under
 * `pnpm check`: the inline scripts must parse, the command reference and slot
 * catalogues must track the source of truth (`CLI_COMMANDS`, `SLOTS`), and
 * internal links must resolve. Currency is asserted one way on purpose — the
 * site may *curate* (say less), it may not *lag* (miss what exists).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

import { describe, expect, test } from 'vitest';

import { SLOTS } from '../src/adapters.js';
import { CLI_COMMANDS } from '../src/cli.js';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const pages = readdirSync(SITE).filter((f) => f.endsWith('.html')).toSorted();
const page = (name: string): string => readFileSync(join(SITE, name), 'utf8');

/** The one dc script each page carries — its logic component. */
function dcScript(html: string): string | null {
  const m = /<script type="text\/x-dc" data-dc-script>([\s\S]*?)<\/script>/.exec(html);
  return m?.[1] ?? null;
}

describe('site pages are well-formed', () => {
  test('there are pages to check (the suite must fail loudly if site/ moves)', () => {
    expect(pages.length).toBeGreaterThanOrEqual(4);
    expect(pages).toContain('index.html');
    expect(pages).toContain('api.html');
  });

  for (const name of pages) {
    test(`${name}: the inline dc script parses`, () => {
      const src = dcScript(page(name));
      expect(src, `${name} has no data-dc-script block`).not.toBeNull();
      // Syntax only — DCLogic exists at runtime in the browser, not here.
      expect(() => new Script(src ?? '')).not.toThrow();
    });
  }

  test('shipped site scripts parse', () => {
    for (const js of readdirSync(SITE).filter((f) => f.endsWith('.js'))) {
      expect(() => new Script(readFileSync(join(SITE, js), 'utf8')), js).not.toThrow();
    }
  });

  test('internal links resolve to files that exist', () => {
    for (const name of pages) {
      for (const m of page(name).matchAll(/href="([a-z0-9-]+\.html)"/g)) {
        expect(existsSync(join(SITE, m[1] ?? '')), `${name} links to missing ${m[1]}`).toBe(true);
      }
    }
  });
});

// The default command renders as the bare binary on the site.
const rendered = (cmd: string): string => (cmd === 'run' ? 'checkride' : cmd);

describe('site currency: commands', () => {
  test('every command in the dispatch table appears in the api.html reference', () => {
    const html = page('api.html');
    for (const cmd of CLI_COMMANDS) {
      expect(html, `api.html command reference is missing '${rendered(cmd)}'`).toMatch(
        new RegExp(`\\['${rendered(cmd)}',`),
      );
    }
  });

  test('every command in the dispatch table appears in the index.html footer', () => {
    const html = page('index.html');
    for (const cmd of CLI_COMMANDS) {
      expect(html, `index.html footer is missing '${rendered(cmd)}'`).toContain(`<span>${rendered(cmd)}</span>`);
    }
  });
});

describe('site currency: slot catalogue', () => {
  for (const name of ['api.html', 'index.html']) {
    test(`every catalogue slot appears in ${name}`, () => {
      const html = page(name);
      for (const slot of SLOTS) {
        expect(html, `${name} slot table is missing '${slot.name}'`).toMatch(new RegExp(`\\['${slot.name}',`));
      }
    });
  }
});

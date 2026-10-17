/**
 * The dialect rules `init --lang go|rust` ships (R11.6), each held by a
 * failing and a passing fixture, scanned with this repo's own ast-grep.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AST_GREP = join(ROOT, 'node_modules', '.bin', 'ast-grep');

/** The rule ids ast-grep reports for `source`, saved as `file`, under the rule at `rule`. */
function fired(rule: string, file: string, source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'checkride-dialect-'));
  try {
    writeFileSync(join(dir, file), source);
    let out = '[]';
    try {
      out = execFileSync(AST_GREP, ['scan', '--rule', join(ROOT, 'templates', rule), '--json=compact', file], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      out = (error as { stdout?: string }).stdout ?? '[]';
    }
    return (JSON.parse(out) as { ruleId: string }[]).map((m) => m.ruleId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GO = 'go/shared/rules/go';
const RUST = 'rust/shared/rules/rust';

describe('the go dialect rules', () => {
  test('go-no-dot-import forbids a dot import, and nothing else', () => {
    expect(fired(`${GO}/go-no-dot-import.yml`, 'a.go', 'package a\n\nimport . "strings"\n\nvar _ = ToUpper\n')).toEqual(['go-no-dot-import']);
    expect(fired(`${GO}/go-no-dot-import.yml`, 'a.go', 'package a\n\nimport "strings"\n\nvar _ = strings.ToUpper\n')).toEqual([]);
  });

  test('go-no-import-alias forbids an alias, but not _ or a plain import, and yields to an ignore comment', () => {
    expect(fired(`${GO}/go-no-import-alias.yml`, 'a.go', 'package a\n\nimport str "strings"\n\nvar _ = str.ToUpper\n')).toEqual(['go-no-import-alias']);
    expect(fired(`${GO}/go-no-import-alias.yml`, 'a.go', 'package a\n\nimport (\n\t_ "embed"\n\t"strings"\n)\n\nvar _ = strings.ToUpper\n')).toEqual([]);
    const ignored = 'package a\n\nimport (\n\t// ast-grep-ignore: go-no-import-alias\n\tstr "strings"\n)\n\nvar _ = str.ToUpper\n';
    expect(fired(`${GO}/go-no-import-alias.yml`, 'a.go', ignored)).toEqual([]);
  });

  test('go-no-init-func forbids func init outside package main', () => {
    expect(fired(`${GO}/go-no-init-func.yml`, 'a.go', 'package a\n\nfunc init() {}\n')).toEqual(['go-no-init-func']);
    expect(fired(`${GO}/go-no-init-func.yml`, 'main.go', 'package main\n\nfunc init() {}\n\nfunc main() {}\n')).toEqual([]);
  });
});

describe('the rust dialect rules', () => {
  test('rust-no-glob-reexport forbids pub use path::*', () => {
    expect(fired(`${RUST}/rust-no-glob-reexport.yml`, 'lib.rs', 'mod inner {}\npub use inner::*;\n')).toEqual(['rust-no-glob-reexport']);
    expect(fired(`${RUST}/rust-no-glob-reexport.yml`, 'lib.rs', 'mod inner { pub struct Thing; }\npub use inner::Thing;\n')).toEqual([]);
  });

  test('rust-no-glob-import forbids use path::*, other than use super::*', () => {
    expect(fired(`${RUST}/rust-no-glob-import.yml`, 'lib.rs', 'use std::collections::*;\n')).toEqual(['rust-no-glob-import']);
    expect(fired(`${RUST}/rust-no-glob-import.yml`, 'lib.rs', '#[cfg(test)]\nmod tests {\n    use super::*;\n}\nuse std::io::{self, Write};\n')).toEqual([]);
    // A glob re-export is the other rule's to report.
    expect(fired(`${RUST}/rust-no-glob-import.yml`, 'lib.rs', 'mod inner {}\npub use inner::*;\n')).toEqual([]);
  });
});

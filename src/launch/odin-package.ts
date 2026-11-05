/**
 * The `{odin-package}` argument token: the name of the Odin package at a
 * check's root, which `-vet-packages:<name>` needs to vet that package's own
 * procedures and no dependency's. An Odin package is one directory, and every
 * `.odin` file directly in it opens with the same `package <name>` clause,
 * after any comments and `#+build` file tags. The name is read from the
 * files, never by running the compiler.
 *
 * The vet of unused procedures flags every procedure nothing in the checked
 * program calls, so it answers only for a package with an entry point, a
 * `main` procedure of its own: a library package would see each procedure it
 * exports flagged. The read says whether the package is a program, and the
 * orchestrator sits a check out where it isn't.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The token an argument carries the package name in, as `-vet-packages:{odin-package}` does: a part of the argument, not the whole. */
const ODIN_PACKAGE_PLACEHOLDER = '{odin-package}';

/** What a directory's Odin source declares: its package, and whether a file of it declares the entry point. */
type OdinPackage = { name: string; program: boolean };

/** A file's package clause: the first thing in it after comments, blank lines and `#+` file tags. */
const PACKAGE_CLAUSE = /^\s*(?:#\+[^\n]*\n\s*)*package\s+([\p{L}_][\p{L}\p{N}_]*)/u;

/** The entry point a file declares: a `main` procedure at the top level. */
const MAIN_PROC = /(?:^|\n)[ \t]*main\s*::\s*proc\b/;

/** The index just past the literal opening at `start` with `quote`: a raw string ends only at its backtick; the others end at their quote, an escape kept whole, or at the line's end. */
function literalEnd(text: string, start: number, quote: string): number {
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== '`' && ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === quote || (quote !== '`' && ch === '\n')) return i + 1;
  }
  return text.length;
}

/** The index just past the block comment opening at `start`, nested ones inside it closed first, or the text's end. */
function blockCommentEnd(text: string, start: number): number {
  let depth = 1;
  let i = start + 2;
  while (i < text.length && depth > 0) {
    const pair = text.slice(i, i + 2);
    if (pair === '/*') depth += 1;
    if (pair === '*/') depth -= 1;
    i += pair === '/*' || pair === '*/' ? 2 : 1;
  }
  return i;
}

/**
 * `text` with its comments blanked: a line comment to the line's end, a block
 * comment with the ones nested in it, each left as a newline so what follows
 * still opens a line. A comment marker inside a string or rune literal opens
 * none, so literals are kept whole.
 */
function withoutComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    const pair = text.slice(i, i + 2);
    if (pair === '//') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (pair === '/*') {
      i = blockCommentEnd(text, i);
      out += '\n';
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const end = literalEnd(text, i, ch);
      out += text.slice(i, end);
      i = end;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** The `.odin` files directly in `dir`, in name order, or none where it can't be listed. */
function odinFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.odin')).toSorted();
  } catch {
    return [];
  }
}

/** The text of the file at `path`, or `null` where it can't be read. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The package the `.odin` files directly in `dir` declare, named by the first
 * file (in name order) with a package clause, and whether any of them
 * declares a `main` procedure; `null` where no file declares a package, as in
 * a directory with no Odin source. The compiler rejects files of one
 * directory that disagree on the name, so the first clause is the package's.
 */
export function odinPackage(dir: string): OdinPackage | null {
  let name: string | undefined;
  let program = false;
  for (const file of odinFilesIn(dir)) {
    const text = readText(join(dir, file));
    if (text === null) continue;
    const source = withoutComments(text);
    name ??= PACKAGE_CLAUSE.exec(source)?.[1];
    if (MAIN_PROC.test(source)) program = true;
  }
  return name === undefined ? null : { name, program };
}

/** True for an argument list with `{odin-package}` inside any argument. */
export function takesOdinPackage(args: readonly string[] | undefined): boolean {
  return args?.some((arg) => arg.includes(ODIN_PACKAGE_PLACEHOLDER)) ?? false;
}

/** `args` with every `{odin-package}` replaced by `name`, inside each argument. */
export function expandOdinPackage(args: readonly string[], name: string): string[] {
  return args.map((arg) => arg.replaceAll(ODIN_PACKAGE_PLACEHOLDER, name));
}

/** The reason a check taking `{odin-package}` records at a root whose files declare no package: skipped, not failed. */
export function noOdinPackageReason(root: string): string {
  return `no package clause in ${root}`;
}

/** The reason a check taking `{odin-package}` records at a package with no entry point, where the vet of unused procedures would flag every exported one. */
export function noOdinProgramReason(root: string): string {
  return `no main procedure in ${root}: unused procedures are vetted from a program`;
}

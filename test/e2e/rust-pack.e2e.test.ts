/**
 * The rust pack, run end to end against the real tools (R5.6).
 *
 * A Cargo workspace, a library with a doctest and a binary that uses it, pins
 * its toolchain in `rust-toolchain.toml` and cargo-machete in `mise.toml`, and
 * is checked from a rust target. Clean, every check is green, clippy and
 * rustfmt resolve through the toolchain file at its channel, and
 * cargo-machete through its mise pin. Each S5 plant fails the check it names:
 * a clippy warning fails `lint`, a failing doctest fails `snippets`, and an
 * unused dependency fails `dead`. The `struct` plant arrives with the Rust
 * dialect rules. Only rustup reads the toolchain file, so the cases need it.
 */

import { execFile, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { describeWithToolchain } from '../helpers/toolchains.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli.js');

/** The toolchain the repo's own mise.toml pins, with its clippy and rustfmt. */
const CHANNEL = '1.99.0';

const LIB = [
  '/// Adds one.',
  '///',
  '/// ```',
  '/// assert_eq!(kit::add_one(1), 2);',
  '/// ```',
  'pub fn add_one(x: u8) -> u8 {',
  '    x + 1',
  '}',
  '',
  '#[cfg(test)]',
  'mod tests {',
  '    #[test]',
  '    fn adds() {',
  '        assert_eq!(super::add_one(1), 2);',
  '    }',
  '}',
  '',
].join('\n');

const MAIN = 'fn main() {\n    println!("{}", kit::add_one(1));\n}\n';

const FILES: Record<string, string> = {
  'rust/Cargo.toml': '[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n',
  'rust/rust-toolchain.toml': `[toolchain]\nchannel = "${CHANNEL}"\ncomponents = ["clippy", "rustfmt"]\n`,
  'rust/mise.toml': '[tools]\n"ubi:bnjbvr/cargo-machete" = "0.9.2"\n',
  'rust/crates/kit/Cargo.toml': '[package]\nname = "kit"\nversion = "0.1.0"\nedition = "2021"\n',
  'rust/crates/kit/src/lib.rs': LIB,
  'rust/crates/cli/Cargo.toml': '[package]\nname = "cli"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nkit = { path = "../kit" }\n',
  'rust/crates/cli/src/main.rs': MAIN,
  'checkride.config.json': JSON.stringify({ targets: { app: { lang: 'rust', root: 'rust' } } }),
};

type Check = Record<string, unknown>;

const hasRustup = spawnSync('rustup', ['--version'], { stdio: 'ignore' }).status === 0;

(hasRustup ? describeWithToolchain('rust') : describe.skip)('the rust pack', () => {
  let template: string;
  let dir: string;

  beforeAll(async () => {
    template = await mkdtemp(join(tmpdir(), 'checkride-rust-pack-template-'));
    for (const [rel, content] of Object.entries(FILES)) {
      await mkdir(dirname(join(template, rel)), { recursive: true });
      await writeFile(join(template, rel), content);
    }
  });
  afterAll(async () => { await rm(template, { recursive: true, force: true }); });

  beforeEach(async (context) => {
    dir = await mkdtemp(join(tmpdir(), 'checkride-rust-pack-'));
    await cp(template, dir, { recursive: true });
    context.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  });

  const put = (rel: string, content: string): Promise<void> => writeFile(join(dir, rel), content);

  async function run(...args: string[]): Promise<{ code: number; stderr: string; checks: Map<string, Check> }> {
    const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile('node', [CLI, ...args], { cwd: dir, maxBuffer: 32 * 1024 * 1024 }, (error, _stdout, err) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stderr: err });
      });
    });
    const summary = JSON.parse(await readFile(join(dir, '.check', 'summary.json'), 'utf8')) as { checks: Check[] };
    return { code, stderr, checks: new Map(summary.checks.map((c) => [String(c['name']), c])) };
  }

  test('a clean workspace is green, each tool resolving through its pin', async () => {
    const { code, checks, stderr } = await run('--only', 'app', '--include', 'app:format,app:snippets');
    expect(code, stderr).toBe(0);
    expect(checks.get('app:types')).toMatchObject({ ok: true, adapter: 'cargo-check', output_file: 'app/types.jsonl' });
    expect(checks.get('app:lint')).toMatchObject({
      ok: true,
      adapter: 'clippy',
      pin_source: 'rust-toolchain',
      tool_version: CHANNEL,
      argv: ['cargo', 'clippy', '--workspace', '--all-targets', '--message-format=json', '--', '-D', 'warnings'],
    });
    expect(checks.get('app:format')).toMatchObject({ ok: true, adapter: 'rustfmt', pin_source: 'rust-toolchain', argv: ['cargo', 'fmt', '--all', '--check'] });
    expect(checks.get('app:dead')).toMatchObject({
      ok: true,
      adapter: 'cargo-machete',
      detected_by: 'rust/mise.toml: ubi:bnjbvr/cargo-machete',
      pin_source: 'mise',
      argv: ['mise', 'exec', '--', 'cargo', 'machete'],
    });
    expect(checks.get('app:test')).toMatchObject({ ok: true, adapter: 'cargo-test' });
    expect(checks.get('app:snippets')).toMatchObject({ ok: true, adapter: 'cargo-doctest' });
  });

  // S5: a clippy warning fails lint.
  test('a clippy warning fails app:lint, its diagnostics captured as JSON lines', async () => {
    await put('rust/crates/cli/src/main.rs', 'fn main() {\n    let unused = 3;\n    println!("{}", kit::add_one(1));\n}\n');
    const { code, checks } = await run('--only', 'app:lint');
    expect(code).toBe(1);
    expect(checks.get('app:lint')).toMatchObject({ ok: false, output_file: 'app/lint.jsonl' });
    expect(await readFile(join(dir, '.check', 'app', 'lint.jsonl'), 'utf8')).toContain('unused_variables');
  });

  // S5: a failing doctest fails snippets.
  test('a failing doctest fails app:snippets', async () => {
    await put('rust/crates/kit/src/lib.rs', LIB.replace('add_one(1), 2);\n/// ```', 'add_one(1), 3);\n/// ```'));
    const { code, checks } = await run('--only', 'app:snippets');
    expect(code).toBe(1);
    expect(checks.get('app:snippets')).toMatchObject({ ok: false, adapter: 'cargo-doctest' });
  });

  // S5: an unused dependency, with cargo-machete pinned, fails dead.
  test('an unused dependency fails app:dead', async () => {
    await put('rust/crates/cli/Cargo.toml', `${FILES['rust/crates/cli/Cargo.toml'] ?? ''}itoa = "1"\n`);
    const { code, checks } = await run('--only', 'app:dead');
    expect(code).toBe(1);
    expect(checks.get('app:dead')).toMatchObject({ ok: false, exit_code: 1 });
    expect(await readFile(join(dir, '.check', 'app', 'dead.stdout.txt'), 'utf8')).toContain('itoa');
  });
});

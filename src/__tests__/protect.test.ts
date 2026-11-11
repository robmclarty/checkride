/**
 * `checkride protect` against the script it stands in for. The decision is
 * written twice, as the text of the generated `.cjs` and as the typed
 * functions the command calls, and this table is what binds the two: each
 * payload is put to both, the script run on Node and the command run as the
 * CLI runs it, and each must give the verdict the table names and the same
 * exit code and output as the other, byte for byte. A change to either
 * decision adds a case here.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { protectScript } from '../agent-setup/index.js';
import { runCli } from '../cli.js';
import { denialBody, protectDecision, readStdin, runProtect } from '../protect.js';

function capture(): { write: (t: string) => boolean; text: () => string } {
  let buf = '';
  return { write: (t) => { buf += t; return true; }, text: () => buf };
}

/** `checkride protect <args>` with `payload` on stdin, in a project at `cwd`. */
async function cli(args: string[], payload: string, cwd = tmpdir()): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(['protect', ...args], { cwd, stdout, stderr, env: { CURSOR_PROJECT_DIR: cwd }, stdin: () => Promise.resolve(payload) });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** What a hook runner sees of either form: the exit code and what was written to stdout. */
type Verdict = { exitCode: number; stdout: string };

/** The command's verdict on `payload`, run as the CLI runs it. */
async function commandVerdict(payload: string, env: Record<string, string | undefined>, cwd: string): Promise<Verdict & { stderr: string }> {
  const stdout = capture();
  const stderr = capture();
  const { exitCode } = await runProtect({ cwd, env, stdout, stderr, stdin: () => Promise.resolve(payload) });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

type Case = { name: string; payload: (dir: string) => string; denies: string | null };

/** A `preToolUse` payload for a file tool. */
const call = (toolInput: Record<string, unknown>) => (): string => JSON.stringify({ tool_name: 'Write', tool_input: toolInput });

/** The same, with a path under the project. */
const callIn = (key: string, ...rel: string[]) => (dir: string): string => JSON.stringify({ tool_name: 'Write', tool_input: { [key]: join(dir, ...rel) } });

/** A `beforeShellExecution` payload, run from the project or a directory under it. */
const shell = (command: string, ...under: string[]) => (dir: string): string =>
  JSON.stringify({ hook_event_name: 'beforeShellExecution', command, cwd: join(dir, ...under) });

const raw = (text: string) => (): string => text;

const CASES: readonly Case[] = [
  // The file tools: the accounting files, by every spelling of the path.
  { name: 'the baseline, absolute', payload: callIn('file_path', 'checkride.baseline.json'), denies: 'checkride.baseline.json' },
  { name: 'the baseline, relative to the project', payload: call({ file_path: 'checkride.baseline.json' }), denies: 'checkride.baseline.json' },
  { name: 'a file under .check/', payload: callIn('file_path', '.check', 'summary.json'), denies: '.check/summary.json' },
  { name: 'a relative path under .check/', payload: call({ file_path: '.check/digest.md' }), denies: '.check/digest.md' },
  { name: '.check itself', payload: call({ file_path: '.check' }), denies: '.check' },
  { name: 'a named suite’s baseline', payload: callIn('file_path', 'checkride.evals.baseline.json'), denies: 'checkride.evals.baseline.json' },
  { name: 'a hyphenated suite’s baseline', payload: call({ file_path: 'checkride.perf-nightly.baseline.json' }), denies: 'checkride.perf-nightly.baseline.json' },
  { name: 'a suite’s output', payload: callIn('file_path', '.check', 'suites', 'evals', 'summary.json'), denies: '.check/suites/evals/summary.json' },
  { name: 'notebook_path', payload: callIn('notebook_path', '.check', 'n.ipynb'), denies: '.check/n.ipynb' },
  { name: 'path', payload: callIn('path', '.check', 'x'), denies: '.check/x' },
  { name: 'target_file', payload: callIn('target_file', '.check', 'y'), denies: '.check/y' },
  { name: 'filePath', payload: callIn('filePath', '.check', 'z'), denies: '.check/z' },
  { name: 'relative_workspace_path', payload: call({ relative_workspace_path: 'checkride.baseline.json' }), denies: 'checkride.baseline.json' },
  { name: 'a path through a symlink into .check/', payload: callIn('file_path', 'alias', 'summary.json'), denies: '.check/summary.json' },
  // The file tools: everything else.
  { name: 'an ordinary source file', payload: callIn('file_path', 'src', 'index.ts'), denies: null },
  { name: 'a file named like the baseline elsewhere', payload: callIn('file_path', 'fixtures', 'checkride.baseline.json'), denies: null },
  { name: 'a suite’s config', payload: callIn('file_path', 'checkride.evals.config.json'), denies: null },
  { name: 'the default config', payload: callIn('file_path', 'checkride.config.json'), denies: null },
  { name: 'not a suite’s name', payload: callIn('file_path', 'checkride.Evals.baseline.json'), denies: null },
  { name: 'two names where a suite’s goes', payload: callIn('file_path', 'checkride.a.b.baseline.json'), denies: null },
  { name: 'a suite’s baseline elsewhere', payload: callIn('file_path', 'fixtures', 'checkride.evals.baseline.json'), denies: null },
  { name: 'a sibling of .check', payload: callIn('file_path', '.checkpoint', 'x'), denies: null },
  { name: 'a path outside the project', payload: call({ file_path: '/tmp/checkride.baseline.json' }), denies: null },
  // The shell: a demonstrated write.
  { name: 'a redirect onto the baseline', payload: shell('echo "[]" > checkride.baseline.json'), denies: 'checkride.baseline.json' },
  { name: 'an append', payload: shell('echo "[]" >> checkride.baseline.json'), denies: 'checkride.baseline.json' },
  { name: 'a redirect with no spaces', payload: shell('echo x>.check/summary.json'), denies: '.check/summary.json' },
  { name: 'rm -rf .check', payload: shell('rm -rf .check'), denies: '.check' },
  { name: 'mv the baseline away', payload: shell('mv checkride.baseline.json /tmp/stash.json'), denies: 'checkride.baseline.json' },
  { name: 'sed -i', payload: shell('sed -i s/a/b/ checkride.baseline.json'), denies: 'checkride.baseline.json' },
  { name: 'tee down a pipe', payload: shell('cat x | tee .check/summary.json'), denies: '.check/summary.json' },
  { name: 'dd of=', payload: shell('dd if=/dev/null of=.check/summary.json'), denies: '.check/summary.json' },
  { name: 'cp onto the baseline', payload: shell('cp /tmp/x checkride.baseline.json'), denies: 'checkride.baseline.json' },
  { name: 'the second command of two', payload: shell('git status && echo "{}" > checkride.baseline.json'), denies: 'checkride.baseline.json' },
  { name: 'a verb behind an assignment and a path', payload: shell('LC_ALL=C /bin/rm checkride.evals.baseline.json'), denies: 'checkride.evals.baseline.json' },
  { name: 'a relative path from a subdirectory', payload: shell('echo x > ../checkride.baseline.json', 'src'), denies: 'checkride.baseline.json' },
  // The shell: reads, and writes elsewhere.
  { name: 'cat', payload: shell('cat .check/summary.json'), denies: null },
  { name: 'jq', payload: shell('jq . .check/summary.json'), denies: null },
  { name: 'grep -r', payload: shell('grep -r ok .check/'), denies: null },
  { name: 'ls', payload: shell('ls -la .check'), denies: null },
  { name: 'cp out of .check', payload: shell('cp .check/summary.json /tmp/backup.json'), denies: null },
  { name: 'a redirect out of .check', payload: shell('cat .check/summary.json > /tmp/out.json'), denies: null },
  { name: 'a mention in quotes', payload: shell('echo ".check > checkride.baseline.json"'), denies: null },
  { name: 'a write elsewhere', payload: shell('echo hi > src/index.ts'), denies: null },
  { name: 'rm elsewhere', payload: shell('rm -rf node_modules'), denies: null },
  { name: 'sed with no -i', payload: shell('sed s/a/b/ checkride.baseline.json'), denies: null },
  { name: 'the same relative path from the project root', payload: shell('echo x > ../checkride.baseline.json'), denies: null },
  { name: 'a shell event with no command', payload: raw(JSON.stringify({ hook_event_name: 'beforeShellExecution' })), denies: null },
  { name: 'a shell event whose command is no string', payload: raw(JSON.stringify({ hook_event_name: 'beforeShellExecution', command: 7 })), denies: null },
  // The shell: every shape of line the split has a branch for.
  { name: 'a quoted target', payload: shell('echo x > "checkride.baseline.json"'), denies: 'checkride.baseline.json' },
  { name: 'a single-quoted target with a space beside it', payload: shell("rm '.check/a b.json'"), denies: '.check/a b.json' },
  { name: 'a backslash-escaped space in a target', payload: shell(String.raw`rm .check/a\ b.json`), denies: '.check/a b.json' },
  { name: 'a backslash that ends the line', payload: shell('rm .check/x \\'), denies: '.check/x' },
  { name: 'a quote that never closes', payload: shell('rm ".check/x'), denies: '.check/x' },
  { name: 'a quote opened inside the other kind', payload: shell(`echo "it's" > .check/x`), denies: '.check/x' },
  { name: 'a quoted operator, which the split reads as one', payload: shell('echo ">" .check/x'), denies: '.check/x' },
  { name: 'stderr folded in before the redirect', payload: shell('make 2>&1 > .check/log.txt'), denies: '.check/log.txt' },
  { name: 'a redirect with nothing after it', payload: shell('echo x >'), denies: null },
  { name: 'a redirect into an operator', payload: shell('echo x > | cat'), denies: null },
  { name: 'three of an operator are no redirect', payload: shell('echo x >>> checkride.baseline.json'), denies: null },
  { name: 'an input redirect is a read', payload: shell('wc -l < checkride.baseline.json'), denies: null },
  { name: 'a write after a semicolon, from where the payload says', payload: shell('true; rm ../checkride.baseline.json', 'src'), denies: 'checkride.baseline.json' },
  { name: 'a write behind a background job', payload: shell('sleep 1 & rm -f .check/summary.json'), denies: '.check/summary.json' },
  { name: 'a write behind ||', payload: shell('test -f x || truncate -s 0 checkride.baseline.json'), denies: 'checkride.baseline.json' },
  { name: 'assignments and no verb', payload: shell('A=checkride.baseline.json B=.check'), denies: null },
  { name: 'an empty command', payload: shell(''), denies: null },
  { name: 'operators alone', payload: shell('| ; &&'), denies: null },
  { name: 'unlink', payload: shell('unlink checkride.baseline.json'), denies: 'checkride.baseline.json' },
  { name: 'shred', payload: shell('shred -u .check/summary.json'), denies: '.check/summary.json' },
  { name: 'rmdir', payload: shell('rmdir .check'), denies: '.check' },
  { name: 'install onto .check', payload: shell('install -m 644 /tmp/x .check/summary.json'), denies: '.check/summary.json' },
  { name: 'ln onto the baseline', payload: shell('ln -sf /tmp/x checkride.baseline.json'), denies: 'checkride.baseline.json' },
  { name: 'rsync into .check', payload: shell('rsync -a /tmp/x/ .check/'), denies: '.check' },
  { name: 'rsync out of .check', payload: shell('rsync -a .check/ /tmp/x/'), denies: null },
  { name: 'a destination-only verb with flags alone', payload: shell('cp --help'), denies: null },
  { name: 'perl -pi', payload: shell("perl -pi -e 's/a/b/' checkride.baseline.json"), denies: 'checkride.baseline.json' },
  { name: 'sed with -i in a cluster', payload: shell('sed -Ei.bak s/a/b/ checkride.baseline.json'), denies: 'checkride.baseline.json' },
  { name: 'sed -n is no -i', payload: shell('sed -n 1p checkride.baseline.json'), denies: null },
  { name: 'dd reading the baseline', payload: shell('dd if=checkride.baseline.json of=/tmp/copy'), denies: null },
  { name: 'tee -a', payload: shell('echo x | tee -a checkride.baseline.json'), denies: 'checkride.baseline.json' },
  { name: 'a verb the split does not know', payload: shell('python3 fix.py checkride.baseline.json'), denies: null },
  { name: 'the first write of two, when both are accounting', payload: shell('echo x > .check/a; rm checkride.baseline.json'), denies: '.check/a' },
  { name: 'a redirect ahead of its verb’s own targets', payload: shell('rm checkride.baseline.json > .check/log'), denies: '.check/log' },
  { name: 'an absolute path in a command', payload: (dir) => shell(`rm ${join(dir, 'checkride.baseline.json')}`)(dir), denies: 'checkride.baseline.json' },
  { name: 'a shell event with an empty cwd reads from the project', payload: raw(JSON.stringify({ hook_event_name: 'beforeShellExecution', command: 'rm .check/x', cwd: '' })), denies: '.check/x' },
  { name: 'a shell event carrying a tool_input too', payload: raw(JSON.stringify({ hook_event_name: 'beforeShellExecution', command: 'ls', tool_input: { file_path: 'checkride.baseline.json' } })), denies: null },
  // The file tools: the shapes around the path.
  { name: 'another event name is read as a file tool', payload: raw(JSON.stringify({ hook_event_name: 'afterFileEdit', tool_input: { file_path: '.check/x' } })), denies: '.check/x' },
  { name: 'the first key that names accounting, of several', payload: call({ file_path: 'src/a.ts', path: '.check/x', target_file: 'checkride.baseline.json' }), denies: '.check/x' },
  { name: 'a file tool path read from the payload’s cwd', payload: (dir) => JSON.stringify({ cwd: join(dir, 'src'), tool_input: { file_path: '../checkride.baseline.json' } }), denies: 'checkride.baseline.json' },
  { name: 'a path with .. back into .check', payload: call({ file_path: 'src/../.check/x' }), denies: '.check/x' },
  { name: 'a path with a trailing slash', payload: call({ file_path: '.check/' }), denies: '.check' },
  { name: 'a path holding a NUL', payload: call({ file_path: '.check/a\u0000b' }), denies: '.check/a\u0000b' },
  { name: 'a tool_input that is an array', payload: raw(JSON.stringify({ tool_input: ['checkride.baseline.json'] })), denies: null },
  { name: 'a tool_input that is a number', payload: raw(JSON.stringify({ tool_input: 7 })), denies: null },
  { name: 'a tool_input that is true', payload: raw(JSON.stringify({ tool_input: true })), denies: null },
  { name: 'a path that is null', payload: call({ file_path: null }), denies: null },
  { name: 'a path that is an object', payload: call({ file_path: { path: 'checkride.baseline.json' } }), denies: null },
  { name: 'a path that is an array', payload: call({ file_path: ['checkride.baseline.json'] }), denies: null },
  { name: 'a byte order mark ahead of the JSON', payload: raw('\uFEFF{"tool_input":{"file_path":"checkride.baseline.json"}}'), denies: null },
  { name: 'two JSON values', payload: raw('{"tool_input":{"file_path":"checkride.baseline.json"}}{}'), denies: null },
  { name: 'a duplicated key, where the last wins', payload: raw('{"tool_input":{"file_path":"checkride.baseline.json","file_path":"src/a.ts"}}'), denies: null },
  // Input it cannot read: allowed, exit 0, no output.
  { name: 'nothing at all', payload: raw(''), denies: null },
  { name: 'whitespace', payload: raw(' \n'), denies: null },
  { name: 'not JSON', payload: raw('not json'), denies: null },
  { name: 'JSON cut short', payload: raw('{"tool_input":{"file_path":"checkride.baseline.json"'), denies: null },
  { name: 'null', payload: raw('null'), denies: null },
  { name: 'a number', payload: raw('42'), denies: null },
  { name: 'a string', payload: raw('"checkride.baseline.json"'), denies: null },
  { name: 'an array', payload: raw('[{"tool_input":{"file_path":"checkride.baseline.json"}}]'), denies: null },
  { name: 'an empty object', payload: raw('{}'), denies: null },
  { name: 'no tool_input', payload: raw(JSON.stringify({ tool_name: 'Write' })), denies: null },
  { name: 'a tool_input that is null', payload: raw(JSON.stringify({ tool_input: null })), denies: null },
  { name: 'a tool_input that is a string', payload: raw(JSON.stringify({ tool_input: 'checkride.baseline.json' })), denies: null },
  { name: 'a path that is a number', payload: call({ file_path: 42 }), denies: null },
  { name: 'a path that is empty', payload: call({ file_path: '' }), denies: null },
  { name: 'a key it does not know', payload: call({ destination: 'checkride.baseline.json' }), denies: null },
  { name: 'a cwd that is no string', payload: raw(JSON.stringify({ cwd: 7, tool_input: { file_path: 'src/a.ts' } })), denies: null },
];

/** The body a denial of `rel` carries: Cursor's `permission: 'deny'`, the message once for the user and once for the agent. */
function denial(rel: string): string {
  const message = `checkride: ${rel} is checkride-owned accounting. Never edit the baseline or .check artifacts to make a check pass — fix the finding instead (the ratchet prunes the baseline on its own).`;
  return JSON.stringify({ permission: 'deny', user_message: message, agent_message: message });
}

describe('checkride protect and the generated script', () => {
  let dir: string;
  let scriptFile: string;
  let env: Record<string, string | undefined>;

  beforeAll(async () => {
    // The real path, so the directory has one spelling for both forms to resolve.
    dir = await realpath(await mkdtemp(join(tmpdir(), 'checkride-protect-table-')));
    await mkdir(join(dir, '.check'));
    await mkdir(join(dir, 'src'));
    await symlink(join(dir, '.check'), join(dir, 'alias'));
    scriptFile = join(dir, 'protect.cjs');
    await writeFile(scriptFile, protectScript());
    env = { PATH: process.env['PATH'], CURSOR_PROJECT_DIR: dir };
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  /** The generated script's verdict, as a hook runner sees it: its exit code and its stdout. */
  function scriptVerdict(payload: string): Verdict {
    try {
      return { exitCode: 0, stdout: execFileSync(process.execPath, [scriptFile], { input: payload, env, cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] }).toString() };
    } catch (error) {
      const failed = error as { status?: number; stdout?: Buffer };
      return { exitCode: failed.status ?? -1, stdout: failed.stdout?.toString() ?? '' };
    }
  }

  test.each(CASES)('$name', async ({ payload, denies }) => {
    const text = payload(dir);
    const expected: Verdict = { exitCode: 0, stdout: denies === null ? '' : denial(denies) };
    expect(scriptVerdict(text)).toEqual(expected);
    expect(await commandVerdict(text, env, dir)).toEqual({ ...expected, stderr: '' });
  });

  test('the command’s denial body is the script’s, to the byte', () => {
    expect(denialBody('.check/x')).toBe(denial('.check/x'));
    expect(scriptVerdict(JSON.stringify({ tool_input: { file_path: '.check/x' } })).stdout).toBe(denialBody('.check/x'));
  });

  test('the project root comes from CURSOR_PROJECT_DIR, then CLAUDE_PROJECT_DIR, then the working directory', () => {
    const text = JSON.stringify({ tool_input: { file_path: 'checkride.baseline.json' } });
    const elsewhere = join(dir, 'src');
    for (const variables of [{ CURSOR_PROJECT_DIR: dir }, { CLAUDE_PROJECT_DIR: dir }, { CURSOR_PROJECT_DIR: '', CLAUDE_PROJECT_DIR: dir }]) {
      expect(protectDecision(text, variables, elsewhere)).toBe('checkride.baseline.json');
    }
    expect(protectDecision(text, {}, dir)).toBe('checkride.baseline.json');
    // With no variable the working directory is the project, so the project's own baseline is a file outside it.
    expect(protectDecision(JSON.stringify({ tool_input: { file_path: join(dir, 'checkride.baseline.json') } }), {}, elsewhere)).toBeNull();
  });

  test('a payload cut at any byte is allowed by both, and never a fault', async () => {
    const whole = JSON.stringify({ hook_event_name: 'beforeShellExecution', command: 'echo "x" > checkride.baseline.json', cwd: dir });
    for (let end = 0; end < whole.length; end += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one payload at a time, so a failure names the cut it failed at.
      expect(await commandVerdict(whole.slice(0, end), env, dir), `cut at ${end}`).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    }
    for (const end of [0, 1, 20, 60, whole.length - 1]) expect(scriptVerdict(whole.slice(0, end))).toEqual({ exitCode: 0, stdout: '' });
    expect((await commandVerdict(whole, env, dir)).stdout).toBe(denial('checkride.baseline.json'));
  });
});

/** A decision that fails as code does when the machine under it gives way. */
function diskGone(): never {
  throw new Error('the disk went away');
}

/** A decision that throws a value that is no Error. */
function bareThrow(): never {
  // oxlint-disable-next-line no-throw-literal -- the case under test: code that throws a bare value.
  throw 'a bare string';
}

/**
 * A fault of the command's own is not an allow. The script, crashing, exits
 * non-zero with the error on stderr and nothing on stdout; so does the
 * command, and a hook runner can tell a guard that broke from one that
 * passed the edit.
 */
describe('a fault that is not about the payload', () => {
  const BASELINE = JSON.stringify({ tool_input: { file_path: 'checkride.baseline.json' } });

  test('a decision that throws is one line on stderr and exit 1, with nothing on stdout', async () => {
    const stdout = capture();
    const stderr = capture();
    const result = await runProtect({ cwd: tmpdir(), env: {}, stdout, stderr, stdin: () => Promise.resolve(BASELINE), decide: diskGone });
    expect(result).toEqual({ exitCode: 1 });
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toBe('checkride protect: the edit guard failed, so this call was not checked: the disk went away\n');
  });

  test('so is a fault inside the real decision, here an environment that can’t be read', async () => {
    const faulty = { get CURSOR_PROJECT_DIR(): string { throw new Error('unreadable'); } };
    const verdict = await commandVerdict(BASELINE, faulty, tmpdir());
    expect(verdict).toEqual({ exitCode: 1, stdout: '', stderr: 'checkride protect: the edit guard failed, so this call was not checked: unreadable\n' });
  });

  test('a thrown value that is no Error is reported as it is', async () => {
    const stderr = capture();
    expect(await runProtect({ cwd: tmpdir(), env: {}, stdout: capture(), stderr, stdin: () => Promise.resolve(BASELINE), decide: bareThrow })).toEqual({ exitCode: 1 });
    expect(stderr.text()).toContain('not checked: a bare string\n');
  });

  test('through the CLI it is exit 1 too, where a payload it can’t read stays exit 0', async () => {
    const faulty = { get CURSOR_PROJECT_DIR(): string { throw new Error('unreadable'); } };
    const stdout = capture();
    const stderr = capture();
    expect(await runCli(['protect', '--harness', 'cursor'], { cwd: tmpdir(), stdout, stderr, env: faulty, stdin: () => Promise.resolve(BASELINE) })).toBe(1);
    expect(stdout.text()).toBe('');
    expect(await runCli(['protect', '--harness', 'cursor'], { cwd: tmpdir(), stdout, stderr, env: faulty, stdin: () => Promise.resolve('not json') })).toBe(0);
  });
});

describe('checkride protect, the command', () => {
  const BASELINE_EDIT = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'checkride.baseline.json' } });

  test('denies a baseline edit in Cursor’s protocol: the body on stdout, exit 0', async () => {
    const { code, stdout, stderr } = await cli(['--harness', 'cursor'], BASELINE_EDIT);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ permission: 'deny' });
    expect(stderr).toBe('');
  });

  test('allows an ordinary edit with no output at all', async () => {
    expect(await cli(['--harness', 'cursor'], JSON.stringify({ tool_input: { file_path: 'src/a.ts' } }))).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  test('answers Cursor when no harness is named', async () => {
    expect((await cli([], BASELINE_EDIT)).stdout).toContain('"permission":"deny"');
  });

  test.each(['', 'not json', '{"tool_input":'])('allows malformed input: %j', async (payload) => {
    expect(await cli(['--harness', 'cursor'], payload)).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  test.each(['claude', 'windsurf', ''])('refuses another harness with exit 2, naming the one it answers: %j', async (harness) => {
    const { code, stdout, stderr } = await cli(['--harness', harness], BASELINE_EDIT);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toBe(`checkride: invalid --harness '${harness}' (protect answers cursor)\n`);
  });

  test('an unknown flag is a usage error', async () => {
    expect((await cli(['--if-dirty'], BASELINE_EDIT)).code).toBe(2);
  });

  test('--help lists it as a hook command and has its own page', async () => {
    const stdout = capture();
    await runCli(['--help'], { cwd: tmpdir(), stdout, stderr: capture() });
    expect(stdout.text()).toMatch(/^ {2}protect {2,}Decide whether an agent's edit touches the baseline or \.check\/\n.*hook protocol\. Invoked by the\n.*not run by hand\.$/m);
    const own = capture();
    await runCli(['protect', '--help'], { cwd: tmpdir(), stdout: own, stderr: capture() });
    expect(own.text()).toContain('Usage: checkride protect --harness cursor');
  });

  test('runProtect reads the working directory as the project when no variable names one', async () => {
    const stdout = capture();
    const result = await runProtect({ cwd: tmpdir(), env: {}, stdout, stderr: capture(), stdin: () => Promise.resolve(BASELINE_EDIT) });
    expect(result).toEqual({ exitCode: 0 });
    expect(stdout.text()).toContain('"permission":"deny"');
  });
});

/** A stand-in for the process's stdin: a stream of `chunks`, a terminal or not. */
function stream(chunks: (string | Buffer)[], tty = false): NodeJS.ReadStream {
  return Object.assign(Readable.from(chunks, { objectMode: false }), { isTTY: tty }) as unknown as NodeJS.ReadStream;
}

describe('readStdin', () => {
  test('reads every chunk as UTF-8, a character split across two included', async () => {
    const bytes = Buffer.from('{"a":"é"}');
    expect(await readStdin(stream([bytes.subarray(0, 7), bytes.subarray(7)]))).toBe('{"a":"é"}');
    expect(await readStdin(stream(['{"a":', '1}']))).toBe('{"a":1}');
  });

  test('an empty stream is an empty payload', async () => {
    expect(await readStdin(stream([]))).toBe('');
  });

  test('a terminal is not read: no hook is on the other end of one', async () => {
    expect(await readStdin(stream(['typed'], true))).toBe('');
  });

  test('a stream that fails is an empty payload, which the verdict allows', async () => {
    const failing = new Readable({ read() { this.destroy(new Error('EIO')); } });
    expect(await readStdin(Object.assign(failing, { isTTY: false }) as unknown as NodeJS.ReadStream)).toBe('');
  });
});

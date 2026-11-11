/**
 * The standalone binary, for real (R14.1): `pnpm build:sea`'s output for this
 * host, or the one `CHECKRIDE_BIN` names, run as a user without Node runs it.
 *
 * Every case runs the binary under a `PATH` that holds `sh`, `which` and the
 * binary itself, and nothing else, so a binary that reached for a `node`
 * beside it would fail here. The npm CLI (`node dist/cli.js`) is run beside
 * it wherever the two must agree: the scaffold `init` writes and the summary
 * a run leaves.
 *
 * The build runs in a `beforeAll` and needs the Node the binary embeds, which
 * `build/sea/build.mjs` reaches through mise when this process runs on
 * another. A build that fails fails every case: nothing here skips, so a
 * green `pnpm test:e2e` always ran a binary. A run that must leave the binary
 * out says so itself, by excluding this file (`.github/workflows/publish.yaml`).
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

/** A cold build bundles, embeds and signs in seconds, and may first wait on mise to fetch the pinned Node. */
const BUILD_TIMEOUT_MS = 600_000;

type Run = { code: number | null; stdout: string; stderr: string };

/** The binary under test: the one `CHECKRIDE_BIN` names, or a fresh build. Throws when there is none to test. */
function locateBinary(): string {
  const named = process.env['CHECKRIDE_BIN'];
  if (named !== undefined && named !== '') {
    if (!existsSync(named)) throw new Error(`CHECKRIDE_BIN names ${named}, which doesn't exist`);
    return realpathSync(named);
  }
  const built = spawnSync(process.execPath, [join(ROOT, 'build', 'sea', 'build.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: BUILD_TIMEOUT_MS - 30_000 });
  if (built.status === 0) return built.stdout.trim();
  const why = `${built.error?.message ?? ''}\n${built.stderr}`.trim().split('\n').slice(-6).join('\n');
  throw new Error(`build:sea failed, so there is no binary to test (exit ${built.status ?? built.signal}):\n${why}`);
}

const scratch = mkdtempSync(join(tmpdir(), 'checkride-binary-e2e-'));
const WHICH = ['/usr/bin/which', '/bin/which'].find((path) => existsSync(path));

/** A directory for `PATH` holding `sh`, for the custom checks, and `which`, which doctor finds each tool with. */
function pathDir(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir);
  symlinkSync('/bin/sh', join(dir, 'sh'));
  if (WHICH !== undefined) symlinkSync(WHICH, join(dir, 'which'));
  return dir;
}

/** `sh`, `which` and, once it is built, `checkride`, the binary: no `node`, no package manager, no git. */
const BARE_PATH = pathDir('path');

/** `sh` and `which` alone: no `checkride` either, as when the binary is run by its path. */
const EMPTY_PATH = pathDir('path-without-checkride');

/** The environment a machine without Node gives the binary. */
const BARE_ENV = { PATH: BARE_PATH, HOME: scratch };

let BIN = '';

beforeAll(() => {
  BIN = locateBinary();
  symlinkSync(BIN, join(BARE_PATH, 'checkride'));
}, BUILD_TIMEOUT_MS);

function spawn(command: string, args: readonly string[], cwd: string, env: Record<string, string>): Run {
  const done = spawnSync(command, [...args], { cwd, env, encoding: 'utf8', timeout: 120_000 });
  if (done.error) throw done.error;
  return { code: done.status, stdout: done.stdout, stderr: done.stderr };
}

/** The binary, on a `PATH` with no `node`. */
function binary(args: readonly string[], cwd: string, env: Record<string, string> = {}): Run {
  return spawn(BIN, args, cwd, { ...BARE_ENV, ...env });
}

/** The npm CLI, on this process's Node and `PATH`, without the CHECKRIDE_ variables a shell exported. */
function npm(args: readonly string[], cwd: string): Run {
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith('CHECKRIDE_')));
  return spawn(process.execPath, [CLI, ...args], cwd, env);
}

let serial = 0;

/** A fresh directory named `name`, so a scaffold that takes its name from the directory gets the same one from each CLI. */
function freshDir(name = 'repo'): string {
  serial += 1;
  const dir = join(scratch, `case-${serial}`, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function write(dir: string, file: string, content: unknown): void {
  writeFileSync(join(dir, file), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

/** Every file under `dir`, by relative path, with its bytes as base64. */
function tree(dir: string): Record<string, string> {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  const pairs = files.map((entry) => {
    const path = join(entry.parentPath, entry.name);
    return [relative(dir, path), readFileSync(path).toString('base64')] as const;
  });
  return Object.fromEntries(pairs.toSorted(([a], [b]) => a.localeCompare(b)));
}

/** `value` with every timestamp and duration under it masked, whatever key holds it. */
function mask(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => mask(item));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, k)]));
  return /(_ms|^timestamp)$/.test(key) ? '<masked>' : value;
}

/** A summary without what differs between two runs of the same repo: when it ran and how long each check took. */
function stable(dir: string, file = '.check/summary.json'): unknown {
  return mask(JSON.parse(readFileSync(join(dir, file), 'utf8')));
}

const GREEN = { checks: { hello: { command: 'sh', args: ['-c', 'echo hi'] } } };
const RED = { checks: { hello: { command: 'sh', args: ['-c', 'echo broken >&2; exit 1'] } } };

/** A `PATH` whose `node` answers `--version` with `version`, as a real one would. */
function pathWithNode(version: string): string {
  const dir = join(scratch, `node-${serial}`);
  mkdirSync(dir);
  symlinkSync('/bin/sh', join(dir, 'sh'));
  writeFileSync(join(dir, 'node'), `#!/bin/sh\necho v${version}\n`);
  chmodSync(join(dir, 'node'), 0o755);
  return dir;
}

/** A home whose nvm holds Node `version`. */
function homeWithNvm(version: string): string {
  const home = join(scratch, `home-${serial}`);
  const bin = join(home, '.nvm', 'versions', 'node', `v${version}`, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'node'), `#!/bin/sh\necho v${version}\n`);
  chmodSync(join(bin, 'node'), 0o755);
  return home;
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A Cursor `preToolUse` payload for a file tool writing `path`. */
function edit(path: string): string {
  return JSON.stringify({ hook_event_name: 'preToolUse', tool_name: 'Write', tool_input: { file_path: path } });
}

describe('the standalone binary', () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDir();
    write(dir, 'README.md', '# a repo\n');
  });

  test('the PATH it runs under holds no node', () => {
    expect(spawn('/bin/sh', ['-c', 'command -v node'], dir, BARE_ENV).code).not.toBe(0);
  });

  test('--version prints package.json’s version, as the npm CLI does', () => {
    const run = binary(['--version'], dir);
    expect(run).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: '' });
    expect(run.stdout).toBe(npm(['--version'], dir).stdout);
  });

  test('doctor names the channel and the embedded Node, and fails nothing for the missing node', () => {
    write(dir, 'checkride.config.json', GREEN);
    const table = binary(['doctor'], dir);
    expect(table.stdout).toMatch(/^ {2}channel: binary \(embedded Node \d+\.\d+\.\d+\)$/m);
    expect(table.stdout).toMatch(/· node +not on PATH \(checkride embeds Node \d+\.\d+\.\d+\)/);

    type Row = { name: string; required: boolean; status: string };
    const report = JSON.parse(binary(['doctor', '--json'], dir).stdout) as { channel: string; embeddedNode: string; checks: Row[] };
    expect(report.channel).toBe('binary');
    expect(report.embeddedNode).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.checks.find((c) => c.name === 'node')).toMatchObject({ required: false, status: 'n/a' });
    // The bare PATH holds no git either, which doctor does require: the one row it fails here.
    expect(report.checks.filter((c) => c.required && c.status !== 'ok').map((c) => c.name)).toEqual(['git']);

    expect(npm(['doctor'], dir).stdout).toMatch(/^ {2}channel: npm$/m);
  });

  test.each([
    ['ts', 'flat'],
    ['ts', 'monorepo'],
    ['go', 'module'],
    ['rust', 'crate'],
  ])('init --lang %s --shape %s scaffolds from the embedded templates what the npm CLI scaffolds, byte for byte', (lang, shape) => {
    const fromBinary = freshDir('demo');
    const fromNpm = freshDir('demo');
    const args = ['init', '--lang', lang, '--shape', shape, '--name', 'demo', '--harness', 'claude,cursor'];
    const a = binary(args, fromBinary);
    const b = npm(args, fromNpm);
    expect(a.code).toBe(0);
    expect(a).toEqual(b);
    const scaffold = tree(fromBinary);
    expect(Object.keys(scaffold).length).toBeGreaterThan(10);
    expect(scaffold).toEqual(tree(fromNpm));
  });

  test('a run goes green, and leaves the summary the npm CLI leaves', () => {
    write(dir, 'checkride.config.json', GREEN);
    const run = binary([], dir);
    expect(run.stderr).toContain('✔ all checks passed');
    expect(run.code).toBe(0);
    const summary = stable(dir);
    expect(summary).toMatchObject({ ok: true });

    const twin = freshDir();
    write(twin, 'README.md', '# a repo\n');
    write(twin, 'checkride.config.json', GREEN);
    expect(npm([], twin).code).toBe(0);
    expect(summary).toEqual(stable(twin));
  });

  test('a run goes red on a failing custom check and on the built-in links check', () => {
    write(dir, 'checkride.config.json', RED);
    write(dir, 'README.md', '# a repo\n\n[gone](./gone.md)\n');
    const run = binary(['--json'], dir);
    expect(run.code).toBe(1);
    const summary = JSON.parse(run.stdout) as { ok: boolean; checks: { name: string; ok: boolean; skipped?: boolean }[] };
    expect(summary.ok).toBe(false);
    const failed = summary.checks.filter((c) => !c.ok && c.skipped !== true).map((c) => c.name);
    expect(failed.toSorted()).toEqual(['hello', 'links']);
    expect(readFileSync(join(dir, '.check', 'links.stderr.txt'), 'utf8')).toContain('broken link in README.md:3 -> ./gone.md');
    expect(readFileSync(join(dir, '.check', 'hello.stderr.txt'), 'utf8')).toBe('broken\n');
  });

  test('--suite runs a named suite beside the code gate', () => {
    write(dir, 'checkride.config.json', RED);
    write(dir, 'checkride.evals.config.json', { checks: { evals: { command: 'sh', args: ['-c', 'echo scored'] } } });
    const run = binary(['--suite', 'evals'], dir);
    expect(run.stderr).toContain('Running 1 check(s) of suite evals');
    expect(run.code).toBe(0);
    expect(stable(dir, '.check/suites/evals/summary.json')).toMatchObject({ ok: true });
    expect(existsSync(join(dir, '.check', 'summary.json'))).toBe(false);
  });

  test('--annotate github prints an annotation for a red run, the one the npm CLI prints', () => {
    write(dir, 'checkride.config.json', GREEN);
    write(dir, 'README.md', '# a repo\n\n[gone](./gone.md)\n');
    const run = binary(['--annotate', 'github'], dir);
    expect(run.code).toBe(1);
    const annotations = run.stderr.split('\n').filter((line) => line.startsWith('::'));
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatch(/^::error title=links::/);
    expect(npm(['--annotate', 'github'], dir).stderr.split('\n').filter((line) => line.startsWith('::'))).toEqual(annotations);
    // The variable switches them on too, and a green run prints none.
    write(dir, 'README.md', '# a repo\n');
    const green = binary([], dir, { CHECKRIDE_ANNOTATE: 'github' });
    expect(green.code).toBe(0);
    expect(green.stderr).not.toContain('::error');
  });

  test('an extends naming a package is refused with exit 2, for the default config and a suite’s', () => {
    write(dir, 'checkride.config.json', { extends: '@acme/preset' });
    expect(binary([], dir)).toEqual({
      code: 2,
      stdout: '',
      stderr:
        'checkride: invalid checkride.config.json: package presets need the npm distribution; use a file path: ' +
        'extends "@acme/preset" (in checkride.config.json)\n',
    });
    write(dir, 'checkride.evals.config.json', { extends: 'acme-preset' });
    const suite = binary(['--suite', 'evals'], dir);
    expect(suite.code).toBe(2);
    expect(suite.stderr).toContain(
      'invalid checkride.evals.config.json: package presets need the npm distribution; use a file path: extends "acme-preset" (in checkride.evals.config.json)',
    );
  });

  test('a package extends three files down a chain is named with the file that holds it', () => {
    write(dir, 'checkride.config.json', { extends: './org.json' });
    write(dir, 'org.json', { extends: './team.json' });
    write(dir, 'team.json', { extends: '@acme/preset' });
    const run = binary([], dir);
    expect(run.code).toBe(2);
    expect(run.stderr).toBe(
      'checkride: invalid checkride.config.json: package presets need the npm distribution; use a file path: extends "@acme/preset" (in team.json)\n',
    );
  });

  test('an extends naming a file resolves', () => {
    write(dir, 'base.json', GREEN);
    write(dir, 'checkride.config.json', { extends: './base.json' });
    const run = binary(['--only', 'hello'], dir);
    expect(run.stderr).toContain('✔ hello');
    expect(run.code).toBe(0);
  });

  test('agent-setup writes `checkride`, found on PATH, as the entry command of a repo with no package.json', () => {
    const run = binary(['agent-setup', '--hook', 'gate'], dir);
    expect(run.code).toBe(0);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain('`checkride` is the single source of truth for "done"');
    const hook = readFileSync(join(dir, '.claude', 'hooks', 'checkride-gate.sh'), 'utf8');
    expect(hook).toContain('body=$(checkride gate --harness claude)');
    // The pin a binary's hook recommends installs a binary: the npm pin would need the Node this repo has none of.
    expect(hook).toContain('mise use github:robmclarty/checkride@<version>');
    expect(hook).not.toContain('npm:checkride');
  });

  /**
   * Cursor's edit guard, in the repo this binary is for: `agent-setup` writes
   * a hook that calls `checkride protect` and no Node script, and the hook's
   * own command line, run by `sh` as Cursor runs it, answers each payload
   * with no `node` on `PATH`.
   */
  test('Cursor’s protect hook is `checkride protect`, and it denies a baseline edit and allows an ordinary one with no node', () => {
    mkdirSync(join(dir, '.cursor'));
    expect(binary(['agent-setup', '--harness', 'cursor'], dir).code).toBe(0);
    expect(existsSync(join(dir, '.cursor', 'hooks', 'checkride-protect.cjs'))).toBe(false);
    const hooks = (JSON.parse(readFileSync(join(dir, '.cursor', 'hooks.json'), 'utf8')) as { hooks: Record<string, { command: string }[]> }).hooks;
    const command = hooks['preToolUse']?.[0]?.command ?? '';
    expect(command).toContain('out=$(checkride protect --harness cursor)');
    expect(command).not.toMatch(/\bnode\b/);
    expect(hooks['beforeShellExecution']?.[0]?.command).toBe(command);

    const hook = (payload: string, path = BARE_PATH): Run => {
      const done = spawnSync('/bin/sh', ['-c', command], { cwd: dir, env: { ...BARE_ENV, PATH: path, CURSOR_PROJECT_DIR: dir }, input: payload, encoding: 'utf8', timeout: 120_000 });
      if (done.error) throw done.error;
      return { code: done.status, stdout: done.stdout, stderr: done.stderr };
    };

    const denied = hook(edit(join(dir, 'checkride.baseline.json')));
    expect(denied.code).toBe(0);
    expect(denied.stderr).toBe('');
    expect(JSON.parse(denied.stdout)).toMatchObject({ permission: 'deny', agent_message: expect.stringContaining('checkride.baseline.json is checkride-owned accounting') });

    const shell = hook(JSON.stringify({ hook_event_name: 'beforeShellExecution', command: 'echo "{}" > checkride.evals.baseline.json', cwd: dir }));
    expect(shell.code).toBe(0);
    expect(JSON.parse(shell.stdout)).toMatchObject({ permission: 'deny' });

    for (const allowed of [edit(join(dir, 'src', 'main.go')), JSON.stringify({ hook_event_name: 'beforeShellExecution', command: 'cat .check/summary.json', cwd: dir }), 'not json', '']) {
      expect(hook(allowed)).toEqual({ code: 0, stdout: '', stderr: '' });
    }

    // On a PATH with no checkride, the hook says the guard did not run and allows the call: exit 0, never a bare 127.
    const unguarded = hook(edit(join(dir, 'checkride.baseline.json')), EMPTY_PATH);
    expect(unguarded.code).toBe(0);
    expect(JSON.parse(unguarded.stdout)).toMatchObject({ permission: 'allow', agent_message: expect.stringContaining('the edit guard could not run — checkride is not on PATH') });
    expect(unguarded.stdout).toContain('mise use github:robmclarty/checkride@<version>');
    expect(unguarded.stderr).toContain('the edit guard could not run');

    const refused = binary(['protect', '--harness', 'claude'], dir);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("invalid --harness 'claude' (protect answers cursor)");
  });

  test('doctor’s harness row recommends the github: pin, never the npm one', () => {
    const doctor = binary(['doctor'], dir);
    expect(doctor.stdout).toContain('harness unpinned');
    expect(doctor.stdout).toContain('Pin it with `mise use github:robmclarty/checkride@<version>`');
    expect(doctor.stdout).not.toContain('npm:checkride');
  });

  describe('run by its path, with no checkride on PATH', () => {
    const env = { PATH: EMPTY_PATH, HOME: scratch };

    test('gate runs the binary itself', () => {
      write(dir, 'checkride.config.json', GREEN);
      const gate = spawn(BIN, ['gate', '--harness', 'claude'], dir, env);
      expect(gate.stderr).not.toContain('ENOENT');
      expect(gate.stderr).toContain('✔ all checks passed');
      expect(gate.code).toBe(0);
    });

    test('triage runs the binary itself, and shows the entry command as `checkride`', () => {
      write(dir, 'checkride.config.json', GREEN);
      const triage = spawn(BIN, ['triage'], dir, env);
      expect(triage.stdout).not.toContain('ENOENT');
      expect(triage.stdout).toContain('- gate: `checkride` → exit 0');
      expect(triage.stdout).toContain('**green**');
    });

    test('another checkride on PATH is never the one the gate or triage runs', () => {
      const other = join(scratch, `other-${serial}`);
      mkdirSync(other);
      symlinkSync('/bin/sh', join(other, 'sh'));
      writeFileSync(join(other, 'checkride'), '#!/bin/sh\necho "the wrong checkride ran" >&2\nexit 3\n');
      chmodSync(join(other, 'checkride'), 0o755);
      write(dir, 'checkride.config.json', GREEN);
      const wrong = { PATH: other, HOME: scratch };
      const gate = spawn(BIN, ['gate', '--harness', 'claude'], dir, wrong);
      expect(gate.stderr).not.toContain('the wrong checkride ran');
      expect(gate.code).toBe(0);
      const triage = spawn(BIN, ['triage'], dir, wrong);
      expect(triage.stdout).not.toContain('the wrong checkride ran');
      expect(triage.stdout).toContain('- gate: `checkride` → exit 0');
    });

    test('a broken harness is diagnosed by the binary’s own doctor, the checkride the gate ran', () => {
      write(dir, 'checkride.config.json', GREEN);
      // A usage error in the run, exit 2, that doctor ignores: the fold has a doctor to ask and a report to read.
      const triage = spawn(BIN, ['triage'], dir, { ...env, CHECKRIDE_ANNOTATE: 'bogus' });
      expect(triage.stdout).toContain('- gate: `checkride` → exit 2');
      expect(triage.stdout).toContain('## doctor');
      expect(triage.stdout).toMatch(/`checkride doctor` exited \d/);
      expect(triage.stdout).not.toContain('could not be consulted');
    });
  });

  describe('the repo’s Node is the node on PATH, never the embedded one', () => {
    beforeEach(() => {
      write(dir, 'checkride.config.json', GREEN);
      write(dir, '.nvmrc', '24\n');
    });

    test('a repo with no Node pin costs the gate no node at all: the one on PATH is never run', () => {
      rmSync(join(dir, '.nvmrc'));
      const path = pathWithNode('24.15.0');
      const ran = join(path, 'node-ran');
      writeFileSync(join(path, 'node'), `#!/bin/sh\necho ran >> ${ran}\necho v24.15.0\n`);
      const env = { PATH: path, HOME: scratch };
      expect(spawn(BIN, ['gate', '--harness', 'claude'], dir, env).code).toBe(0);
      write(dir, 'checkride.config.json', RED);
      expect(spawn(BIN, ['gate', '--harness', 'claude'], dir, env).code).not.toBe(0);
      expect(existsSync(ran)).toBe(false);
      // The same PATH with a pin does run it, once a gate: the marker is how this case would know.
      write(dir, '.nvmrc', '24\n');
      spawn(BIN, ['gate', '--harness', 'claude'], dir, env);
      expect(readFileSync(ran, 'utf8')).toBe('ran\n');
    });

    test('a PATH node that satisfies .nvmrc is left alone, though the binary embeds another major', () => {
      const gate = spawn(BIN, ['gate', '--harness', 'claude'], dir, { PATH: pathWithNode('24.15.0'), HOME: homeWithNvm('24.18.1') });
      expect(gate.stderr).not.toContain('running the check on Node');
      expect(gate.code).toBe(0);
    });

    test('a PATH node that misses .nvmrc is aligned, and named as the Node the hook started on', () => {
      const home = homeWithNvm('24.18.1');
      const gate = spawn(BIN, ['gate', '--harness', 'claude'], dir, { PATH: pathWithNode('22.1.0'), HOME: home });
      expect(gate.stderr).toContain(`running the check on Node 24.18.1 from ${join(home, '.nvm', 'versions', 'node', 'v24.18.1', 'bin')} (.nvmrc pins 24; this hook started on 22.1.0).`);
      expect(gate.code).toBe(0);
    });

    test('with no node on PATH the pinned install is found, and nothing claims a Node the hook started on', () => {
      const home = homeWithNvm('24.18.1');
      const gate = spawn(BIN, ['gate', '--harness', 'claude'], dir, { PATH: EMPTY_PATH, HOME: home });
      expect(gate.stderr).toContain('running the check on Node 24.18.1 from');
      expect(gate.stderr).toContain('(.nvmrc pins 24; this hook’s PATH holds no node).');
      expect(gate.stderr).not.toContain('started on');
      expect(gate.code).toBe(0);
    });

    test('doctor’s node pin hint names PATH’s node, or none, and never the embedded one', () => {
      const embedded = (JSON.parse(binary(['doctor', '--json'], dir).stdout) as { embeddedNode: string }).embeddedNode;
      const hintOf = (path: string): string => {
        const report = JSON.parse(spawn(BIN, ['doctor', '--json'], dir, { PATH: path, HOME: scratch }).stdout) as { checks: { name: string; hint: string | null }[] };
        return report.checks.find((c) => c.name === 'node pin')?.hint ?? '';
      };
      const withNode = pathWithNode('22.1.0');
      if (WHICH !== undefined) symlinkSync(WHICH, join(withNode, 'which'));
      expect(hintOf(withNode)).toContain("not this shell's (22.1.0)");
      expect(hintOf(EMPTY_PATH)).toContain("not this shell's (which has none on PATH)");
      expect(hintOf(EMPTY_PATH)).not.toContain(embedded);
    });
  });

  describe('the schema slot, on the libraries the binary bundles', () => {
    const RULES = {
      checks: { links: false },
      schemas: [
        { files: ['skills/*/SKILL.md'], schema: 'checkride:agent-skill' },
        { files: ['.vscode/*.jsonc'], schema: 'schemas/settings.schema.json' },
        { files: ['workflows/*.yml'], schema: 'schemas/settings.schema.json' },
        { files: ['checkride.config.json'], schema: 'checkride:checkride-config' },
      ],
    };
    const SETTINGS = { type: 'object', required: ['name'], properties: { name: { type: 'string' }, tabSize: { type: 'integer' } } };

    beforeEach(() => {
      for (const sub of ['skills/pdf', '.vscode', 'workflows', 'schemas']) mkdirSync(join(dir, sub), { recursive: true });
      write(dir, 'checkride.config.json', RULES);
      write(dir, 'schemas/settings.schema.json', SETTINGS);
      write(dir, 'skills/pdf/SKILL.md', '---\nname: pdf\ndescription: Reads and fills PDF forms.\n---\n\n# PDF\n');
      write(dir, '.vscode/settings.jsonc', '{\n  // the editor\n  "name": "editor",\n  "tabSize": 2,\n}\n');
      write(dir, 'workflows/ci.yml', 'name: CI\non: push\n');
    });

    test('the repo has no node_modules, and no node to install one with', () => {
      expect(existsSync(join(dir, 'node_modules'))).toBe(false);
      expect(spawn('/bin/sh', ['-c', 'command -v node'], dir, BARE_ENV).code).not.toBe(0);
    });

    test('YAML frontmatter, JSONC and YAML rules go green, and the report counts their files', () => {
      const run = binary([], dir);
      expect(run.stderr).toContain('✔ all checks passed');
      expect(run.code).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, '.check', 'schema.json'), 'utf8'))).toEqual({
        rules: [
          { schema: 'checkride:agent-skill', files: 1 },
          { schema: 'schemas/settings.schema.json', files: 1 },
          { schema: 'schemas/settings.schema.json', files: 1 },
          { schema: 'checkride:checkride-config', files: 1 },
        ],
        errors: [],
      });
    });

    test('they go red on a skill misnamed for its directory, a JSONC value of the wrong type and a duplicate YAML key', () => {
      write(dir, 'skills/pdf/SKILL.md', '---\nname: pdf-tools\ndescription: Reads and fills PDF forms.\n---\n');
      write(dir, '.vscode/settings.jsonc', '{\n  "name": "editor", // still a comment\n  "tabSize": "two",\n}\n');
      write(dir, 'workflows/ci.yml', 'name: CI\nname: Again\n');
      const run = binary([], dir);
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/^ {2}✘ schema /m);
      const report = JSON.parse(readFileSync(join(dir, '.check', 'schema.json'), 'utf8')) as { errors: { file: string; keyword: string; instancePath: string; line?: number }[] };
      expect(report.errors.map(({ file, keyword, instancePath, line }) => ({ file, keyword, instancePath, line }))).toEqual([
        { file: 'skills/pdf/SKILL.md', keyword: 'directory-name', instancePath: '/name', line: 2 },
        { file: '.vscode/settings.jsonc', keyword: 'type', instancePath: '/tabSize', line: 3 },
        { file: 'workflows/ci.yml', keyword: 'parse', instancePath: '', line: 2 },
      ]);
      expect(run.stderr).toContain("skills/pdf/SKILL.md:2  /name must equal the parent directory's name, 'pdf'  [directory-name]");
    });

    test('a copy of a library in the repo is never the one that runs', () => {
      // An ajv the npm CLI would refuse, and would crash on if it loaded it.
      mkdirSync(join(dir, 'node_modules', 'ajv'), { recursive: true });
      write(dir, 'node_modules/ajv/package.json', { name: 'ajv', version: '6.12.6', main: 'index.js' });
      write(dir, 'node_modules/ajv/index.js', 'throw new Error("the repo\'s ajv was loaded");\n');
      const run = binary(['--only', 'schema'], dir);
      expect(run.stderr).not.toContain('ajv');
      expect(run.code).toBe(0);
    });

    test('doctor reports the slot ready, with the bundled versions', () => {
      const report = JSON.parse(binary(['doctor', '--json'], dir).stdout) as { checks: { slot?: string; status: string; found: string | null }[] };
      const row = report.checks.find((c) => c.slot === 'schema');
      expect(row?.status).toBe('ok');
      expect(row?.found).toMatch(/^bundled: ajv 8\.\d+\.\d+, yaml 2\.\d+\.\d+, jsonc-parser 3\.\d+\.\d+$/);
    });
  });

  test('triage runs the gate through the binary on PATH and asks the binary’s own doctor, and qa reads the run', () => {
    write(dir, 'checkride.config.json', GREEN);
    const triage = binary(['triage'], dir);
    expect(triage.code).toBe(0);
    expect(triage.stdout).toContain('- gate: `checkride` → exit 0');
    expect(triage.stdout).toContain('**green**');
    expect(triage.stdout).not.toContain('could not be consulted');

    const qa = binary(['qa'], dir);
    expect(qa.code).toBe(0);
    expect(qa.stdout).toContain('# checkride qa');
    expect(qa.stdout).toContain('hello');
  });
});

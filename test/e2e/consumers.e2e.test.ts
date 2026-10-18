/**
 * The consumer recipes of `docs/consumers.md`, end to end (R13.6, S18).
 *
 * A review agent checks a pull request over `examples/polyglot-stack` from
 * outside the repo, with its own defaults file and `mise.toml`. The
 * pre-sandbox pass runs over a copy nobody installed: `--static-only` keeps
 * the checks that read the repo as data, which run the agent's pinned copies,
 * and skips the rest with their reasons. The sandbox pass runs over an
 * installed copy with the repo's own pins. Each pass writes outside the repo,
 * leaves the repo's files alone, and every finding a failed check reports
 * parses through `checkride/findings`, the text-output checks (tsc, typos)
 * among them. Every pass takes `--discover`, as the recipes do: the example's
 * own targets stand in for discovery, and a copy with no config of its own
 * checks the targets discovery proposes.
 */

import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { Finding } from '../../src/findings/api.js';
import { findingsFor, isParseable } from '../../src/findings/api.js';
import type { Summary, SummaryCheck } from '../../src/orchestrator/index.js';
import { toolchainGate } from '../helpers/toolchains.js';

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const EXAMPLE = join(ROOT, 'examples', 'polyglot-stack');
const BIG = { maxBuffer: 32 * 1024 * 1024 };

// cspell:ignore recieve

/** The pull request: one finding for each check it plants, the file it lands in, and the check that should report it. */
const PLANTS: readonly { file: string; edit: (text: string) => string; check: string }[] = [
  { file: 'scripts/deploy.sh', edit: (t) => t.replace('"$target"', '$target'), check: 'scripts:lint' },
  { file: 'api/internal/greet/dot.go', edit: () => 'package greet\n\nimport . "strings"\n\nvar _ = ToUpper\n', check: 'struct' },
  { file: 'skills/release/SKILL.md', edit: (t) => `${t}\nWe recieve the release notes from the deploy log.\n`, check: 'spell' },
  { file: 'web/src/app.ts', edit: (t) => t.replace("greeting('world').length", "greeting('world')"), check: 'web:types' },
  { file: 'api/cmd/api/remove.go', edit: () => 'package main\n\nimport "os"\n\nfunc init() { os.Remove("stale") }\n', check: 'api:lint' },
];

/** The version this repo's dev `mise.toml` pins `tool` to, installed wherever the e2e suite runs with its toolchains. */
async function devPin(tool: string): Promise<string> {
  const text = await readFile(join(ROOT, 'mise.toml'), 'utf8');
  const version = new RegExp(`^${tool}\\s*=\\s*"([^"]+)"`, 'm').exec(text)?.[1];
  if (version === undefined) throw new Error(`mise.toml pins no ${tool}`);
  return version;
}

/** A `mise.toml` pinning each of `tools` at the version {@link devPin} reads. */
async function devPins(tools: readonly string[]): Promise<string> {
  const lines = await Promise.all(tools.map(async (tool) => `${tool} = "${await devPin(tool)}"`));
  return `[tools]\n${lines.join('\n')}\n`;
}

/** Run git in `cwd` as a throwaway identity. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd });
  return stdout.trim();
}

/** A copy of the example as a pull request: the base commit, then a commit planting each finding. Returns the base's sha. */
async function pullRequest(dir: string): Promise<string> {
  await cp(EXAMPLE, dir, { recursive: true, filter: (src) => !/(?:^|\/)(?:node_modules|\.check)(?:\/|$)/.test(src) });
  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { devDependencies: Record<string, string> };
  delete pkg.devDependencies['checkride'];
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  // A real checkout ignores its install, so the sandbox pass's tools never read it.
  await writeFile(join(dir, '.gitignore'), 'node_modules/\n');
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '--no-verify', '-m', 'base');
  const base = await git(dir, 'rev-parse', 'HEAD');
  for (const plant of PLANTS) {
    const path = join(dir, plant.file);
    await mkdir(dirname(path), { recursive: true });
    const text = existsSync(path) ? await readFile(path, 'utf8') : '';
    await writeFile(path, plant.edit(text));
  }
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '--no-verify', '-m', 'pull request');
  return base;
}

type Run = { code: number; summary: Summary; stderr: string };

/**
 * Run the built CLI in `cwd` with `args`, which end in `--out <runDir> --json`,
 * under `env`, returning its exit code and the summary on stdout.
 */
async function checkride(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<Run> {
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env, ...BIG }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr });
    });
  });
  return { code: result.code, summary: JSON.parse(result.stdout) as Summary, stderr: result.stderr };
}

/** The summary's entry named `name`. */
function entry(summary: Summary, name: string): SummaryCheck {
  const found = summary.checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no check ${name}; the run has ${summary.checks.map((c) => c.name).join(', ')}`);
  return found;
}

/**
 * Every finding of every failed check that has a parser, through
 * `findingsFor` as the guide reads them, by check name. Each such check must
 * yield at least one finding that gates, since its failure has to come from
 * somewhere a reviewer can point at.
 */
function findingsOf(summary: Summary, runDir: string, repoRoot: string): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>();
  for (const check of summary.checks) {
    const findings = findingsFor(check, runDir, { repoRoot });
    if (check.ok || check.skipped === true || check.adapter === null || !isParseable(check.adapter)) continue;
    expect(findings, `${check.name} failed, so its findings parse`).not.toBeNull();
    expect(findings?.some((f) => f.gates !== false), `${check.name} has a finding that gates`).toBe(true);
    out.set(check.name, findings ?? []);
  }
  return out;
}

/** The repo untouched by a consumer run: no baseline written, no artifacts at its root. */
function expectRepoUntouched(dir: string): void {
  expect(existsSync(join(dir, 'checkride.baseline.json'))).toBe(false);
  expect(existsSync(join(dir, '.check'))).toBe(false);
}

const gates = ['go', 'bash', 'repo'] as const;
const missing = gates.flatMap((pack) => {
  const gate = toolchainGate(pack);
  return gate.run ? [] : [gate.reason];
});
const hasMise = spawnSync('mise', ['--version'], { stdio: 'ignore' }).status === 0;
if (!hasMise) missing.push('mise not found');
if (missing.length > 0) console.warn(`skipping the consumer e2e cases: ${missing.join('; ')}`);

(missing.length === 0 ? describe : describe.skip)('the consumer recipes (R13.6)', () => {
  let work: string;
  let agent: { defaults: string; pins: string };
  let uninstalled: string;
  let installed: string;
  let base: string;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'checkride-consumers-'));
    await mkdir(join(work, 'agent'));
    agent = { defaults: join(work, 'agent', 'defaults.json'), pins: join(work, 'agent', 'mise.toml') };
    // The agent fills spell where a repo leaves it empty, and runs its own shellcheck, ast-grep and typos.
    await writeFile(agent.defaults, JSON.stringify({ checks: { spell: 'typos' } }));
    await writeFile(agent.pins, await devPins(['shellcheck', 'ast-grep', 'typos']));
    uninstalled = join(work, 'uninstalled');
    base = await pullRequest(uninstalled);
    installed = join(work, 'installed');
    await cp(uninstalled, installed, { recursive: true });
    await execFileP('pnpm', ['install'], { cwd: installed, ...BIG });
  }, 300_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  test('the pre-sandbox pass over an uninstalled copy runs only static checks, through the agent’s pins', async () => {
    const runDir = join(work, 'run', 'static');
    const args = ['--discover', '--defaults', agent.defaults, '--pins', agent.pins, '--static-only', '--changed', '--base', base, '--out', runDir, '--json'];
    const run = await checkride(uninstalled, args);
    expect(run.code).toBe(1);
    expect(run.summary.run).toEqual({ partial: true, changed: true, static_only: true, discover: true, defaults: agent.defaults, pins: agent.pins, out: runDir });
    // The example declares its targets, so they stand in for discovery.
    expect(run.stderr).toContain('--discover: the config declares its targets (web, api, scripts), so they stand in for discovery');
    for (const target of run.summary.targets ?? []) expect(target, target.name).not.toHaveProperty('discovered');

    expect(entry(run.summary, 'web:types').reason).toBe("static-only: tsc isn't a static check");
    for (const name of ['api:types', 'api:lint', 'api:test']) expect(entry(run.summary, name).reason, name).toMatch(/^static-only: /);
    for (const name of ['scripts:lint', 'struct', 'spell']) {
      expect(entry(run.summary, name), name).toMatchObject({ ok: false, pin_source: 'override' });
      expect(entry(run.summary, name).argv?.slice(0, 2), name).toEqual(['mise', 'exec']);
    }
    expect(entry(run.summary, 'spell')).toMatchObject({ adapter: 'typos', origin: 'defaults' });
    expect(entry(run.summary, 'links')).toMatchObject({ ok: true });
    expect(entry(run.summary, 'links')).not.toHaveProperty('skipped');

    const findings = findingsOf(run.summary, runDir, uninstalled);
    expect([...findings.keys()].toSorted()).toEqual(['scripts:lint', 'spell', 'struct']);
    for (const plant of PLANTS.filter((p) => findings.has(p.check))) {
      expect(findings.get(plant.check)?.map((f) => f.file), plant.check).toContain(plant.file);
    }
    expectRepoUntouched(uninstalled);
  }, 180_000);

  test('the sandbox pass over an installed copy runs the repo’s own pins, and every finding parses, the text-output ones included', async () => {
    const runDir = join(work, 'run', 'full');
    const args = ['--discover', '--defaults', agent.defaults, '--changed', '--base', base, '--out', runDir, '--json'];
    const run = await checkride(installed, args);
    expect(run.code).toBe(1);
    expect(run.summary.run).toEqual({ partial: true, changed: true, discover: true, defaults: agent.defaults, out: runDir });

    const findings = findingsOf(run.summary, runDir, installed);
    expect([...findings.keys()].toSorted()).toEqual(['api:lint', 'scripts:lint', 'spell', 'struct', 'web:types'].toSorted());
    for (const plant of PLANTS) expect(findings.get(plant.check)?.map((f) => f.file), plant.check).toContain(plant.file);
    // tsc and typos print text, which the summary names no file for: findingsFor reads their stdout.
    for (const name of ['web:types', 'spell']) expect(entry(run.summary, name).output_file, name).toBeNull();
    expect(entry(run.summary, 'struct').pin_source).toBe('js-lockfile');
    expectRepoUntouched(installed);
  }, 300_000);

  test('a copy with no config of its own takes --discover, and its targets say so', async () => {
    const dir = join(work, 'unconfigured');
    await cp(uninstalled, dir, { recursive: true });
    await rm(join(dir, 'checkride.config.json'));
    const runDir = join(work, 'run', 'discovered');
    const args = ['--discover', '--defaults', agent.defaults, '--pins', agent.pins, '--static-only', '--changed', '--base', base, '--out', runDir, '--json'];
    const run = await checkride(dir, args);
    expect(run.summary.run).toMatchObject({ discover: true, static_only: true });
    expect(run.summary.targets?.length).toBeGreaterThan(0);
    for (const target of run.summary.targets ?? []) expect(target, target.name).toMatchObject({ discovered: true });
    findingsOf(run.summary, runDir, dir);
    expectRepoUntouched(dir);
  }, 180_000);
});

const goGate = toolchainGate('go');
const scaffoldMissing = [...(goGate.run ? [] : [goGate.reason]), ...(hasMise ? [] : ['mise not found'])];
if (scaffoldMissing.length > 0) console.warn(`skipping the untrusted scaffold case: ${scaffoldMissing.join('; ')}`);

/**
 * A `--pins` run over an `init --lang go` scaffold before `mise trust` (D83).
 * checkride's entry sets a tool option, so mise won't read the scaffold's
 * `mise.toml` until someone trusts it, as a review agent finds in a fresh
 * clone. The override asks mise with the repo root ignored, so the check runs
 * the agent's go and the file stays untrusted. mise keeps what it trusts in a
 * state directory of the case's own, and the run carries `MISE_YES`, under
 * which mise trusts a config it reads, so only the ignore keeps it untrusted.
 */
(scaffoldMissing.length === 0 ? describe : describe.skip)('a --pins run in a repo whose mise.toml mise hasn’t trusted', () => {
  let dir: string;
  let repo: string;
  let pins: string;

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'checkride-consumers-untrusted-')));
    repo = join(dir, 'repo');
    await mkdir(repo);
    await execFileP(process.execPath, [CLI, 'init', '--lang', 'go', '--name', 't-demo'], { cwd: repo, ...BIG });
    await git(repo, 'init', '-q');
    // Beside the repo, not above it, where mise would read it as a config of the repo's.
    await mkdir(join(dir, 'agent'));
    pins = join(dir, 'agent', 'mise.toml');
    await writeFile(pins, await devPins(['go']));
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('the check runs the agent’s go as the override, and the scaffold’s mise.toml stays untrusted', async () => {
    const inherited = Object.entries(process.env).filter(([key]) => key !== 'MISE_TRUSTED_CONFIG_PATHS');
    const env = { ...Object.fromEntries(inherited), MISE_STATE_DIR: join(dir, 'state'), MISE_YES: '1' };
    const version = await devPin('go');
    const run = await checkride(repo, ['--pins', pins, '--only', 'app:types', '--out', join(dir, 'run'), '--json'], env);
    const types = entry(run.summary, 'app:types');
    expect(types, run.stderr).toMatchObject({ ok: true, pin_source: 'override', tool_version: version });
    expect(types.argv?.slice(0, 3)).toEqual(['mise', 'exec', `go@${version}`]);
    const trust = await execFileP('mise', ['trust', '--show'], { cwd: repo, env, ...BIG });
    expect(trust.stdout).toContain(`${repo}: untrusted`);
  }, 120_000);
});

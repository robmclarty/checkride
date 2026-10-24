/**
 * `checkride gate` — the stop-gate verdict, harness-neutral.
 *
 * Every agent harness offers some "the turn is ending" hook, and checkride's
 * gate hangs off it: run the repo's `check` script, and while it is red, refuse
 * to let the turn finish. What differs between harnesses is only the *wire
 * format* of that refusal — Claude Code reads stderr and blocks on exit 2,
 * Cursor reads a `followup_message` on stdout and submits it as the next turn.
 * The decision itself (is it dirty, is it green, which artifact should the agent
 * read) is identical, so it lives here once and the generated hook scripts
 * become two-line adapters that name their harness.
 *
 * That split is the point. Before this command, the whole body was duplicated
 * shell inside `.claude/hooks/checkride-gate.sh`, untestable outside an e2e run
 * and impossible to share with a second harness.
 *
 * The gate answers three verdicts, not two. Green and red are the pipeline's;
 * the third is **could not run**, for a package manager that refused to start
 * the check script at all — an `engines.node` pin the hook's Node does not
 * satisfy is the common cause, and it exits non-zero exactly like a failing
 * test. Reading that as red produced a permanent red no code change could clear,
 * pointing at a `.check/summary.json` no run had written. So it names the cause
 * instead of naming an artifact. See `./launch/refusal.ts` for the classification and
 * `./node-pin.ts` for the alignment that avoids it.
 *
 * Whether that third verdict *blocks* turns on one question: can the turn clear
 * it? A missing `check` script can be fixed by the agent holding the edit tools,
 * so the gate blocks and the agent fixes it. A Node the harness never put on
 * `PATH` cannot, so the gate says so and stands down (see
 * {@link reportStandDown}). Blocking on the second only re-asks an agent that
 * has no lever to pull, which is not gating — it is a loop, and the way out of
 * a loop is turning the gate off.
 *
 * Not to be confused with `../triage/gate.ts`, which also runs the `check`
 * script: that one runs it *verbatim* as a reader's preflight and classifies the
 * result for a report. This one appends `--strict --digest` because it IS the
 * gate, and its output is a verdict for the harness, not prose for a human.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { ADAPTERS, SLOTS } from './adapters.js';
import { formatDuration, OUT_ENV, outDir, readSummary, type SummaryRead } from './artifacts/index.js';
import type { CheckrideConfig, GateProfile } from './config.js';
import { CONFIG_ENV, DEFAULTS_ENV, loadConfig, resolveChecks } from './config.js';
import { DIGEST_FILE, withinBudget } from './digest/index.js';
import { BASE_ENV } from './git.js';
import { PINS_ENV } from './launch/index.js';
import type { NodeAlignment, PinEnv } from './node-pin.js';
import { alignNode, NODE_BIN_VAR, realPinEnv, withNodeBin } from './node-pin.js';
import type { Out, SummaryCheck } from './orchestrator/index.js';
import {
  detectPackageManager,
  type EntryCommand,
  entryArgv,
  entryCheckride,
  entryText,
  type LaunchRefusal,
  launchRefusal,
  type PackageManager,
  resolveEntry,
  SPAWN_FAILED_MARKER,
} from './launch/index.js';
import { tokenProblem } from './targets/index.js';

/**
 * The edit marker: touched by the harness's "a file changed" hook, checked here
 * under `--if-dirty`, and cleared by a green gate. Dot-named so it can never
 * collide with a slot's `<slot>.json`/`<slot>.stdout.txt` artifacts, which the
 * orchestrator deletes per slot before a re-run — the marker must survive every
 * run.
 *
 * It lives here, not in `agent-setup`, because the gate is what reads and clears
 * it; the hook writers import it from this module to build the touch command.
 */
export const DIRTY_MARKER = '.check/.dirty';

/**
 * Whether a follow-up has already been auto-submitted this conversation: `1` if
 * so, `0` if not. The generated stop-hook script reads the harness's stop payload
 * and exports it; the hook writers import the name from here to spell the export.
 *
 * It exists for exactly one decision. Under Cursor the only channel that reaches
 * a *user* is `followup_message`, and that field **submits a new turn** — so a
 * stand-down spending it on every turn is the unbounded loop a stand-down exists
 * to avoid. `0` means the budget of one has not been spent yet. checkride cannot
 * work this out alone: the stop payload goes to the hook script, never to this
 * process. See {@link reportStandDown}.
 *
 * **Absence is not `0`.** A script generated before this variable existed exports
 * neither value, and reading absence as "go ahead" would loop under precisely the
 * pairing checkride cannot detect — a new binary, an old script, and the
 * `loop_limit: null` the gate's own hook entry asks for. So absence keeps the
 * older and quieter behavior, and only an explicit `0` unlocks the message.
 */
export const GATE_RETRY_ENV = 'CHECKRIDE_GATE_RETRY';

/** Where the gate points a red agent when this run wrote a summary and no digest. */
const SUMMARY_PATH = '.check/summary.json';

/** The digest's file, which a red verdict carrying the digest names as its copy. */
const DIGEST_PATH = `.check/${DIGEST_FILE}`;

/**
 * Cursor's own hook config. It lives here rather than in `agent-setup/cursor.ts`
 * for the same reason {@link DIRTY_MARKER} does: the gate *reads* it (see
 * {@link deferredToCursor}), and the writer importing from the gate is the
 * direction that has no cycle. `agent-setup/cursor.ts` re-exports it.
 */
export const CURSOR_HOOKS_FILE = '.cursor/hooks.json';

/**
 * What a registered checkride gate looks like inside a harness's hook config.
 * Both harnesses name the script the same, so finding it in Cursor's config is
 * enough to know Cursor has a native gate of its own.
 */
const GATE_SCRIPT_SENTINEL = 'checkride-gate.sh';

/** Every harness whose stop-hook protocol the gate can speak. */
export const HARNESS_NAMES = ['claude', 'cursor'] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

/** Script name every checkride repo exposes; `checkride init` writes it. */
const CHECK_SCRIPT = 'check';

/**
 * Spawn the check script and forward its output. Injectable so the command's
 * branches are testable without a real toolchain.
 *
 * Both child streams are forwarded to **stderr**, never stdout: under
 * `--harness cursor` this process's stdout must contain the hook's JSON and
 * nothing else, and in a hook context the check's output is human-facing
 * progress either way. Returns the exit code; a signal death is `null` and the
 * caller reads it as red, because "not cleanly green" is the only distinction a
 * gate needs.
 */
export type GateSpawn = (
  command: string,
  args: readonly string[],
  opts: { cwd: string; stderr: Out; env: Record<string, string | undefined> },
) => Promise<number | null>;

const spawnForward: GateSpawn = (command, args, opts) =>
  new Promise((resolve) => {
    const proc = spawn(command, [...args], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...opts.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => opts.stderr.write(chunk));
    proc.stderr.on('data', (chunk: string) => opts.stderr.write(chunk));
    // A gate that cannot spawn its package manager is not a crash: the harness
    // gets a verdict it can act on rather than a stack trace. The message goes
    // to the stream so it is both visible and classifiable — a spawn failure
    // that printed nothing at all was reported as a red with no explanation.
    proc.on('error', (err) => {
      opts.stderr.write(`${SPAWN_FAILED_MARKER} \`${command}\`: ${err.message}\n`);
      resolve(null);
    });
    proc.on('close', (code) => resolve(code));
  });

/**
 * How much of the child's output to keep for {@link launchRefusal}.
 *
 * The **head**, not the tail: a package manager that refuses to launch says so
 * before anything else runs, so the evidence is always in the first bytes. A
 * check that fails after this much output is a pipeline red, which needs no
 * classification.
 */
const CAPTURE_LIMIT = 8 * 1024;

/** An `Out` that forwards everything and remembers the beginning. */
function recording(out: Out): Out & { text: () => string } {
  let kept = '';
  return {
    write: (chunk: string) => {
      if (kept.length < CAPTURE_LIMIT) kept += chunk;
      return out.write(chunk);
    },
    text: () => kept,
  };
}

export type GateOptions = {
  cwd?: string;
  /** Skip the run entirely when the edit marker is absent (`--if-dirty`). */
  ifDirty?: boolean;
  /** Which harness's stop-hook protocol to answer in. Defaults to `claude`. */
  harness?: HarnessName;
  pm?: PackageManager;
  stdout?: Out;
  stderr?: Out;
  spawn?: GateSpawn;
  /** Process environment; injectable so {@link deferredToCursor} is testable. */
  env?: Record<string, string | undefined>;
  /** The Node-pin surface; injectable so alignment is testable without a version manager. */
  pinEnv?: PinEnv;
  /**
   * The gate profile. Read from `checkride.config.json` when absent; pass `null`
   * to run the full check whatever the config says.
   */
  profile?: GateProfile | null;
  /** Wall-clock source for the elapsed time the gate reports; injectable for tests. */
  now?: () => number;
};

export type GateResult = {
  exitCode: number;
  /** False when `--if-dirty` or the Cursor deferral short-circuited the run. */
  ran: boolean;
  green: boolean;
  /**
   * Why the check script never started, or `null` when it did: the package
   * manager refused it, or the gate profile named a token no check answers to.
   * A refusal is not a red: it blocks the turn all the same, but nothing was
   * checked and nothing was written, so no artifact describes this run.
   */
  refusal: string | null;
};

/**
 * True when this `--harness claude` invocation is really Cursor running the
 * repo's `.claude/settings.json` hooks, *and* Cursor has a native checkride gate
 * of its own that will run for the same turn.
 *
 * Cursor loads third-party (Claude Code) hook configs when "Include third-party
 * Plugins, Skills, and other configs" is on, maps `Stop` onto `stop`, and — the
 * load-bearing sentence — runs **all** matching hooks from **every** source. A
 * repo wired for both harnesses therefore fires two full pipelines into one
 * `.check/` directory, concurrently and with nothing to serialize them, where
 * the orchestrator clears each slot's artifacts before re-running it.
 *
 * So one of the two has to stand down, and it is this one: under Cursor the
 * native `.cursor/hooks.json` gate is the only one that can answer in Cursor's
 * protocol, which makes it authoritative there.
 *
 * Deliberately narrow — it defers only when a Cursor gate is *registered*, not
 * merely when Cursor is running, so the failure mode of a stale environment
 * variable is a duplicate run (today's behavior) rather than no gate at all.
 */
function deferredToCursor(cwd: string, env: Record<string, string | undefined>): boolean {
  if (!env['CURSOR_PROJECT_DIR']) return false;
  try {
    return readFileSync(join(cwd, CURSOR_HOOKS_FILE), 'utf8').includes(GATE_SCRIPT_SENTINEL);
  } catch {
    return false;
  }
}

/**
 * The gate's `check`-script invocation for `pm` (the alias `agent-setup`
 * ensures exists). The hook IS a gate, so it runs `--strict` (zero checks
 * running is exit 2, not a pass — docs/contract.md) and `--digest` (the
 * token-bounded failure excerpt is a far better landing spot for an agent than
 * raw summary.json). npm alone needs `--` to reach the script with flags;
 * pnpm/yarn/bun forward them directly.
 */
export function checkArgs(pm: PackageManager, profile: GateProfile | null = null): string[] {
  return [
    'run',
    CHECK_SCRIPT,
    ...(pm === 'npm' ? ['--'] : []),
    '--strict',
    '--digest',
    ...profileArgs(profile),
  ];
}

/**
 * The profile's flags, appended **after** the check script's own.
 *
 * Last wins in `parseArgs`, so a repo whose `check` script already carries
 * `--only` has the profile override it rather than fight it — the profile is the
 * more specific statement, made about this hook in particular.
 */
function profileArgs(profile: GateProfile | null): string[] {
  if (profile === null) return [];
  return [
    ...(profile.only && profile.only.length > 0 ? ['--only', profile.only.join(',')] : []),
    ...(profile.skip && profile.skip.length > 0 ? ['--skip', profile.skip.join(',')] : []),
    ...(profile.changed === true ? ['--changed'] : []),
  ];
}

/**
 * The repo's gate profile, or `null` when it configures none and the gate should
 * run the whole check.
 *
 * A profile with nothing in it is `null` too: `"gate": {}` narrows nothing, and
 * carrying it forward would put "not the full check" on a verdict that *was* the
 * full check.
 */
export function gateProfile(cwd: string, config: CheckrideConfig | null = loadConfig(cwd)): GateProfile | null {
  const profile = config?.gate;
  if (!profile) return null;
  return profileArgs(profile).length > 0 ? profile : null;
}

/**
 * Why the profile's `only` or `skip` can't run, or `null` when each token it
 * names selects a check.
 *
 * The run would refuse such a token as well, but it would name `--only`, a flag
 * nobody typed, and the gate would then find no summary from this run and
 * report a red, sending the agent to a failing slot when the fix is one word in
 * `checkride.config.json`. Read before anything spawns, the message names
 * `gate.only` or `gate.skip` and every valid token. An empty list is no
 * narrowing at all (see {@link gateProfile}), so only a non-empty one is read.
 */
function profileProblem(cwd: string, profile: GateProfile | null): string | null {
  if (profile === null) return null;
  const resolved = resolveChecks({ slots: SLOTS, adapters: ADAPTERS, config: loadConfig(cwd), cwd });
  for (const key of ['only', 'skip'] as const) {
    const tokens = profile[key];
    const problem = tokens && tokens.length > 0 ? tokenProblem(resolved, `gate.${key}`, tokens) : null;
    if (problem !== null) return problem;
  }
  return null;
}

/** The cause a profile with an unknown token reports, in the words a refusal uses. */
const PROFILE_REFUSAL = 'the gate profile names a token no check answers to';

/** The cause a gate reports when the repo's config can't be read at all. */
const CONFIG_REFUSAL = "checkride.config.json can't be read";

/** Why the gate can't run as the repo configures it: the cause it reports, the mistake, and where to fix it. */
type ProfileBlock = { refusal: string; problem: string; fix: string };

/**
 * The verdict for a profile that can't run. Nothing ran, as with a launch
 * refusal, but the fix is the repo's, so it blocks rather than standing down.
 */
function profileVerdict(block: ProfileBlock, elapsedMs: number): Verdict {
  return {
    status: headline('could not run', '⚠', elapsedMs, block.refusal),
    instruction:
      `checkride: the gate could not run — ${block.problem} ${block.fix} ` +
      'Nothing ran: no check executed and no artifact was written.',
    refusal: block.refusal,
    standDown: false,
    digest: null,
  };
}

/**
 * The profile the gate runs with (`given`, else the repo's), and why the gate
 * can't run as configured, or `null`: a token no check answers to, or a config
 * it can't read at all, a malformed `gate` among them. Read before anything
 * spawns. A config error is the repo's to fix, as a bad token is, so it
 * blocks with a message rather than exiting 2, which Cursor reads as a broken
 * hook.
 */
function readProfile(cwd: string, given: GateProfile | null | undefined): { profile: GateProfile | null; block: ProfileBlock | null } {
  try {
    const profile = given !== undefined ? given : gateProfile(cwd);
    const problem = profileProblem(cwd, profile);
    return { profile, block: problem === null ? null : { refusal: PROFILE_REFUSAL, problem, fix: 'Fix `gate` in checkride.config.json.' } };
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    return { profile: null, block: { refusal: CONFIG_REFUSAL, problem: `${problem}.`, fix: 'Fix checkride.config.json.' } };
  }
}

/**
 * The repo's gate preflight, or `null` when it declares none.
 *
 * Read at *write* time rather than at run time, by the hook writers in
 * `./agent-setup/`, and baked into the generated script as a literal path. Two
 * reasons, and both are the point of the seam:
 *
 * 1. A preflight that only ran once checkride had started could not answer for
 *    the case it exists to cover — a repo whose dependencies were never
 *    installed, where `checkride gate` is the thing that cannot run.
 * 2. Every `hooks add`/`agent-setup` re-reads this file, so the wiring is
 *    restored on every refresh instead of being clobbered by it. That is exactly
 *    the failure a `--preflight` flag would have kept: a teammate running the
 *    bare command would silently drop the guard.
 *
 * Kept separate from {@link gateProfile} because a preflight narrows nothing —
 * it must never put a "NOT the full check" clause on a verdict.
 */
export function gatePreflight(cwd: string, config: CheckrideConfig | null = loadConfig(cwd)): string | null {
  const path = config?.gate?.preflight;
  return path !== undefined && path.length > 0 ? path : null;
}

/**
 * How a narrowed run must describe itself — the narrowing words that ride
 * inside every verdict's parenthetical while a profile is active.
 *
 * This is the price of the profile and it is not optional. A gate that runs two
 * of eighteen slots and reports a bare `green ✔` has told the reader the work is
 * done, which is exactly what it does not know. Naming the narrowing turns a
 * silent partial pass into a stated one.
 */
function profileClause(profile: GateProfile | null): string | null {
  if (profile === null) return null;
  const parts = [
    profile.only && profile.only.length > 0 ? `only ${profile.only.join(', ')}` : null,
    profile.skip && profile.skip.length > 0 ? `without ${profile.skip.join(', ')}` : null,
    profile.changed === true ? 'affected-only' : null,
  ].filter((p): p is string => p !== null);
  return parts.join(', ');
}

/**
 * Below this, naming the slowest check is noise rather than insight — every
 * check in a fast repo is "the slowest" by some millisecond.
 */
const SLOWEST_FLOOR_MS = 1000;

/** The checks that actually ran, in report order. */
function ranChecks(checks: readonly SummaryCheck[]): SummaryCheck[] {
  return checks.filter((c) => c.skipped !== true);
}

/**
 * The verdict's parenthetical: what the run says about itself, comma-joined
 * into one clause — the check count, the profile's narrowing words when one is
 * active, and the slowest check when naming it is insight rather than noise.
 * Without a fresh summary the narrowing words stand alone, and with neither
 * there is no parenthetical at all.
 */
function gateDetail(read: SummaryRead, fresh: boolean, green: boolean, profile: GateProfile | null): string | null {
  const narrowing = profileClause(profile);
  if (!fresh || read.state !== 'ok') return narrowing;
  const ran = ranChecks(read.summary.checks);
  return green ? greenDetail(ran, narrowing) : redDetail(ran, narrowing);
}

/** `15 checks, without test, slowest: spell in 1.8s` — what a green run is worth saying about itself. */
function greenDetail(ran: readonly SummaryCheck[], narrowing: string | null): string {
  const parts = [`${ran.length} check${ran.length === 1 ? '' : 's'}`];
  if (narrowing !== null) parts.push(narrowing);
  const slowest = ran.reduce<SummaryCheck | null>(
    (worst, c) => (worst === null || c.duration_ms > worst.duration_ms ? c : worst),
    null,
  );
  if (slowest !== null && slowest.duration_ms >= SLOWEST_FLOOR_MS) {
    parts.push(`slowest: ${slowest.name} in ${formatDuration(slowest.duration_ms)}`);
  }
  return parts.join(', ');
}

/** `2 of 15 failed: lint, test; without mutation` — what a red run says, with the narrowing after it. */
function redDetail(ran: readonly SummaryCheck[], narrowing: string | null): string {
  const failed = ran.filter((c) => !c.ok).map((c) => c.name);
  // Red with nothing failing means the check script itself died (or --strict
  // caught a vacuous run); say the honest thing rather than name no slots.
  const detail =
    failed.length === 0
      ? `${ran.length} checks ran, none failed; the check script itself failed`
      : `${failed.length} of ${ran.length} failed: ${failed.join(', ')}`;
  return narrowing === null ? detail : `${detail}; ${narrowing}`;
}

/**
 * Tolerance for a summary written moments before the gate's own clock reading —
 * mirrors `MTIME_TOLERANCE_MS` in `./triage/triage.ts`, where the same
 * comparison decides whether the summary belongs to this run.
 *
 * Without it this comparison is unsound on Linux: file mtimes come from the
 * kernel's coarse (timer-tick) clock while `Date.now()` does not, so a summary
 * written *after* `startedAt` routinely lands a few milliseconds behind it —
 * measured at ~47% of writes on overlayfs, and never once on APFS. That is why
 * the gate went red only on the Linux CI legs.
 */
const MTIME_TOLERANCE_MS = 1000;

/**
 * Is the summary on disk the one *this* run wrote?
 *
 * A gate that could not run wrote none, and a report that invents "0 checks
 * failed" from a missing file is exactly the vacuous green the artifact exists
 * to disprove. A summary older than `startedAt` belongs to a *previous* run and
 * is dropped for the same reason — not hypothetical: a check script of the shape
 * `tsc --build && checkride` leaves the summary untouched when the build fails,
 * so trusting whatever is on disk would report the last run's failing slots as
 * this one's, confidently and wrongly. The tolerance is far smaller than any
 * real gate run, so it cannot launder a genuinely stale summary into a fresh one.
 */
function isFresh(read: SummaryRead, startedAt: number): boolean {
  return read.state === 'ok' && read.mtimeMs >= startedAt - MTIME_TOLERANCE_MS;
}

/**
 * This run's digest: the text of `digest.md` in `dir` when its mtime says
 * this run wrote it, by {@link isFresh}'s rule, or `null`. The gate always
 * passes `--digest`, but the `check` script is the repo's to write, and one
 * that never reaches checkride leaves the last run's digest in place, which
 * must never read as this one's. Asked only once this run's summary is fresh.
 *
 * The file is anyone's to write, so a digest with no text is none, and one
 * past the budget, as a release before 0.19 could write, is held to it
 * ({@link withinBudget}), since the verdict hands it to the agent whole.
 */
async function freshDigest(dir: string, startedAt: number): Promise<string | null> {
  const path = join(dir, DIGEST_FILE);
  try {
    const { mtimeMs } = await stat(path);
    if (mtimeMs < startedAt - MTIME_TOLERANCE_MS) return null;
    const text = await readFile(path, 'utf8');
    return text.trim() === '' ? null : withinBudget(text);
  } catch {
    return null;
  }
}

/**
 * The one line a human reads to know the gate ran, what it decided, and how long
 * they waited on it: `checkride green in 3.6s ✔ (10 checks, without test,
 * slowest: spell in 1.8s)`. The glyph trails the clause it confirms and the
 * detail rides one parenthetical, so a harness prefix ("Notice:") still leaves
 * a line that reads as a sentence, with no colon or dash chain of its own.
 *
 * The elapsed time is the gate's own wall clock — package-manager startup,
 * incremental build and all — not the pipeline's `total_duration_ms`, because
 * the honest answer to "why did that pause" is the whole pause, not the part
 * checkride chooses to measure.
 */
function headline(verdict: string, glyph: string, elapsedMs: number, detail: string | null): string {
  return `checkride ${verdict} in ${formatDuration(elapsedMs)} ${glyph}${detail === null ? '' : ` (${detail})`}`;
}

/**
 * The triage command a red verdict names: `<pm> exec checkride triage`, as the
 * gate has always spelled it in a package-manager repo, else the entry
 * command's own.
 */
function triageCommand(entry: EntryCommand): string {
  return entry.kind === 'script' ? `${entry.pm} exec checkride triage` : entryCheckride(entry, ['triage']);
}

/**
 * The argv the gate runs: the repo's entry command (R6.6) as a hard gate,
 * `--strict` and `--digest`, then the profile's flags. A package-manager repo
 * runs its `check` script as {@link checkArgs} spells it.
 */
function gateArgv(entry: EntryCommand, profile: GateProfile | null): [string, ...string[]] {
  if (entry.kind === 'script') return [entry.pm, ...checkArgs(entry.pm, profile)];
  return entryArgv(entry, ['--strict', '--digest', ...profileArgs(profile)]);
}

/**
 * What this run wrote for a red verdict to send the agent to: its digest,
 * which the verdict carries; its summary, when it wrote no digest; or neither,
 * when the check failed before checkride wrote a summary, as a `check` script
 * of the shape `tsc --build && checkride` does, so no `.check/` file describes
 * this run and naming one would send the agent to an earlier run's.
 */
type RedEvidence = 'digest' | 'summary' | 'none';

/** The first thing a red verdict asks of the agent, by what this run wrote. */
function redStep(evidence: RedEvidence, entry: EntryCommand): string {
  if (evidence === 'digest') return "fix what this run's digest names";
  if (evidence === 'summary') return `read ${SUMMARY_PATH}, fix the failing slot`;
  return `this run wrote no ${SUMMARY_PATH}, so nothing in .check/ describes it — run \`${entryText(entry)}\` to see why, fix that`;
}

/** The sentence a red gate hands the agent, naming what to open first, if anything. */
function redMessage(entry: EntryCommand, profile: GateProfile | null, evidence: RedEvidence): string {
  // A narrowed red is still a red, but it is not the whole story: the slots the
  // profile skipped were never asked, so fixing what it names may not be enough.
  const narrowed =
    profile === null
      ? ''
      : ` This gate ran a profile, not the full check — run \`${entryText(entry)}\` for the rest.`;
  return (
    `checkride: the gate is red — ${redStep(evidence, entry)}, then finish ` +
    `(do not stop while checkride is red). Run \`${triageCommand(entry)}\` for full triage.${narrowed}`
  );
}

/**
 * Said above the digest a red verdict carries to the agent: that this is it,
 * so there's nothing to open first, and that the file is a copy.
 */
const DIGEST_FOLLOWS = `This run's digest follows; ${DIGEST_PATH} is a copy of it, and each section names the raw file that holds the rest.`;

/**
 * Said on the stderr line instead. The check's own output, which the gate
 * forwards to stderr ahead of this line, already printed the digest, and
 * that whole stream is what an exit-2 hook with no body shows the agent, so a
 * second copy would only double it.
 */
const DIGEST_ABOVE = `This run's digest is above, in the check's own output; ${DIGEST_PATH} is a copy of it.`;

/**
 * The Node half of a refusal message: what this process is running, what the
 * repo asked for, and the one lever that closes the gap.
 *
 * This clause is why the whole classification exists. The default cause of a
 * refused launch is that the harness ran its hook in a non-login shell, so the
 * hook got the machine's default interpreter rather than the contributor's —
 * a fact no amount of reading `.check/` would ever reveal.
 */
function nodeClause(alignment: NodeAlignment | null, running: string): string {
  const context =
    'Agent harnesses run hooks in a non-login shell, so a hook gets the machine’s default ' +
    'Node rather than the one your terminal has.';
  const pin = alignment?.pin ?? null;
  if (pin === null) {
    return (
      `${context} This process is on Node ${running} and the repo pins no ` +
      `\`.nvmrc\`/\`.node-version\` for checkride to align to; add one, or set ${NODE_BIN_VAR} to the ` +
      'bin directory of a Node the repo accepts.'
    );
  }
  return (
    `${context} This one is on Node ${running}, the repo pins ${pin.version} ` +
    `(${pin.file}), and no matching install was found in a known version-manager layout — ` +
    `so checkride could not align to it. Install that Node, or set ${NODE_BIN_VAR} to its bin directory.`
  );
}

/**
 * Said on the refusals nobody in the turn can clear, and only those: the gate is
 * declining to block.
 *
 * Stating it is the whole point. A turn that ended unverified must not look like
 * a turn that passed, and the reader — who *can* fix their environment, unlike
 * the agent — is the one who needs to know a check was owed and never ran.
 */
const STOOD_DOWN =
  'This gate is not blocking the turn: nothing here is fixable by editing the repo, so blocking ' +
  'would only re-ask an agent that has no lever to pull. Nothing was verified — fix the ' +
  'environment and run the check yourself before trusting this turn.';

/**
 * The verdict for a package manager that refused to start the check script.
 *
 * It says the three things a red verdict would get wrong here: nothing ran, so
 * `.check/` describes some earlier turn and not this one; the code is not what
 * failed, so no edit will clear it; and here is the actual cause. A gate that
 * sent a reader to `summary.json` for a run that never happened is the confusion
 * this replaces.
 *
 * {@link nodeClause} rides only on an `environment` refusal. It is a paragraph
 * about which interpreter this process got, and appending it to "this repo has
 * no `check` script" pointed a reader at their Node version to explain a missing
 * line of package.json.
 */
function refusalMessage(
  refusal: LaunchRefusal,
  context: { alignment: NodeAlignment | null; running: string; entry: EntryCommand },
): string {
  const environment = refusal.fixable === 'environment';
  return [
    `checkride: the gate could not run — ${refusal.cause}.`,
    'Nothing ran: no check executed and no artifact was written, so `.check/` holds nothing from ' +
      'this turn and the code is not what to look at.',
    ...(environment ? [nodeClause(context.alignment, context.running), STOOD_DOWN] : []),
    `Run \`${entryText(context.entry)}\` in a terminal to see the same failure directly.`,
  ].join(' ');
}

/**
 * Put the pinned Node in front of the child's `PATH`, and say so on stderr.
 *
 * Never silent, by rule: which interpreter the whole pipeline runs on is not
 * something to change behind the reader's back, and the line is what turns a
 * mysteriously different result into an explained one. It goes to stderr with
 * the rest of the run's progress rather than into the one-line verdict, so it is
 * present on a red run too — which is exactly when it is worth knowing.
 *
 * Returns `env` unchanged when there is nothing to align, which is every repo
 * that pins nothing and every hook that already arrived on the right Node.
 */
function announceAlignment(
  alignment: NodeAlignment | null,
  env: Record<string, string | undefined>,
  stderr: Out,
): Record<string, string | undefined> {
  if (alignment === null) return env;
  const { bin } = alignment;
  if (bin === null) return env;
  const target = alignment.version ?? alignment.pin?.version ?? 'the pinned version';
  const why = alignment.pin === null ? NODE_BIN_VAR : `${alignment.pin.file} pins ${alignment.pin.version}`;
  stderr.write(`checkride: running the check on Node ${target} from ${bin} (${why}; this hook started on ${alignment.running}).\n`);
  return withNodeBin(env, bin);
}

/**
 * The variables a consumer uses to shape a run from outside the repo. The gate
 * is the repo's own verdict, so the check it spawns must read the repo's config
 * whatever a consumer left exported in the hook's environment.
 */
const CONSUMER_VARS: ReadonlySet<string> = new Set([CONFIG_ENV, BASE_ENV, OUT_ENV, DEFAULTS_ENV, PINS_ENV]);

/** `env` without {@link CONSUMER_VARS}: the environment the gate's check run inherits. */
function withoutConsumerVars(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CONSUMER_VARS.has(name)));
}

/** Everything a failed run needs to say what failed, and whether anything ran at all. */
type Failure = {
  entry: EntryCommand;
  elapsedMs: number;
  summary: SummaryRead;
  /** Whether the summary on disk was written by this run. */
  fresh: boolean;
  /** This run's digest, when it wrote a fresh summary and a digest ({@link freshDigest}). */
  digest: string | null;
  output: string;
  alignment: NodeAlignment | null;
  running: string;
  profile: GateProfile | null;
};

/** What this run wrote for its red verdict to point at ({@link RedEvidence}). */
function evidenceOf(f: Failure): RedEvidence {
  if (f.digest !== null) return 'digest';
  return f.fresh ? 'summary' : 'none';
}

/**
 * Classify a non-green run and phrase it.
 *
 * The one judgement here is whether the pipeline ran. A summary from this run
 * proves it did, so on that branch nothing in the output can mean otherwise —
 * the guard that keeps a check which merely *printed* a package-manager error
 * code from being read as a launch refusal.
 */
function failedVerdict(f: Failure): Verdict {
  const refusal = f.fresh ? null : launchRefusal(f.output);
  if (refusal === null) {
    return {
      status: headline('red', '✘', f.elapsedMs, gateDetail(f.summary, f.fresh, false, f.profile)),
      instruction: redMessage(f.entry, f.profile, evidenceOf(f)),
      refusal: null,
      standDown: false,
      digest: f.digest,
    };
  }
  // A launch refusal names no profile: nothing ran, so how much would have run
  // is beside the point.
  return {
    status: headline('could not run', '⚠', f.elapsedMs, refusal.cause),
    instruction: refusalMessage(refusal, { alignment: f.alignment, running: f.running, entry: f.entry }),
    refusal: refusal.cause,
    standDown: refusal.fixable === 'environment',
    digest: null,
  };
}

/**
 * Answer a green run in `harness`'s protocol.
 *
 * Claude Code gets `{"systemMessage": …}`, which it shows the user. Without it a
 * green gate is completely silent: the turn simply takes a minute longer than it
 * should have, with nothing on screen to say a full pipeline just ran, which is
 * indistinguishable from a hung model.
 *
 * Cursor gets nothing, and cannot. Its stop hook accepts one field —
 * `followup_message` — and that field *submits a new turn*, so using it to
 * announce a pass would put the agent back to work every time it succeeded. No
 * other channel is documented for the event; see docs/cursor.md.
 */
function reportGreen(
  harness: HarnessName,
  stdout: Out,
  status: string,
  env: Record<string, string | undefined>,
): void {
  if (harness === 'cursor') return;
  stdout.write(`${JSON.stringify({ systemMessage: noticePad(status, env) })}\n`);
}

/**
 * The variable Claude Code names its host in, which a hook inherits: `cli` for
 * the terminal, and `sdk-ts`, `sdk-py`, `claude-desktop`, `claude-vscode` and
 * the like for the hosts that run it through its SDK. Claude Code reads an unset
 * one as the terminal.
 */
const ENTRYPOINT_ENV = 'CLAUDE_CODE_ENTRYPOINT';

/**
 * Blank lines in front of the user-visible verdict, in the terminal only.
 *
 * The harness prints a `systemMessage` right after the turn's last text and
 * trims whatever trailing whitespace that text carried, so the verdict has to
 * bring its own separation: without the pad it lands jammed against the
 * previous sentence. Only the `systemMessage` channel gets it; the agent-facing
 * `reason` and the stderr line are read by parsers and scrollback, not layout.
 *
 * Every other host (Zed and the other ACP clients, the desktop app, the IDE
 * extensions) runs Claude Code through its SDK, which writes `<hook> says: ` in
 * front of *every* line of a `systemMessage`, so there the pad renders as bare
 * `Stop says:` lines. Those hosts already set the message apart (Zed shows it as
 * a session notice), so they get the bare verdict.
 */
function noticePad(message: string, env: Record<string, string | undefined>): string {
  const host = env[ENTRYPOINT_ENV];
  return host === undefined || host === 'cli' ? `\n\n${message}` : message;
}

/** A non-green run, phrased — and whether blocking on it would accomplish anything. */
type Verdict = {
  status: string;
  instruction: string;
  refusal: string | null;
  /** True when the cause is outside the turn's reach, so the gate declines to block. */
  standDown: boolean;
  /** This run's digest, which the agent's channel carries below the instruction, or `null`. */
  digest: string | null;
};

/**
 * Answer a refusal the turn cannot possibly clear: say so, loudly, and do not
 * block.
 *
 * This is the one place checkride chooses *not* to gate, and it is not a
 * softening of the vacuous-green rule — it is that rule reaching its limit.
 * Blocking exists to make an agent fix what it broke. When the cause is a Node
 * the harness did not put on `PATH`, or a package manager corepack will not
 * verify, there is nothing to fix from inside the turn; the block just re-asks
 * the same agent forever, and the observed end of that road is a contributor
 * turning the gate off. A standing gate that says "I could not run" beats a
 * removed one.
 *
 * The message goes to whoever can act on it. Under Claude Code that is
 * `systemMessage`, which the *user* sees — and the full text rides there rather
 * than the one-line status, because without a `decision: "block"` there is no
 * `reason` channel to carry the rest.
 *
 * Cursor has no equivalent. Its stop hook takes one output field,
 * `followup_message`, and that *submits a new turn* — the loop being stood down
 * from. This used to settle for stderr, on the reading that a stand-down nobody
 * sees still beats a loop. That reading was wrong in its premise: Cursor does not
 * document hook stderr as reaching the user at all, surfacing it only in a Hooks
 * output panel under Customize, so "not silent" held on one harness and the
 * party who can actually run an install saw nothing.
 *
 * So the message does go to `followup_message` — **once**. {@link GATE_RETRY_ENV}
 * carries the one fact that makes that safe, since the `loop_count` deciding it
 * reaches the hook script rather than this process. One nudge names the fix in
 * the chat; the next turn is silent, and the loop is bounded at a single extra
 * turn rather than at nothing.
 */
function reportStandDown(
  harness: HarnessName,
  out: { stdout: Out; stderr: Out },
  full: string,
  env: Record<string, string | undefined>,
): number {
  if (harness === 'cursor') {
    if (env[GATE_RETRY_ENV] === '0') out.stdout.write(`${JSON.stringify({ followup_message: full })}\n`);
  } else {
    out.stdout.write(`${JSON.stringify({ systemMessage: noticePad(full, env) })}\n`);
  }
  out.stderr.write(`${full}\n`);
  return 0;
}

/**
 * Answer a run that was not green in `harness`'s protocol — a pipeline red, or a
 * launch refusal the repo can fix; the wire format is the same for both, because
 * both block. A refusal nothing in the turn can fix takes
 * {@link reportStandDown} instead, before any of this.
 *
 * Claude Code gets both spellings of the same verdict, because which one lands
 * depends on the hook script the repo happens to have. The JSON body
 * (`decision: "block"`) is what a current script forwards on its own exit 0,
 * and that body is the one form that can carry a user-visible `systemMessage`
 * alongside the block. The stderr line is what a script that blocks on exit 2
 * relies on, one generated before that change: Claude Code shows the agent
 * such a hook's stderr, unless its stdout holds a blocking body, whose
 * `reason` it gives instead. Emitting both is what lets an already-installed
 * hook script keep gating across the upgrade.
 *
 * Cursor gets `{"followup_message": …}` on stdout and **exit 0**: it reads a
 * non-zero stop hook as a *failed hook* and lets the turn end anyway, so the
 * verdict cannot ride on the exit code. Cursor caps those auto-followups at five
 * per script by default; the hook entry `agent-setup` writes opts out
 * (`loop_limit: null`), because a gate that stops replying after five turns is
 * not a gate.
 *
 * The agent's channel, `reason` under Claude Code and `followup_message`
 * under Cursor, carries this run's digest below the instruction when the run
 * wrote one, so a red verdict shows what failed without a read of its own
 * (#22). Claude Code shows the agent no stderr from a hook that exits 0, as
 * the current script does, so stderr can't carry it there. The digest is
 * held to its 8,000-byte budget, under the 10,000 characters Claude Code caps
 * a hook's `systemMessage` and `additionalContext` at; neither harness
 * documents a cap on these two fields.
 */
function reportRed(
  harness: HarnessName,
  out: { stdout: Out; stderr: Out },
  verdict: Verdict,
  env: Record<string, string | undefined>,
): number {
  // The agent is told what to open and what not to do; the user is told what
  // happened and how long it took. Handing the user the agent's marching orders
  // would bury the one line they are actually reading.
  const full = `${verdict.status}\n${verdict.instruction}`;
  if (verdict.standDown) return reportStandDown(harness, out, full, env);
  const agent = verdict.digest === null ? full : `${full}\n${DIGEST_FOLLOWS}\n\n${verdict.digest.trimEnd()}`;
  if (harness === 'cursor') {
    out.stdout.write(`${JSON.stringify({ followup_message: agent })}\n`);
    return 0;
  }
  out.stdout.write(
    `${JSON.stringify({ decision: 'block', reason: agent, systemMessage: noticePad(verdict.status, env) })}\n`,
  );
  out.stderr.write(`${verdict.digest === null ? full : `${full}\n${DIGEST_ABOVE}`}\n`);
  return 2;
}

/**
 * The options with their defaults applied — every injection point this command
 * has, resolved in one place so {@link runGate} reads as the decision it makes
 * rather than as a list of fallbacks.
 */
type GateContext = {
  cwd: string;
  harness: HarnessName;
  stdout: Out;
  stderr: Out;
  run: GateSpawn;
  env: Record<string, string | undefined>;
  pinEnv: PinEnv;
  now: () => number;
};

function gateContext(options: GateOptions): GateContext {
  return {
    cwd: options.cwd ?? process.cwd(),
    harness: options.harness ?? 'claude',
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    run: options.spawn ?? spawnForward,
    env: options.env ?? process.env,
    pinEnv: options.pinEnv ?? realPinEnv,
    now: options.now ?? Date.now,
  };
}

/**
 * Run the gate and answer in `harness`'s protocol.
 *
 * The exit code is unchanged and stays as `docs/contract.md` promises it: 2 while
 * blocked under `--harness claude`, always 0 under `--harness cursor`. What each
 * harness *displays* is carried by the JSON body on stdout — see
 * {@link reportGreen} and {@link reportRed} — because that is the only channel
 * either harness renders for a human.
 */
export async function runGate(options: GateOptions = {}): Promise<GateResult> {
  const { cwd, harness, stdout, stderr, run, env, pinEnv, now } = gateContext(options);
  const marker = join(cwd, DIRTY_MARKER);

  // Cursor running this repo's Claude hooks alongside its own. Stand down before
  // touching the marker: the native Cursor gate owns both the verdict and the
  // marker for this turn.
  if (harness === 'claude' && deferredToCursor(cwd, env)) {
    return { exitCode: 0, ran: false, green: true, refusal: null };
  }

  // No edit marker → this turn touched no files → nothing to gate. Stop hooks
  // fire on every turn, including pure-conversation ones; without this the gate
  // taxes every reply with a full pipeline run.
  if (options.ifDirty === true && !existsSync(marker)) {
    return { exitCode: 0, ran: false, green: true, refusal: null };
  }

  const pm = options.pm ?? detectPackageManager({ cwd });
  // The gate runs the check the way the repo runs it (R6.6).
  const entry = resolveEntry(cwd, pm);
  const startedAt = now();
  const { profile, block } = readProfile(cwd, options.profile);
  if (block !== null) {
    const exitCode = reportRed(harness, { stdout, stderr }, profileVerdict(block, now() - startedAt), env);
    return { exitCode, ran: true, green: false, refusal: block.refusal };
  }
  const alignment = alignNode(cwd, pinEnv);
  const childEnv = announceAlignment(alignment, withoutConsumerVars(env), stderr);
  const output = recording(stderr);
  const [command, ...args] = gateArgv(entry, profile);
  const code = await run(command, args, { cwd, stderr: output, env: childEnv });
  const green = code === 0;
  // The run wrote `<cwd>/.check`, since CHECKRIDE_OUT was stripped above.
  const summary = await readSummary(outDir(cwd));
  const fresh = isFresh(summary, startedAt);

  if (green) {
    rmSync(marker, { force: true });
    reportGreen(harness, stdout, headline('green', '✔', now() - startedAt, gateDetail(summary, fresh, true, profile)), env);
    return { exitCode: 0, ran: true, green: true, refusal: null };
  }

  const verdict = failedVerdict({
    entry,
    elapsedMs: now() - startedAt,
    summary,
    fresh,
    digest: fresh ? await freshDigest(outDir(cwd), startedAt) : null,
    output: output.text(),
    alignment,
    running: pinEnv.running(),
    profile,
  });
  const exitCode = reportRed(harness, { stdout, stderr }, verdict, env);
  return { exitCode, ran: true, green: false, refusal: verdict.refusal };
}

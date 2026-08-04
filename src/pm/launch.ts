/**
 * Launch refusals — the package manager declining to start the script at all.
 *
 * Every caller that runs the repo's `check` script reads a non-zero exit as
 * "the pipeline is red". That reading is wrong for a whole class of exits,
 * because a package manager refuses *before* the script runs and still exits
 * non-zero: pnpm answers an `engines.node` mismatch with
 * `ERR_PNPM_UNSUPPORTED_ENGINE` and exit 1, exactly as it answers a failing
 * test. The difference is invisible in the status code and obvious in the
 * output, so the output is what is read here.
 *
 * The distinction is not cosmetic. A pipeline red is cleared by fixing code and
 * points at `.check/`; a launch refusal cannot be cleared by any code change and
 * points at nothing, because nothing ran and no artifact was written. Reporting
 * the second as the first sends the reader — human or agent — to an artifact
 * that does not describe this run, which is the failure this table exists to
 * prevent.
 *
 * Each refusal also carries {@link RefusalFix}, because "no code change clears
 * it" is true of only *some* of them. That field is what lets the gate block on
 * the ones an agent can fix and stand down on the ones it cannot, instead of
 * blocking on both and looping forever on the second.
 *
 * **Every pattern here must be one a check's own output cannot contain.** A
 * false positive is worse than the bug being fixed: it would tell someone their
 * environment is broken while their code is what failed. The patterns are all
 * package-manager error *codes*, and the one caller-supplied sentinel checkride
 * writes itself; callers additionally gate on "this run wrote no summary", so a
 * pipeline that demonstrably ran can never be reclassified by a tool that merely
 * printed one of these strings.
 */

/** The sentinel a caller writes when the package-manager binary itself never started. */
export const SPAWN_FAILED_MARKER = 'checkride: could not start';

/**
 * Who can clear a refusal — the one thing a gate has to know before deciding
 * whether blocking on it accomplishes anything.
 *
 * `repo` refusals are cleared by editing the repo: add the missing `check`
 * script, add the missing package.json. An agent holding the edit tools can do
 * that, so a gate that blocks is a gate that works.
 *
 * `environment` refusals cannot be cleared from inside the turn at all — the
 * wrong Node is on `PATH`, corepack will not verify the package manager, the
 * package manager is not installed. Blocking there does not produce a fix; it
 * produces an unbounded retry against an impossible one, because the harness
 * re-prompts the same agent that already has no lever to pull.
 */
export type RefusalFix = 'repo' | 'environment';

/**
 * A refusal checkride recognizes: the marker to look for, the cause in the words
 * a reader needs, and who can clear it.
 *
 * `cause` completes the sentence "the gate could not run — …", so it names what
 * refused and why, never what to do about it; the fix is the caller's to phrase,
 * because it differs by command.
 */
export type LaunchRefusal = { marker: string; cause: string; fixable: RefusalFix };

/**
 * Markers that mean the script never started, most specific first.
 *
 * npm is the delicate one: it prints `EBADENGINE` as a *warning* on a version
 * mismatch and runs the script anyway, and only `engine-strict` turns it into an
 * error. Matching the bare code would reclassify a genuine red in any repo whose
 * dependency tree carries one stale `engines` field — so the two error spellings
 * npm has shipped are matched, and the warning is not.
 *
 * Only pnpm's and npm's spellings are listed, because those are the two the
 * behavior above was verified against. Yarn's and bun's equivalents are
 * deliberately absent rather than guessed: an unmatched refusal degrades to
 * today's report (a red), while a wrong pattern degrades to a false diagnosis.
 * Add one when a real output line is in hand, not before.
 */
const REFUSALS: readonly LaunchRefusal[] = [
  {
    marker: 'ERR_PNPM_UNSUPPORTED_ENGINE',
    cause: "the repo's `engines` pin does not match the Node or pnpm running this process, and pnpm refuses to run a script under it",
    fixable: 'environment',
  },
  {
    marker: 'npm error code EBADENGINE',
    cause: "the repo's `engines` pin does not match the Node running this process, and npm is configured `engine-strict`",
    fixable: 'environment',
  },
  {
    marker: 'npm ERR! code EBADENGINE',
    cause: "the repo's `engines` pin does not match the Node running this process, and npm is configured `engine-strict`",
    fixable: 'environment',
  },
  {
    // `repo`, and deliberately: a missing `check` script is one edit away, and it
    // is the one refusal an agent could otherwise *create* to escape the gate.
    // Standing down here would make "delete the check script" a way out.
    marker: 'ERR_PNPM_NO_SCRIPT',
    cause: 'this repo has no `check` script for the gate to run',
    fixable: 'repo',
  },
  {
    marker: 'Missing script:',
    cause: 'this repo has no `check` script for the gate to run',
    fixable: 'repo',
  },
  {
    marker: 'ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND',
    cause: 'there is no package.json here, so the package manager has nothing to run',
    fixable: 'repo',
  },
  {
    // corepack verifying a `packageManager` field against its bundled signing
    // keys. Common after a corepack upgrade, and total: nothing runs.
    marker: 'Cannot find matching keyid',
    cause: 'corepack could not verify the package manager named in `packageManager`, so it never launched',
    fixable: 'environment',
  },
  {
    marker: SPAWN_FAILED_MARKER,
    cause: 'the package-manager binary is not on this process’s PATH',
    fixable: 'environment',
  },
];

/**
 * Classify `output` — whatever the child printed on either stream — as a launch
 * refusal, or `null` when nothing in it says the script failed to start.
 *
 * `null` is the safe answer and the common one: an unrecognized refusal reads as
 * a pipeline red, which is the behavior that predates this module. A new package
 * manager or a reworded error therefore degrades to today's report rather than
 * to a wrong one.
 */
export function launchRefusal(output: string): LaunchRefusal | null {
  return REFUSALS.find((r) => output.includes(r.marker)) ?? null;
}

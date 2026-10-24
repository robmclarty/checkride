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
 * environment is broken while their code is what failed. The patterns are
 * package-manager error *codes*, the one caller-supplied sentinel checkride
 * writes itself, and the line the `check` script's own shell prints when it
 * finds no `checkride`, matched only as a whole line, so the same line a
 * sub-script printed under a recursive run's prefix (`packages/b check: …`),
 * where another package's checks may have run, never reads as one. Callers
 * additionally gate on "this run wrote no summary", so a pipeline that
 * demonstrably ran can never be reclassified by a tool that merely printed
 * one of these strings.
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
 *
 * `install` refusals are the repo's dependencies never installed: the `check`
 * script runs checkride, and nothing put one where its shell looks. An install
 * clears that rather than an edit, so a gate stands down on it as it does on
 * `environment`, the way the generated hook does when it finds no checkride
 * to start, and names the install where `environment` names the Node.
 */
export type RefusalFix = 'repo' | 'environment' | 'install';

/**
 * A refusal checkride recognizes: the marker to look for, text anywhere in the
 * output or a pattern a line must match, the cause in the words a reader
 * needs, and who can clear it.
 *
 * `cause` completes the sentence "the gate could not run — …", so it names what
 * refused and why, never what to do about it; the fix is the caller's to phrase,
 * because it differs by command.
 */
export type LaunchRefusal = { marker: string | RegExp; cause: string; fixable: RefusalFix };

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
  // The repo's `packageManager` (or `devEngines.packageManager`) pin, refused.
  // `environment`, because the usual cause is a pnpm on PATH the pin doesn't
  // name, as after a global upgrade, which no edit in the turn can switch.
  // Unlike a missing `check` script, an agent could make one only by writing
  // a pin no pnpm can satisfy, and the stand-down says loudly, every turn, that
  // nothing was verified. These are read where checkride starts outside the
  // package manager, a mise or PATH entry and `triage`: under a script entry
  // the same pin refuses the hook's own `<pm> exec`, which the generated hook
  // tells apart by its failing `--version`.
  // Most specific first: pnpm 11 prints a mismatched version after the same
  // `[ERROR] This project is configured to use ` it prints for another manager.
  {
    // pnpm 12.14.0: `Error: ERR_PNPM_BAD_PM_VERSION`.
    marker: 'ERR_PNPM_BAD_PM_VERSION',
    cause: "the pnpm running this process isn't a version the repo's `packageManager` pin names, and pnpm refuses to run under it",
    fixable: 'environment',
  },
  {
    // pnpm 11.28.5 prints no code: `[ERROR] This project is configured to use 10.x of pnpm. Your current pnpm is v11.28.5`.
    marker: 'of pnpm. Your current pnpm is',
    cause: "the pnpm running this process isn't a version the repo's `packageManager` pin names, and pnpm refuses to run under it",
    fixable: 'environment',
  },
  {
    // pnpm 12.14.0: `Error: ERR_PNPM_OTHER_PM_EXPECTED`.
    marker: 'ERR_PNPM_OTHER_PM_EXPECTED',
    cause: "the repo's `packageManager` field names another package manager, and pnpm refuses to run in it",
    fixable: 'environment',
  },
  {
    // pnpm 11.28.5: `[ERROR] This project is configured to use yarn`.
    marker: '[ERROR] This project is configured to use ',
    cause: "the repo's `packageManager` field names another package manager, and pnpm refuses to run in it",
    fixable: 'environment',
  },
  {
    // corepack 0.34.6's shim: `This project is configured to use yarn because /repo/package.json has a "packageManager" field`.
    marker: 'has a "packageManager" field',
    cause: "the repo's `packageManager` field names another package manager, and corepack refuses to run this one in it",
    fixable: 'environment',
  },
  {
    // The `check` script's own shell finding no `checkride` to run, which
    // every package manager that runs scripts through a shell prints ahead of
    // its own failure: macOS's `sh`, bash 3.2, under pnpm 11.28.5 and npm
    // 11.12.1, `sh: checkride: command not found`; yarn 1.22.22's
    // `/bin/sh: …` and bun 1.3.10's `/bin/bash: …`; and dash's
    // `sh: 1: checkride: not found`, on Debian and Ubuntu. A whole line only,
    // never one a recursive run prefixed with the package it ran in.
    marker: /^(?:\/\S*\/)?(?:ba|da)?sh(?:: \d+)?: checkride: (?:command )?not found\r?$/m,
    cause: "the repo's `check` script runs checkride, and nothing installed checkride here",
    fixable: 'install',
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
  return REFUSALS.find(({ marker }) => (typeof marker === 'string' ? output.includes(marker) : marker.test(output))) ?? null;
}

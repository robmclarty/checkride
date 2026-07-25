/**
 * Triage module — the bundled plugin's preflight reader.
 *
 * Runs the repo's own `check` script, branches on checkride's promised 0/1/2
 * exit split, then reads `.check/` as an index: the summary's provenance and
 * schema, one row per slot with its raw output located and sized, and the traps
 * the five-line prose procedure never mentions (vacuous green, narrow green,
 * `baselined`, `skipped`, `exit_code: -1`, a stale artifact). It defines no new
 * contract surface and runs nothing checkride does not already run.
 *
 * `./cli.ts` is the executable form (`node dist/triage/cli.js`); this barrel is
 * the module's programmatic surface, and files inside the module import each
 * other directly rather than through it.
 */

export type { SpawnOutcome, TriageEnv } from './env.js';

export { isHarnessProblem } from './gate.js';

export { resolveCheckrideCli } from './doctor-fold.js';

export { renderTriage } from './render.js';

export { triage } from './triage.js';
export type { TriageReport } from './triage.js';

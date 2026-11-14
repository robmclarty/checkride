/**
 * Checkride — an agent harness for code repositories.
 *
 * The primary interface is the `checkride` CLI (see `src/cli.ts`). This module is
 * the package's programmatic surface, trimmed to the names its consumers import:
 * the run and the doctor, and the types that describe their options and results
 * (including the `.check/summary.json` schema). `checkride/findings` is the other
 * public entry point.
 */

export { runChecks } from './orchestrator/index.js';
export type { RunOptions, RunResult, Summary, SummaryCheck } from './orchestrator/index.js';

export { runDoctor } from './doctor.js';
export type { DoctorCheck } from './doctor.js';

/**
 * Checkride — an agent harness for TypeScript repositories.
 *
 * The primary interface is the `checkride` CLI (see `src/cli.ts`). This module is
 * the package's programmatic surface: the command entry points, the adapter
 * registry, and the public types (including the `.check/summary.json` schema).
 */

export { ADAPTERS, SCHEMA_VERSION, SLOTS } from './adapters.js';
export type { Adapter, Slot } from './adapters.js';

export { loadConfig, resolveChecks } from './config.js';
export type { CheckrideConfig, CustomCheck, ResolvedCheck, SlotConfig, UseConfig } from './config.js';

export { runChecks, runFix, selectChecks } from './orchestrator.js';
export type {
  RunFlags,
  RunOptions,
  RunResult,
  Summary,
  SummaryCheck,
} from './orchestrator.js';

export { runDoctor } from './doctor.js';
export type { DoctorCheck, DoctorReport, DoctorResult } from './doctor.js';

export { runInit } from './init.js';
export type { InitOptions, InitResult, Shape } from './init.js';

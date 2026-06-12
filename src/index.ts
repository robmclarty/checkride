/**
 * Checkride — an agent harness for TypeScript repositories.
 *
 * The primary interface is the `checkride` CLI (see `src/cli`). This module is
 * the package's programmatic surface: the command entry points, the adapter
 * registry, and the public types (including the `.check/summary.json` schema).
 */

export { ADAPTERS, SCHEMA_VERSION, SLOTS } from './adapters/index.js';
export type { Adapter, Slot } from './adapters/index.js';

export { loadConfig, resolveChecks } from './config/index.js';
export type { CheckrideConfig, CustomCheck, ResolvedCheck, SlotConfig, UseConfig } from './config/index.js';

export { runChecks, runFix, selectChecks } from './orchestrator/index.js';
export type {
  RunFlags,
  RunOptions,
  RunResult,
  Summary,
  SummaryCheck,
} from './orchestrator/index.js';

export { runDoctor } from './doctor/index.js';
export type { DoctorCheck, DoctorReport, DoctorResult } from './doctor/index.js';

export { runInit } from './init/index.js';
export type { InitOptions, InitResult, Shape } from './init/index.js';

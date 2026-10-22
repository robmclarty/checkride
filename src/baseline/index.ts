/**
 * Baseline module — per-adapter diagnostic fingerprints and the baseline
 * read/write/ratchet built on top of them. This barrel is
 * the module's only public surface: siblings import from `../baseline`,
 * never from `./fingerprint.js` directly.
 */

export type { Fingerprint, Tally } from './fingerprint.js';
export { findingText, fingerprint, isFingerprintable, observedTally, reportVerdict, tallied, tally } from './fingerprint.js';
export type { FallowVerdict } from './fallow.js';
export { fallowVerdict } from './fallow.js';
export type { BaselineDelta, Candidate, HistoryScan, Recount } from './history.js';
export {
  baselineDirty,
  collectCandidates,
  DEFAULT_DEPTH,
  diffBaselines,
  historicalHint,
  readBaselineAt,
  unionBaselines,
} from './history.js';
export type { Baseline, BaselineEntry, BaselineRead, Captured, Excess, Observation, RanWith, Rerecord } from './store.js';
export {
  applyBaseline,
  BASELINE_FILE,
  BASELINE_SCHEMA_VERSION,
  baselineDrift,
  baselinesEqual,
  capturedRecord,
  copyNamed,
  countBaselineKeys,
  countGrandfathered,
  entryFor,
  loadBaseline,
  parseBaseline,
  ratchet,
  readBaselineStatus,
  renameBaselineSlots,
  rerecordCopies,
  writeBaseline,
} from './store.js';

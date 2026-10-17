/**
 * Baseline module — per-adapter diagnostic fingerprints and the baseline
 * read/write/ratchet built on top of them. This barrel is
 * the module's only public surface: siblings import from `../baseline`,
 * never from `./fingerprint.js` directly.
 */

export type { Fingerprint } from './fingerprint.js';
export { fingerprint, isFingerprintable, reportVerdict } from './fingerprint.js';
export { fallowVerdict } from './fallow.js';
export type { BaselineDelta, Candidate, HistoryScan } from './history.js';
export {
  baselineDirty,
  collectCandidates,
  DEFAULT_DEPTH,
  diffBaselines,
  historicalHint,
  readBaselineAt,
  unionBaselines,
} from './history.js';
export type { Baseline, BaselineRead } from './store.js';
export {
  applyBaseline,
  BASELINE_FILE,
  BASELINE_SCHEMA_VERSION,
  baselinesEqual,
  countBaselineKeys,
  loadBaseline,
  parseBaseline,
  ratchet,
  readBaselineStatus,
  renameBaselineSlots,
  writeBaseline,
} from './store.js';

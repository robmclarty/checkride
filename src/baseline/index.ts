/**
 * Baseline module — per-adapter diagnostic fingerprints, the baseline
 * read/write/ratchet built on top of them, and the files a baseline is
 * spread over once a target is local. This barrel is
 * the module's only public surface: siblings import from `../baseline`,
 * never from `./fingerprint.js` directly.
 */

export type { Fingerprint, Tally } from './fingerprint.js';
export { findingText, fingerprint, gatingFindings, isFingerprintable, observedTally, printedByKey, reportVerdict, stoppedShortReason, tallied, tally } from './fingerprint.js';
export type { FallowVerdict } from './fallow.js';
export { fallowVerdict } from './fallow.js';
export type { BaselineDelta, Candidate, HistoryScan, Recount } from './history.js';
export {
  baselinesDirty,
  collectCandidates,
  DEFAULT_DEPTH,
  diffBaselines,
  historicalHint,
  treeAt,
  unionBaselines,
} from './history.js';
export type { DeclaredAt, ShardChange, ShardMap, ShardsRead } from './shards.js';
export { captureShards, ratchetShards, readShards, readShardsAt, recoverShards, rehomeShards, rerecordShards, shardMap, shardOf, shardsOfOne, strayKeyCount, unownedShards, unwritableShard, writeShards } from './shards.js';
export type { Baseline, BaselineEntry, Captured, Excess, Observation, RanWith, Rerecord } from './store.js';
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

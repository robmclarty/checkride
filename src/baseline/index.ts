/**
 * Baseline module — per-adapter diagnostic fingerprints and the baseline
 * read/write/ratchet built on top of them. This barrel is
 * the module's only public surface: siblings import from `../baseline`,
 * never from `./fingerprint.js` directly.
 */

export type { Fingerprint } from './fingerprint.js';
export { fingerprint, isFingerprintable } from './fingerprint.js';
export { fallowVerdict } from './fallow.js';
export type { Baseline } from './store.js';
export {
  applyBaseline,
  BASELINE_FILE,
  baselinesEqual,
  countBaselineKeys,
  loadBaseline,
  ratchet,
  writeBaseline,
} from './store.js';

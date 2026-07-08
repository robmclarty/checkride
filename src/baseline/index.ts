/**
 * Baseline module — per-adapter diagnostic fingerprints (step 4) and, in later
 * steps, the baseline read/write/ratchet built on top of them. This barrel is
 * the module's only public surface (C2): siblings import from `../baseline`,
 * never from `./fingerprint.js` directly.
 */

export type { Extractor, Fingerprint } from './fingerprint.js';
export { fingerprint } from './fingerprint.js';

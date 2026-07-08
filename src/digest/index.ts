/**
 * Digest module — the token-bounded failure excerpt (step 11). This barrel is
 * the module's only public surface (C2): siblings import from `../digest`, never
 * from `./digest.js` directly.
 */

export type { DigestBudget } from './digest.js';
export { buildDigest, DEFAULT_BUDGET, DIGEST_FILE, writeDigest } from './digest.js';

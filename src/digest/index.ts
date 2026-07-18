/**
 * Digest module — the token-bounded failure excerpt (step 11). This barrel is
 * the module's only public surface (C2): siblings import from `../digest`, never
 * from `./digest.js` directly.
 */

export { buildDigest, DIGEST_FILE, writeDigest } from './digest.js';

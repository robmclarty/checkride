/**
 * Digest module — the token-bounded failure excerpt. This barrel is
 * the module's only public surface: siblings import from `../digest`, never
 * from `./digest.js` directly.
 */

export { buildDigest, DIGEST_FILE, writeDigest } from './digest.js';

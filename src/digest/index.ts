/**
 * Digest module — the token-bounded failure excerpt. This barrel is
 * the module's only public surface: siblings import from `../digest`, never
 * from `./digest.js` directly.
 */

export { buildDigest, DIGEST_FILE, withinBudget, writeDigest } from './digest.js';
export type { GoTestCase } from './go-test.js';
export { caseName, goTestReport } from './go-test.js';

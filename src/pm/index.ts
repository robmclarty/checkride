/**
 * Package-manager module — the public surface for detecting a repo's package
 * manager and translating each adapter's canonical `pnpm exec <tool>` prefix
 * into that PM's form. Detection lives in `detect.ts`, translation in
 * `translate.ts`; siblings import only from here.
 */

export type { PackageManager } from './detect.js';
export { detectPackageManager } from './detect.js';
export { isAvailableUnder, translateExec } from './translate.js';

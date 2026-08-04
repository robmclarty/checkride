/**
 * Package-manager module — the public surface for detecting a repo's package
 * manager and translating each adapter's canonical `pnpm exec <tool>` prefix
 * into that PM's form. Detection lives in `detect.ts`, translation in
 * `translate.ts`, where a slot's tool must resolve from in `tools.ts`, and the
 * refusals that mean it never launched at all in `launch.ts`; siblings import
 * only from here.
 */

export type { PackageManager } from './detect.js';
export { detectPackageManager } from './detect.js';
export type { LaunchRefusal } from './launch.js';
export { launchRefusal, SPAWN_FAILED_MARKER } from './launch.js';
export { execTool, execUsesGlobalCache, installCommand, isPnPInstall, resolveSlotTool } from './tools.js';
export { execCommand, isAvailableUnder, runScript, translateExec } from './translate.js';

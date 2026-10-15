/**
 * Launch module — turns the invocation a check declares into the argv it
 * spawns, through a pin source. The launcher itself lives in `resolve.ts`. The
 * `js-lockfile` source, the project's own package manager, spans the rest:
 * detection in `package-manager.ts`, the exec-prefix translation in
 * `translate.ts`, where a tool has to resolve from in `js-lockfile.ts`, and the
 * refusals that mean a package-manager script never launched at all in
 * `refusal.ts`. Siblings import only from here.
 */

export type { PackageManager } from './package-manager.js';
export { detectPackageManager } from './package-manager.js';
export type { LaunchRefusal } from './refusal.js';
export { launchRefusal, SPAWN_FAILED_MARKER } from './refusal.js';
export { execTool, execUsesGlobalCache, installCommand, isPnPInstall, resolveSlotTool } from './js-lockfile.js';
export type { Launch } from './resolve.js';
export { launchCheck, launchFix } from './resolve.js';
export { execCommand, isAvailableUnder, runScript, translateExec } from './translate.js';

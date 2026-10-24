/**
 * Launch module — turns the invocation a check declares into the argv it
 * spawns, through its pack's pin chain. The launcher itself, the chain walk,
 * lives in `resolve.ts`, and each upward search shares `walk.ts`. The `mise`
 * source is `mise.ts`, the `go-mod-tool` source `go-mod.ts`, the
 * `rust-toolchain` source `rust-toolchain.ts`, the `uv-lock` source `uv.ts`
 * and the `path` source `path.ts`, with `nix.ts` saying whether a copy it finds
 * is a Nix dev shell's. The variables a check's pack sets on its spawn, and the
 * hint a check prints when one of them, or a missing piece of its setup,
 * stopped it, are `env.ts`. The `js-lockfile`
 * source, the project's own package manager, spans the rest: detection in
 * `package-manager.ts`, the exec-prefix translation in `translate.ts`, where a
 * tool has to resolve from in `js-lockfile.ts`, and the refusals that mean a
 * package-manager script never launched at all in `refusal.ts`. How a repo
 * runs checkride itself, its entry command, is `entry.ts`, and the release of
 * the toolchain a check's pack runs it on, which a run records beside its
 * tool's, is `toolchain.ts`. Siblings import only from here.
 */

export type { EntryCommand, EntryLike } from './entry.js';
export { asEntry, entryArgv, entryCheckride, entryText, PIN_CHECKRIDE, resolveEntry } from './entry.js';
export { failureLine, packEnv, setupHint } from './env.js';
export type { ModuleImports } from './go-mod.js';
export { expandGoPackages, goImports, goPackagePatterns, readGoWorkspace, takesGoPackages, usePattern, withDependents } from './go-mod.js';
export type { PackageManager } from './package-manager.js';
export { detectPackageManager, nearestPackageManager } from './package-manager.js';
export type { LaunchRefusal } from './refusal.js';
export { launchRefusal, SPAWN_FAILED_MARKER } from './refusal.js';
export type { MiseAnswer } from './mise.js';
export { loadPinsFile, miseHasInstalled, miseWhereVersion, PINS_ENV } from './mise.js';
export { nixCopy } from './nix.js';
export { execTool, execUsesGlobalCache, installCommand, isPnPInstall, jsLockfileDeclares, resolveSlotTool } from './js-lockfile.js';
export type { Launch, LaunchContext, OverrideCause, Spawn } from './resolve.js';
export {
  chainCanRun,
  commandBin,
  isReadableSource,
  launchCheck,
  overrideCause,
  overridePin,
  pinChain,
  pinDeclaration,
  pinResolution,
} from './resolve.js';
export { launchOnToolchain, packToolchain } from './toolchain.js';
export { isAvailableUnder, translateExec } from './translate.js';
export { dirsUpTo } from './walk.js';

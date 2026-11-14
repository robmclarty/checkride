/**
 * Targets module — named (pack, root) pairs, the rules a config's `targets`
 * and `packs` blocks keep, the token grammar that selects checks by slot,
 * custom name or target, which targets a `--changed` run leaves out, the
 * files a file-list target's checks run over, the keys a local target and
 * its file each hold, and how an included file's targets join the repo's. This
 * barrel is the module's only public surface: siblings import from
 * `../targets/index.js`, never from a file inside it.
 */

export { addTarget, liftDiscovered } from './add.js';
export type { TargetChange } from './add.js';
export { changedGoModules, changedUnder, noChangesReason, noGoModuleChangedReason, pathsUnder } from './changed.js';
export { declaredNote, discoverRun, discoverTargets, ignoreToolsRoot, isImplicit, rootRunsTsTool } from './discover.js';
export type { ProposedTarget } from './discover.js';
export {
  argvBytes,
  expandFiles,
  filesOnDisk,
  globRegExp,
  goSourceFiles,
  isFileListPack,
  listFiles,
  MAX_FILES_ARGV_BYTES,
  NO_FILES_REASON,
  takesFiles,
  targetFiles,
} from './files.js';
export { includedDir, includedFileProblem, includeListProblem, joinedTargets } from './include.js';
export type { DeclaringFile } from './include.js';
export { composedEntry, declaresLocal, heldByLocal, isLocalEntry, localFileOf, localFileProblem, unreadWarnings } from './local.js';
export { markerAt } from './markers.js';
export {
  checkKeys,
  configProblem,
  configuredTargets,
  hasParentSegment,
  implicitPack,
  isAbsoluteForm,
  localTargetsProblem,
  markedPack,
  normalizeRoot,
  presetProblem,
  show,
  skipExitCodeProblem,
} from './resolve.js';
export type { Target } from './resolve.js';
export { checkName, namedBy, selectedBy, tokenProblem } from './tokens.js';
export { checkUnclaimed, findUnclaimed } from './unclaimed.js';
export type { Unclaimed } from './unclaimed.js';
export { findUnreached, unreachedLine, unreachedNote } from './unreached.js';
export type { TsTarget, Unreached } from './unreached.js';

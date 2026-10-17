/**
 * Targets module — named (pack, root) pairs, the rules a config's `targets`
 * and `packs` blocks keep, the token grammar that selects checks by slot,
 * custom name or target, which targets a `--changed` run leaves out, and the
 * files a file-list target's checks run over. This
 * barrel is the module's only public surface: siblings import from
 * `../targets/index.js`, never from a file inside it.
 */

export { addTarget } from './add.js';
export type { TargetChange } from './add.js';
export { changedUnder, noChangesReason } from './changed.js';
export { argvBytes, expandFiles, isFileListPack, MAX_FILES_ARGV_BYTES, NO_FILES_REASON, takesFiles, targetFiles } from './files.js';
export { configProblem, configuredTargets, normalizeRoot, presetProblem, skipExitCodeProblem } from './resolve.js';
export type { Target } from './resolve.js';
export { checkName, namedBy, selectedBy, tokenProblem } from './tokens.js';
export { checkUnclaimed, findUnclaimed } from './unclaimed.js';
export type { Unclaimed } from './unclaimed.js';

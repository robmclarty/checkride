/**
 * Targets module — named (pack, root) pairs, the rules a config's `targets`
 * and `packs` blocks keep, the token grammar that selects checks by slot,
 * custom name or target, and which targets a `--changed` run leaves out. This
 * barrel is the module's only public surface: siblings import from
 * `../targets/index.js`, never from a file inside it.
 */

export { changedUnder, noChangesReason } from './changed.js';
export { configProblem, configuredTargets, presetProblem, skipExitCodeProblem } from './resolve.js';
export type { Target } from './resolve.js';
export { checkName, namedBy, selectedBy, tokenProblem } from './tokens.js';

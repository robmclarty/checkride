/**
 * Targets module — named (pack, root) pairs, the rules a config's `targets`
 * and `packs` blocks keep, and the token grammar that selects checks by slot,
 * custom name or target. This barrel is the module's only public surface:
 * siblings import from `../targets/index.js`, never from a file inside it.
 */

export { configProblem, configuredTargets, presetProblem, skipExitCodeProblem } from './resolve.js';
export type { Target } from './resolve.js';
export { checkName, namedBy, selectedBy, tokenProblem } from './tokens.js';

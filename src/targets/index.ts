/**
 * Targets module — named (pack, root) pairs and the rules a config's
 * `targets` and `packs` blocks keep. This barrel is the module's only public
 * surface: siblings import from `../targets/index.js`, never from a file
 * inside it.
 */

export { configProblem, presetProblem, skipExitCodeProblem } from './resolve.js';

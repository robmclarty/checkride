/**
 * Schema module — the `schema` slot: the rules a config's `schemas` holds,
 * the libraries it validates with and where they're loaded from, the formats
 * it reads, the schemas checkride bundles, the check itself, and what
 * `doctor` reports of it. This barrel
 * is the module's only public surface: siblings import from
 * `../schema/index.js`, never from a file inside it.
 */

export type { LibrarySource } from './libraries.js';
export { probeSchemaLibraries } from './probe.js';
export { schemaRulesProblem } from './rules.js';
export { runSchemaCheck } from './run.js';
export { schemaLibrarySource } from './source.js';

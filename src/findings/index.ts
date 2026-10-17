/**
 * Findings module — one parser per tool output format, each returning the
 * findings it read with their baseline keys and declaring the stream it reads
 * (D28, D49). The baseline derives its fingerprints from these parsers, so the
 * two never drift apart. This barrel is the module's only public surface:
 * siblings import from `../findings/index.js`, never from a file inside it.
 */

export { parseFallowReport } from './parsers/fallow.js';
export { parserFor } from './registry.js';
export { streamText } from './stream.js';
export type { CheckOutput, KeyedFinding } from './types.js';

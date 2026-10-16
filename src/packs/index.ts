/**
 * Packs module — the language packs and the tools they run, as plain data:
 * each pack's adapter rows in `ts.ts`, `repo.ts` and `bash.ts`, the registry by name in
 * `packs.ts`, and every external tool once in `tools.ts`. This barrel is the
 * module's only public surface: siblings import from `../packs/index.js`, never
 * from a file inside it.
 */

export { PACKS } from './packs.js';
export { TOOLS } from './tools.js';
export type { Pack, PinSourceName, Tool } from './types.js';

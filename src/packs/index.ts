/**
 * Packs module — the language packs and the tools they run, as plain data:
 * each pack's adapter rows in `ts.ts`, `repo.ts`, `bash.ts`, `go.ts`, `rust.ts`, `python.ts` and `terraform.ts`, the registry by name in
 * `packs.ts`, and every external tool once in `tools.ts`, with the
 * `--static-only` classification those rows feed in `static.ts`. This barrel is the
 * module's only public surface: siblings import from `../packs/index.js`, never
 * from a file inside it.
 */

export { PACKS } from './packs.js';
export { staticCause } from './static.js';
export type { StaticScope } from './static.js';
export { CARGO_TOOLCHAIN, GO_TOOLCHAIN, TERRAFORM_TOOLCHAIN, TOFU_TOOLCHAIN, TOOLCHAINS, TOOLS } from './tools.js';
export type { Pack, PinSourceName, Tool } from './types.js';

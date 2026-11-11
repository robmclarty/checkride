// The standalone binary's main module: it registers what the npm package has
// no need of, then starts the CLI.
//
// The registry is a property of the global object under the symbol
// `src/schema/libraries.ts` names `BUNDLED_LIBRARIES`. It is set before the
// CLI is imported, so the `schema` slot's bundled libraries are there by the
// time any module of the CLI asks for them.

import { libraries } from './schema-libraries.mjs';

globalThis[Symbol.for('checkride.schema.libraries')] = libraries;

await import('../../dist/cli.js');

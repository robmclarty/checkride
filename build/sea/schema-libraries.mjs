// The three libraries the `schema` slot validates with, for the standalone
// binary alone.
//
// The npm package imports none of them: it loads each from the repo a run is
// in. The binary has no install to read, so esbuild bundles this module, and
// so the libraries, and the binary's main module (`./entry.mjs`) registers
// what it exports before the CLI starts. `modules` holds each library by the
// specifier a repo's copy is required by, and `versions` the version of each
// that was bundled, which `doctor` reports.

import ajv2020 from 'ajv/dist/2020.js';
import ajvPackage from 'ajv/package.json' with { type: 'json' };
import ajv07 from 'ajv';
import * as jsonc from 'jsonc-parser';
import jsoncPackage from 'jsonc-parser/package.json' with { type: 'json' };
import * as yaml from 'yaml';
import yamlPackage from 'yaml/package.json' with { type: 'json' };

/** The bundled libraries, in the shape `src/schema/libraries.ts` reads them from the registry in. */
export const libraries = {
  modules: { ajv: ajv07, 'ajv/dist/2020': ajv2020, yaml, 'jsonc-parser': jsonc },
  versions: { ajv: ajvPackage.version, yaml: yamlPackage.version, 'jsonc-parser': jsoncPackage.version },
};

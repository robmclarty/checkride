/**
 * Quality module — the bundled plugin's reader for the four artifacts
 * checkride already writes about code quality: `mutation`, `dead`, `dupes` and
 * `health`. Named for the skill it serves, as `../triage` is.
 *
 * It runs nothing (D2). It opens what a previous run left in `.check/`, folds
 * each artifact to a short, ranked list, and says plainly which of the four is
 * evidence and which is stale, absent, or from a slot the repo never opted into
 * — the normal case, not the edge case, since three of the four are opt-in.
 *
 * `./cli.ts` is the executable form (`node dist/qa/cli.js`); this
 * barrel is the module's programmatic surface, and files inside the module
 * import each other directly rather than through it.
 */

export { extractDead } from './dead.js';

export { extractDupes } from './dupes.js';

export { extractHealth } from './health.js';

export { extractMutation } from './mutation.js';

export { qaExtract } from './qa.js';
export type { QaReport } from './qa.js';

export { readJsonArtifact } from './read.js';

export { QA_MAX_BYTES, renderQa } from './render.js';

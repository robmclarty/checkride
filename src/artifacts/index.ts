/**
 * Artifacts module — the shared, bounded read of what a checkride run left in
 * `.check/`. Parse the summary and pin its schema, judge each file against the
 * run's freshness window, resolve a slot's raw output by the documented
 * convention, and size what was found without opening it.
 *
 * Both bundled-plugin readers (`../triage`, and the quality extractor beside
 * it) consume the contract only through here — one copy of the summary parse,
 * one freshness rule, one raw-output lookup. This barrel is the module's only
 * public surface: siblings import from `../artifacts/index.js`, never from a
 * file inside it.
 */

export { formatBytes, formatDuration, tail } from './format.js';

export { classifyFreshness, runWindowStart } from './freshness.js';
export type { Freshness } from './freshness.js';

export { asStringOrNull, isRecord, parseJson } from './json.js';

export { resolveRawOutput, statArtifact } from './raw.js';
export type { ArtifactFile, RawOutput } from './raw.js';

export { CHECK_DIR, parseSummary, readSummary, SUPPORTED_SCHEMA_VERSION } from './summary.js';
export type { SummaryRead } from './summary.js';

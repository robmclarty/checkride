/**
 * Artifacts module — the output directory a checkride run writes into, and
 * the shared, bounded read of what it left there. Name the directory, clear
 * the directories of targets the config dropped, parse the summary and pin its
 * schema, judge each file against the run's freshness window, resolve a slot's
 * raw output by the documented convention, and size what was found without
 * opening it.
 *
 * Both bundled-plugin readers (`../triage` and `../qa`) consume the
 * contract only through here — one copy of the summary parse,
 * one freshness rule, one raw-output lookup. This barrel is the module's only
 * public surface: siblings import from `../artifacts/index.js`, never from a
 * file inside it.
 */

export { formatBytes, formatDuration, tail } from './format.js';

export { classifyFreshness, runWindowStart } from './freshness.js';
export type { Freshness } from './freshness.js';

export { asNumberOrNull, asRecord, asRecordArray, asStringOrNull, isRecord, parseJson } from './json.js';

export { CHECK_DIR, isInside, namedOut, OUT_ENV, outDir, outLabel, prepareScratch, scratchDir, SUMMARY_FILE } from './out.js';

export { listArtifacts, resolveRawOutput, statArtifact } from './raw.js';
export type { ArtifactFile, RawOutput } from './raw.js';

export { parseSummary, readSummary, SUPPORTED_SCHEMA_VERSION } from './summary.js';
export type { SummaryRead } from './summary.js';

export { pruneDroppedTargets } from './targets.js';

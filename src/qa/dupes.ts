/**
 * `dupes.json` — fallow's duplication report. The smallest of the four
 * artifacts (483 B when clean here) and the one most able to explode: every
 * clone instance carries a `fragment` holding the duplicated *source text*, so
 * a report with real findings is mostly code.
 *
 * None of that text is extracted. What a reader needs is where the duplication
 * is and how much of it there is — so a family reduces to its file membership
 * and its line and token totals, and the fragments stay on disk.
 *
 * Families, not groups, are the unit: fallow groups clones by content and then
 * collects the groups that span the same files into a family, which is the
 * level a refactor actually happens at. The group count still reports, because
 * that is what checkride gates the slot on.
 *
 * The `../qa` barrel is this module's only public surface.
 */

import { asNumberOrNull, asRecord, asRecordArray } from '../artifacts/index.js';

/** Families listed; the rest are counted. */
const TOP_FAMILIES = 6;
/** Files named per family before the rest collapse to a count. */
const FILES_PER_FAMILY = 4;

/** A set of files sharing duplicated code. */
export type CloneFamily = {
  files: string[];
  /** Files past {@link FILES_PER_FAMILY}, so the list never implies completeness. */
  omittedFiles: number;
  groups: number;
  lines: number | null;
  tokens: number | null;
};

export type DupesExtract = {
  duplicationPercentage: number | null;
  duplicatedLines: number | null;
  totalLines: number | null;
  totalFiles: number | null;
  filesWithClones: number | null;
  /** Clone groups — the count checkride gates the `dupes` slot on. */
  cloneGroups: number;
  totalFamilies: number;
  families: CloneFamily[];
  omittedFamilies: number;
};

function readFamily(family: Record<string, unknown>): CloneFamily {
  const files = (Array.isArray(family['files']) ? family['files'] : []).filter(
    (file): file is string => typeof file === 'string',
  );
  return {
    files: files.slice(0, FILES_PER_FAMILY),
    omittedFiles: Math.max(0, files.length - FILES_PER_FAMILY),
    groups: asRecordArray(family['groups']).length,
    lines: asNumberOrNull(family['total_duplicated_lines']),
    tokens: asNumberOrNull(family['total_duplicated_tokens']),
  };
}

/** Worst first: most duplicated lines, then most files, then by name. */
function byWeight(a: CloneFamily, b: CloneFamily): number {
  return (
    (b.lines ?? 0) - (a.lines ?? 0) ||
    b.files.length - a.files.length ||
    (a.files[0] ?? '').localeCompare(b.files[0] ?? '')
  );
}

/**
 * Fold a parsed `dupes.json` into the report model, or `null` when it has no
 * `clone_groups` array — the field checkride's own verdict reads, so a report
 * without it is not a dupes report and must not be summarized as clean.
 */
export function extractDupes(value: Record<string, unknown>): DupesExtract | null {
  const groups = value['clone_groups'];
  if (!Array.isArray(groups)) return null;

  const stats = asRecord(value['stats']);
  const families = asRecordArray(value['clone_families']).map(readFamily).toSorted(byWeight);
  return {
    duplicationPercentage: asNumberOrNull(stats['duplication_percentage']),
    duplicatedLines: asNumberOrNull(stats['duplicated_lines']),
    totalLines: asNumberOrNull(stats['total_lines']),
    totalFiles: asNumberOrNull(stats['total_files']),
    filesWithClones: asNumberOrNull(stats['files_with_clones']),
    cloneGroups: groups.length,
    totalFamilies: families.length,
    families: families.slice(0, TOP_FAMILIES),
    omittedFamilies: Math.max(0, families.length - TOP_FAMILIES),
  };
}

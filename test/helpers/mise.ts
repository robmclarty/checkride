/**
 * What mise's CI detection reads on GitHub Actions: the vendor's own
 * variable, and the four the ci_info crate takes as any CI. Where it finds
 * one, mise trusts every config file without recording it, so a file reads
 * as trusted whatever a run did. A case about trust drops these to see what
 * mise does on a laptop.
 */
export const CI_MARKERS = ['GITHUB_ACTIONS', 'CI', 'CONTINUOUS_INTEGRATION', 'BUILD_NUMBER', 'RUN_ID'] as const;

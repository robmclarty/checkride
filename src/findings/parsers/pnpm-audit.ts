/**
 * `pnpm audit --json`: `{ advisories: { <id>: { module_name, title, severity,
 * github_advisory_id, patched_versions, findings: [{ version, paths }] } },
 * metadata: { vulnerabilities } }`, one entry per advisory and one `findings`
 * element per installed version it covers. `severity` is `info`, `low`,
 * `moderate`, `high` or `critical`, and `patched_versions` is `null`, or
 * `<0.0.0`, for an advisory no release fixes. pnpm 11 leaves out of the map
 * every advisory below `--audit-level` and every one the repo's audit config
 * ignores. An audit that never reached the registry prints `{ error }` in
 * the report's place.
 */

import { isRecord } from '../../json.js';
import { AUDIT_LEVELS, auditLevelFromArgs } from '../../security.js';
import { findingKey } from '../key.js';
import { asArray, parseJson, runsTool, str } from '../read.js';
import type { Argv, KeyedFinding, Parser } from '../types.js';

/** The level the registry's own args gate at, for a caller that names no argv. */
const REGISTRY_LEVEL = 'high';

/**
 * Whether an advisory of `severity` fails the run: when it sits at or above
 * the argv's `--audit-level`, as the `security` built-in decides its verdict
 * (`src/security.ts`), and never for `info` or a level pnpm doesn't name. An
 * argv that hides pnpm's flags can't say, so its findings leave `gates` out;
 * with no argv at all, the registry's own `--audit-level=high` decides.
 */
function gatesAt(severity: string, argv: Argv): boolean | undefined {
  if (argv !== undefined && !runsTool(argv, ['pnpm'])) return undefined;
  const level = argv === undefined ? REGISTRY_LEVEL : auditLevelFromArgs(argv);
  const at = AUDIT_LEVELS.findIndex((l) => l === severity);
  return at !== -1 && at >= AUDIT_LEVELS.indexOf(level);
}

/** The installed versions an advisory covers, each once, in the report's order. */
function installedVersions(advisory: Record<string, unknown>): string[] {
  const versions = asArray(advisory['findings']).map((f) => (isRecord(f) ? str(f['version']) : ''));
  return [...new Set(versions.filter((v) => v !== ''))];
}

/** What fixes an advisory: the range its `patched_versions` names, or that no release does. */
function fixOf(advisory: Record<string, unknown>): string {
  const patched = str(advisory['patched_versions']).trim();
  return patched === '' || patched === '<0.0.0' ? 'no fixed release' : `fixed in ${patched}`;
}

/**
 * One advisory as a finding, or `null` for an entry with no package or no
 * severity: `<package> <versions>: <title> (<fix>)`, under its GHSA id, or
 * pnpm's own id where it has none.
 */
function advisoryFinding(advisory: unknown, argv: Argv): KeyedFinding | null {
  if (!isRecord(advisory)) return null;
  const name = str(advisory['module_name']);
  const severity = str(advisory['severity']);
  if (name === '' || severity === '') return null;
  const id = advisory['id'];
  const rule = str(advisory['github_advisory_id']) || (typeof id === 'number' ? String(id) : '');
  const versions = installedVersions(advisory).join(', ');
  const title = str(advisory['title']).trim();
  const message = `${versions === '' ? name : `${name} ${versions}`}: ${title === '' ? 'advisory' : title} (${fixOf(advisory)})`;
  const gates = gatesAt(severity, argv);
  return { file: '', rule, message, severity, ...(gates !== undefined ? { gates } : {}), key: findingKey('', rule, message) };
}

/**
 * Every advisory in the report, in its order. An advisory is about a package
 * the lockfile resolved, so it names no file. Served to `checkride/findings`
 * and listed under a red `security` slot, but never keyed into the baseline:
 * an advisory is a security finding to fix or to ignore by name in the
 * repo's audit config, not a debt to grandfather.
 *
 * Returns `null` for output that isn't an audit report (pnpm's `{ error }`,
 * a payload with no `advisories` map or no `metadata`) and for a report
 * holding an entry it can't read.
 */
export const pnpmAuditParser: Parser = {
  stream: 'artifact',
  parseOnly: true,
  parse: (raw, context) => {
    const payload = parseJson(raw);
    if (!isRecord(payload) || !isRecord(payload['advisories']) || !isRecord(payload['metadata'])) return null;
    const findings = Object.values(payload['advisories']).map((advisory) => advisoryFinding(advisory, context.argv));
    return findings.every((f) => f !== null) ? findings : null;
  },
};

#!/usr/bin/env node
/**
 * Executable form of the triage reader — what the bundled `/checkride:check`
 * skill invokes:
 *
 * ```
 * node <plugin-root>/dist/triage/cli.js [cwd]
 * ```
 *
 * It ships in the package's existing `dist/`, so both the published tarball and
 * an installed plugin cache already carry it and no consumer build step exists.
 * It adds no CLI command, flag or config to checkride itself: `dist/cli.js`
 * knows nothing about this file.
 *
 * Exit code 0 means *a report was rendered*, however the gate came back — the
 * gate's verdict is in the Markdown, not in this process's status, so a red repo
 * does not look to the caller like a broken reader. Only a failure to produce a
 * report at all exits non-zero.
 */

import { realEnv } from './env.js';
import { renderTriage } from './render.js';
import { triage } from './triage.js';

const [, , cwdArg] = process.argv;
const report = await triage(cwdArg ?? process.cwd(), realEnv);
process.stdout.write(`${renderTriage(report)}\n`);

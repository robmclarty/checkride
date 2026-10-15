#!/usr/bin/env node
/**
 * Executable form of the triage reader — what the bundled `/checkride:check`
 * skill invokes:
 *
 * ```
 * node <plugin-root>/dist/triage/cli.js [cwd] [--out <dir>]
 * ```
 *
 * It ships in the package's existing `dist/`, so both the published tarball and
 * an installed plugin cache already carry it and no consumer build step exists.
 * `dist/cli.js` knows nothing about this file; `checkride triage` is the same
 * reader behind the CLI. `--out` (else `CHECKRIDE_OUT`) points it at another
 * output directory, resolved against the working directory, and the gate run
 * it starts writes there.
 *
 * Exit code 0 means *a report was rendered*, however the gate came back — the
 * gate's verdict is in the Markdown, not in this process's status, so a red repo
 * does not look to the caller like a broken reader. Only a failure to produce a
 * report at all exits non-zero.
 */

import { parseArgs } from 'node:util';

import { namedOut } from '../artifacts/index.js';
import { realEnv } from './env.js';
import { renderTriage } from './render.js';
import { triage } from './triage.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
const out = namedOut(process.cwd(), values.out, process.env);
const report = await triage(positionals[0] ?? process.cwd(), realEnv, out);
process.stdout.write(`${renderTriage(report)}\n`);

#!/usr/bin/env node
/**
 * Executable form of the quality reader — what the bundled `/checkride:qa`
 * skill invokes:
 *
 * ```
 * node <plugin-root>/dist/qa/cli.js [cwd] [--out <dir>]
 * ```
 *
 * It ships in the package's existing `dist/`, so both the published tarball and
 * an installed plugin cache already carry it and no consumer build step exists.
 * `dist/cli.js` knows nothing about this file; `checkride qa` is the same
 * reader behind the CLI. `--out` (else `CHECKRIDE_OUT`) points it at another
 * output directory, resolved against the working directory.
 *
 * Exit code 0 means *a report was rendered* — including one whose every
 * artifact is missing, which is a legitimate answer about a repo and not a
 * reader failure. Unlike the triage reader, this one spawns nothing at all.
 */

import { parseArgs } from 'node:util';

import { namedOut } from '../artifacts/index.js';
import { qaExtract } from './qa.js';
import { renderQa } from './render.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
const out = namedOut(process.cwd(), values.out, process.env);
const report = await qaExtract(positionals[0] ?? process.cwd(), Date.now, out);
process.stdout.write(`${renderQa(report)}\n`);

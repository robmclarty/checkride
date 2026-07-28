#!/usr/bin/env node
/**
 * Executable form of the quality reader — what the bundled `/checkride:qa`
 * skill invokes:
 *
 * ```
 * node <plugin-root>/dist/qa/cli.js [cwd]
 * ```
 *
 * It ships in the package's existing `dist/`, so both the published tarball and
 * an installed plugin cache already carry it and no consumer build step exists.
 * It adds no CLI command, flag or config to checkride itself: `dist/cli.js`
 * knows nothing about this file.
 *
 * Exit code 0 means *a report was rendered* — including one whose every
 * artifact is missing, which is a legitimate answer about a repo and not a
 * reader failure. Unlike the triage reader, this one spawns nothing at all.
 */

import { qaExtract } from './qa.js';
import { renderQa } from './render.js';

const [, , cwdArg] = process.argv;
const report = await qaExtract(cwdArg ?? process.cwd());
process.stdout.write(`${renderQa(report)}\n`);

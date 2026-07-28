/**
 * Opening a quality artifact — the one place this module reads bytes.
 *
 * Triage never opens a `.check/` file; it reports sizes and points. The quality
 * extractor has to open four of them, which makes *bounding* the read this
 * module's whole discipline: `mutation.json` is 2.3 MB in this repo and its
 * parsed form is an order of magnitude more. Nothing here escapes into the
 * report — each extractor folds a parsed artifact into counts and a capped
 * short list, and the parsed object is dropped on the way out.
 *
 * A file past {@link MAX_PARSE_BYTES} is *reported*, never parsed: a reader
 * that exhausts memory on a pathological artifact is worse than one that says
 * how big the file got and stops.
 *
 * The `../qa` barrel is this module's only public surface.
 */

import { readFile } from 'node:fs/promises';

import type { ArtifactFile } from '../artifacts/index.js';
import { isRecord, parseJson, statArtifact } from '../artifacts/index.js';

/**
 * The largest artifact this reader will parse. Set well above the 2.3 MB
 * `mutation.json` that motivated the bound — the ceiling exists to stop a
 * runaway file, not to second-guess a normal one — and low enough that parsing
 * cannot take the process down.
 */
const MAX_PARSE_BYTES = 64 * 1024 * 1024;

/** The outcome of opening one artifact. Every state is reportable. */
export type ArtifactRead =
  | { state: 'ok'; file: ArtifactFile; value: Record<string, unknown> }
  | { state: 'too-large'; file: ArtifactFile }
  | { state: 'unreadable'; file: ArtifactFile; detail: string }
  | { state: 'missing'; file: null };

/**
 * Measure `<checkDir>/<name>`, then parse it when it is small enough to be
 * worth parsing. Never throws: an unreadable artifact is a finding about the
 * artifact, not a crash.
 */
export async function readJsonArtifact(
  checkDir: string,
  name: string,
  windowStart: number | null,
  maxBytes: number = MAX_PARSE_BYTES,
): Promise<ArtifactRead> {
  const file = await statArtifact(checkDir, name, windowStart);
  if (file === null) return { state: 'missing', file: null };
  if (file.bytes > maxBytes) return { state: 'too-large', file };
  try {
    const value = parseJson(await readFile(file.path, 'utf8'));
    if (!isRecord(value)) return { state: 'unreadable', file, detail: 'not a JSON object' };
    return { state: 'ok', file, value };
  } catch {
    return { state: 'unreadable', file, detail: 'could not be read from disk' };
  }
}

/**
 * Which of a check's streams a parser is handed (D49).
 */

import type { CheckOutput, FindingStream } from './types.js';

/**
 * The text a parser that reads `stream` is handed out of what a check printed:
 * stderr for a stderr parser, else stdout, which holds the JSON artifact's
 * bytes as well as the check's own text (see {@link FindingStream}).
 */
export function streamText(output: CheckOutput, stream: FindingStream): string {
  return stream === 'stderr' ? output.stderr : output.stdout;
}

/**
 * The `schema` built-in's report (`<out>/schema.json`):
 * `{ rules: [{ schema, files }], errors: [{ file, rule, instancePath, keyword,
 * message, param?, line? }] }`, its `file` relative to the repo root and its
 * `line` 1-based.
 *
 * A finding's rule is the error's `keyword`: the JSON Schema keyword the
 * value broke, or one of the check's own (`parse`, `frontmatter`, `files`,
 * `$ref`, `directory-name`). Its message opens with the JSON pointer of the
 * value it is about.
 */

import { isRecord } from '../../json.js';
import { findingKey } from '../key.js';
import { rebasePath } from '../paths.js';
import { located, oneBased, parseJson, str } from '../read.js';
import type { KeyedFinding, Parser } from '../types.js';

/**
 * Every error that names a file and a keyword. Each fails the check, so each
 * gates.
 *
 * The key is the file, the keyword and the JSON pointer, then the error's
 * `param` where it has one, and never the message. A message quotes the
 * schema (`must match pattern "…"`) and a parser's own words, both of which a
 * library bump or a schema edit can reword while the finding stays the one it
 * was. `param` is what the keyword names as at fault, the property a
 * `required` error misses or an `additionalProperties` error found: without
 * it, a missing `name` and a missing `description` would share one key, and a
 * baseline that counts keys would let one be swapped for the other.
 *
 * Returns `null` for a payload with no `errors` array, which the check never
 * writes: a clean run's report holds an empty one.
 */
export const schemaParser: Parser = {
  stream: 'artifact',
  parse: (raw, context) => {
    const payload = parseJson(raw);
    const errors = isRecord(payload) ? payload['errors'] : undefined;
    if (!Array.isArray(errors)) return null;
    const findings: KeyedFinding[] = [];
    for (const error of errors) {
      if (!isRecord(error)) continue;
      const file = str(error['file']);
      const rule = str(error['keyword']);
      if (!file || !rule) continue;
      const pointer = str(error['instancePath']);
      const param = str(error['param']);
      const path = rebasePath(context, file);
      findings.push({
        file: path,
        ...located(oneBased(error['line'], 1), undefined),
        rule,
        message: [pointer, str(error['message'])].filter((part) => part !== '').join(' '),
        gates: true,
        key: findingKey(path, rule, param === '' ? pointer : `${pointer}:${param}`),
      });
    }
    return findings;
  },
  // The key holds no message, so a reader is shown the finding itself.
  printed: (finding) => `${finding.file}: ${finding.message} [${finding.rule}]`,
};

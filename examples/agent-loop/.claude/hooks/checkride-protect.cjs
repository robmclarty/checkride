#!/usr/bin/env node
// checkride-protect.cjs — deny agent edits to checkride's accounting files.
// checkride owns this file: `checkride agent-setup` (and `checkride init`)
// overwrite it on every run.
//
// Pre-tool hook for claude. Reads the tool call as JSON on stdin and
// denies the write when it targets the baseline or .check/. Reads are never
// matched — triage depends on reading .check artifacts.
'use strict';
const { realpathSync } = require('node:fs');
const { basename, dirname, isAbsolute, relative, resolve, sep } = require('node:path');

const PATH_KEYS = ["file_path","notebook_path","path","target_file","filePath","relative_workspace_path"];

// Resolve symlinks in `p`, so a symlinked prefix cannot make an in-repo path
// look external. On macOS the repo root routinely arrives in two spellings —
// the harness passes /var/…, the environment reports /private/var/… — and a
// raw string comparison across the two rejects every path in the repo.
//
// `p` need not exist: this hook runs *before* the write, and the target is
// often a file (or a whole directory) that is about to be created. So walk up
// to the first ancestor that does exist, resolve that, and re-append the rest.
function canon(p) {
  let dir = resolve(p);
  const rest = [];
  for (;;) {
    try {
      return resolve(realpathSync(dir), ...rest);
    } catch {
      const up = dirname(dir);
      if (up === dir) return resolve(p);
      rest.unshift(basename(dir));
      dir = up;
    }
  }
}

let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0); // fail open: a broken hook must not brick every edit
  }
  const tool = (input && input.tool_input) || {};
  const target = PATH_KEYS.map((k) => tool[k]).find((v) => typeof v === 'string' && v.length > 0);
  if (target === undefined) process.exit(0);
  const root = canon(process.env.CURSOR_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const abs = canon(isAbsolute(target) ? target : resolve(root, target));
  const rel = relative(root, abs).split(sep).join('/');
  const denied = rel === 'checkride.baseline.json' || rel === '.check' || rel.startsWith('.check/');
  if (!denied) process.exit(0);
  process.stderr.write('checkride: ' + rel + ' is checkride-owned accounting. Never edit the baseline or .check ' +
    'artifacts to make a check pass — fix the finding instead (the ratchet prunes the baseline on its own).' + '\n');
  process.exit(2);
});

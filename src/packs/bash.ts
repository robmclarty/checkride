/**
 * The bash pack: shell scripts, checked as a list of files rather than from a
 * root, since a directory of scripts has no manifest that says what it holds.
 *
 * It has no root markers, so a bash target is always declared (or, later,
 * discovered), never implied. Its tools are single binaries a `mise.toml`
 * pins, or failing that the copies on `PATH`. Each adapter takes its files
 * through `{files}`, which a run expands to the target's file list (R11.2):
 * what the target's `include` globs match, by default every `.sh` and `.bash`
 * file under its root plus any extensionless file with a shell shebang, less
 * what its `exclude` globs match.
 */

import type { Pack } from './types.js';

export const BASH_PACK: Pack = {
  name: 'bash',
  markers: [],
  pins: ['mise', 'path'],
  env: {},
  adapters: [
    {
      name: 'shellcheck',
      slot: 'lint',
      description: 'ShellCheck: shell script analysis',
      // shellcheck needs no config file, but a bare bash target with neither a
      // `.shellcheckrc` nor a pin says nothing about which copy should run, so
      // the slot detects on one or the other. Naming it in config runs it too.
      detect: ['.shellcheckrc'],
      detectPin: 'shellcheck',
      command: 'pnpm',
      // `json1` is the format that carries every comment's file, line and code;
      // the older `json` drops the wrapper object and nothing else.
      args: ['exec', 'shellcheck', '-f', 'json1', '{files}'],
      outputFile: 'lint.json',
      devDeps: {},
    },
    {
      name: 'shfmt',
      slot: 'format',
      description: 'shfmt: shell script formatting',
      detect: [],
      detectPin: 'shfmt',
      command: 'pnpm',
      // `-d` prints a diff for each file that would change and exits 1 when
      // any would, so the check fails on drift without touching the files.
      args: ['exec', 'shfmt', '-d', '{files}'],
      outputFile: null,
      fixArgs: ['exec', 'shfmt', '-w', '{files}'],
      devDeps: {},
    },
  ],
};

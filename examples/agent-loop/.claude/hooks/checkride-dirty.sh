#!/bin/sh
# checkride-dirty.sh — record that this turn edited a file.
#
# checkride owns this file: `checkride agent-setup` (and `checkride init`)
# overwrite it on every run.
#
# The gate reads this marker under `--if-dirty` and clears it on green.

cd "${CURSOR_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-.}}" || exit 0
mkdir -p "$(dirname .check/.dirty)" && touch .check/.dirty
exit 0

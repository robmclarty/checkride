#!/bin/sh
# checkride-gate.sh — the claude stop-hook gate.
#
# checkride owns this file: `checkride agent-setup` (and `checkride init`)
# overwrite it on every run. Customize via a sibling script or the
# environment, not by editing here — edits are lost on the next refresh.
#
# Runs the repo's `check` script as a hard gate, and reports the verdict in
# claude's hook protocol. See `checkride gate --help`.

cd "${CURSOR_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-.}}" || exit 2

pnpm --config.verify-deps-before-run=false exec checkride gate --harness claude --if-dirty
status=$?
[ "$status" -eq 0 ] && exit 0
[ "$status" -eq 2 ] && exit 2

# Neither of checkride's two gate codes: it never ran. Block anyway.
printf '%s\n' 'checkride: the gate could not run — `checkride gate` is not resolvable in this repo. Install checkride (or re-run `checkride agent-setup`) before finishing.' >&2
exit 2

#!/usr/bin/env bash
# Print where a deploy would go: the first argument, or staging.
set -euo pipefail

target="${1:-staging}"
printf 'deploying to %s\n' "$target"

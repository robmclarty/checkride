<!--
build-log.md — your live ledger for execution. Append constantly; reorganize at
step boundaries. The antidote to "my plan got lost in the noise."

  Steps     : where you are. One step in flight at a time.
  Park list : where ideas go so you do not chase them. CAPTURE, never act inline.
  Harvest   : the boundary ritual that keeps you on one branch.
  Log       : the build's history. `plumbbob checkpoint` appends a line per step as it
              lands; feeds the /pb-finish report, which rides the branch into the PR.
-->

# Build log — checkride: post-0.3.0 fixes — bugs, hardening, docs sync

**Current step:** none (at the boundary)
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status. Only ONE step is in flight. A step
is done only after a checkpoint — check green + checkpoint taken, via `/pb-verify` or
`/pb-build`.)*

- ☐ 1. <step>

## Park list

> Mid-step, every new problem / idea / "ooh what if" lands HERE, untouched, and you
> go straight back to the step. Acting the instant an idea arrives is the disease.
> Capture is one line (`/pb-park` composes it). Harvest happens only at the boundary.
- [x] detached spawn (step 9) means Ctrl-C on checkride no longer reaches running checks — they're in their own process group and there's no SIGINT forwarding, so an interrupted run can orphan check processes (e.g. a vitest worker). Follow-up: install a SIGINT/SIGTERM handler in the orchestrator/CLI that group-kills all live children before exit.

## Harvest  *(run `/pb-harvest` at each step boundary, after green)*

Classify each parked item as exactly ONE. Naming it before acting is what keeps you
from sprawling across branches.

| Class            | Meaning                                   | Action                          |
|------------------|-------------------------------------------|---------------------------------|
| **blocker**      | Plan was wrong/incomplete; can't proceed  | `/pb-revert`, fold into intent  |
| **tangent**      | A different path, not clearly better      | Defer or kill. Default here.    |
| **pivot signal** | Evidence the whole approach is wrong      | Stop. Replan deliberately.      |

> Reality check: almost everything that *feels* like a pivot is a tangent. Require a
> failed assumption, not a shinier idea, before you pivot.

Harvest results this boundary:

- 2026-07-10 — Ctrl-C orphans (parked during step 9) → **tangent**, promoted to
  step 19 rather than deferred: a real user-facing regression introduced by
  step 9's detached spawn, small and well-understood (reuse the group-kill
  machinery), worth fixing before the next release.

## Log

*(The build's history, oldest first. `plumbbob checkpoint` appends a dated line here
every time a step lands — via `/pb-build` or `/pb-verify` — so this
fills in as you go, not at the end. Add your own decision/event lines too: this is what
you point at to say "I did that — the LLM helped, but those were my calls."
`/pb-finish` reads this for the report; `plumbbob finish` commits it with the build
folder, so it rides the branch into the PR.)*
- 2026-07-10 — step 1 checkpointed · 98f93d279 — Green the local gate: explicit 30s timeouts on subprocess-spawning tests
- 2026-07-10 — step 2 checkpointed · 3c68c86e7 — `doctor`: distinguish "timed out" from "could not parse", 30s probe
- 2026-07-10 — step 3 checkpointed · b27983e43 — Bug: `init --baseline --dry-run` must not write the baseline
- 2026-07-10 — step 4 checkpointed · e732539a0 — Bug: new-mode `init` refuses to overwrite existing files; add `--force`
- 2026-07-10 — step 5 checkpointed · 5ef7b6c51 — Bug: unknown slot names in `--only`/`--skip`/`--include` exit 2
- 2026-07-10 — step 6 checkpointed · a3098a889 — Pin policy: `init` writes an exact checkride version; README installs
- 2026-07-10 — step 7 checkpointed · a028caf83 — CLI polish: per-command `--help`, `baseline` parses its argv, `init`
- 2026-07-10 — step 8 checkpointed · b2d7081f1 — Orchestrator: clear a slot's stale `.check/` outputs at the start of its
- 2026-07-10 — step 9 checkpointed · 13458fed0 — Orchestrator: process-group kill on timeout + UTF-8-safe capture
- 2026-07-10 — step 10 checkpointed · b6e644ff5 — `checkride fix` translates to the detected package manager
- 2026-07-11 — step 11 checkpointed · 56edb1229 — Friendly file-named errors for malformed consumer JSON
- 2026-07-11 — step 12 checkpointed · 85ef47834 — Repo automation: release tag↔version guard, CI concurrency, Dependabot
- 2026-07-11 — step 13 checkpointed · d7b2b84fa — Dogfood the library-publishing pair
- 2026-07-11 — step 14 checkpointed · 15e3d1500 — Docs drift batch (mechanical corrections)
- 2026-07-11 — step 15 checkpointed · 46538ed42 — Reconcile contract.md's "everything locked by test/contract/" claim
- 2026-07-11 — step 16 checkpointed · 78010e3bf — README restructure (connective fixes)
- 2026-07-11 — step 17 checkpointed · 1cf9d83eb — getting-started + tools.md sync
- 2026-07-11 — step 18 checkpointed · 490743e02 — Docs gaps

<!--
build-log.md — your live ledger for execution. Append constantly; reorganize at
step boundaries. The antidote to "my plan got lost in the noise."

  Steps     : where you are. One step in flight at a time.
  Park list : where ideas go so you do not chase them. CAPTURE, never act inline.
  Harvest   : the boundary ritual that keeps you on one branch.
  Log       : the build's history. `plumbbob checkpoint` appends a line per step as it
              lands; feeds the /pb-finish report, which rides the branch into the PR.
-->

# Build log — Publish-ready bundle + wave scheduler

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

- (none yet)

## Log

*(The build's history, oldest first. `plumbbob checkpoint` appends a dated line here
every time a step lands — via `/pb-build` or `/pb-verify` — so this
fills in as you go, not at the end. Add your own decision/event lines too: this is what
you point at to say "I did that — the LLM helped, but those were my calls."
`/pb-finish` reads this for the report; `plumbbob finish` commits it with the build
folder, so it rides the branch into the PR.)*
- 2026-07-18 — step 1 checkpointed · 4c5b150e2 — Order data model + `order` widening (no scheduler yet) (30m)
- 2026-07-18 — step 2 checkpointed · b9f7731e2 — Concurrent wave scheduler + `--concurrency` (20m)
- 2026-07-18 — step 3 checkpointed · 295026764 — Scheduler docs + CHANGELOG (6m)
- 2026-07-18 — step 4 checkpointed · 5a710199a — `build` slot + detection widening (1 drift, 27m)
- 2026-07-18 — step 5 checkpointed · 73f5a4cef — `pack` built-in (1 drift, 17m)
- 2026-07-18 — step 6 checkpointed · cfbec0da7 — `smoke` built-in (1 drift, 67m)
- 2026-07-18 — step 7 checkpointed · 97a8f0883 — `snippets` extraction core (pure) (11m)
- 2026-07-19 — step 8 checkpointed · 5e982c172 — `snippets` adapters + execution (1 drift, 27m)
- 2026-07-19 — step 9 checkpointed · 4e0680086 — init library bundle + doctor polish (38m)
- 2026-07-19 — step 10 checkpointed · c8e26f075 — Slot docs + CHANGELOG (1 drift, 44m)

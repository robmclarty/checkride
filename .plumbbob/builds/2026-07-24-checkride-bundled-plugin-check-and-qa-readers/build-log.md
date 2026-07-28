<!--
build-log.md — your live ledger for execution. Append constantly; reorganize at
step boundaries. The antidote to "my plan got lost in the noise."

  Steps     : where you are. One step in flight at a time. CLI-maintained: `build`,
              `checkpoint`, and `revert` keep this mirror and the Current step line
              in sync with intent.md — you never hand-edit them.
  Park list : where ideas go so you do not chase them. CAPTURE, never act inline.
  Harvest   : the boundary ritual that keeps you on one branch.
  Log       : the build's history. `plumbbob checkpoint` appends a line per step as it
              lands; feeds the /pb-finish report, which rides the branch into the PR.
-->

# Build log — checkride bundled plugin: check and qa readers

**Current step:** 3 — feat(check): add the check skill that triages a red gate
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status — CLI-maintained, not hand-edited.
`build`/`checkpoint`/`revert` re-render this from intent.md, and set the Current step
line above. Only ONE step is in flight; a step is done only after a checkpoint —
check green + checkpoint taken, via `/pb-verify` or `/pb-build`.)*

- ☑ 1. feat(plugin): ship a Claude Code plugin manifest from the package root
- ☑ 2. feat(check): add a bounded, contract-aware triage preflight reader
- ☐ 3. feat(check): add the check skill that triages a red gate
- ☐ 4. feat(qa): add a bounded extractor for the quality artifacts
- ☐ 5. feat(qa): add the qa skill that reads quality signal
- ☐ 6. feat(init): point the AGENTS.md stanza at the installed skill
- ☐ 7. docs(plugin): document the bundled plugin and its two skills

## Park list

> Mid-step, every new problem / idea / "ooh what if" lands HERE, untouched, and you
> go straight back to the step. Acting the instant an idea arrives is the disease.
> Capture is one line (`/pb-park` composes it). Harvest happens only at the boundary.
- [ ] pnpm 11.1.2 verifyDepsBeforeRun prints 'Already up to date / Done in Xms' to stdout before every 'pnpm exec', breaking the JSON parse in dead/dupes/health/attw (tools exit 0, adapter reports 'did not emit valid JSON'). Hits every consumer on pnpm 11; workaround is --config.verify-deps-before-run=false. Real fix is adapters tolerating leading non-JSON, or not routing tools through pnpm exec.
- [ ] On a red gate with zero failing slots (compound check script like 'tsc --build && node dist/cli.js' died before checkride ran), src/triage/render.ts shows no gate stderr — renderHarness returns '' unless doctor is folded in. The one branch where the gate's own output IS the only evidence is the branch that hides it. Fix: render the stderr tail whenever failing.length === 0 and the verdict is red.
- [ ] src/artifacts/raw.ts:79 assumes stdout carries diagnostics and stderr is leftovers, but markdownlint-cli2 inverts it: docs.stdout.txt is progress narration ('Summary: 1 error(s)') while docs.stderr.txt (smaller!) holds the file:line:rule. Verified on a reddened run. The reader sends you to the count, not the location. Fix needs a per-adapter stream hint, or prefer the smaller .txt even when first is already .txt.
- [ ] pnpm-11 JSON pollution trigger identified (refines park 1): it fires ONLY when checkride runs with no outer pnpm process — 'node dist/cli.js' direct makes each inner 'pnpm exec' re-verify deps and print to stdout, so dead/dupes/health fail with exit 0 + 'did not emit valid JSON'; via 'pnpm run check' the outer pnpm already verified and the inner exec stays quiet. Validates D3 (repo-script-preflight): the triage reader runs '<pm> run check', which is the invocation that avoids it.

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
- 2026-07-25 — step 1 checkpointed · cf4856b17 — feat(plugin): ship a Claude Code plugin manifest from the package root (2 red, 20m)
- 2026-07-25 — step 2 checkpointed · 5850a1685 — feat(check): add a bounded, contract-aware triage preflight reader (1 drift, 26m)

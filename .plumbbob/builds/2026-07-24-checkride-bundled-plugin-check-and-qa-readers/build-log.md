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

**Current step:** none (at the boundary)
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status — CLI-maintained, not hand-edited.
`build`/`checkpoint`/`revert` re-render this from intent.md, and set the Current step
line above. Only ONE step is in flight; a step is done only after a checkpoint —
check green + checkpoint taken, via `/pb-verify` or `/pb-build`.)*

- ☑ 1. feat(plugin): ship a Claude Code plugin manifest from the package root
- ☑ 2. feat(check): add a bounded, contract-aware triage preflight reader
- ☑ 3. feat(check): add the check skill that triages a red gate
- ☑ 4. fix(check): route triage to the bytes that explain the failure
- ☑ 5. feat(qa): add a bounded extractor for the quality artifacts
- ☑ 6. feat(qa): add the qa skill that reads quality signal
- ☑ 7. feat(init): point the AGENTS.md stanza at the installed skill
- ☑ 8. docs(plugin): document the bundled plugin and its two skills

## Park list

> Mid-step, every new problem / idea / "ooh what if" lands HERE, untouched, and you
> go straight back to the step. Acting the instant an idea arrives is the disease.
> Capture is one line (`/pb-park` composes it). Harvest happens only at the boundary.
- [x] pnpm 11.1.2 verifyDepsBeforeRun prints 'Already up to date / Done in Xms' to stdout before every 'pnpm exec', breaking the JSON parse in dead/dupes/health/attw (tools exit 0, adapter reports 'did not emit valid JSON'). Hits every consumer on pnpm 11; workaround is --config.verify-deps-before-run=false. Real fix is adapters tolerating leading non-JSON, or not routing tools through pnpm exec.
- [x] On a red gate with zero failing slots (compound check script like 'tsc --build && node dist/cli.js' died before checkride ran), src/triage/render.ts shows no gate stderr — renderHarness returns '' unless doctor is folded in. The one branch where the gate's own output IS the only evidence is the branch that hides it. Fix: render the stderr tail whenever failing.length === 0 and the verdict is red.
- [x] src/artifacts/raw.ts:79 assumes stdout carries diagnostics and stderr is leftovers, but markdownlint-cli2 inverts it: docs.stdout.txt is progress narration ('Summary: 1 error(s)') while docs.stderr.txt (smaller!) holds the file:line:rule. Verified on a reddened run. The reader sends you to the count, not the location. Fix needs a per-adapter stream hint, or prefer the smaller .txt even when first is already .txt.
- [x] pnpm-11 JSON pollution trigger identified (refines park 1): it fires ONLY when checkride runs with no outer pnpm process — 'node dist/cli.js' direct makes each inner 'pnpm exec' re-verify deps and print to stdout, so dead/dupes/health fail with exit 0 + 'did not emit valid JSON'; via 'pnpm run check' the outer pnpm already verified and the inner exec stays quiet. Validates D3 (repo-script-preflight): the triage reader runs '<pm> run check', which is the invocation that avoids it.
- [x] co-locate unit tests in per-directory src/**/__tests__/ folders instead of one src/__tests__/ (20 files + import-path rewrites), and decide the enforcement mechanism — ast-grep can only do it via a files-glob rule that matches any statement, so a fallow policy or a custom check may fit better
- [ ] Stop-hook guidance in src/agent-setup/hook.ts still carries the thin procedure ('read .check/summary.json, fix the failing slot') and never names /checkride:check — deferred: changing the command string rewrites .claude/settings.json in every repo on upgrade
- [x] CHANGELOG now carries an '## [Unreleased]' section, but .claude/skills/version/SKILL.md step 8 says to insert the new release section 'above the current top ## [...] section' — which would land the release ABOVE Unreleased and strand it. Teach /version to fold an existing Unreleased section into the new release heading (and drop the empty shell) instead.

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

**2026-07-28 — boundary after step 3.** Four items, all four classified. Three came out
of step 3's dogfood, which is the point of dogfooding: the reader looked correct until a
deliberately-reddened tree disagreed with it.

- **tangent — deferred, not killed.** pnpm 11.1.2 `verifyDepsBeforeRun` prints
  `Already up to date / Done in Xms` to stdout before every `pnpm exec`, so
  `dead`/`dupes`/`health`/`attw` fail with exit 0 and "did not emit valid JSON". Real bug,
  wrong seam — it lives in the adapters, not the plugin, and nothing in this build is
  blocked by it (the gate is green via `pnpm run check`). **Gets its own build, and should
  be the next one: it hits every consumer on pnpm 11.** Real fix is adapters tolerating
  leading non-JSON, or not routing tools through `pnpm exec`; the workaround is
  `--config.verify-deps-before-run=false`.
- **blocker — folded into `intent.md`, already landed as step 4.** `src/triage/render.ts`
  drops the gate's stderr on a red gate with zero failing slots, which is the one branch
  where that stderr is the only evidence there is. It never literally halted the build, so
  the class is the *action*, not the obstruction: the plan was incomplete, and the fix went
  into the plan rather than into step 3's diff. Weight came from traffic, not severity —
  `tsc --build && node dist/cli.js` is the shape `init` writes and a type error is the usual
  way a TS repo goes red, so this branch fires constantly.
- **tangent — split: part absorbed, part deliberately killed.** `src/artifacts/raw.ts:79`
  prefers stdout on the assumption it carries diagnostics, but markdownlint-cli2 inverts
  checkride's stream discipline: `docs.stdout.txt` is progress narration while the *smaller*
  `docs.stderr.txt` holds the `file:line:rule`. The actionable slice — naming each alternate
  candidate with its size instead of a bare `(+N)` — went into step 4. The reader-side fix
  is **killed on purpose**: no reader can know which tools invert the convention without a
  per-adapter table, so that judgment stays in the check skill's prose where step 3 put it.
- **tangent — merged into item 1, closed.** The pnpm-11 trigger condition: the pollution
  fires *only* when checkride runs with no outer pnpm process, because each inner
  `pnpm exec` then re-verifies deps and prints. An annotation on item 1, not an independent
  idea. Its lasting value is that it confirms D3 (repo-script-preflight) — the triage reader
  runs `<pm> run check`, which is exactly the invocation that avoids the bug — and that is
  already recorded in the Verdicts.

No pivot signals. The approach held: the plugin reads what checkride already writes, and
every finding this boundary was about *which bytes the reader points at*, never about
whether reading is the right shape.

**2026-07-28 — boundary after step 5.** One item, classified. It arrived as a review
comment on the step rather than out of a dogfood, which is why it is a convention question
and not a defect.

- **tangent — deferred, not killed.** Co-locate unit tests in per-directory
  `src/**/__tests__/` folders instead of the single `src/__tests__/`, and decide what
  enforces it. Deferred because the 20 affected test files are all unrelated to this
  build's frame and none of steps 6–8 touch test layout, so folding it in would double the
  plugin build's diff with a mechanical sweep that reviews better on its own. Two notes for
  whoever runs it: `fallow.toml`'s entry glob is already `src/**/*.test.ts`, so nested
  `__tests__/` dirs need no registration change; and **ast-grep is the wrong enforcement
  tool** — it matches AST patterns *inside* files and has no concept of a file being in the
  wrong directory, so the only way to express the rule is a `files:`-glob rule whose pattern
  matches any statement, which fires on location while pointing at an arbitrary line.
  fallow's path-aware `policy_violations` (already gated by `dead`) or a config-defined
  custom check are the better fits.

No pivot signals, no blockers. Step 5's own three defects — the relative-cwd `loadConfig`
throw, the tail-drop budget overshoot, the negative age on a future-dated summary — were
all found and fixed inside the step, so none of them reached the park list.

## Log

*(The build's history, oldest first. `plumbbob checkpoint` appends a dated line here
every time a step lands — via `/pb-build` or `/pb-verify` — so this
fills in as you go, not at the end. Add your own decision/event lines too: this is what
you point at to say "I did that — the LLM helped, but those were my calls."
`/pb-finish` reads this for the report; `plumbbob finish` commits it with the build
folder, so it rides the branch into the PR.)*
- 2026-07-25 — step 1 checkpointed · cf4856b17 — feat(plugin): ship a Claude Code plugin manifest from the package root (2 red, 20m)
- 2026-07-25 — step 2 checkpointed · 5850a1685 — feat(check): add a bounded, contract-aware triage preflight reader (1 drift, 26m)
- 2026-07-28 — step 3 checkpointed · 661907892 — feat(check): add the check skill that triages a red gate (5056m)
- 2026-07-28 — step 4 checkpointed · 281d5ff3a — fix(check): route triage to the bytes that explain the failure (1 drift, 13m)
- 2026-07-28 — step 5 checkpointed · 92bf88bc1 — feat(qa): add a bounded extractor for the quality artifacts (1 drift, 29m)
- 2026-07-28 — step 6 checkpointed · 6e303f588 — feat(qa): add the qa skill that reads quality signal (1 drift, 8m)
- 2026-07-28 — step 7 checkpointed · f1498bcb2 — feat(init): point the AGENTS.md stanza at the installed skill (1 drift, 5m)
- 2026-07-28 — step 8 checkpointed · 1f0892de5 — docs(plugin): document the bundled plugin and its two skills (28m)

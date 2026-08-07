<!--
build-log.md — your live ledger for execution. Append constantly; reorganize at
step boundaries. The antidote to "my plan got lost in the noise."

  Steps     : where you are. One step in flight at a time. CLI-maintained: `build`,
              `checkpoint`, and `revert` keep this mirror and the Current step line
              in sync with intent.md — you never hand-edit them.
  Park list : where ideas go so you do not chase them. CAPTURE, never act inline.
  Harvest   : the boundary ritual that keeps you on one branch.
  Log       : the build's history. `plumbbob checkpoint` appends a line per step as it
              lands; feeds the /plumbbob:finish report, which rides the branch into the PR.
-->

# Build log — prose slot: vale writing-style linting

**Current step:** 2 — feat(prose): scaffold a hermetic vale config and house style
**Heavy check:** checkride (set a "check" key in .plumbbob/settings.json to override)

## Steps

*(Mirror of intent.md's Steps, with live status — CLI-maintained, not hand-edited.
`build`/`checkpoint`/`revert` re-render this from intent.md, and set the Current step
line above. Only ONE step is in flight; a step is done only after a checkpoint —
check green + checkpoint taken, via `/plumbbob:verify` or `/plumbbob:build`.)*

- ☑ 1. feat(prose): add the prose slot and vale adapter to the registry
- ☐ 2. feat(prose): scaffold a hermetic vale config and house style
- ☐ 3. feat(prose): fingerprint vale findings into the baseline
- ☐ 4. chore(prose): enable the prose slot on checkride itself
- ☐ 5. docs(prose): document the prose slot and its division of labour with spell

## Park list

> Mid-step, every new problem / idea / "ooh what if" lands HERE, untouched, and you
> go straight back to the step. Acting the instant an idea arrives is the disease.
> Capture is one line (`/plumbbob:park` composes it). Harvest happens only at the boundary.

## Harvest  *(run `/plumbbob:harvest` at each step boundary, after green)*

Classify each parked item as exactly ONE. Naming it before acting is what keeps you
from sprawling across branches.

| Class            | Meaning                                   | Action                          |
|------------------|-------------------------------------------|---------------------------------|
| **blocker**      | Plan was wrong/incomplete; can't proceed  | `/plumbbob:revert`, fold into intent  |
| **tangent**      | A different path, not clearly better      | Defer or kill. Default here.    |
| **pivot signal** | Evidence the whole approach is wrong      | Stop. Replan deliberately.      |

> Reality check: almost everything that *feels* like a pivot is a tangent. Require a
> failed assumption, not a shinier idea, before you pivot.

Harvest results this boundary:

- (none yet)

## Log

*(The build's history, oldest first. `plumbbob checkpoint` appends a dated line here
every time a step lands — via `/plumbbob:build` or `/plumbbob:verify` — so this
fills in as you go, not at the end. Add your own decision/event lines too: this is what
you point at to say "I did that — the LLM helped, but those were my calls."
`/plumbbob:finish` reads this for the report; `plumbbob finish` commits it with the build
folder, so it rides the branch into the PR.)*
- 2026-08-07 — step 1 checkpointed · fc7ee5c55 — feat(prose): add the prose slot and vale adapter to the registry (1 drift, 5m)
- 2026-08-07 — **step 2 finding (was Q11): bare `vale .` does NOT descend into `node_modules/`.**
  Verified against the pinned `@vvago/vale` 3.17.1 binary in a scratch fixture with a *real*
  directory `node_modules/some-pkg/` (real files, no symlinks — the symlink theory was the
  reason to doubt the earlier pnpm-repo observation). Vale skipped it at the root **and**
  nested at `pkgs/app/node_modules/dep/`, so the skip is by directory *name*, at any depth,
  not by content. `.git/` is skipped the same way. A directory renamed `vendor_modules/`
  **was** walked, confirming the name is the trigger; and an explicit path *into*
  `node_modules/` is still linted, so the skip is a walk rule, not a file filter.
  **D10's default `.` stands — not reopened.** The earlier finding is unchanged and still the
  reason this repo overrides `args`: vale reads no `.gitignore` and walks `dist/`,
  `.stryker-tmp/`, `.plumbbob/`, `.claude/`, and `research/` happily.
- 2026-08-07 — step 2 verification, same 3.17.1 binary against the scaffold `--add prose` wrote:
  clean fixture exit 0; planted doubled word exit 1 (`Vale.Repetition`), in `.md` **and** inside
  a `.ts` doc comment (D5's `[formats] ts = js` re-confirmed at this version); all four enabled
  rules fire on one line while `Repo.Weasel` stays silent on a planted `very` (D15). D6's
  premise re-verified here too: a warning-severity rule produced three alerts and **exit 0**,
  and they still appear in the JSON — which is why the scaffold pins `MinAlertLevel = suggestion`
  rather than `error` (raising it hides the advisory half instead of silencing it).
- 2026-08-07 — step 2 rule-set calibration (informational; step 4 owns the tuning). The shipped
  default over this repo's `README.md AGENTS.md CONTRIBUTING.md docs src` finds **112** — down
  from the naive prototype's 373 — split 36 markdown / 76 TS comments: ThereIs 61, Latin 28,
  LyHyphen 21, Repetition 2. False-positive audit: **all 21 LyHyphen hits are true positives**
  (`normally-default`, `fully-observed`, `silently-empty`, …) — vale's RE2 has no lookahead, so
  the non-adverb `-ly` words are handled by an `exceptions:` list, verified to match on whole
  words (`only` does not suppress `commonly-used`). The only false positives in the whole run
  are Repetition's two, on `'A A'`/`'B B'` placeholder identifiers in a test fixture. A separate
  edge fixture (URLs, inline code spans, fenced blocks, exception words) scored **zero** alerts.
- 2026-08-07 — step 2 incidental, corroborates D13 (for step 5's docs): getting a 3.17.1 binary to
  verify against meant `npm install @vvago/vale@3.17.1` in a scratch dir, and `node_modules/.bin/vale`
  **did not exist** afterwards — the binary was only reachable at `node_modules/@vvago/vale/bin/vale`.
  D13's npm bin-shim caveat is not theoretical; it reproduced on the first try.

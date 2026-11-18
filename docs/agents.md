# Working with agents

checkride is an agent harness, so the goal of `init` is that a coding agent
adopts the "exit 0 = done" rule on its own.

## How agents pick it up

`init` writes the contract into two files:

- **`AGENTS.md`** — a stanza, between `<!-- checkride:begin … -->` and
  `<!-- checkride:end -->` markers, stating that `pnpm check` is the definition
  of done (`mise exec -- checkride` in a repo whose `mise.toml` pins
  checkride), how to read `.check/` when it fails, that the check run with
  `--digest` prints a capped excerpt of what failed below its report, the
  module-boundary conventions, and the tight-loop commands.
- **`CLAUDE.md`** — an `@AGENTS.md` import. If you already have a
  `CLAUDE.md`, `init` adds that one line to its end and leaves the rest
  alone, unless it already imports `AGENTS.md`.

Claude Code (and Codex, Cursor, Amp, …) load these instruction files into
context at the start of a session. That is the whole integration: the agent runs
`pnpm check` because it read the instruction, not because checkride hooks into
the tool. It is guidance, not enforcement — the model has to follow it.

The import is what gets the stanza to Claude Code. Claude Code reads `AGENTS.md`
on its own only while the repo has no `CLAUDE.md`, `.claude/CLAUDE.md` or
`CLAUDE.local.md`; once one exists it reads that instead, and a sentence or a
link pointing at `AGENTS.md` leaves opening it to the model. `checkride doctor`
warns when a CLAUDE file keeps the stanza from loading.

`init` rewrites the stanza in place on every run, so keep any edits of your own
*outside* the `checkride:begin`/`checkride:end` markers. That is where
repo-specific additions belong: checkride never touches a line outside them.

It will not silently take an edit from you, though. The begin marker carries a
hash of the stanza checkride generated (`<!-- checkride:begin hash=… -->`), so a
later run can tell its own output from a block someone has since edited. If the
stanza has changed, `init` and `agent-setup` refuse the whole run — writing
nothing, not even the hooks — and say so:

```text
checkride: refusing to overwrite the checkride stanza in AGENTS.md: it has been
edited since checkride wrote it.
  Move your additions outside the markers — checkride never rewrites what is
  outside them — or re-run with --force to discard them and refresh.
```

`--force` accepts the loss and refreshes. A stanza written before checkride
started stamping them (v0.10.0 and earlier) is indistinguishable from an edited
one, so the first run after upgrading refuses too; `--force` once stamps it, and
detection is automatic from then on.

## Make it a hard gate

checkride writes **hooks** into your agent harness's config —
`.claude/settings.json` for Claude Code, `.cursor/hooks.json` for Cursor. By
default that is only `protect`, the guard on the baseline and `.check/`. The
**stop gate** is opt-in. It turns "exit 0 = done" from advice into a mechanical
gate: it fires when the agent tries to finish and refuses to let it, so the
agent keeps working until the pipeline is green. That costs a full pipeline run
at the end of every turn that edited a file. The AGENTS.md stanza already
carries the same rule as instruction, and agents mostly follow it, so whether
the run is worth it is yours to decide.

To opt in:

```bash
pnpm exec checkride hooks add     # every hook: gate, dirty, protect
```

Which harnesses get wired is detected — Claude Code always, Cursor when
`.cursor/` exists — and `--harness <a,b>` overrides that.

`init` writes the default hooks, which is `protect` alone, in new and existing
projects. To add them to a repo you have already set up — without re-running
the full `init` — use:

```bash
pnpm exec checkride agent-setup   # "check" alias + AGENTS.md stanza + protect, nothing else
```

Both commands are idempotent (re-running is a no-op), take `--hook <a,b>` to
choose which hooks to write (`--hook gate,dirty,protect` opts in to the gate),
and opt out entirely with `--no-hook`. Without `--hook` they write `protect`,
plus whatever hooks the repo already has, so a repo that opted in keeps its
gate refreshed on every re-run. Three hooks exist:

- **`gate`** — the hard gate, opt-in. The config entry is a stable one-liner
  invoking a checkride-owned script (`.claude/hooks/checkride-gate.sh`,
  `.cursor/hooks/checkride-gate.sh`); checkride overwrites that script freely
  on refresh, so put customization in a sibling script, never inside it. The
  script is a thin adapter over [`checkride gate`](#the-gate-command), which
  runs the check the way your repo does — your **detected package manager**'s
  `run check` where there's a `package.json`, or `mise exec -- checkride` in a
  repo whose `mise.toml` pins checkride — with `--strict --digest`, and on red
  hands the agent this run's digest (the capped failure excerpt) below its
  instruction, or points it at `.check/summary.json` when the run wrote no
  digest.
- **`dirty`** — opt-in, and only useful alongside the gate. Touches an edit
  marker, `.check/.dirty`. The gate exits 0
  immediately when the marker is absent, so pure-conversation turns don't pay
  for a pipeline run; a green gate clears it. (File writes made through a shell
  don't set the marker — a known, accepted gap; the next tool-edited turn
  re-covers it. If you select `--hook gate` without `dirty`, the generated
  script is unconditional.)
- **`protect`** — written by default. Denies edits to `checkride.baseline.json`
  and `.check/**`, turning "never add to the baseline to make a check pass" into enforcement.
  Reads are never denied; triage depends on them.

Each lands on the nearest thing its harness offers:

| hook | Claude Code | Cursor |
| --- | --- | --- |
| `gate` | `Stop` | `stop` |
| `dirty` | `PostToolUse`, matcher `Edit\|Write\|NotebookEdit` | `afterFileEdit` |
| `protect` | `permissions.deny` rules | `preToolUse`, matcher `Write\|Delete` |

### What lands in your repo

Under Claude Code, one generated file:

```text
.claude/settings.json          the hook entries and the deny rules
.claude/hooks/checkride-gate.sh
```

In a repo without a `package.json`, that script runs `mise exec --
checkride` through the `mise.toml` that pins checkride, which
`init --lang go` or `--lang rust` writes, so mise has to be on the `PATH`
your harness gives its hooks; nothing else lands. `protect` is a pair of
`permissions.deny` rules and `dirty` is an inline command, so neither needs a
script. That is not only tidier — Claude Code
evaluates a deny rule regardless of what a `PreToolUse` hook returns, so
`protect` is now enforced *below* the layer it used to live in, and costs
nothing per tool call instead of spawning Node on every edit:

```json
"permissions": {
  "deny": [
    "Edit(**/checkride.baseline.json)",
    "Edit(**/.check/**)",
    "Edit(**/checkride.*.baseline.json)"
  ]
}
```

checkride appends to that list and removes only its own entries, so rules you
add alongside — a `fallow.baseline`, a lint baseline, anything else that
suppresses findings — survive every refresh. Adding your own is the supported
way to widen what `protect` covers.

Two details worth knowing if you write rules by hand. They must be `Edit(...)`:
Claude Code checks file paths against `Edit` and `Read` rules only, and a
`Write(...)` or `NotebookEdit(...)` path rule is accepted, never consulted, and
warns at startup — it looks like protection and is none. And `Read` deny rules
are deliberately absent here, because triage reads `.check/` artifacts.

Cursor still gets three scripts: its config is hooks and nothing else, with no
documented file-path deny list to move `protect` into.

### What `protect` leaves open

`protect` guards the record of what failed, and not the rules that decide it.
An agent that can't edit the baseline can still turn a check off in
`checkride.config.json`, or loosen a rule in a tool's own config, and the next
run is green.

To put the config out of an agent's reach under Claude Code, add a rule of
your own beside checkride's:

```json
"permissions": {
  "deny": ["Edit(**/checkride.config.json)"]
}
```

The agent's edits to the file are then refused, including one that adopts a
check or adds a custom one, so those are yours to make by hand. Cursor has no
deny list, so the same guard there is a `preToolUse` hook of your own.

A tool's own config is a different trade. An agent edits `tsconfig.json` and
`cspell.json` in ordinary work, and a deny rule on them costs more than it
saves. Catch a loosened rule in review instead, with a `CODEOWNERS` line for
those files. For a check that a pull request switched off, CI can run the pull
request under the base branch's config, which still names the check:
[Comparing the base branch's config with the pull request's](./consumers.md#comparing-the-base-branchs-config-with-the-pull-requests).

### When the gate is too slow

The gate fires on every turn that touched a file, and a full pipeline is minutes
in a large repo. Paid on every edit, that is enough friction that the rational
response is to turn the gate off — which loses the guarantee entirely. A **gate
profile** is the middle: declare what the *turn* gate runs, and keep the full
check binding where it already is (a commit hook, CI).

```json
{
  "gate": { "only": ["types", "lint", "struct"], "changed": true }
}
```

`only`, `skip` and `changed` mean what the run flags mean, and are appended after
the check script's own flags, so the profile wins over anything the script
already carried.

**The gate then says so, in every verdict it produces:**

```text
checkride green in 4.1s ✔ (only types, lint, struct, affected-only)
```

Naming the narrowing is the price of the feature and it is not optional. A gate
that runs three of twenty-one slots and reports a bare `green ✔` has told you the
work is done, which is exactly what it does not know — the vacuous pass this
whole tool exists to prevent, arrived at from the comfortable direction. A
narrowed red likewise points past itself, because fixing what the profile found
may not be enough.

So a profile is a trade, not a free win: use one when something else still runs
the full check before the work lands. If nothing does, leave it unset.

**A narrowed gate never prunes the baseline.** A run that saw part of the
pipeline can't tell a fixed finding from one it didn't look at, so only a full
run ratchets `checkride.baseline.json`. Inside a narrowed agent loop, fixing a
grandfathered finding and then reverting the fix is invisible: the key stays in
the baseline throughout. Pruning waits for a full run somewhere else, a commit
hook or CI, and whoever runs it commits the smaller baseline. A narrowed run
says when a full run would prune something, on stderr:

```text
baseline: not ratcheted, because a run with --changed sees only part of the pipeline; a full run would prune at least 2 grandfathered finding(s) these checks no longer report
```

It counts only the checks that read every file they cover. A check `--changed`
pointed at part of its files, through its `changedArgs` or its narrowed Go
packages, counts nothing, so the number is a floor.

### Running something before the gate

checkride owns the generated hook scripts and overwrites them on every refresh,
so an edit to `.claude/hooks/checkride-gate.sh` is lost on the next
`agent-setup`, and a harness config re-pointed at your own wrapper is rewritten
by the next `hooks add`. `gate.preflight` is the seam that survives both:

```json
{
  "gate": { "preflight": "scripts/checkride-preflight.sh" }
}
```

The path is repo-relative, and the script runs from the repo root **before**
checkride is started — which is what lets it answer for a repo where checkride
*cannot* start, such as one whose dependencies were never installed. Its exit
code is read in the gate's own vocabulary, so there is one meaning per code:

| Exit | What happens |
| --- | --- |
| `0` | The gate runs, as if the preflight were not there. |
| `2` | The turn is **blocked**, with the script's output as the message. |
| anything else | The gate **stands down**, with the script's output as the message. |

Neither non-zero branch starts checkride. A configured path that is not there
blocks, so a typo cannot quietly disarm your gate. Output is folded to one line
and stripped of `"` and `\` on its way into the harness's JSON, so keep the
message to a plain sentence. Because the path is re-read on every write, a
teammate running a bare `checkride hooks add` restores your wiring instead of
clobbering it.

Note that checkride already handles the commonest reason to reach for this — an
uninstalled repo — natively, per [the section above](#make-it-a-hard-gate).
Reach for a preflight when your repo has something of its own to say.

### Turning the gate off

`--hook <a,b>` chooses what to *write*; it does not touch what is already there.
To take an installed hook back out — entry and generated script both — name it
in `--remove-hook`:

```bash
pnpm exec checkride agent-setup --remove-hook gate   # keep the guards, drop the stop gate
pnpm exec checkride hooks add gate,dirty             # and put it back
```

On its own, `--remove-hook` still refreshes everything else (that is what
`agent-setup` is for). Pair it with `--no-hook` to remove and touch nothing
else:

```bash
pnpm exec checkride agent-setup --no-hook --remove-hook gate
```

Dropping the gate leaves the AGENTS.md stanza in place, so the contract survives
as instruction — the agent is still told `pnpm check` is the definition of done,
it is just no longer stopped from ignoring it. Removing `dirty` while keeping
`gate` rewrites the gate script unguarded, so it runs on every turn rather than
skipping conversation-only ones.

### The gate command

The decision — is it dirty, is it green, which artifact should the agent read —
lives in `checkride gate`, so each harness's hook script only has to translate
the verdict. **The two harnesses disagree about how a stop hook says "no", and
the disagreement is total:**

- **Claude Code** blocks on **exit 2** and shows the agent stderr. A plain
  failing `run check` exits `1`, which it treats as a non-blocking error and
  lets the agent stop anyway — so the gate has to translate.
- **Cursor** treats *any* non-zero stop hook as a **broken** hook and ends the
  turn regardless. Its verdict rides in the body instead:
  `{"followup_message": "…"}` on stdout, exit 0. Cursor submits that as the next
  user message.

So `checkride gate --harness cursor` always exits 0 by design. Run it by hand
with `--harness claude` (the default) if you want the exit code.

### Seeing the gate run

A full pipeline takes as long as it takes, and a stop hook that runs one with no
output is indistinguishable from a model that has hung. Two things say otherwise
under Claude Code:

- **While it runs**, the Stop entry carries a `statusMessage`, so the spinner
  reads `` checkride gate — running `pnpm check` `` (or the repo's own check
  command, such as `mise exec -- checkride`) instead of nothing. The entry
  also raises `timeout` to 900s: Claude Code's default is 600, and a cancelled
  Stop hook is a *broken* one, which ends the turn — a pipeline slower than the
  default would stop gating without saying so.
- **When it finishes**, `checkride gate` writes a one-line verdict as the hook's
  `systemMessage`, so the wall clock you just waited on is stated rather than
  guessed at:

  ```text
  checkride green in 38.2s ✔ (15 checks, slowest: test in 21.4s)
  checkride red in 41.7s ✘ (2 of 15 failed: lint, test)
  ```

  The elapsed time is the gate's own wall clock — package-manager startup and
  incremental build included — not the pipeline's `total_duration_ms`, because
  the honest answer to "why did that pause" is the whole pause. The failing-slot
  detail comes from `.check/summary.json`; when there is no readable summary the
  line reports the time and claims nothing else.

**Cursor has neither.** Its hook config has no spinner field, and its `stop`
hook accepts exactly one output field — `followup_message` — which *submits a
new turn*, so it cannot be used to announce a pass. A red Cursor gate carries
the same verdict line at the top of the follow-up it submits; a green one is
silent, and nothing in Cursor's documented hook API can change that today. See
[Cursor](./cursor.md#what-the-gate-can-and-cannot-show-you).

A gate that *could not run at all* answers one question before deciding what to
do: **can this turn fix it?**

If it can — the repo's `package.json` has no `check` script — the gate blocks in
both harnesses, exactly as a red does. The agent has the edit tools, so blocking
is what gets it fixed.

If it cannot — checkride was never installed, mise hasn't installed the copy
`mise.toml` pins or hasn't trusted that file, the hook's Node does not satisfy
the repo's `engines` pin, corepack will not verify the package manager — the gate
**says so and lets the turn end**. Nothing here is silent: Claude Code gets a
`systemMessage` naming the fix (`pnpm install`, or the `CHECKRIDE_NODE_BIN`
lever) and stating that nothing was verified, and Cursor gets the same text on
stderr. This is the one place checkride declines to gate, and it is not a
softening of the vacuous-green rule — it is that rule reaching its limit.
Blocking is how you make an agent fix what it broke; when the cause is a Node the
harness never put on `PATH`, the agent has no lever to pull, and the block just
re-asks it every turn until a contributor removes the gate. A standing gate that
reports "could not run" beats a removed one.

The commonest case by far is a fresh clone, or a branch that newly added
checkride, opened before `<pm> install`. The gate names the package manager and
the fact that checkride is a devDependency, because that is the whole fix. In a
repo whose `mise.toml` pins checkride, it names `mise install`, or `mise trust`
for a `mise.toml` mise hasn't trusted yet.

The generated scripts bound this in one more place. Claude Code's Stop payload
carries `stop_hook_active` and Cursor's a `loop_count`; on the **second**
consecutive could-not-run the script stands down rather than blocking again,
whatever the cause. A red pipeline is never bounded that way — that loop is the
gate working. (`protect` goes the other way and fails open too: a broken protect
hook must not become a repo where nothing can be written.)

Cursor's defaults would undo that in two more places, so the gate entry
overrides both. `loop_limit` defaults to **5** — after five auto-followups the
gate stops replying and a red repo finishes anyway, where Claude Code re-blocks
indefinitely — so checkride writes `loop_limit: null`. And Cursor is fail-*open*
by default: a hook that crashes, times out or emits unparseable JSON lets the
turn end silently, so the gate writes `failClosed: true`. Both are
checkride-owned and restored on the next `agent-setup`; the supported way to
stand the gate down is [`--remove-hook gate`](#turning-the-gate-off), not
editing the entry. The two guards keep the fail-open default on purpose.

One more Cursor-only wrinkle: with third-party configs enabled, Cursor runs your
`.claude/settings.json` hooks *alongside* its own, which would fire two full
pipelines per turn. `checkride gate --harness claude` detects that and stands
down in favour of the native Cursor gate. Details, along with the assumptions
Cursor's docs leave open, are in **[Cursor](./cursor.md)**.

The generated gate reads `stop_hook_active` (Claude Code) and `loop_count`
(Cursor) off the Stop payload and uses them to bound its own could-not-run
verdicts, as above. It does **not** bound a red one: a red gate re-blocking until
the pipeline is green is the gate working, and capping that is how a repo
finishes red.

The gate runs `--strict` because it is a gate: zero checks actually running is
exit 2, never a silent pass ([the contract](./contract.md#vacuous-green) asks
this of anything that gates). The honest trade: in a misconfigured repo the
agent is blocked from stopping until the configuration is fixed — which is the
point of a definition-of-done gate. CI remains the other, branch-protecting
backstop — see [Running checkride in CI](./ci.md).

Repos that adopted an earlier checkride carry the old inline `Stop` and
`PostToolUse` commands in settings.json; the next `agent-setup` (or `init`)
migrates them in place to the script form — each detected by its own sentinel,
replaced, never duplicated.

## Avoiding duplicate runs

In a repo that opted in to the stop gate, the Stop hook and the AGENTS.md stanza
both want `pnpm check`, so the agent can run the full pipeline itself and then
the hook runs it again. Two things head that
off. The `dirty` marker already skips the gate entirely on turns that touched
no files. For turns that did edit, the generated stanza tells the agent that
*if a stop-gate hook is configured* it runs the check when the turn ends — so
iterate with the narrow commands rather than running the full pipeline every
loop. That is the "simplest fix" below, applied by default.

The stanza stops short of calling that run authoritative, because a [gate
profile](#when-the-gate-is-too-slow) can narrow it and the stanza is written
once while the config moves on without it. It sends the agent to the gate's own
verdict instead, which states the profile on every run.

Do **not** delete the AGENTS.md block to dodge the duplicate. The block does two
jobs — it tells the agent to run the gate, *and* it teaches the agent how to read
`.check/summary.json`, what the module conventions are, and which narrow commands
to iterate with. A stop hook only replaces the first job; deleting the whole
block makes every agent worse at *fixing* what the hook flags, and it strands
any harness checkride has no hook writer for.

Whether the duplicate matters depends on your suite — pick by how expensive a run
is:

- **Fast suite (seconds):** accept the duplicate. The second run is cheap and
  guarantees the gate saw the final tree, whatever the agent did.
- **Slow suite (minutes), simplest fix:** rely on the stanza note above — the
  agent runs only cheap, narrowed checks during the loop, and the hook runs the
  pipeline once at the end.
- **Slow suite, most robust fix:** make the hook *verify the artifact instead of
  recomputing*. `.check/summary.json` records every slot that ran and whether it
  passed, so the hook can accept a complete, green summary that is newer than
  your sources and only run `pnpm check` when it is missing or stale. That
  removes the duplicate deterministically — it does not depend on the agent
  choosing not to run — at the cost of a slightly more involved hook.

# Getting started

A practical walk-through for getting checkride running — and for getting back up
to speed if it has been a while. The whole tool reduces to one rule:

> `pnpm check` is the definition of done. **Exit 0 means complete. Anything else
> means it is not.**

## Prerequisites

checkride spawns your project's tools; it does not bundle them. Three things
must exist on your machine *outside* the project:

| Tool | Minimum | Install |
| ---- | ------- | ------- |
| Node | `>=22.18` | <https://nodejs.org> or `nvm install 22 && nvm use 22` (24 works too) |
| a package manager | pnpm `>=9` (default) / npm / yarn / bun | pnpm: `corepack enable && corepack prepare pnpm@latest --activate` |
| git  | any | <https://git-scm.com/downloads> |

The examples in this guide use pnpm's forms; on another manager, substitute
yours (`npx` / `yarn` / `bunx` for `pnpm exec`, and so on) — see
[Package managers](./tools.md#package-managers) for the exact mapping.

Everything else (oxlint, ast-grep, fallow, vitest, …) is a project
`devDependency` and is restored by `pnpm install`. That full list describes a
new-project scaffold; an existing repo has only the tools it already installed —
checkride detects what is present and skips the rest. See
[Tools and installation](./tools.md) for the full list and how to add a missing
one.

Verify the environment at any time:

```bash
pnpm exec checkride doctor
```

`doctor` is read-only. It checks Node/pnpm/git versions, that the project is
installed, and reports every slot's status (installed, opt-in, disabled, or no
tool detected). Exit `0` means you are ready to run.

## Add checkride to a project

`init` auto-detects whether the current directory is a new or existing project
by looking for a `package.json`.

### An existing repository

```bash
pnpm add -D checkride
pnpm exec checkride init
```

`init` is additive here. It inventories the tools you already have, writes only
what is missing (a `checkride.config.json`, a `check` script alias, an AGENTS.md
stanza), and never overwrites an existing tool config. Any adopted check that
fails on the first run is recorded as disabled so the initial `pnpm check` is
green — re-enable each slot as you fix it.

Disabling is the blunt fallback. For a repo with real existing findings, prefer
the **baseline ratchet**:

```bash
pnpm exec checkride init --baseline
```

Instead of writing failing slots off as disabled, this grandfathers today's
findings into a committed `checkride.baseline.json` and keeps the slots
*enabled*: the run stays green while only known findings remain, fails on
anything new, and prunes entries as you fix them — the debt only ratchets down.
(A failing slot whose tool has no fingerprint extractor still falls back to a
disable.) See [README § Baseline](../README.md#baseline) for the full
mechanics.

`init` also makes sure the `.check/` output directory is gitignored — it
appends `.check/` to your `.gitignore`, or creates one. If you adopted with an
older checkride and `.check/` is showing up in `git status`, add the line
yourself: the directory is regenerated on every run and never belongs in
version control.

To scaffold a tool you do not have yet, name its slot with `--add`:

```bash
pnpm exec checkride init --add struct,dead
pnpm add -D @ast-grep/cli fallow
```

`--add` writes the config files (for example `sgconfig.yml` plus
`rules/no-deep-sibling-import.yml`, and `fallow.toml`); the follow-up
`pnpm add -D` installs the tools themselves.

`--add struct` scaffolds the boundary rule only. checkride's other house rules —
no classes, named exports, NodeNext `.js` extensions — are style decisions your
repo has already made, so adopting a check does not hand you three of them to
argue with. They are listed in [deep modules](./deep-modules.md) if you want
them; copy in the ones you agree with.

### A new project

From an empty directory:

```bash
pnpm dlx checkride init --shape flat --name my-app
pnpm install
pnpm check
```

`init` generates a complete, green-out-of-the-box repo. Pick a shape:

- **flat** — a single package using the deep-modules layout under `src/`.
- **monorepo** — a pnpm workspace of `apps/*` and `libs/*`.
- **hybrid** — a root app in `src/` plus internal `packages/*`.

Preview without writing anything using `--dry-run`.

## The daily loop

Once set up, daily usage is one command regardless of the tool's name, because
`init` writes a `check` script alias:

```bash
pnpm check
```

That runs the full pipeline — types, lint, structure, dead code, tests, docs,
links, spelling — cheapest checks first. Exit `0` and you are done.

While iterating, narrow the loop so feedback is fast:

```bash
pnpm check --bail            # stop at the first failing check
pnpm check --only types,lint # run just the named slots
pnpm check --changed         # affected-only (incremental types, changed tests)
```

Run the full `pnpm check` once at the end to confirm green.

## When a check fails

Every run writes machine-readable output to `.check/`. To debug a failure:

1. Read **`.check/summary.json`** — the aggregate report. Find the check whose
   `ok` is `false`.
2. Read that slot's raw output — **`.check/<slot>.json`** (for example
   `.check/lint.json`), or `.check/<slot>.stdout.txt` when the tool's output is
   not JSON.
3. Fix the root cause, not the symptom.
4. Re-run `pnpm check`.

Some failures have a one-shot fix. `checkride fix` runs every active adapter's
fix command (`oxlint --fix`, `markdownlint-cli2 --fix`, and so on):

```bash
pnpm exec checkride fix
```

Never claim a task is finished while `pnpm check` is red.

## Working with agents

checkride is an agent harness, so the goal of `init` is that a coding agent
adopts the "exit 0 = done" rule on its own.

### How agents pick it up

`init` writes the contract into two files:

- **`AGENTS.md`** — a stanza, between `<!-- checkride:begin … -->` and
  `<!-- checkride:end -->` markers, stating that `pnpm check` is the definition
  of done, how to read `.check/` when it fails, the module-boundary conventions,
  and the tight-loop commands.
- **`CLAUDE.md`** — a short pointer to `AGENTS.md` (written only if you do not
  already have one).

Claude Code (and Codex, Cursor, Amp, …) load these instruction files into
context at the start of a session. That is the whole integration: the agent runs
`pnpm check` because it read the instruction, not because checkride hooks into
the tool. It is guidance, not enforcement — the model has to follow it.

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

### Make it a hard gate

To turn "exit 0 = done" from advice into a mechanical gate, checkride writes
**hooks** into your agent harness's config — `.claude/settings.json` for Claude
Code, `.cursor/hooks.json` for Cursor. The load-bearing one is the **stop
gate**: it fires when the agent tries to finish and refuses to let it, so the
agent keeps working until the pipeline is green.

Which harnesses get wired is detected — Claude Code always, Cursor when
`.cursor/` exists — and `--harness <a,b>` overrides that.

`init` writes the hooks automatically (both new and existing projects). To add
them to a repo you have already set up — without re-running the full `init` —
use:

```bash
pnpm exec checkride agent-setup   # "check" alias + AGENTS.md stanza + hooks, nothing else
```

Both commands are idempotent (re-running is a no-op), take `--hook <a,b>` to
select a subset, and opt out entirely with `--no-hook`. Three hooks exist:

- **`gate`** — the hard gate. The config entry is a stable one-liner invoking a
  checkride-owned script (`.claude/hooks/checkride-gate.sh`,
  `.cursor/hooks/checkride-gate.sh`); checkride overwrites that script freely
  on refresh, so put customization in a sibling script, never inside it. The
  script is a thin adapter over [`checkride gate`](#the-gate-command), which
  runs your **detected package manager**'s `run check` with `--strict
  --digest` and on red points the agent at `.check/digest.md` (the capped
  failure excerpt) when it exists, `.check/summary.json` otherwise.
- **`dirty`** — touches an edit marker, `.check/.dirty`. The gate exits 0
  immediately when the marker is absent, so pure-conversation turns don't pay
  for a pipeline run; a green gate clears it. (File writes made through a shell
  don't set the marker — a known, accepted gap; the next tool-edited turn
  re-covers it. If you select `--hook gate` without `dirty`, the generated
  script is unconditional.)
- **`protect`** — denies edits to `checkride.baseline.json` and `.check/**`,
  turning "never add to the baseline to make a check pass" into enforcement.
  Reads are never denied; triage depends on them.

Each lands on the nearest thing its harness offers:

| hook | Claude Code | Cursor |
| --- | --- | --- |
| `gate` | `Stop` | `stop` |
| `dirty` | `PostToolUse`, matcher `Edit\|Write\|NotebookEdit` | `afterFileEdit` |
| `protect` | `permissions.deny` rules | `preToolUse`, matcher `Write\|Delete` |

#### What lands in your repo

Under Claude Code, one generated file:

```text
.claude/settings.json          the hook entries and the deny rules
.claude/hooks/checkride-gate.sh
```

`protect` is a pair of `permissions.deny` rules and `dirty` is an inline
command, so neither needs a script. That is not only tidier — Claude Code
evaluates a deny rule regardless of what a `PreToolUse` hook returns, so
`protect` is now enforced *below* the layer it used to live in, and costs
nothing per tool call instead of spawning Node on every edit:

```json
"permissions": {
  "deny": ["Edit(**/checkride.baseline.json)", "Edit(**/.check/**)"]
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

#### When the gate is too slow

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
checkride ✔ green in 4.1s — gate profile: only types, lint, struct — NOT the full check
```

That clause is the price of the feature and it is not optional. A gate that runs
three of eighteen slots and reports a bare `✔ green` has told you the work is
done, which is exactly what it does not know — the vacuous pass this whole tool
exists to prevent, arrived at from the comfortable direction. A narrowed red
likewise points past itself, because fixing what the profile found may not be
enough.

So a profile is a trade, not a free win: use one when something else still runs
the full check before the work lands. If nothing does, leave it unset.

#### Turning the gate off

`--hook <a,b>` chooses what to *write*; it does not touch what is already there.
To take an installed hook back out — entry and generated script both — name it
in `--remove-hook`:

```bash
pnpm exec checkride agent-setup --remove-hook gate   # keep the guards, drop the stop gate
pnpm exec checkride agent-setup --hook gate          # and put it back
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

#### The gate command

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

#### Seeing the gate run

A full pipeline takes as long as it takes, and a stop hook that runs one with no
output is indistinguishable from a model that has hung. Two things say otherwise
under Claude Code:

- **While it runs**, the Stop entry carries a `statusMessage`, so the spinner
  reads `checkride gate — running \`pnpm check\`` instead of nothing. The entry
  also raises `timeout` to 900s: Claude Code's default is 600, and a cancelled
  Stop hook is a *broken* one, which ends the turn — a pipeline slower than the
  default would stop gating without saying so.
- **When it finishes**, `checkride gate` writes a one-line verdict as the hook's
  `systemMessage`, so the wall clock you just waited on is stated rather than
  guessed at:

  ```text
  checkride ✔ green in 38.2s — 15 checks, slowest test 21.4s
  checkride ✘ red in 41.7s — 2 of 15 failed: lint, test
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

A gate that *could not run at all* — an uninstalled checkride, a broken launcher,
a repo it cannot even enter — blocks in both harnesses rather than passing. A
gate that silently stops gating is the vacuous green this whole tool exists to
prevent. (`protect` goes the other way and fails open: a broken protect hook must
not become a repo where nothing can be written.)

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

Claude Code's Stop-hook input also carries a `stop_hook_active` flag, and
Cursor's carries `loop_count` — check either in a sibling script if you want to
break out of a fix loop that is not converging.

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

### Avoiding duplicate runs

A Stop hook and the AGENTS.md stanza both want `pnpm check`, so the agent can run
the full pipeline itself and then the hook runs it again. Two things head that
off. The `dirty` marker already skips the gate entirely on turns that touched
no files. For turns that did edit, the generated stanza tells the agent that
*if a Stop hook is configured* it owns the final full run — so iterate with the
narrow commands and let the hook run the authoritative pipeline once at the
end. That is the "simplest fix" below, applied by default.

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
  one authoritative pipeline at the end.
- **Slow suite, most robust fix:** make the hook *verify the artifact instead of
  recomputing*. `.check/summary.json` records every slot that ran and whether it
  passed, so the hook can accept a complete, green summary that is newer than
  your sources and only run `pnpm check` when it is missing or stale. That
  removes the duplicate deterministically — it does not depend on the agent
  choosing not to run — at the cost of a slightly more involved hook.

## Uninstalling

There is no lock-in to undo. checkride's whole footprint is: the `checkride`
devDependency, `checkride.config.json`, `checkride.baseline.json` (if you
baselined), the `check` script alias, the AGENTS.md stanza between the
`checkride:begin`/`checkride:end` markers (plus the CLAUDE.md pointer, if
`init` created it), the hook entries in `.claude/settings.json` and
`.cursor/hooks.json` with their `checkride-*` scripts, the
`.cursor/skills/checkride-*` directories, and the gitignored `.check/` output
directory. Remove those and checkride is gone. The
tools keep working untouched — they are ordinary `devDependencies` with their
own config files, so `pnpm exec oxlint`, `pnpm exec vitest run`, and the rest
run exactly as before; you have merely dropped the orchestrator.

## Where to go next

- [Cheat sheet](./cheatsheet.md) — every command and flag at a glance.
- [Tools and installation](./tools.md) — installing a missing tool, slot by slot.
- [README](../README.md) — the slot/adapter model and the `.check/` contract.
- [AGENTS.md](../AGENTS.md) — the contract for coding agents.

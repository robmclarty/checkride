# Cursor

checkride wires Cursor the same way it wires Claude Code: a stop gate, an edit
marker, a baseline guard, and the two reader skills. `checkride agent-setup`
writes all of it.

```bash
pnpm exec checkride agent-setup --harness cursor
```

Without `--harness`, Cursor is included when the repo already has a `.cursor/`
directory, and Claude Code always. That asymmetry is deliberate: seeding
`.cursor/` into every repo checkride touches would put config in front of people
who never asked for it.

What lands:

| path | what it is |
| --- | --- |
| `.cursor/hooks.json` | the three hook entries |
| `.cursor/hooks/checkride-gate.sh` | stop gate — a thin adapter over `checkride gate --harness cursor` |
| `.cursor/hooks/checkride-dirty.sh` | edit marker, so conversation-only turns skip the pipeline |
| `.cursor/hooks/checkride-protect.cjs` | denies edits to the baseline and `.check/` |
| `.cursor/skills/checkride-check/SKILL.md` | `/checkride-check` — triage a red gate |
| `.cursor/skills/checkride-qa/SKILL.md` | `/checkride-qa` — read the quality artifacts |

Commit all of it. These are project files, reviewed and versioned with the repo,
and refreshed in place by the next `agent-setup`.

The rest of this page is the part that is **not** symmetric with Claude Code —
where the two harnesses disagree, where checkride had to choose, and where the
choice rests on something not yet verified against a live Cursor.

## The disagreement that shapes everything: how a stop hook says "no"

Claude Code blocks a turn on **exit 2** and shows the agent stderr. Cursor reads
*any* non-zero stop hook as a **broken** hook and ends the turn anyway; its
verdict has to ride in the body — `{"followup_message": "…"}` on stdout, exit 0
— which Cursor submits as the next user message.

So `checkride gate --harness cursor` **always exits 0 by design**. Run it by
hand with `--harness claude` (the default) if you want an exit code. This is the
one documented exception to checkride's 0/1/2 split; see
[the contract](./contract.md#cli).

The practical consequence: under Cursor the gate does not *block*, it *replies*.
An agent that ignores the follow-up is not stopped by anything mechanical. That
is the ceiling of what Cursor's hook API offers today.

## Three fields checkride sets against Cursor's defaults

Every Cursor default is tuned for hooks that observe. The gate does not observe,
so its entry overrides all three:

```json
{
  "command": "sh \"${CURSOR_PROJECT_DIR:-.}/.cursor/hooks/checkride-gate.sh\"",
  "timeout": 900,
  "loop_limit": null,
  "failClosed": true
}
```

- **`timeout: 900`** — a full pipeline is minutes and the platform default is
  not. Generous on purpose: it exists to break a hang, not to police a slow
  repo, and checkride's own per-check timeouts fire long before it does.
- **`loop_limit: null`** — Cursor caps a stop hook at **five** auto-followups
  per script by default, after which a red repo simply finishes. Claude Code
  re-blocks indefinitely. Leaving the default would make the Cursor gate five
  nudges rather than a gate, so checkride removes the cap.
- **`failClosed: true`** — Cursor's default is fail-*open*: a hook that crashes,
  times out, or emits unparseable JSON lets the turn end silently. For a gate
  that is the vacuous green [the contract](./contract.md#vacuous-green) exists to
  prevent, so the gate opts in to failing closed.

**These three are checkride-owned.** Editing them in `.cursor/hooks.json` gets
them restored on the next `agent-setup`. The supported way to turn the gate off
is to not write it (`--hook dirty,protect`, or `--no-hook` for none of the
three), or to take an installed one back out with `--remove-hook gate` — which
deletes the entry and the script it invoked.

The two guards keep Cursor's fail-open default, deliberately and for the same
reason in both cases: a broken `dirty` hook costs one skipped gate, and a broken
`protect` hook must never become a repo where nothing can be written.

`loop_limit: null` plus `failClosed: true` would mean a genuinely broken gate
could keep a turn from ending forever, so the generated script bounds itself
rather than the config bounding it. Cursor sends a `loop_count` on the stop
payload; on the second consecutive **could not run** the script stands down
instead of blocking again, and a cause nothing in the repo can fix (checkride
never installed, an `engines` pin the hook's Node fails) stands down on the
first.

Neither is silent, and until 0.11.1 that claim rested on stderr — which Cursor
does not document as reaching a user at all. Its only mention is a Hooks output
channel under **Customize**, a panel someone has to go and open, so the party who
could actually run `pnpm install` saw nothing. A stand-down now spends
`followup_message` too, but **exactly once**: that field submits a new turn, so
one sent every turn is the loop being stood down from. `loop_count` is what
rations it, and the guard errs toward quiet — Cursor counts every auto-follow-up
in the conversation rather than the consecutive ones, so an over-count costs a
silent stand-down and never a loop.

checkride's own stand-down needs the same bound and cannot compute it: the stop
payload goes to the hook script, not to the child. So the script exports
`CHECKRIDE_GATE_RETRY` — `0` when the message is still unspent, `1` when it is
not — and checkride emits a followup only on an explicit `0`. **Absence is not
`0`.** A script generated before 0.11.1 exports neither, and keeps the older
stderr-only behavior; that asymmetry is deliberate, and it is what stops a
refreshed checkride from looping under an unrefreshed script. `agent-setup`
rewrites the script, so a refresh closes it.

What stays uncapped is a **red** gate, which is the point of `loop_limit: null`:
a gate that stops re-blocking after five turns is five nudges. The escape hatch
for that one is `--remove-hook gate`, not waiting it out.

## What the gate can and cannot show you

This is the second place the two harnesses are not symmetric, and unlike the
first one it is not a choice checkride made.

A full pipeline run is minutes of silence in the middle of a turn. Claude Code
offers two places to say what is going on, and checkride uses both: a
`statusMessage` on the hook entry (the spinner reads `checkride gate — running
\`pnpm check\`` while it runs) and a `systemMessage` in the hook's JSON body
(a one-line verdict with the wall clock when it finishes, green or red).

**Cursor has neither.**

- Its hook configuration has no spinner or progress field. While the gate runs,
  nothing in the UI says a gate is running.
- Its `stop` hook accepts exactly one output field, `followup_message`, and that
  field **submits a new user turn**. It is the wrong instrument for "everything
  passed, that took 38 seconds": announcing a pass through it would put the
  agent back to work every time it succeeded.

So under Cursor a **red** gate carries the verdict line at the top of the
follow-up it submits — visible in the chat, because Cursor shows the message it
submits — and a **green** gate says nothing at all. The common `user_message`
field is documented for *denials*, not for the `stop` event, and with
`failClosed: true` an output Cursor rejects as malformed is a hook failure that
blocks the turn. Guessing at an undocumented field is not worth that risk, so
checkride does not send one. If Cursor documents a display field for `stop`,
this is the gap to close.

## Cursor also runs your Claude Code hooks

This is the one that surprises people, and checkride works around it.

With **Settings → Rules, Skills, Subagents → "Include third-party Plugins,
Skills, and other configs"** enabled — and it ships **enabled by default**, so
this is the case to assume rather than the exception — Cursor loads hooks from
`.claude/settings.json` too, maps `Stop` onto `stop`, and — the load-bearing
detail — runs **all matching hooks from every source**. A repo wired for both
harnesses (the default, since Claude Code is always selected) would therefore
fire **two full pipelines for a single turn**, concurrently, into one `.check/`
directory that the orchestrator clears per slot before each re-run. Two racing
gates, trampled artifacts, and a race on the edit marker.

checkride resolves it in `checkride gate`: under `--harness claude`, if
`CURSOR_PROJECT_DIR` is set *and* `.cursor/hooks.json` registers a checkride
gate, the Claude-protocol run stands down and lets the native Cursor gate answer
— it is the only one of the two that can speak Cursor's protocol.

The check is deliberately narrow. It defers only when a Cursor gate is actually
*registered*, not merely when Cursor appears to be running, so the failure mode
of a stale environment variable is a duplicate run rather than no gate at all.

There was a stretch where this did not bite — a Cursor bug silently skipped
`.claude/settings.json` hooks entirely, reported against 2.6.11 and fixed in
April 2026. It is loading them again, so the stand-down is load-bearing, not
belt-and-braces.

The same setting governs skills: Cursor reads `.claude/skills/` for
compatibility only when third-party configs are enabled. checkride writes to
`.cursor/skills/` regardless — that is the directory Cursor owns, it needs no
setting, and a repo with no Claude Code setup should not be growing a `.claude/`
tree.

## Where the hooks land

| hook | Claude Code | Cursor |
| --- | --- | --- |
| `gate` | `Stop` | `stop` |
| `dirty` | `PostToolUse`, matcher `Edit\|Write\|NotebookEdit` | `afterFileEdit`, no matcher **+** `afterShellExecution`, matched on the command |
| `protect` | `permissions.deny` rules | `preToolUse`, matcher `Write\|Delete` **+** `beforeShellExecution`, matched on the command |

`protect` is the row where the two harnesses stopped being the same shape.
Claude Code has a declarative file-path deny list, checked below the hook layer,
so checkride writes rules rather than a script. Cursor's config is hooks and
nothing else, so it keeps `.cursor/hooks/checkride-protect.cjs` — with the
best-effort caveat below, which the deny rules do not share.

Two notes on the right-hand column. `afterFileEdit` is purpose-built for "a file
changed", so it needs no matcher and cannot drift when Cursor renames a tool.
And Cursor has no `Edit` tool — `Write` covers both creating and modifying —
while `Delete` can remove an accounting file just as effectively as a write can
overwrite it.

### Why each guard takes a second entry

Cursor cuts the shell out as its own pair of events, and their matchers run
against the **command string** rather than a tool name. That is what makes the
shell reachable at all: a file-tool matcher cannot see
`echo … > checkride.baseline.json`, because that is a shell call and not a
`Write`.

Both entries share their sibling's name and script — one guard, one
`--remove-hook protect`, one `.cjs` that branches on `hook_event_name`. The gate
takes no shell entry; it is not per-call.

The two matchers do very different amounts of work:

- **`protect`** matches `checkride.baseline.json|\.check\b` — every command that
  so much as names an accounting path, *including reads*. The matcher only
  decides what is worth parsing; the script decides what is denied, and it denies
  only on demonstrated write intent (a `>`/`>>` target, or a positional argument
  of `rm`, `mv`, `tee`, `sed -i`, `dd of=` and kin). `cat`, `jq`, `grep` and
  `cp .check/summary.json /tmp/x` all pass, and must: triage reads these files.
- **`dirty`** matches write-shaped commands and its script does no deciding at
  all — the matcher is the whole judgment, since the marker is one `touch`.

This is checkride's standing objection to shell matching answered rather than
abandoned: a guard that fires on a wrong parse is still worse than a known hole,
so the blast radius shrinks from "every command the agent runs" to "commands
that already name an accounting path," and within that set anything unreadable
is allowed. The two biases differ because their costs do — `protect` errs toward
allowing a write, `dirty` errs toward marking a turn dirty, and each is the
recoverable direction for that hook.

## Known gaps and unverified assumptions

Everything below is written against Cursor's published documentation. Where the
documentation is silent, checkride guessed, and the guess is recorded here
rather than buried.

**`protect` may not fire at all, silently.** The script pulls the target path
out of the tool call's `tool_input`, trying `file_path`, `notebook_path`, `path`,
`target_file`, `filePath`, `relative_workspace_path` in turn. Cursor documents
that shape for `Shell` but **not** for `Write` or `Delete`. If the real key is
not in that list the script finds no target, exits 0, and the write proceeds with
no output — `protect` stops protecting and nothing says so. The tests can only
assert the keys checkride *chose*, never the keys Cursor sends, so this is
settled by one live `preToolUse` payload and not by anything in the repo. Until
then, treat `protect` as best-effort under Cursor and the baseline as guarded by
convention.

**The `command` string assumes shell expansion.** checkride writes `sh
"${CURSOR_PROJECT_DIR:-.}/…"` so a clone that lost its exec bits still gates and
a session rooted in a subdirectory still resolves. Cursor documents `command` as
"a shell string, an absolute path, or a relative path", but every documented
example is a bare path, and Cursor states separately that project hooks already
run from the project root. If Cursor spawns these without a shell, the `${…}`
stays literal and the spawn fails — and that is the one failure `failClosed`
cannot catch, because the hook it would guard never started. If you see hooks
that never appear to run, replace the command with the bare relative path
Cursor's docs show and report it.

**Claude Code still does not match its shell tool.** Cursor's half of this gap
is now covered by the `beforeShellExecution` and `afterShellExecution` entries
[above](#why-each-guard-takes-a-second-entry). Claude Code has no equivalent:
`permissions.deny` is a file-path list, so `echo … > checkride.baseline.json`
still walks through, and a `Bash` matcher would mean shipping Claude Code a
generated script it currently does not need. The AGENTS.md stanza covers it as
instruction, and the ratchet prunes the baseline on its own regardless.

**The shell parse is a heuristic, in both directions.** `protect` allows any
command it cannot read as a write, so an exotic spelling — a path built from a
variable, an `eval`, a heredoc — reaches the file. `dirty` decides from its
matcher alone, so a write it does not recognize skips the gate for that turn,
and a command that merely looks write-shaped costs one unnecessary pipeline run.
Neither is a parser for the shell and neither is trying to be; the file tools
remain the covered path, and this is the uncovered one narrowed.

**No progress or completion display.** Covered in full
[above](#what-the-gate-can-and-cannot-show-you): Cursor's hook API offers no
spinner field and no user-visible output field on `stop`, so a green Cursor gate
is silent and a running one is invisible. Claude Code shows both.

**Skill frontmatter carries fields Cursor does not read.** The bundled skills
declare `argument-hint` and `allowed-tools`, which are Claude Code's; Cursor's
documented set is `name`, `description`, `paths`, `disable-model-invocation` and
`metadata`. Unknown fields are ignored, so the skills work — but the tool
restrictions in `allowed-tools` do not apply under Cursor.

## See also

- [Make it a hard gate](./getting-started.md#make-it-a-hard-gate) — the hooks in
  full, for both harnesses.
- [The plugin](./plugin.md#cursor) — why the skills are copied into the repo
  rather than installed.
- [The contract](./contract.md#cli) — `gate` as the documented exception to the
  exit-code split.

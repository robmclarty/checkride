# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.2] - 2026-08-04

### Changed

- **A Cursor stand-down now reaches the user, exactly once.** The promise since
  0.11.0 was that a stand-down is never silent: Claude Code gets a
  `systemMessage`, Cursor gets stderr. Those were never equivalent, and the
  Cursor half does not hold — Cursor documents no channel that shows hook stderr
  to a user, mentioning only a Hooks output panel under **Customize** that
  someone has to go and open. So on the one verdict whose entire purpose is to
  name a fix only a human can apply (`pnpm install`, an `engines` pin), the human
  saw nothing.

  `followup_message` is the field that reaches the chat, and the reason it was
  avoided is real: it *submits a new turn*, so a stand-down spending it every
  turn rebuilds the unbounded loop 0.11.0 removed. It is therefore rationed to
  one. The generated hook script already reads `loop_count` to bound `block`, and
  that same guard now bounds `stand_down` — one nudge naming the fix, silence
  after. The guard errs toward quiet: Cursor's `loop_count` counts every
  auto-follow-up in a conversation rather than the consecutive ones, so an
  over-count costs a silent stand-down and never a loop.

- **`CHECKRIDE_GATE_RETRY`, a new environment variable the generated gate script
  sets.** checkride's own stand-down — a refusal it detects from inside, such as
  an `engines` pin the hook's Node fails — needs the same one-shot bound and
  cannot compute it, because the stop payload reaches the hook script and never
  the child process. The script now exports `0` when the one message is unspent
  and `1` when it is not, and `checkride gate --harness cursor` emits a followup
  only on an explicit `0`.

  **Absence is not `0`.** A hook script generated before this release exports
  neither value and keeps the older stderr-only behavior. That asymmetry is the
  point: it is what stops a refreshed checkride from looping under an
  unrefreshed script, given the `loop_limit: null` the gate's own hook entry
  asks for. Run `checkride agent-setup` to pick up the new script.

  The variable is an internal contract between the two halves checkride
  generates, not a knob — setting it by hand only suppresses or unlocks one
  message.

## [0.11.1] - 2026-08-04

### Fixed

- **The Cursor stop gate no longer writes package-manager noise to the channel
  Cursor parses as protocol.** The two generated gate scripts were asymmetric,
  and accidentally so: the Claude Code script captured the run, so a failed
  launch wrote into a variable it could then decline to print, while the Cursor
  script ran the launcher uncaptured in order to let checkride's own JSON pass
  straight through. A *failed* launch writes to that same stdout, and nothing
  filtered it — so in a repo whose dependencies were never installed, two lines
  of pnpm resolution error landed on stdout while the correct stand-down
  explanation went to stderr.

  The turn still ended as intended, because Cursor does not parse that text as a
  hook body. The reason to fix it anyway is what happens if it ever does: a
  bare-text followup would submit a new turn on every stand-down, rebuilding the
  unbounded loop 0.11.0 removed, and doing it on the one cause an agent can do
  nothing about. It also muddies the gate's own diagnostic — a maintainer
  reading a Cursor transcript sees a dependency-resolution error on the protocol
  channel and a different, correct explanation beside it on stderr.

  Both scripts now capture, and each re-prints that body only on the two exit
  statuses checkride answers with by design. Anything else is the launcher's
  error rather than a verdict, and `block`/`stand_down` own stdout there alone.

### Internal

- The marketing site under `site/` picks up Fathom analytics and Open Graph plus
  Twitter Card metadata across all three pages. The published package is
  unchanged.

## [0.11.0] - 2026-08-04

### Added

- **`gate.preflight` — a supported seam for wrapping the stop gate.** checkride
  owns the generated hook scripts and overwrites them on every refresh, so a repo
  with something to say before the gate had nowhere to say it: editing the script
  lost the edit, and re-pointing the harness config lost it to the next
  `hooks add`. A `"preflight"` under `gate` in checkride.config.json names a
  repo-relative script the generated gate runs, from the repo root, before
  checkride is started — which is what lets it answer for a repo where checkride
  *cannot* start.

  Its exit code is read in the gate's own vocabulary rather than a second
  convention: `0` runs the gate, `2` blocks the turn, anything else stands the
  gate down. Both non-zero branches use the script's output as the message and
  never start checkride. A configured path that does not exist **blocks**, so a
  typo cannot quietly disarm the gate.

  It is a config key rather than a `hooks add --preflight` flag for one reason:
  the path is re-read on every write, so a teammate running the bare command
  restores the wiring instead of silently dropping it. A preflight narrows
  nothing, so it never adds the "NOT the full check" clause to a verdict.

### Contract

- **A could-not-run gate now blocks only when blocking could lead to a fix.**
  Previously every could-not-run verdict blocked, in both harnesses, on the
  reasoning that a gate which stops gating is a vacuous green. That reasoning
  holds only while the block can *cause* the fix, and for a whole class of causes
  it cannot: the harness re-prompts the same agent, which has no lever to pull.
  The observed end of that road is an unbounded retry against an impossible
  remedy, and then a contributor removing the gate.

  Launch refusals are now classified by who can clear them. A **repo** refusal —
  no `check` script, no package.json — blocks exactly as before, because an agent
  holding the edit tools can fix it. (A missing `check` script stays blocking for
  a second reason: it is the one refusal an agent could otherwise *create* to
  escape the gate.) An **environment** refusal — an `engines` pin the hook's Node
  fails, a corepack that will not verify the package manager, a package manager
  absent from `PATH` — stands down: exit 0, no `decision`, `green: false`.

  Two properties are promised about the stand-down and neither may be weakened:
  it is never silent (Claude Code gets a `systemMessage`, Cursor gets stderr,
  both stating that nothing was verified), and it is never reported as green.
  `docs/contract.md` and `test/contract/gate-verdict.contract.test.ts` are
  updated deliberately; a hook script that reads only the exit status will now
  let a turn end on an environment refusal, which is the intended change.

### Changed

- **`init` now pins markdownlint-cli2 0.23.2 for the `docs` slot**, up from
  0.23.1 — the version that resolves a vulnerable `js-yaml`
  (GHSA-pm4m-ph32-ghv5) transitively into every repo it sets up. An existing
  repo keeps whatever it installed; re-run `checkride init` or bump it yourself.

### Fixed

- **An uninstalled repo no longer traps the agent in an unbreakable loop.** A
  developer who pulled a branch that newly added checkride — or cloned fresh —
  and started a session before `<pm> install` got a gate that blocked every turn
  with `checkride gate is not resolvable in this repo. Install checkride (or
  re-run checkride agent-setup)`. Every part of that was a dead end: the
  suggested remedy needs the missing binary, and in a repo with a customized
  AGENTS.md stanza `agent-setup` would refuse and exit 2 even if it could run.
  The actual fix, `<pm> install`, was never named. Nothing bounded the retry.

  The generated gate now distinguishes the two ways checkride can fail to answer.
  Dependencies never installed → it names `<pm> install`, says checkride is a
  devDependency, and stands down. Installed but not answering → it blocks, as
  before, since there is no remedy to name. Yarn PnP is recognized, so a healthy
  PnP repo is not misread as uninstalled.

- **Both generated gates bound every could-not-run cause.** The scripts now read
  the Stop payload from stdin and consult Claude Code's `stop_hook_active` and
  Cursor's `loop_count`. On the second consecutive could-not-run, whatever the
  cause, the gate stands down instead of blocking again — the previous script
  read no stdin at all, so `stop_hook_active` was discarded and
  `"loop_limit": null` left the Cursor gate unbounded by design. A **red**
  pipeline is deliberately still unbounded: that loop is the gate working.

- **The claude gate no longer forwards the launcher's error as a hook body.** On
  a missing install pnpm writes `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` to *stdout*
  — ahead of a stray `undefined` on pnpm 11 — which the script captured into
  `$body` and printed where Claude Code expects JSON. The status is now checked
  before the body is forwarded, so a body travels only when checkride wrote it.

- **A refusal the repo can fix is no longer explained by the hook's Node.** The
  `nodeClause` paragraph rode on every refusal, so "this repo has no `check`
  script" was followed by an account of non-login shells and interpreter
  alignment. It is now attached to environment refusals only.

- **A red run could be reported as "could not run" on Linux.** `isFresh` judged
  the summary this run wrote by comparing its mtime against a `Date.now()`
  reading taken just before the check spawned — and those are not the same
  clock. Linux mtimes come from the kernel's coarse timer-tick clock, so a
  summary written *after* `startedAt` routinely landed a few milliseconds behind
  it: 934 of 2000 writes in a container, and 0 of 2000 on APFS. When it misfired
  the gate read its own summary as a previous run's, believed an `engines`-pin
  marker the check had merely printed, and blamed the environment for broken
  code. `MTIME_TOLERANCE_MS` already guarded the same comparison in `triage/`;
  the gate's own copy had dropped it. This is what turned the Linux CI legs red
  on v0.10.2 and v0.10.3 while both macOS legs stayed green.

- **A green run that skipped most of its slots says so.** `✔ all checks passed`
  is a true sentence about the checks that ran and a misleading one about the
  repo, and the gap was invisible exactly where it matters: a repo configuring
  almost nothing reported the same confident green as one configuring
  everything. The line now reads `✔ all checks passed in 13ms — only 1 of 8
  checks ran, 7 skipped` whenever any slot sat out. `--strict` is unchanged; its
  floor is *zero* checks, which an always-available slot like `links` keeps a
  repo off by itself.

### Internal

- CI dumps a failing slot's captured streams into collapsible log groups and
  keeps `.check/` as an artifact. A red run logged `✘ test` and nothing else,
  and on a hosted runner the directory holding the reason died with the
  workspace — so the Linux-only gate failure above had to be reproduced in a
  container before it could be read at all.

- Dependency audit cleared and mostly retired. Two high advisories were open
  (`fast-uri` GHSA-7p8r-x3mc-p8w7, `brace-expansion` GHSA-rgw5-rvv9-x895), both
  already carrying an override whose range the advisory had since outgrown.
  Re-resolving showed four of the five overrides were dead weight — the parents'
  own ranges reach patched versions — so they were removed rather than widened,
  leaving one. No runtime `dependencies` are declared, so none of this ever
  reached the tarball.

## [0.10.3] - 2026-08-01

### Added

- **Both Cursor guards now cover the shell.** `protect` and `dirty` each take a
  second `.cursor/hooks.json` entry — on `beforeShellExecution` and
  `afterShellExecution` — whose matchers run against the command string rather
  than a tool name. This closes the older of the two documented Cursor gaps:
  `echo … > checkride.baseline.json` is a shell call, not a `Write`, so no
  file-tool matcher could ever see it, and a turn that wrote only through the
  shell used to skip the gate entirely.

  The standing objection was that matching the shell means parsing arbitrary
  command lines, and a guard that fires on a wrong parse is worse than one with
  a known hole. That objection is answered rather than dropped. `protect`'s
  matcher admits only commands already naming an accounting path — reads
  included — and the script then denies solely on demonstrated write intent: a
  `>`/`>>` redirect target, or a positional argument of `rm`, `mv`, `tee`,
  `sed -i`, `dd of=` and kin. Anything it cannot read that way is allowed, so
  `cat`, `jq`, `grep` and `cp .check/summary.json /tmp/x` keep working, as
  triage requires. `dirty` decides from its matcher alone and biases the other
  way, toward marking a turn dirty, because there the recoverable error is one
  extra pipeline run.

  Both entries share their sibling's name and script: one guard, one
  `--remove-hook protect`, one `.cjs` branching on `hook_event_name`. The gate
  takes no shell entry — it is not per-call. Claude Code's half of the gap stays
  open; `permissions.deny` is a file-path list, and a `Bash` matcher there would
  mean shipping a generated script that harness does not currently need.

### Changed

- **The AGENTS.md stanza no longer promises the gate ran everything.** It said
  the stop-gate hook "runs the full `pnpm check`" and told the agent to "let the
  hook run the authoritative pipeline once at the end" — written before gate
  profiles existed, and false in any repo that declares one. The cost of that is
  specific: the stanza is what an agent reads *first*, so it pre-authorized
  reading a profiled `✔ green` as done, and the `NOT the full check` clause
  arrived after the agent had already been told the hook was the last word. The
  disclosure and the contract disagreed, and the contract was the one being read
  in advance.

  The paragraph now sends the reader to the gate's own verdict — "read the
  gate's verdict rather than assuming it covered everything" — and says plainly
  that a narrowed green is not the "done" defined above. It names no profile
  deliberately: a repo can add `gate` to `checkride.config.json` without
  re-running `agent-setup`, so any stanza that spelled out a specific profile
  would drift back into over-promising, while the verdict is generated per run
  and cannot.

## [0.10.2] - 2026-07-31

### Added

- **A gate profile, for repos where the full pipeline is too slow to run every
  turn.** `checkride.config.json` gains a `gate` key — `only`, `skip`, `changed`
  — that applies to the stop-gate run and nothing else:

  ```json
  { "gate": { "only": ["types", "lint", "struct"], "changed": true } }
  ```

  The flags are appended after the check script's own, so the profile wins over
  anything the script already carried. The intended shape is a fast gate per
  turn with the full check still binding at commit or in CI; the gate is not the
  only place "done" can be enforced, and in a large repo it should not be the
  expensive one.

  **Every verdict a profiled gate emits says it was a profile**, in those words:
  `checkride ✔ green in 4.1s — gate profile: only types, lint — NOT the full
  check`. That is the price of the feature and it is deliberately not
  configurable. A gate that runs three of eighteen slots and reports a bare
  green has told the reader the work is done, which is the one thing it does not
  know — the vacuous pass this tool exists to prevent, reached from the
  comfortable direction rather than the alarming one. A narrowed red points past
  itself for the same reason. A profile that narrows nothing is treated as no
  profile, so the warning never appears on a run that was in fact complete.

- **checkride aligns the gate to the repo's Node pin.** Before running the check
  script, if the repo names an exact interpreter (`.nvmrc` or `.node-version`)
  and the running Node does not satisfy it, checkride puts a matching installed
  Node in front of the child's `PATH` — so a hook that arrived on the wrong Node
  runs the pipeline on the right one instead of failing to run it at all.

  Four rules bound it, because choosing the interpreter a repo's whole pipeline
  runs on is not a small thing to do silently: only on an explicit pin file
  (`engines.node` is a *range* — a compatibility declaration, not an instruction
  to switch interpreters — and is read for diagnosis only); only when the running
  Node does not already satisfy it; only an interpreter already installed under a
  known layout (nvm, fnm, nodenv, asdf, volta, n — nothing is downloaded and no
  version manager is invoked, since under a non-login shell `nvm` is a shell
  function and not a binary); and never without a line on stderr saying what it
  aligned to and why.

  `CHECKRIDE_NODE_BIN` is the escape hatch in both directions: a directory to use
  verbatim — the documented wrapping point for a layout checkride does not know —
  or `off` to disable alignment entirely. When alignment cannot help, nothing
  changes and the refusal above names the pin, the Node that ran, and the lever.

- **`doctor` reports the Node a hook would get, not just this shell's.** Every
  other row describes the terminal `doctor` was typed into, which is how it said
  `environment ok` about a repo whose gate could not start — the bug was
  invisible to every read-only command checkride had. The new `node pin` row asks
  the question that *is* answerable from any shell: given the repo's pin, could
  checkride put the right Node back if a hook arrived with the wrong one? It is
  never required, so it flags a risk without failing a repo that works.

- **`checkride hooks add <a,b>` / `checkride hooks remove <a,b>` — hook
  management that never touches AGENTS.md.** `agent-setup` writes four things at
  once (the `check` alias, the stanza, the hooks, the Cursor skills) with the
  stanza guard in front of all of them, so managing a hook inherited the stanza's
  problems: a repo whose AGENTS.md had been edited could not remove a hook *at
  all* — the run refused and, by contract, wrote nothing — and a repo mid-upgrade
  had its stanza rewritten by a command it had asked to touch hooks.

  The new command writes only the harness config entries and the generated
  scripts. It never reads or writes AGENTS.md, so no state of that file can block
  it and no run of it can change that file. `--harness <a,b>` and `--dry-run`
  both apply, and both directions are idempotent. `add` defaults to every hook;
  `remove` requires an explicit list, because a bare command that tore out the
  gate would be the silent un-gating checkride exists to prevent.

  `agent-setup` is unchanged, flags and refusal included.

### Changed

- **checkride generates one file for Claude Code, not four.** `protect` is now a
  pair of `permissions.deny` rules and `dirty` is an inline command, so
  `.claude/hooks/checkride-protect.cjs` and `.claude/hooks/checkride-dirty.sh`
  are gone. Both are deleted automatically on the next `agent-setup`, `init`, or
  `hooks add`.

  `protect` gains more than tidiness from the move. Claude Code evaluates a deny
  rule **regardless of what a `PreToolUse` hook returns**, so the same paths are
  now guarded a layer below the hook that used to guard them — and at no cost
  per tool call, where the script spawned Node on every single edit while
  allowing essentially all of them. The rules are also a list checkride
  *appends* to and removes only its own entries from, so a repo can add its own
  suppression files beside them (a `fallow.baseline`, a lint baseline) and keep
  them across every refresh. The generated script could never offer that: it was
  checkride-owned and overwritten wholesale on every run.

  ```json
  "permissions": {
    "deny": ["Edit(**/checkride.baseline.json)", "Edit(**/.check/**)"]
  }
  ```

  `Edit(...)` is the only correct spelling, and getting it wrong fails silently:
  Claude Code checks file paths against `Edit` and `Read` rules only, and a
  `Write(...)` or `NotebookEdit(...)` path rule is accepted, never consulted, and
  warns at startup. An `Edit` rule covers every file-editing tool. `Read` deny
  rules stay deliberately absent — triage reads `.check/` artifacts.

  Nothing moves in the user-facing surface: `--hook protect`,
  `--remove-hook protect`, and `checkride hooks add|remove protect` all mean what
  they meant. **Cursor is unchanged** and still gets all three scripts; its
  config is hooks and nothing else, with no documented file-path deny list to
  move `protect` into.

- **`checkride hooks` counts files changed, not files deleted.** Removing a hook
  a harness expresses as configuration rewrites the config and deletes nothing,
  and the old wording reported that as `removed 0 file(s)` — a run that did
  exactly what was asked, reading as a no-op. The line now names the hooks and
  counts every file it touched.

- **The AGENTS.md stanza no longer prescribes an architecture.** It carried
  checkride's own house style as if it were law — "Named exports only; no
  classes; `.js` extensions on relative imports", plus the barrel-`index.ts`
  rules — into every repo that ran `init` or `agent-setup`. For a repo that uses
  classes, default exports, or bundler-style extensionless imports, that is a
  contract file instructing the agent to write the wrong code. The stanza is
  also the one region a repo cannot correct: editing it is what makes the next
  refresh refuse.

  The `### Module boundaries` section now names where the rules live instead of
  what they say — the `struct` check runs whatever ast-grep rules `sgconfig.yml`
  points at, and those files are the convention. It is emitted only when
  `struct` is an active check; a repo without it gets no section at all. Delete
  `rules/no-class.yml` and the stanza stays true, which is the property it was
  missing.

  `init` still *scaffolds* those rules as its opinionated default — that part is
  a starter you own and can edit, and is unchanged.

- **`--add struct` scaffolds the boundary rule and stops.** It used to write
  four ast-grep rules, three of which are style, not structure: `no-class`,
  `no-default-export`, and `require-js-extension`. A repo that uses classes,
  default exports, or bundler resolution went red the moment it adopted the
  slot — for code it had always written, over a convention it never chose, which
  reads as checkride being broken rather than as a finding. `--add struct` now
  writes `sgconfig.yml` and `rules/no-deep-sibling-import.yml`: the rule that
  makes `struct` the slot it is, and one whose failures mean what they say.

  New-mode `init` still writes all four. That is a different bargain — it is
  creating the package, so there is no prior decision to override — and the
  other rules are listed in `docs/deep-modules.md` for any repo that wants them.

### Fixed

- **A package manager that refuses to start the check script is no longer
  reported as a red pipeline.** In any repo pinning `engines.node`, pnpm answers
  a Node it does not accept with `ERR_PNPM_UNSUPPORTED_ENGINE` and **exit 1** —
  the same exit code a failing test uses. The gate read that as a verdict on the
  code and said so: `checkride ✘ red in 265ms`, exit 2, turn blocked, every turn,
  regardless of what was written. It then sent the reader to
  `.check/summary.json`, which no run had written, because no check had run.

  That is the vacuous gate inverted — not a silent green but a permanent red no
  code change can clear, whose rational response is to switch the gate off. And
  it is not one repo's problem: agent harnesses run hooks in a **non-login
  shell**, which never sources the rc file a version manager puts its shims in,
  so the hook gets the machine's default Node rather than the contributor's. On
  nvm that is the norm, not the exception.

  `gate` now answers a third verdict — **could not run** — for a launch that
  never happened, naming the cause and saying plainly that nothing ran and no
  artifact describes this turn. It still blocks, in both harnesses: an unrunnable
  gate has never been a pass. `triage` gained the matching `could-not-start`
  verdict, since it runs the same script and had folded the same exit into `red`,
  confirming the gate's wrong answer to whoever came asking why.

  The classification is guarded on both sides. Only pnpm's and npm's own error
  codes are matched — npm's `EBADENGINE` *warning* deliberately is not, because
  npm runs the script anyway unless `engine-strict` is set — and a summary
  written by the current run vetoes the whole thing, so a check that merely
  *printed* one of these strings can never be reclassified into an environment
  problem.

- **Upgrading no longer looks like an edit.** 0.10.1 started stamping the stanza
  so a refresh could tell its own output from a customization — but a stanza
  written *before* the stamp carries no evidence either way, so every upgrading
  repo read as `unstamped`, refused, and by contract wrote **nothing**: not the
  stanza, not the config, not the hooks. That is how 0.10.1's own gate-timeout
  fix failed to reach the repos it was written for. The guard protecting AGENTS.md
  prose was withholding a fix for a gate that had silently stopped gating.

  checkride now recognizes the wordings it actually shipped — four distinct texts
  across v0.1.1–v0.10.0, matched on everything but the generated
  `Active checks in this repo:` line, so a repo's own slot list is irrelevant. A
  pre-stamp stanza that matches one is checkride's own output, refreshes without
  `--force`, and comes back stamped; one that matches nothing has been edited and
  is still refused, with a message that now says so plainly instead of hedging
  about indistinguishable wordings.

  The list is closed and needs no maintenance: every release from 0.10.1 stamps
  what it writes, so no future version can add an unstamped wording.

- **The AGENTS.md stanza is package-manager-agnostic.** It hardcoded `pnpm
  check` and `pnpm exec checkride triage` regardless of the repo's package
  manager, while checkride detects that manager everywhere else and README
  promises the tool is agnostic. The stanza is a list of commands an agent is
  told to run, so in an npm repo it was an instruction that cannot succeed: the
  agent either invents a substitute or reports the pipeline as broken. It now
  renders `npm run check` / `npx --no-install checkride triage`, `yarn run
  check`, or `bun run check` from the detected manager, and `pnpm check` is
  unchanged for pnpm repos.

  The Claude Code gate's `statusMessage` had the same bug from the same source
  and is fixed with it — the spinner said `npm check`, which is not a command,
  and `yarn check` names Yarn 1's integrity checker rather than the repo's
  script.

- **The `spell` check no longer trips over checkride's own stanza hash.** The
  `hash=v1…` marker is 16 hex digits, so sooner or later it spells something
  cspell does not recognize (`…fedf…`) and fails a slot for a string checkride
  itself generated. The shipped `cspell.json` now ignores the marker.

### Contract

- **A gate that could not run answers "could not run", not "red"**
  (docs/contract.md §CLI). The exit codes are unchanged and remain the promise —
  2 while blocked under `--harness claude`, always 0 under `--harness cursor` —
  because an unrunnable gate has always blocked. What is new is that the verdict
  distinguishes a red pipeline from a launch that never happened, so anything
  reading the `systemMessage` / `followup_message` body sees a cause instead of a
  pointer to an artifact this run did not write. Additive: a hook script that
  gates on the exit code alone is unaffected.

- **`checkride.config.json` promises a `gate` key** (docs/contract.md §CLI), and
  with it the disclosure: while a profile is active, every gate verdict names the
  profile and states that it was not the full check.

- **`CHECKRIDE_NODE_BIN`** is promised as the hook author's wrapping point: a
  directory prepended to the check run's `PATH`, or `off` to disable checkride's
  own Node-pin alignment.

- **What a hook *is* belongs to the harness** (docs/contract.md §CLI). The three
  hook names stay promised; whether one lands as a config entry, a permission
  rule, or a generated script is checkride's to choose per harness and may change
  again. What is promised about the Claude Code deny rules is the part a consumer
  builds on: checkride appends its own and removes only those. Anyone scripting
  against the *path* `.claude/hooks/checkride-protect.cjs` should read
  `permissions.deny` instead.

## [0.10.1] - 2026-07-31

### Added

- **`init` and `agent-setup` refuse to overwrite an AGENTS.md stanza that has
  been edited.** Repos routinely need a line or two of their own in the contract
  — a directory the `spell` check is allowed to skip, what a custom check means
  here — and the refresh rewrote the marked region blind, taking those additions
  with it. Idempotent, as promised, and lossy: the second run reported
  `changed: false` precisely because the first one had already discarded the
  edit.

  The begin marker now carries a hash of the body checkride generated
  (`<!-- checkride:begin hash=v1… -->`), so a later run can tell its own output
  from a block someone has since changed. A changed one stops the run: exit 2, a
  message naming the file and the two ways forward, and **nothing written at
  all** — not the config, not the hooks — so a refused run leaves the repo
  exactly as it found it, the rule new-mode `init` already followed for scaffold
  collisions. `--force` accepts the loss and refreshes, and now carries that
  meaning on `agent-setup` too, where the flag previously reached nothing.

  Two things are deliberately *not* edits. Reformatting: line endings and
  trailing whitespace are normalized away before hashing, so a Prettier run over
  AGENTS.md does not read as a customization. And anything outside the markers,
  which stays the right home for repo-specific additions — checkride has never
  rewritten a line out there and still does not.

  One-time cost on upgrade: a stanza written by 0.10.0 or earlier carries no
  hash, and an older version's wording is indistinguishable from an edit, so the
  first run after upgrading refuses with its own wording of the message.
  `--force` once stamps it; detection is automatic from then on.

- **`--remove-hook <a,b>` tears an installed hook back out** — the config entry
  and the generated script both. `--hook` only ever chose what to *write*, so
  there was no supported way to drop the gate after the fact. It pairs with
  `--no-hook` to remove without refreshing anything else, and removing `dirty`
  rewrites a surviving gate unguarded, so the gate cannot silently disarm itself
  on the way out.

- **A `note` field on any check entry, and at the config root**, for commentary
  aimed at whoever reads `checkride.config.json` next. It is validated as a
  string and then dropped — no code path carries it onto an Adapter, so it
  cannot reach the status line or `summary.json`. `description` keeps its
  user-facing role; this repo's own config dogfoods the split.

- **The gate states its verdict in words**, not just an exit code: the wall
  clock and the failing slots, read back from `.check/summary.json` —
  `checkride red in 41.7s, 2 of 15 failed: lint, test`. Under Claude Code it
  rides in the hook body as `systemMessage`, which moves the block onto
  `decision: "block"`, since hook JSON is parsed only on exit 0. `checkride
  gate`'s own exit codes are unchanged: the generated script does the
  translation and falls back to exit-2 blocking when no body comes back, so an
  unrefreshed repo or an older checkride keeps gating either way. Cursor gets
  the same line atop its `followup_message` on red; a green Cursor gate stays
  silent, because its only stop-hook output field submits a new turn, and the
  gap is recorded in docs/cursor.md rather than papered over.

- **The Claude Code Stop entry carries `statusMessage` and `timeout: 900`.** The
  spinner now names the command rather than leaving a multi-minute pipeline
  indistinguishable from a hung model, and the timeout closes a live hole: the
  platform default is 600s, and a hook cancelled by it exits non-zero, which
  Claude Code reads as a broken hook and lets the turn end. Any repo whose
  pipeline crossed ten minutes had a gate that had quietly stopped gating.

### Fixed

- **`triage` no longer reports an unparseable summary as a run with no
  failures.** A repo whose gate is a homegrown script writing a checkride-shaped
  `.check/` — same file names, no `schema_version` — made the reader announce
  "checkride never ran, a compound script short-circuited" about a gate that had
  run all eight of its checks and failed three. An empty slot table now reads as
  "nothing was read", not "nothing failed": the short-circuit verdict is
  reserved for a genuinely absent summary, `covered:` renders `unknown` rather
  than a count nobody measured, a missing `schema_version` becomes its own
  `foreign` state, and a new `.check/ contents` section lists the directory when
  the summary is not an index.

- **The gate ignores a summary older than its own start time.** A check script
  shaped `tsc --build && checkride` leaves `summary.json` untouched when the
  build fails, and trusting it would report the previous run's failing slots as
  this run's.

### Contract

- **checkride owns the AGENTS.md stanza and only the stanza**, and the boundary
  is now enforced rather than documented (docs/contract.md §CLI, locked by
  `test/contract/flags.contract.test.ts`). The promise a consumer can build on:
  a stanza carrying local edits is never overwritten without `--force`, and the
  run that refuses writes nothing. Behavioural break for anyone scripting
  `agent-setup` over a repo with a hand-edited or pre-0.10.1 stanza — that
  invocation exited 0 and now exits 2 until it is re-run with `--force`.

## [0.10.0] - 2026-07-31

### Added

- **Cursor support — hooks and skills.** `init` and `agent-setup` now write the
  same three hooks (`gate`, `dirty`, `protect`) into `.cursor/hooks.json` as
  they do into `.claude/settings.json`, and write the bundled `check` and `qa`
  skills into `.cursor/skills/` as `checkride-check` and `checkride-qa` —
  Cursor has no plugin system to install them from. Which harnesses get wired
  is detected (Claude Code always, Cursor when `.cursor/` exists) and
  overridable with `--harness <a,b>`.

  The gate had to learn a second protocol to get there. Claude Code blocks a
  turn on **exit 2** and reads stderr; Cursor treats any non-zero stop hook as a
  *broken* hook and lets the turn end, so its verdict rides in a
  `{"followup_message": …}` body on stdout instead. Same decision, two wire
  formats.

  Cursor's defaults would have made that gate advisory, so the entry overrides
  three of them: `timeout` (a pipeline is minutes), `loop_limit: null` (the
  default of 5 stops the gate replying after five turns, where Claude Code
  re-blocks indefinitely) and `failClosed: true` (Cursor is fail-open, so a
  crashed or timed-out gate would end the turn silently). The `dirty` and
  `protect` guards keep the fail-open default, deliberately.

- **[Cursor](docs/cursor.md).** A page for the parts that are not symmetric with
  Claude Code — the reply-don't-block stop protocol, the three overridden
  defaults, the third-party-configs setting, and an explicit list of the
  assumptions Cursor's own docs leave open (chiefly: the `tool_input` path key
  `protect` matches on is a guess, and a wrong guess fails open silently).

- **`checkride gate`, `checkride triage`, `checkride qa`.** The gate's body —
  the edit-marker check, the `check` run, the digest-or-summary choice — moved
  out of the generated shell script into a real command, so it is testable and
  every harness's hook script is now a thin adapter over it. `triage` and `qa`
  promote the two bundled plugin readers to first-class commands, so a skill no
  longer needs `${CLAUDE_PLUGIN_ROOT}` (or a hardcoded `node_modules/` path) to
  find them.

### Fixed

- **The gate no longer fails open when checkride cannot run.** An uninstalled
  or unresolvable checkride made the hook exit 1, which Claude Code reads as
  "hook failed, carry on" — leaving a repo whose gate had silently stopped
  gating. Any exit outside the gate's own 0/2 now blocks, naming the cause.
  (`protect` still fails open, deliberately: a broken protect hook must not
  become a repo where nothing can be written.)
- **A repo wired for both harnesses no longer runs two gates per turn.** Cursor
  loads `.claude/settings.json` hooks when third-party configs are enabled, maps
  `Stop` onto `stop`, and runs *every* matching source — so the default wiring
  (Claude Code is always selected) fired two full pipelines concurrently into one
  `.check/`, racing on the artifacts the orchestrator clears per slot and on the
  edit marker. `checkride gate --harness claude` now stands down when Cursor is
  running it and a native Cursor gate is registered. Narrow on purpose: a stale
  `CURSOR_PROJECT_DIR` costs a duplicate run, never the gate.
- **A gate that cannot enter the repo now reports it.** The `cd` guard was a bare
  `exit 2`, which said nothing under Claude Code and — because Cursor reads any
  non-zero stop hook as a broken one — ended the turn silently under Cursor. It
  now emits the same "could not run" verdict as every other way the gate can fail
  to start, in each harness's protocol.
- **`protect` no longer misses paths under a symlinked repo root.** It compared
  the harness's spelling of a path against the environment's, which on macOS
  routinely differ (`/var/…` vs `/private/var/…`), making every in-repo path
  look external — so an edit to `checkride.baseline.json` was allowed through.
  Both sides are now resolved before comparison.

### Contract

- The command set gains `gate`, `triage` and `qa`; `init`/`agent-setup` gain
  `--harness <a,b>`. All additive. `gate` is documented as the one command
  outside the 0/1/2 exit split, because it answers a harness's hook protocol
  rather than checkride's own — see `docs/contract.md` §CLI. Its one documented
  no-op is promised there too: `--harness claude` stands down for a registered
  native Cursor gate.

## [0.9.6] - 2026-07-30

### Fixed

- **A slot refused for a missing tool was reported as a harness problem.** The
  refusal carried `exit_code: -1`, which is reserved for a spawn failure or
  timeout — so `triage` matched it and printed "it failed to spawn or timed out.
  That is a harness problem, not a finding," telling the reader to discount the
  one failure the pre-flight exists to make them act on, remediation and all. It
  now exits **1**, a finding like any other. `-1` keeps meaning the harness
  broke, and a triage test now pins the two apart.
- **A tool installed above the repo root satisfied the pre-flight.** The upward
  search for `node_modules/.bin/<tool>` stopped only at the filesystem root, so
  a stray install in a home or projects directory counted — the same
  machine-state dependence the local resolution was added to remove, reached by
  a different route: the slot passed for whoever had that directory above their
  clone and failed on the clean checkout. The search now stops at the repo root,
  marked by a `.git` or a lockfile, and searches that root before stopping.
- **A timed-out `yarn bin` probe reported the tool as missing.** Under Yarn PnP
  `doctor` folded every probe failure into "not a dependency", so a slow package
  manager produced a confident `missing` and told you to install a tool that was
  already there. A timeout is now `unknown`, with a hint naming it — the
  treatment the `--version` probe alongside it already had.
- **`doctor` reported a healthy Yarn PnP project as broken.** Both of its
  install questions were path tests against a `node_modules/` tree, which a PnP
  project does not have: `install` asserted the directory and so reported
  `lockfile only`, and each slot's tool was looked for at
  `node_modules/.bin/<tool>` and so reported missing — on a repo where every
  tool was installed and every check ran green. The two commands therefore
  contradicted each other, `doctor` calling the environment broken while the
  gate passed. `install` is now satisfied by `.pnp.cjs` plus the lockfile, and a
  tool is resolved with `yarn bin <tool>`, whose exit code carries the answer.
  A tool that genuinely does not resolve still reports missing — the looser
  question must not become a softer one, or this would trade a false red for a
  false green, which is the worse of the two. Detection is gated on yarn so a
  `.pnp.cjs` left by a migration off Yarn cannot reroute an npm or pnpm repo.

## [0.9.5] - 2026-07-30

### Contract

- **A slot's tool is now resolved in the local tree before the check spawns,
  under `npx` and `bunx`.** 0.9.3 stopped those launchers *fetching* a missing
  tool, but `--no-install` bounds the download and not the per-user cache, so
  both still run a copy left behind by some earlier unrelated invocation. The
  gate's verdict therefore depended on machine state nobody declared: a repo
  whose `docs` slot was detected from `.markdownlint-cli2.jsonc` but never
  installed `markdownlint-cli2` passed for every developer holding a cached copy
  and failed on the clean checkout — which is the CI runner, the most expensive
  place to find out. The tool is now looked up at `node_modules/.bin/<tool>`,
  searched from the check's directory upward so a workspace tool hoisted to the
  repo root still counts, and a slot whose tool is absent fails there with a
  message naming the slot, the path searched, and the PM's own install command
  instead of the launcher's `npx canceled due to missing packages`. **Behavior
  change:** a slot passing only because of a cached tool now fails until that
  tool is a declared dependency — the same trade 0.9.3 made, applied to the
  fallback it left open, and it fails on the developer's machine rather than
  only in CI. Scoped to the two launchers that keep such a cache: `pnpm exec`
  and `yarn` resolve from the project tree already and are not pre-flighted,
  which also leaves Yarn PnP — where no `node_modules/.bin` exists to find —
  working as before. See `docs/contract.md` §Vacuous green and `docs/tools.md`
  §Package managers.

### Fixed

- **`doctor` told npm, yarn and bun repos to run `pnpm install`.** The
  remediation hint on a missing-tool row was a hardcoded string, so the one
  actionable line on a red row named a package manager the repo does not use —
  while `checkInstall` two functions above it had been PM-aware all along. It
  now names the detected manager and the exact dev-dependency install.
- **`doctor` reported a hoisted workspace tool as missing.** The probe tested
  `<cwd>/node_modules/.bin/<tool>` and nothing above it, but pnpm and npm both
  hoist a shared tool's bin to the workspace root — so a correctly installed
  monorepo showed a false `missing` for every tool from any package
  subdirectory, on exactly the repos the workspace presets generate. It now
  walks upward like the package managers do, sharing one resolver with the run
  path so the two cannot disagree about where a tool lives.

## [0.9.4] - 2026-07-30

### Fixed

- **Member-scoped fallow findings now key on `<container>.<leaf>` instead of a
  line and column.** fallow reports an unused class/enum/store member as
  `parent_name` + `member_name`, a component binding as `component_name` +
  `prop_name`/`input_name`/`output_name`/`emit_name`/`event_name`, and a catalog
  entry as `catalog_name` + `entry_name` — none of which the extractor
  recognized, so every such finding fell through to the `<path>:<line>:<col>`
  fallback. That key moves whenever code above it does, so editing anything
  earlier in a file re-keyed its grandfathered members and re-surfaced them as
  new findings. They are now line-free
  (`dead-code:unused_class_members:src/a.ts:Svc.unusedOne`) and survive the edit,
  as every other category already did. The same pass gave the report's remaining
  `*_name` categories a stable identity too, so they key on a symbol rather than
  a position as well. **This changes the `dead` slot's fingerprints — re-run
  `checkride baseline` to re-capture, or those findings will report as new
  once.**
- **Report arrays that fallow does not count are no longer fingerprinted.**
  `workspace_diagnostics` carries a `path`, and the opt-in `thin_wrappers` and
  `duplicate_prop_shapes` rules a `file`, so all three produced keys while
  fallow's issue registry marks them `counts_in_total: false`. The extra keys
  pushed the key count past the issue count, where the un-keyable-findings guard
  clamped the difference to zero — so a spurious key could offset a finding that
  genuinely had no stable identity, and the baseline masked a slot green that it
  had never grandfathered. The guard now counts un-keyable findings directly
  rather than inferring them from the totals, which closes that offset even if a
  future fallow adds an uncounted array this version does not know to skip.

## [0.9.3] - 2026-07-29

### Contract

- **An empty slot selection is now a usage error.** `--only`, `--skip` or
  `--include` given a value that names nothing after trimming (`--only ,`,
  `--only ''`, `--only '  '`) exits **2**, naming the flag. It previously
  parsed to an empty list, which is truthy, so `--only ,` filtered every check
  out and exited **0** having verified nothing — the same vacuous green that
  `--only lints` was fixed for in 0.5.0, reached by a different route. The two
  empty spellings also disagreed: `--only ''` ran the whole pipeline. The rule
  now holds for a programmatic caller too — `runChecks({ only: [] })` throws
  rather than selecting nothing. See `docs/contract.md` §CLI and §Exit codes.
- **`summary.json`'s published schema described `total_duration_ms` as a sum.**
  It is, and has been since concurrency landed, the **wall-clock** span of the
  run; the two diverge whenever checks overlap. No behavior changed — the
  description in `schema/checkride.summary.schema.json` was simply wrong, and a
  consumer implementing against it would derive the wrong run-start
  (`timestamp - total_duration_ms`) and read stale artifacts as fresh. The
  semantics are now pinned by a test, not just prose. See `docs/contract.md`
  §`.check/summary.json`.

### Fixed

- **Tools are no longer installed from the registry mid-run under npm or bun.**
  The exec translation emitted a bare `npx <tool>` / `bunx <tool>`, and both
  launchers fetch a missing package and run it rather than failing — checks are
  spawned without a TTY, which is precisely the non-interactive case where
  neither stops to prompt. A repo missing a tool could therefore have its gate
  silently execute an unpinned `latest`. Both now carry `--no-install`, which
  bounds the download but not the launcher's global cache — the guarantee is
  "nothing new is fetched mid-run". **Behavior change:** a tool that would have
  to be downloaded now fails its slot. `pnpm exec` and `yarn` have no such cache
  path and are unchanged.
- **The triage reader's gate timeout could not reap what it started.** It
  spawned without `detached` and sent a bare `SIGTERM` with no escalation, so
  the signal reached the package-manager wrapper and left the checks themselves
  running — which also meant `close` could wait on their inherited pipes
  forever, hanging the reader the timeout existed to protect. It now leads its
  own process group and escalates to `SIGKILL`, the same discipline the
  orchestrator already applied; both share the new `killGroup` helper.
- **`.check/` artifacts are now flushed before the rename that publishes them.**
  The atomic write promised each file was "either the previous complete version
  or the new complete version", but without an `fsync` a crash could leave the
  renamed inode holding nothing — the torn read it exists to prevent, relocated.
- **A committed baseline whose `slots` is an array is rejected instead of being
  keyed by index.** Two of the four copies of the `isRecord` guard accepted
  arrays (`typeof [] === 'object'`); the baseline read was one of them, so such
  a file loaded cleanly and masked nothing. All four now share one definition.
- **A baseline from a newer schema version is dropped rather than half-read.**
  `schema_version` was recorded and never checked. Dropping it fails closed: the
  run reports the diagnostics that are really there, where guessing risks
  masking findings the author never grandfathered.
- **AGENTS.md described a tree the repo does not have.** It named four folder
  modules where there are seven (`artifacts/`, `qa/` and `triage/` were
  missing), and stated a test-placement rule — colocate beside the source file —
  that no test in the repo has ever followed. Both are corrected, and both are
  now checked against the tree.
- **Report columns no longer break on long check names.** Fixed widths were
  sized for catalogue slots, so a config custom check (`typecheck-tests`, or
  `custom:typecheck-tests` in the adapter column) shunted every later column
  right on its own row. `doctor` and the run status lines now size each column
  to the rows it holds.

### Internal

- **This repo's own gate now runs the `security` slot.** `pnpm audit` takes well
  under a second and reports zero advisories at every level, and a package that
  publishes to npm with provenance should be auditing its own dependency tree as
  part of "done" rather than out of band. Note the trade-off: the gate now needs
  the registry to be reachable, and a failure to *verify* is a failure, not a
  pass — so a network outage turns the run red rather than quietly skipping the
  check.
- **The stryker break threshold moves 55 → 68.** The measured score is 73.2%
  (up from 71.7%), so the old gate sat 18 points below reality and could not
  have failed on anything short of deleting a suite. It now sits ~5 points
  under — enough headroom that a mutant timing out on a loaded machine does not
  turn the run red, which is the only reason not to set it tighter. The two
  bundled-plugin bins are excluded from the mutate set: they are three lines
  each, do their work at module top level, and are unreachable from the unit
  runner stryker drives, so they reported a permanent 0% no test could move.
  They are covered as processes by `test/e2e/plugin-readers.e2e.test.ts`.
- Tests for the last uncovered code in the package. The two bundled-plugin
  entry points (`dist/triage/cli.js`, `dist/qa/cli.js`) are exercised as
  processes, which is the only way to reach a bin that works at module top
  level; `checkride fix` gained CLI-dispatch coverage it never had; and the
  three `qa/` extractors gained tests for their truncation caps and
  malformed-input fallbacks — the bounded-reader behavior those modules exist
  for. Branch coverage 84.3% → 85.5%.
- New guards for the claims that drifted: `test/conventions.test.ts` checks
  AGENTS.md's folder-module list and test placement against the tree, and the
  summary contract suite now pins `total_duration_ms` behaviorally — wall-clock
  under concurrency, equal to the summed durations when sequential. Both fail
  when reverted, which is the point.
- `test/e2e/defaults.e2e.test.ts` resolves a fixture repo that has the tool
  configs but **no `checkride.config.json`**, so the shipped catalogue and the
  detection path are exercised. This repo's own config names all twenty slots,
  which is deliberate but meant daily runs never walked a consumer's path.
- First tests for `src/triage/env.ts`, previously the only module in the package
  with no coverage at all.
- Two new single-file modules: `src/proc.ts` (process-group kill and escalation,
  shared by both spawners) and `src/json.ts` (the one `isRecord`).
- Long-form rationale moved out of source comments and into the docs that own
  it: the pnpm stdout-narration investigation to `docs/tools.md` §Launcher
  quirks, and the freshness-window derivation to `docs/plugin.md`. The comments
  keep the "why" and point at the rest.

## [0.9.2] - 2026-07-28

### Changed

- **`checkride init` now writes a newer toolchain into generated projects.**
  The pinned versions a new project receives move to oxlint 1.74.0 (with
  oxlint-tsgolint 0.25.0), fallow 3.9.1, ast-grep 0.45.0, vitest 4.1.10,
  markdownlint-cli2 0.23.1, cspell 10.0.1, prettier 3.9.6, biome 2.5.6, jest
  30.4.2, publint 0.3.22, attw 0.18.5, and `@types/node` 22.20.1. A freshly
  generated project still installs and passes green out of the box. TypeScript
  stays at 6.0.3, and the eslint and knip pins stay on their current majors —
  all three are deliberate holds, now marked as such in the adapter registry.
- **The documented fallow pin is 3.9.1.** The supported floor is unchanged:
  fallow ≥ 3.5, JSON `schema_version` 7. Every release from 3.5.0 through 3.9.1
  emits schema 7 with identical report layouts, so an existing baseline keeps
  masking and no consumer has to move.

### Fixed

- **The bundled `check` skill quoted a markdownlint summary line that no longer
  exists.** Its guidance on reading a failing `docs` slot cited
  `Summary: 1 error(s)`; markdownlint-cli2 0.23 emits `Summary: 1 issue in 1
  file`. The surrounding advice was still right — that tool puts the count on
  stdout and the `file:line:rule` you actually need on stderr — but the quoted
  string sent agents looking for text no run produces.

### Internal

- Development dependencies upgraded across the board, in separate verified
  steps: fallow's report schema and layouts confirmed unchanged, ast-grep's
  rules confirmed to still fire (repo *and* shipped template copies), and
  oxlint's diagnostic text confirmed byte-identical for the baseline fixtures
  it fingerprints.
- Nine new oxlint errors from the 1.61 → 1.74 jump were fixed at the root
  rather than suppressed: two genuinely unnecessary type assertions, and seven
  test helpers hoisted out of the scopes they never captured.
- `pnpm audit` is clean again. The `brace-expansion` override had gone stale as
  its advisory widened, `fast-uri`, `postcss`, and a js-yaml 5.x entry were
  added, and the `markdown-it` and js-yaml 4.x overrides were retired as
  redundant — each verified by removal and re-audit, not by inspection.
- Every GitHub Actions ref is now SHA-pinned with a version comment. `ci.yml`
  alone had floated on mutable major tags, which made the workflow gating every
  merge the one an upstream tag move could reach. CI's pnpm moves to 11.17.0,
  verified to accept the committed lockfile unmodified.

## [0.9.1] - 2026-07-28

### Fixed

- **The `links` check no longer flags example links inside code blocks.** A
  `[text](target)` shown inside a fenced block or inline backticks was resolved
  against disk like any real link, so documentation that demonstrates Markdown
  syntax could only pass by enumerating every example target in
  `checks.links.allowlist`. Fence state is now tracked across the file —
  honoring CommonMark on marker length, tilde fences, and info strings — and
  inline code spans are masked before parsing. Two limits are deliberate and
  tested: 4-space indented blocks are still checked, since indentation is
  ambiguous with list continuation, and code spans straddling a newline stay
  unmatched. The check only became less strict, so a repo passing on 0.9.0
  still passes.

## [0.9.0] - 2026-07-28

### Added

- **A PreToolUse deny hook guards checkride's accounting files.** "Never add
  to the baseline to make a check pass" was README advice that an agent
  editing the file has every local incentive to ignore; it is now
  enforcement. Edits (Edit/Write/NotebookEdit) to `checkride.baseline.json`
  and `.check/**` are blocked with a message explaining the ratchet; reads
  are never denied — the stanza's own triage procedure and both plugin
  skills read `.check/` artifacts. Both paths are unambiguous, so the deny
  is exact; module-boundary rules deliberately stay in ast-grep, where they
  are enforced over parsed code rather than approximated by paths.
- **The gate now skips turns that edited nothing.** A new PostToolUse hook
  (`dirty`) touches `.check/.dirty` on every Edit/Write/NotebookEdit; the gate
  script exits 0 immediately when the marker is absent and clears it after a
  green run. Stop fires at the end of *every* turn, including
  pure-conversation ones — on a real repo that was a multi-second pipeline
  tax (plus formatter writes) for a turn that changed nothing, the single
  best reason to disable the gate. File writes made through Bash don't set
  the marker (a known, accepted gap — matching Bash would fire on every
  command); the next tool-edited turn re-covers it. A `--hook gate`
  selection without `dirty` writes an unconditional script, so the guard can
  never disarm a gate that has no marker source.
- **The generated gate runs `--strict --digest`.** The Stop hook is a gate,
  and the contract says anything that gates should pass `--strict` — now
  checkride's own generated hook does. `--digest` writes the token-bounded
  `.check/digest.md` on red, and the guidance message points there when it
  exists (summary.json otherwise) and names `/checkride:check` for full
  triage. npm repos get the `--` passthrough form; pnpm/yarn/bun forward
  flags directly.

### Changed

- **The Stop-hook gate moved into a checkride-owned script,
  `.claude/hooks/checkride-gate.sh`.** The settings.json entry is now a stable
  one-liner invoking it (`sh "${CLAUDE_PROJECT_DIR:-.}/…"`), so refreshing is
  genuinely lossless: checkride overwrites its script freely, and consumer
  customization has a natural home (a sibling script, or the environment)
  instead of an inline command the next `agent-setup` would clobber. Repos
  carrying the old inline form are migrated in place on the next
  `agent-setup`/`init` — detected by the existing sentinel and replaced, never
  duplicated. `init`/`agent-setup` grow `--hook <a,b>` to select which hooks
  to write (default: all); `--no-hook` remains the write-none escape.

### Fixed

- **The `security` slot now gates at `--audit-level`, not at any advisory.**
  pnpm's JSON mode exits 1 on *any* advisory regardless of `--audit-level`
  (only table mode lets the level gate the exit code — reproduced with a
  single-moderate lockfile: `--json` exits 1, table exits 0), so the slot
  judged by exit code effectively gated at zero advisories of any severity
  rather than the declared `high`. `security` is now a built-in evaluator: it
  runs the audit with `--json`, parses `metadata.vulnerabilities`, and fails
  only on advisories at or above the threshold parsed from the adapter's own
  `--audit-level` arg — so a consumer override keeps meaning what it says,
  and "audit could not run" (registry unreachable, malformed output) stays a
  failure rather than a silent pass. Consumers who dropped `--json` to work
  around this can return to the default args and get the
  `.check/security.json` artifact back (`--json` is appended if an override
  omits it).
- **`pack` no longer fails hard under pnpm older than 10.26.** pnpm only
  learned `pack --dry-run` in 10.26.0; every earlier pnpm — including 10.18.x
  lines consumers actually pin — rejects the flag with
  `Unknown option: 'dry-run'`, and the slot failed on a manager checkride
  has promised since 0.5.0 (reported by a real consumer on 10.18.1). On that
  rejection checkride now falls back to a real pack into a temp destination
  outside the repo (`pnpm pack --json --pack-destination <tmp>` — same
  npm-shaped `files[].path` JSON, verified back to 10.18.1), with lifecycle
  scripts suppressed the same way, and deletes the tarball afterward whether
  the check passes or not. Capability fallback, not version sniffing, so it
  keeps working wherever the flag is missing.
- **The default concurrency no longer collapses to 1 on a 2-core CI runner.**
  `defaultConcurrency` reserved a core to keep the machine responsive — sound
  on a laptop, inapplicable on a hosted runner with no human at it. A
  standard GitHub-hosted runner reports 2 CPUs, so the pool was 1 and a
  wave-scheduled config executed fully sequentially (measured on a real
  consumer: 27.4s wall against 27.4s of summed check time — 1.00x), on
  exactly the machine class the docs say to gate on. With `CI` set (every
  provider sets it) no core is reserved, so that runner now gets a pool of 2.
  The cap of 4, the `--concurrency` override, and `--bail`'s sequential
  behavior are unchanged. How much a 2-wide pool on 2 cores buys depends on
  the mix: checks dominated by process startup and file discovery overlap
  well; two CPU-bound tools may be closer to a wash. It is never slower than
  the serialized pool it replaces, and `order` waves now schedule as
  documented. docs/ci.md explains the runner-size effect and how to read
  `total_duration_ms` against the per-check sum.
- **The AGENTS.md stanza reports the configured gate, not the detected one.**
  `init` and `agent-setup` derived the stanza's "Active checks in this repo"
  line from the adoption inventory, which has detection semantics and never
  reads `checkride.config.json` — so opt-in slots a config entry opts in
  (`format`, `build`, …) and non-catalogue custom checks were silently missing
  from the agent-facing contract while the gate ran them. The stanza now
  derives from the same selection a default run makes (the pattern `doctor`
  already used), so what it names and what `pnpm check` runs agree.

### Internal

- The design record for this release is
  [docs/spec-agent-setup-upgrade.md](./docs/spec-agent-setup-upgrade.md): two
  consumers' reports validated against source, with the measured pnpm version
  boundaries. docs/getting-started.md's hard-gate section was rewritten for
  the three-hook suite.

## [0.8.1] - 2026-07-28

### Fixed

- **A package-manager banner on stdout no longer fails the JSON-reading slots.**
  pnpm verifies dependencies before `exec`/`run` and narrates it on **stdout**
  (`Already up to date`, `Done in Xms using pnpm vN`) whenever no outer pnpm
  process has already done so. That preamble landed ahead of the tool's own
  JSON, so `checkride` invoked directly — `node dist/cli.js`, which is what the
  bundled triage reader and any non-pnpm-wrapped call does — failed `dead`,
  `dupes` and `health` with "fallow did not emit valid JSON" while the tools
  themselves exited 0, and silently cost `lint`, `struct` and `attw` their JSON
  artifacts. The same gate under `pnpm run check` passed, which is what made it
  hard to see. Fixed at both ends: checkride now passes
  `--config.verify-deps-before-run=false` ahead of `exec`/`run` under pnpm (the
  only form that works — `--silent` does not suppress it, and after `exec` pnpm
  reads it as the tool's argument), and every stdout-JSON parse tolerates up to
  ten leading non-JSON lines, because a consumer's launcher is not checkride's
  to pin. The `<slot>.json` artifact is written from the first JSON character
  on, so it parses on its own; nothing inside the tool's output is altered.
- **`summary.json`'s `output_file` no longer names files that were never
  written.** It was copied from the adapter's declaration, so any run where a
  JSON-declaring tool emitted something else — a warning first, a crash, or the
  banner above — left the summary pointing at a `<slot>.json` that did not
  exist while the real bytes sat in `<slot>.stdout.txt` beside it. It is now
  what the run actually wrote, and `null` when that is nothing (including for a
  skipped check, which writes nothing at all). This is the field's documented
  meaning; see [docs/contract.md](./docs/contract.md).

## [0.8.0] - 2026-07-28

### Added

- **A bundled Claude Code plugin, shipped from the package root.** The published
  package now carries `.claude-plugin/plugin.json` and a `skills/` directory, so
  `checkride` installs as a plugin from the same npm tarball you already depend
  on (`/plugin marketplace add robmclarty/agent-tools`, then
  `/plugin install checkride@robmclarty`). It is bundled rather than published
  separately so the readers version in lockstep with the `.check/` contract they
  parse; a test asserts the manifest's version equals `package.json`'s. Nothing
  about the CLI, the exit codes or the `.check/` contract changes, installed or
  not. See [docs/plugin.md](./docs/plugin.md).
- **`/checkride:check` — triage a red gate.** Runs the repo's own `check` script
  (the definition of done, which may carry deliberate `--only`/`--skip`), branches
  on the promised 0/1/2 exit split, and names one root cause plus what it is
  deliberately not reading. It covers the contract corners a hand-read of
  `summary.json` gets wrong — exit 2 versus exit 1, vacuous green, a narrow run's
  green, `baselined` counts, `skipped` slots, `exit_code: -1`, an unexpected
  `schema_version`, stale artifacts, and a red gate whose compound `check` script
  died before checkride ran — then opens exactly one raw file. Artifacts are
  measured, never opened: a green 17-slot run renders in about 2 kB.
- **`/checkride:qa` — read the quality signal.** Folds `mutation.json`,
  `dead.json`, `dupes.json` and `health.json` into a report under 8 kB (2.2 MB of
  mutation data becomes a ranked page), runs nothing at all, and opens with a
  present / stale / not-opted-in ledger naming the command or config entry that
  would produce each missing artifact — three of the four come from opt-in slots,
  so partial data is the normal case.
- **Two dependency-free readers behind those skills**, shipped prebuilt in
  `dist/` so a plugin install needs no build step, and runnable without Claude
  Code: `node node_modules/checkride/dist/triage/cli.js` and
  `node node_modules/checkride/dist/qa/cli.js`, each taking an optional repo
  path. Both use `node:` builtins only. Every artifact read is bounded, dated
  against the run that claims it (an artifact older than the run's start is
  labelled stale with its age, never silently dropped), and resolved by the
  documented `output_file` → `<slot>.json` → `<slot>.stdout.txt`/`.stderr.txt`
  convention, which matters because `output_file` is null for 8 of this repo's
  17 slots — `test` among them.
- **`examples/` — eight runnable projects, each demonstrating one thing.** They
  are standalone packages rather than workspace members, so you `cd` in, install,
  and run one without the rest of the repo: `agent-loop` (what an agent reads
  when the gate is red), `existing-repo-baseline` (adopting checkride on a repo
  that already has findings), `custom-checks` (the escape hatch — a bespoke
  formatter ahead of the built-ins, `detect`-gated checks that stand down),
  `shared-preset` (org-wide policy as one versioned package), `polyglot` (a
  Python repo where the TypeScript built-ins stand down and ast-grep enforces
  boundaries in Python), and `module-boundaries` / `dal-boundaries` /
  `dal-boundaries-declarative` for boundary enforcement — the last expressing a
  data-access policy with fallow zones and ast-grep rules alone, no custom script.
  Each declares the exit code it expects and `test/e2e/examples.e2e.test.ts`
  asserts it on every push, so an example that stops behaving as its README
  claims fails CI.

### Changed

- **The AGENTS.md stanza written by `checkride init` and `checkride agent-setup`
  names `/checkride:check`.** Exactly one added line; the prose procedure is
  unchanged and still works standalone in a repo that never installs the plugin.

### Internal

- `/version` now folds an existing `## [Unreleased]` changelog section into the
  new release heading instead of inserting above it.

## [0.7.0] - 2026-07-22

### Changed

- **checkride is now licensed [Apache-2.0](./LICENSE), previously MIT.** No code
  or API changed; the terms you receive it under did. Apache-2.0 adds an express
  patent grant and, via section 5, makes contributions inbound under the same
  license without a CLA — the reason for the switch, ahead of accepting outside
  contributions. Consumers redistributing checkride should note the section 4
  conditions (include the license, mark modified files); there is deliberately
  no `NOTICE` file, so nothing to propagate. `checkride init --license` still
  defaults to `MIT` for scaffolded projects — that remains the user's choice and
  is unaffected.

### Internal

- `CONTRIBUTING.md` gains a licensing section: how section 5 works, why an
  employer may own contributions written on their time, and DCO sign-off via
  `git commit -s`.

## [0.6.0] - 2026-07-21

### Added

- **`optIn` override to configure a slot without opting it into the default
  run.** A slot entry (both the `{ use }` and custom `{ command }` forms) now
  takes `optIn?: boolean`: `true` configures the slot but keeps it reachable
  only via `--all`/`--include` (so giving `attw` a profile no longer drags
  `attw`/`build`/`pack`/`smoke` into a plain `checkride` run), and `false`
  forces a slot into the default run. Resolution-side only, so selection, the
  vacuous-green warning, and `doctor` all adjust automatically.
- **Config-driven `exclude` and `allowlist` for the built-in `links` check.**
  `exclude` adds directory names to skip on top of the built-in set, and
  `allowlist` takes regex sources whose matching link targets count as valid
  (for generated or illustrative markdown that never resolves on disk).
  Patterns are compiled and validated at config load, so a bad one is a
  friendly exit-2 error rather than a mid-run crash. Both are declared in the
  JSON schema.
- **`profile` shortcut for the `attw` slot.** A `profile` string on the config
  entry appends `--profile <name>` to attw's invocation instead of re-typing
  the full args array (a no-op on other slots; a non-string is a friendly
  config error).

### Changed

- **`publint` and `attw` stand down when their tool isn't installed.** Both
  were always-available and hard-failed an `--all` run with "Command not found"
  on a repo that never installed them; they now gate on their package
  (`publint`, `@arethetypeswrong/cli`) and skip cleanly when absent, matching
  checkride's skip-not-fail principle for opt-in slots. Naming one explicitly
  in config still forces it to run.

### Fixed

- **A single duplicate fingerprint no longer disables baselining for a whole
  fallow slot.** The baseline gate guarded against un-fingerprintable findings by
  comparing the deduplicated key count to the raw issue count, but that
  comparison could not tell a finding that produced *no* key apart from two
  findings that produced the *same* key. One key collision (two `<arrow>`
  functions in a file, or two symbol-less `unused_class_members`) made the slot
  look untracked, so `checkride baseline` followed by `checkride` stayed red
  forever. The gate now tracks an explicit un-keyed count instead, so a collision
  merely coarsens the baseline (grandfathering one finding grandfathers its twin)
  rather than disabling it, while a genuinely un-keyable finding still holds the
  slot red.
- **Colliding fallow fingerprints are now disambiguated.** Anonymous health
  functions (`<arrow>`, `<anonymous>`) and symbol-less dead-code findings
  (`unused_class_members`) append their line and column, so a real sibling
  finding can no longer be masked by a baseline captured for a different one.
  Named functions and symbol-bearing findings keep their line-free keys.

  This changes the fingerprint strings for the `dead` and `health` slots, which
  **invalidates existing `checkride.baseline.json` entries for those slots**.
  Re-run `checkride baseline` to recapture them.

### Internal

- **Cleared all `pnpm audit` advisories** via `pnpm-workspace.yaml` overrides:
  `brace-expansion` (GHSA-3jxr-9vmj-r5cp) and `js-yaml` (GHSA-52cp-r559-cp3m)
  were high, `qs` (GHSA-q8mj-m7cp-5q26) and `markdown-it` (GHSA-6v5v-wf23-fmfq)
  moderate. Each is a transitive **dev** dependency (of stryker and
  markdownlint-cli2), so none reached the published package; each override is
  scoped to its advisory's vulnerable range and capped to the compatible major.
- Docs: added a deep-modules guide and a fleet-presets guide for org-wide
  rollout, reframed swappable module boundaries as the default, dropped the
  "TypeScript-only" framing from the README, homepage, and npm package
  description, clarified the README for first-time readers, and pointed
  `package.json` `homepage` at the GitHub Pages site.

## [0.5.3] - 2026-07-19

### Internal

- **Docs: `docs/ordering-in-practice.md`** — a worked guide to `order`
  scheduling waves, now with a second example where waves encode a *dependency*
  (`build` produces `dist/`; the publish bundle — `publint`, `attw`, `pack`,
  `smoke`, `snippets-dist` — consumes it) rather than just a duration tier.
- Adopt explicit ordering waves in checkride's own `checkride.config.json`, so
  the gate config states its execution plan instead of leaning on adapter
  defaults and pool arithmetic.
- CI: bump `upload-pages-artifact` to v5 and drop the Node 20 pages runtime.
- Expand the `cspell` dictionary with words the docs introduced.

## [0.5.2] - 2026-07-19

### Internal

- Split the release workflow into a gated `publish.yaml` (npm publish with
  provenance, now paused behind a required-reviewer approval on the
  `npm-publish` GitHub Environment) and a separate `release.yaml` (GitHub
  Release from the CHANGELOG), matching the fascicle/plumbbob pattern so the
  npm publish credential and the release-authoring permission never share a
  job.

## [0.5.1] - 2026-07-19

### Added

- **A GitHub Pages marketing site** under `site/` — a homepage pitching the
  elevator case for checkride, a docs hub aggregating the existing
  `docs/*.md` guides into a concise sidebar reference, and a full
  CLI/config/programmatic API reference — plus the GitHub Actions workflow
  that deploys it.
- `docs/why.md` — the case for adopting checkride: what it's selling, the ROI
  against ad-hoc scripts and task runners, and straight answers to the
  objections that come up in an adoption conversation.

## [0.5.0] - 2026-07-19

### Contract

- **The `order` field is now a first-class, promised scheduling surface.** A
  config entry's `order` accepts a **number** — a wave, where distinct wave
  numbers run in ascending order with a barrier between them, checks sharing a
  number run concurrently, and decimals sequence steps within a wave (`1` before
  `1.1`) — or one of `first`, `last`, `middle`, `single`, `any`. It is honored
  on every object-form entry: a slot's `{ use, order }` and a custom check
  alike. `first`/`last` keep their exact historical meaning, pinned by a
  backward-compat contract test. See `docs/contract.md` §"Check ordering and
  concurrency".
- **Two deliberate default-placement changes**, both noted in `docs/contract.md`:
  a config-only custom check with **no** `order` now defaults to `any` (the main
  group) instead of the old implicit `last` — set `"order": "last"` to restore
  the previous placement — and a catalogue-filling custom entry's `order`, which
  earlier releases documented as ignored, is now **honored**. A sequential
  default run is unaffected in verdicts and summary order; the difference is
  visible only under concurrency or beside a numbered wave.
- **New `--concurrency <n>` flag.** Sets the size of the pool that runs a wave's
  checks concurrently (`1` = sequential; the default is a conservative cap
  derived from the CPU count). `--bail` overrides it: the run goes fully
  sequential and a one-line stderr note reports that `--concurrency` was ignored
  (the combination is safe, just slower — not a usage error). Additive to the
  flag contract and contract-tested.
- **`total_duration_ms` is now the run's wall-clock duration.** Under
  concurrency the summary's total is measured wall-to-wall rather than summed
  across checks; the two are identical for any sequential run (including
  `--bail`). The `checks` array stays in deterministic group order — the run's
  scheduling sequence, never completion order. `schema_version` is unchanged.

### Added

- **A publish-ready bundle of four opt-in slots** that take the definition of
  done past static publishing lint (`publint`, `attw`) and out to the shipped
  artifact. Each is a built-in or runs the consumer's own `build`/`tsc`, so
  enabling them adds **zero devDependencies**:
  - **`build`** (wave 10) runs the consumer's `build` script, so the artifact
    checks below inspect fresh output rather than a stale `dist/`. An opted-in
    `build` on a repo with no build script stands down as a skip, never a red
    check.
  - **`pack`** (wave 20) packs the tarball with a dry-run and fails if a required
    file (a resolved `exports`/`main`/`types`/`bin` target, or `README`) is
    missing or a forbidden one (`src/`, tests, `.ts` sources — the
    `dist/**/*.d.ts` declarations excepted) is shipped. npm/pnpm only; yarn/bun
    report **unavailable** until a per-manager adapter lands, like `security`.
  - **`smoke`** (wave 20) imports every `exports` entry of the built package
    through its own resolution map and asserts each declared value export is live
    at runtime — a liveness check, not a type check.
  - **`snippets`** (wave 20 / `any`) type-checks the fenced code blocks tagged
    `<!-- snippet: check -->` in `README.md` and `docs/*.md`. The default
    `snippets` adapter checks against source; a second `snippets-dist` adapter
    checks against the built `.d.ts`. A slot opted in with zero tagged fences is
    a hard error.

  All four are opt-in (`--all`, `--include`, or config), so a default run is
  byte-for-byte unchanged. They **order themselves**: `build` at wave 10 precedes
  `pack`/`smoke`/`snippets`/`publint`/`attw` at wave 20, so `checkride --all`
  builds before it inspects the artifact with no ordering config. `checkride
  init` on a library can scaffold the bundle.

### Changed

- **A dependency can now activate a slot, not just its config file.** Adapters
  whose tool runs correctly with zero config — `oxlint` (lint), `knip` (dead),
  `vitest` (test), `cspell` (spell), and `prettier` (the opt-in format slot) —
  now also activate when the package appears in `dependencies`/`devDependencies`,
  as a backup to the detect-file signal. A repo that installed one of these but
  never wrote its config file gains that check on upgrade; `doctor` names which
  signal matched. This widens the default run for those slots and is a
  deliberate, noted behavior change.
- **Checks now run concurrently within a wave by default.** The orchestrator
  schedules the wave sequence — `first`s, the numeric line ascending (equal
  values through a bounded pool, a barrier between distinct values), `single`s
  exclusively, then `last`s — instead of strictly one-at-a-time cheapest-first.
  `--bail` keeps the sequential fail-fast path. The catalogue ships ordered so
  existing default runs produce the same verdicts and the same summary order as
  before, only faster; `mutation` runs as a `single` (exclusive) because Stryker
  saturates every core and races the real test run's cache.
- **`mutation` now ships uncapped (`timeout: 0`) by default.** A real Stryker run
  legitimately outlives the 600s per-check cap; because `mutation` is opt-in and
  never part of the definition-of-done gate the cap protects, its adapter runs to
  completion instead of tripping a timeout under `checkride --all`. Every other
  slot keeps the safe-by-default cap; override per check or globally with
  `timeout`.

## [0.4.3] - 2026-07-18

### Internal

- Refactored for maintainability: decomposed high-complexity functions across
  the orchestrator, `init`, `doctor`, `config`, and the baseline code into small
  single-purpose helpers, extracted shared option/stanza helpers, and broke
  internal import cycles. No change to runtime behavior or the public API.
- Zeroed the project's grandfathered debt: cleared the `lint`, `dead`, `dupes`,
  and `health` baselines and removed checkride's own `checkride.baseline.json`,
  so the repo passes a full `pnpm check` with no suppressions.
- The repo's own default `pnpm check` now also runs the `dupes` and `health`
  slots. Mutation stays opt-in (`pnpm mutation`): a cold full pass has no warm
  incremental cache in CI and would time out the gate.

## [0.4.2] - 2026-07-18

### Fixed

- **The `dead` (fallow) slot now actually gates.** checkride ran fallow in JSON
  mode, which exits `0` even with findings, so the slot reported ✔ while fallow
  had real issues. checkride now reads fallow's JSON report and derives the
  verdict from the issue count instead of the (unreliable) exit code — so the
  slot fails `pnpm check` on new findings and passes only when clean or fully
  baselined. An **unrecognized fallow report fails loudly** (explicit
  "unsupported schema_version" / "unrecognized kind") rather than passing
  silently.
- **fallow ≥ 3.5 support.** The dead-code parser reads fallow's current
  `schema_version` 7 JSON (2.x emitted schema 4 with an incompatible layout).
  The pinned devDependency moves from `fallow@2.48.0` to `fallow@3.5.0`.

### Added

- **`checkride baseline` now grandfathers fallow findings.** A fingerprint
  extractor keys each fallow finding by kind + file + symbol, so fallow slots
  participate in `checkride.baseline.json` like `lint`/`struct`/`spell` (and
  ratchet the same way). Repos that prefer fallow's native `--save-baseline`
  suppression can still use it — see `docs/tools.md`.
- **New opt-in `dupes` and `health` slots.** fallow's duplication and
  complexity analyses are now first-class checks (`--include dupes,health` or
  `"dupes": "fallow"` in config), each with gating and baselines. They stay
  opt-in so adopting checkride never fails a repo on duplication/complexity it
  never signed up for.

## [0.4.1] - 2026-07-11

### Internal

- Docs refresh: updated the reported mutation score to 69% and bumped the README `$schema` example to v0.4.0.

## [0.4.0] - 2026-07-11

### Contract

- **An unknown slot name is now a usage error.** An unrecognized slot in
  `--only`, `--skip`, or `--include` (e.g. `checkride --only lints`) exits **2**,
  naming the bad slot and the valid set (catalogue slots plus config
  custom-check names). It previously matched nothing and exited **0** — a typo
  could silently disable the gate, the worst vacuous green in a definition-of-done
  check. See `docs/contract.md` §CLI.

### Added

- New-project `checkride init` refuses to overwrite existing files, listing
  every collision, and writes nothing; `--force` overrides. Existing-project
  mode (additive-only) is unchanged.
- Per-command `--help` (`checkride init --help`, etc.); new-project `init` ends
  by printing the next command to run; `checkride baseline` now rejects stray
  flags instead of ignoring them.

### Changed

- `checkride init` scaffolds an exact checkride version (no caret), and the
  README install uses `pnpm add -D -E checkride`, matching the pre-1.0
  exact-pin policy consumers are told to follow.
- Malformed consumer JSON (`.claude/settings.json`, a project `package.json`)
  now produces an error naming the offending file instead of a bare stack trace.

### Fixed

- **Interrupts no longer orphan checks.** Ctrl-C (SIGINT) or SIGTERM on a
  running `checkride` is forwarded to every in-flight check and group-kills its
  whole process tree before exit, then re-raises so the shell still sees the
  conventional signal exit (130/143). Since checks run in detached process
  groups (for the timeout kill), a plain interrupt previously left them running.
- `doctor` distinguishes a version probe that **timed out** from one that
  **could not be parsed** (30s probe), so a slow `pnpm --version` is no longer
  misdiagnosed.
- `checkride init --baseline --dry-run` no longer writes a real
  `checkride.baseline.json` — a dry run now truly writes nothing.
- A timed-out check's whole process group is killed (wrapper-spawned
  grandchildren included), and output is captured with a UTF-8 decoder so a
  multibyte character split across read chunks survives intact.
- `checkride fix` runs under the detected package manager (e.g. `npx` under
  npm), matching the run path instead of assuming pnpm.
- A slot's stale `.check/` artifacts are cleared before it re-runs, so a leaner
  or empty run can't leave the previous run's output behind as authoritative.

### Internal

- Docs pass: README restructure linking all six `docs/` files and splitting the
  existing-repo vs new-project install paths, getting-started/tools sync,
  reconciliation of the "locked by `test/contract/`" claim with real tests, and
  a batch of drift corrections.
- Release automation: tag↔version guard on release, CI concurrency group,
  security-only Dependabot; `publint` and `attw` added as dev checks and
  dogfooded; explicit test timeouts for slow-spawn machines; npm publishing
  switched to Trusted Publishing (OIDC).

## [0.3.0] - 2026-07-10

### Contract

- Three additions to the promised surfaces, each recorded in `docs/contract.md`
  and locked by `test/contract/`: the `summary.json` `checks_run` field, the
  `--strict` flag, and the `DEFAULT_TIMEOUT_SECONDS` export. (Heading added
  retroactively — the full entries are under **Added** below.)

### Added

- **Vacuous-green signal.** `summary.json` gains a top-level `checks_run` count
  of the checks that actually executed, so "green because everything passed" and
  "green because nothing ran" are distinguishable by every consumer: `ok: true`
  with `checks_run: 0` means nothing was verified. A zero-check run now prints a
  loud warning naming why each slot sat out and how to enable it, and the new
  `--strict` flag turns that case into exit 2 (for CI and commit-hook gates; the
  default stays a warned exit 0 so exploring a fresh repo isn't punished).
  `checks_run` is additive — `schema_version` is unchanged.
- **A frozen, tested contract.** `docs/contract.md` declares the surfaces
  consumers may rely on — the exit-code taxonomy, the `summary.json`
  additive-only discipline, the CLI flags, the programmatic exports, and the
  pre-1.0 exact-pin policy — each locked by a new `test/contract/` suite that
  fails the build on drift. The summary shape ships as a published JSON Schema
  (`schema/checkride.summary.schema.json`).
- `DEFAULT_TIMEOUT_SECONDS` is now part of the public programmatic surface.
- New docs: a copy-paste CI guide (`docs/ci.md`), a reliability article
  (`docs/reliability.md`), and `CONTRIBUTING.md` with the release ritual and
  succession path.

### Changed

- **Per-check timeouts are on by default** (600s; override per check or globally,
  `0` to disable). A check that exceeds it is killed (SIGTERM → grace → SIGKILL)
  and recorded as failed with a "timed out" note — a hung tool can no longer
  hang the definition of done. Give long-running slots (`test`, `mutation`, …) a
  higher cap or `0` on large repos.
- Run artifacts (`summary.json`, the raw slot files, the digest, the baseline)
  are written atomically (temp file then rename), so a run interrupted mid-write
  never leaves a consumer a half-written file to parse.

### Fixed

- The supported Node floor is now stated consistently as `>=22.18` across the
  docs; `docs/tools.md` and `docs/getting-started.md` previously claimed `>=24`,
  contradicting `package.json` engines.

### Internal

- CI runs the full suite across macOS and Linux at the Node floor (22.18.0) and
  current (24), and the e2e suite exercises all four package managers
  (pnpm/npm/yarn/bun) plus an interrupted-run case. Releases now publish with npm
  provenance, and the README wears the Stryker mutation score.

## [0.2.1] - 2026-07-08

### Fixed

- Every `checkride init` scaffold shipped a `spell` check that failed out of the
  box: the generated AGENTS.md contract stanza uses the word "baselined", but the
  scaffolded `cspell.json` dictionary didn't include it, so a freshly generated
  project's first `checkride` run exited non-zero.

### Internal

- Added a fast local guard (`generated-spell.test.ts`) that runs cspell against an
  in-process `init` scaffold for each shape, catching this class of drift in
  `pnpm check` instead of only in the slower end-to-end suite.

## [0.2.0] - 2026-07-08

### Added

- **Baseline** — adopt checkride on an existing repo without turning it into a
  cleanup project. `checkride baseline` records current diagnostics into a
  committed `checkride.baseline.json`; a normal run then passes a slot as long as
  only baselined findings remain, fails listing only genuinely new ones, and
  *ratchets* the file smaller as findings are fixed — never larger, and never
  pruned on a partial `--only`/`--skip`/`--changed` run. `checkride init
  --baseline` grandfathers today's debt instead of disabling failing slots.
  Grandfathered counts surface in `.check/summary.json` as an additive
  `baselined` field.
- **Package-manager-agnostic runs** — checkride detects pnpm, npm, yarn, or bun
  (from the lockfile or the `packageManager` field) and translates each tool
  invocation accordingly; the default pnpm behavior is byte-identical to before.
  `doctor` reports the detected manager. The `security` audit stays pnpm-only
  until per-manager adapters land.
- **`checkride agent-setup`** plus an `init` Stop hook — both write an idempotent
  Claude Code Stop hook to `.claude/settings.json` that runs the gate on the
  *detected* package manager and blocks a stop while checks are red. `agent-setup`
  also (re)writes the AGENTS.md contract stanza for a repo set up without a full
  `init`. Both are opt-out with `--no-hook`.
- **`format` slot** (opt-in) — a blessed `prettier` adapter (with `biome` as an
  alternate) that runs before `lint` and is wired into `checkride fix`. Excluded
  from the default run so upgrading never turns a repo red; `init` can enable it
  for greenfield projects. The `order: "first"` custom-check hatch still works for
  bespoke formatters.
- **`publint` and `attw` slots** (opt-in) — library-publishing checks that make
  "the published package is correct" part of the definition of done: `publint`
  lints the `package.json` publishing surface, `attw` verifies types resolve
  across module systems. Detect-gated so apps that never publish don't run them.
- **Config presets via `extends`** — `checkride.config.json` accepts `"extends":
  "<package-or-path>"` (string or array) to inherit a shared base; local keys win,
  and a missing or circular extend fails with a friendly message.
- **`--digest`** — writes a token-bounded Markdown excerpt of the failing slots to
  `.check/digest.md`, each section pointing at the authoritative raw output, so
  agents spend less context triaging failures on large repos. Absent on a green
  run.
- **Custom-check `detect` field** — a custom check can declare `detect:
  ["<file>"]` so a shared preset skips it when the file is absent and activates it
  when present, keeping one config safe across heterogeneous repos.
- **Published JSON Schema** — `schema/checkride.config.schema.json` describes the
  full config surface and ships in the package; `init` writes a version-pinned
  `$schema` pointer into generated configs for editor validation.

## [0.1.6] - 2026-06-30

### Added

- Custom checks (config entries keyed by a name outside the built-in slot
  catalogue) accept an `order` field: `"order": "first"` runs the check ahead
  of every built-in, `"last"` (the default) keeps it after them. Lets a
  formatter such as `biome format --write` normalize the tree before the
  linters and tests run. Within each group, config key order is preserved.

## [0.1.5] - 2026-06-30

### Added

- `checkride --help` / `-h` and `checkride --version` / `-V`.
- Optional per-check timeout, off by default: set a global `timeout` (seconds)
  in `checkride.config.json` or override it per check; `0` exempts a slot. A hung
  check is killed and reported as failed with its elapsed duration.

### Changed

- Supported Node floor lowered to 22.18 (the minimum required by the cspell and
  oxlint toolchain). `init` and `doctor` reflect it, and CI now runs a Node
  22 + 24 matrix.
- Unknown commands and bad flags print a concise message plus a `checkride
  --help` pointer; a malformed `checkride.config.json` now reports `invalid
  checkride.config.json: <reason>` instead of a raw parser error.
- `prepublishOnly` runs the test suite before publishing, not just the build.

### Internal

- `package.json` gains `repository`, `homepage`, and `bugs` for the npm page.
- README and cheat sheet document the stderr/stdout stream split; README gains a
  header image.

## [0.1.4] - 2026-06-26

### Added

- Onboarding and reference documentation under `docs/`: a getting-started guide,
  a command and flag cheat sheet, and a tool-installation reference (system
  prerequisites plus how to install a missing slot tool such as fallow or
  ast-grep). Includes a "Working with agents" section covering how Claude Code
  and other agents adopt the `pnpm check` contract via the AGENTS.md stanza, and
  how to enforce it with a Stop hook without double-running the pipeline.

### Internal

- Removed the v1 build plan now that it is fully implemented.

## [0.1.3] - 2026-06-17

### Changed

- `checkride doctor` now reports every catalogue slot with its enablement —
  `default`, `opt-in`, `disabled`, or `unavailable` — instead of listing only
  the slots the default run executes. Opt-in slots (mutation, security),
  config-disabled slots, and slots with no detected tool are no longer silently
  omitted; each shows how to enable it. Exit-code behavior is unchanged: only
  default slots are required, so the newly surfaced slots never fail the report.

## [0.1.2] - 2026-06-12

### Fixed

- The CLI now runs when invoked through its installed bin — `pnpm exec
  checkride`, `npx checkride`, and the generated `pnpm check` alias. The 0.1.1
  entrypoint guard compared unresolved paths, so launching via the
  `node_modules/.bin/checkride` symlink (how every consumer runs it) silently
  exited 0 without running any checks.

### Internal

- Added an end-to-end regression test that invokes the CLI through a bin
  symlink and asserts it behaves identically to a direct invocation.
- Bumped the CI GitHub Actions to their node24-runtime majors
  (`actions/checkout`, `actions/setup-node`, `pnpm/action-setup`), clearing the
  Node 20 deprecation warning.

## [0.1.1] - 2026-06-12

### Added

- `checkride init` for existing projects gained `--add <slots>`: it scaffolds
  blessed-default configs for the named empty slots (lint, spell, struct, test,
  docs, types, dead) and adopts them in the same run, never clobbering an
  existing config.
- `checkride init` for existing projects now writes the `check: checkride` alias
  to `package.json` when it is missing — additive, and never overwriting an
  existing `check` script.

### Internal

- Flattened checkride's own source to named single-file modules with a
  logic-free barrel `index.ts`, relocated unit tests to `src/__tests__/`, and
  added a `no-logic-in-barrel` structural rule. The deep-modules folder pattern
  still ships to consumers unchanged.
- Added Stryker mutation testing, strengthened weak tests, and gitignored the
  regenerated `stryker.incremental.json` cache.
- Added a GitHub Actions workflow running `pnpm check` plus the e2e suite.
- Added a `/version` release skill for cutting tagged releases.
- Reconciled the module-boundary documentation with the flat source layout.

## [0.1.0] - 2026-06-11

The first real release. (`0.0.0` was a name-claim placeholder.)

### Added

- `checkride` run command: the verification pipeline across ten slots (types,
  lint, struct, dead, test, docs, links, spell, plus opt-in mutation and
  security), writing raw per-tool output and an aggregate `.check/summary.json`
  (`schema_version: 1`).
- Adapter registry with blessed defaults (`tsc`, `oxlint`, `ast-grep`,
  `fallow`, `vitest`, `markdownlint-cli2`, built-in links, `cspell`, `stryker`,
  `pnpm audit`) and wired alternates (`biome`, `eslint`, `knip`, `jest`).
- Zero-config detection plus `checkride.config.json` for overrides, disabled
  slots, adapter swaps, and custom checks.
- `checkride init` for new projects (flat / monorepo / hybrid shapes, each green
  out of the box) and existing projects (additive adoption, idempotent AGENTS.md
  stanza, failing slots disabled with a report).
- `checkride doctor` (read-only environment + tooling verification) and
  `checkride fix` (runs every active adapter's fix command).
- Flags: `--only`, `--skip`, `--bail`, `--json`, `--changed`, `--all`,
  `--include`.

[0.11.2]: https://www.npmjs.com/package/checkride/v/0.11.2
[0.11.1]: https://www.npmjs.com/package/checkride/v/0.11.1
[0.11.0]: https://www.npmjs.com/package/checkride/v/0.11.0
[0.10.3]: https://www.npmjs.com/package/checkride/v/0.10.3
[0.10.2]: https://www.npmjs.com/package/checkride/v/0.10.2
[0.10.1]: https://www.npmjs.com/package/checkride/v/0.10.1
[0.10.0]: https://www.npmjs.com/package/checkride/v/0.10.0
[0.9.6]: https://www.npmjs.com/package/checkride/v/0.9.6
[0.9.5]: https://www.npmjs.com/package/checkride/v/0.9.5
[0.9.4]: https://www.npmjs.com/package/checkride/v/0.9.4
[0.9.3]: https://www.npmjs.com/package/checkride/v/0.9.3
[0.9.2]: https://www.npmjs.com/package/checkride/v/0.9.2
[0.9.1]: https://www.npmjs.com/package/checkride/v/0.9.1
[0.9.0]: https://www.npmjs.com/package/checkride/v/0.9.0
[0.8.1]: https://www.npmjs.com/package/checkride/v/0.8.1
[0.8.0]: https://www.npmjs.com/package/checkride/v/0.8.0
[0.7.0]: https://www.npmjs.com/package/checkride/v/0.7.0
[0.6.0]: https://www.npmjs.com/package/checkride/v/0.6.0
[0.5.3]: https://www.npmjs.com/package/checkride/v/0.5.3
[0.5.2]: https://www.npmjs.com/package/checkride/v/0.5.2
[0.5.1]: https://www.npmjs.com/package/checkride/v/0.5.1
[0.5.0]: https://www.npmjs.com/package/checkride/v/0.5.0
[0.4.3]: https://www.npmjs.com/package/checkride/v/0.4.3
[0.4.2]: https://www.npmjs.com/package/checkride/v/0.4.2
[0.4.1]: https://www.npmjs.com/package/checkride/v/0.4.1
[0.4.0]: https://www.npmjs.com/package/checkride/v/0.4.0
[0.3.0]: https://www.npmjs.com/package/checkride/v/0.3.0
[0.2.1]: https://www.npmjs.com/package/checkride/v/0.2.1
[0.2.0]: https://www.npmjs.com/package/checkride/v/0.2.0
[0.1.6]: https://www.npmjs.com/package/checkride/v/0.1.6
[0.1.5]: https://www.npmjs.com/package/checkride/v/0.1.5
[0.1.4]: https://www.npmjs.com/package/checkride/v/0.1.4
[0.1.3]: https://www.npmjs.com/package/checkride/v/0.1.3
[0.1.2]: https://www.npmjs.com/package/checkride/v/0.1.2
[0.1.1]: https://www.npmjs.com/package/checkride/v/0.1.1
[0.1.0]: https://www.npmjs.com/package/checkride/v/0.1.0

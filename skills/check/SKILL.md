---
name: check
description: Triage a red checkride gate and name one root cause. Use whenever `pnpm check` (or `npm/yarn/bun run check`) fails, a checkride gate is red, CI is failing on the gate, or you need to know what to fix first. Runs the gate itself, reads a bounded report instead of megabytes of `.check/` artifacts, and covers the contract corners a plain summary read gets wrong — exit 2 vs exit 1, vacuous green, narrow green, baselined findings, skipped slots, spawn failures and stale artifacts.
argument-hint: "[repo-path]"
allowed-tools: Read, Grep, Glob, Bash(node *), Bash(pnpm *), Bash(npm run *), Bash(yarn *), Bash(bun run *), Bash(npx checkride*), Bash(wc *)
---

# checkride: triage a red gate

checkride's gate is the definition of done: exit 0 means the work is complete,
anything else means it is not. This skill is the procedure for the "anything
else" — it turns a red gate into **one named root cause** plus an explicit list
of what it is deliberately not reading yet.

It replaces reading `.check/summary.json` by hand. That habit is wrong in two
directions at once: it is unbounded (`mutation.json` runs to 2.3 MB in
checkride's own repo, `test.json` to 650 KB, and opening one spends the context
you need for the fix), and it is credulous (every run overwrites `summary.json`,
so an `ok: true` on disk may describe three of seventeen slots from fourteen
minutes ago).

## 1. Run the reader

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/triage/cli.js"
```

Pass a repo path as the one optional argument to triage somewhere other than the
current directory. If `CLAUDE_PLUGIN_ROOT` is unset, use the copy in the target
repo: `node node_modules/checkride/dist/triage/cli.js`.

What it does, in order: runs the repo's **own** `check` script (that script is
the definition of done and may carry deliberate `--only` / `--skip` / `--changed`
that a direct `checkride` invocation would bypass), branches on the promised
0/1/2 exit split, then reads what the run wrote. On exit 2 it also folds in
`checkride doctor --json`, so the broken-harness branch arrives with its
diagnosis attached.

Every artifact is measured, never opened. A green 17-slot run renders in about
2 KB. It exits 0 whenever it produced a report — the gate's verdict is in the
Markdown, not in the process status, so a red repo never looks like a broken
reader.

**Do not open any `.check/` file before this report tells you which one.** That
is the whole point: the report is the index, and you open exactly one thing from
it.

## 2. Read the header before you read any finding

The report opens with four lines. They are not preamble — three of the five ways
to be confidently wrong about a checkride run are visible only here.

```text
- gate: `pnpm run check` → exit 0 (20.5s)
- script: `tsc --build && node dist/cli.js`
- summary: `.check/summary.json` — `schema_version` 1, written by this run, 19.8s
- covered: 17 slot(s) ran, 0 skipped
```

- **`script`** — the repo's literal `check` script. If it contains `--only`,
  `--skip` or `--changed`, this gate narrows the run on purpose and a green is
  green *for those slots only*. The report says so under `coverage`.
- **`summary`** — provenance. `written by this run` is the good case. **`left by
  an EARLIER run`** means the table below describes something else entirely and
  every row in it is suspect. `schema_version` anything but 1 means **stop**: the
  reader is pinned to schema 1, additive-only guarantees hold within a version
  and promise nothing across one, so guessing is how you invent a finding.
- **`covered`** — how much was verified. Compare it against the `coverage`
  section, which names the slots `checkride.config.json` configures but this run
  never touched.

**Always open your report with the covered-slot count and the run's age.** A
finding without its coverage is an assertion about the whole repo built from a
fraction of it.

## 3. Branch on the verdict

| verdict | what it means | what to do |
| --- | --- | --- |
| **harness broken** | exit 2 — checkride reserves it for "the harness broke or was misused" | Read the `doctor` section and the `gate output` tail. **No check result from this run is evidence of anything.** Report *what doctor found* — the named requirement, what was found, what was expected — never just "the harness is broken". |
| **off-contract exit** | not 0, 1 or 2 (a 127, a signal death, a wrapper that died before checkride ran) | Same posture as exit 2. Read the `gate output` tail: something in the `check` script failed around checkride, not inside it. |
| **red** | exit 1 — at least one check failed | Go to step 4. This is the normal path. |
| **red, but no slot explains it** | exit 1 with an empty `failing slots` section | The failure happened *outside* checkride. Read the `gate output` tail, which the report includes on this branch. See below — do not triage the table. |
| **vacuous green** | exit 0 with `checks_run: 0` | A failure wearing a pass: nothing was verified. Find out why no check was selected (a typo'd `--only`, an empty config) before believing anything. Treat it as red. |
| **green, but narrow** | exit 0 over a subset | Say which slots were covered and which were not. Do not report the work as done on this evidence. |
| **green** | exit 0, full coverage | Still check the caveats for `baselined` and `skipped` before saying clean — see step 7. |
| **gate not run** | no `check` script in this repo | Nothing here defines done. `checkride init` adds it. Anything in `.check/` is from whatever last wrote it. |

### Red with an empty `failing slots` section

The verdict reads **`red, but no slot explains it`**: the gate exited 1 but
checkride never ran, so nothing in the table came from this run. `check` scripts
are compound — `tsc --build && node dist/cli.js` is the standard shape
`checkride init` writes — and when the command *before* checkride dies, the `&&`
short-circuits and no summary is written.

The `summary` header line is the second tell: **`left by an EARLIER run`**. The
table below it describes something else entirely, and the coverage numbers belong
to that other run too.

**The evidence is already in the report.** On this branch it renders a `gate
output` section — a capped tail of both captured streams — because that is the
only record of the failure that exists. Triage it there rather than re-running
anything.

Read **both** blocks. Which stream carries the diagnosis is the failing tool's
choice, not a convention you can rely on: `tsc` reports errors on **stdout**
while `stderr` holds nothing but pnpm's `$ tsc --build && node dist/cli.js`
command echo. A near-empty `stderr` block is not "no output".

Only if both blocks are absent, re-run the failing prefix directly (`pnpm exec
tsc --build` for the shape above) and triage what it prints. Either way: do not
report any slot in the table as passing.

## 4. Order the failures — this is the judgment

The report lists failing slots in **pipeline order** and says explicitly that
this is not importance order. Re-ranking them is the part no script can do.

When several slots fail at once, most of them are usually one cause and its
shadows. The cheap tell: **does the failing slot consume something an earlier
failing slot produces?**

| when this fails | these failures are usually its shadow | because |
| --- | --- | --- |
| `types` | `build`, `typecheck-tests`, `test` | `build` is normally the same `tsc` invocation, and a type error is the same defect surfacing at runtime |
| `types` on a *syntax* error | also `lint`, `struct`, `dead`, `dupes`, `health` | unparseable source breaks every tool that parses it, which a merely semantic type error does not |
| `build` | `publint`, `attw`, `pack`, `smoke`, `snippets` | they all inspect `dist/`, which is now stale or absent |
| `test` | nothing | no slot consumes a test result |

Two rules that outrank the table:

1. **A slot with `exit_code: -1` is not a finding.** It failed to spawn or timed
   out and reported nothing. That is a harness problem wearing a failure's
   clothes, and it comes first.
2. **The prose lane is independent.** `docs`, `spell` and `links` never share a
   cause with the code lane. `types` red *and* `spell` red is two pieces of work,
   not one — say so rather than folding them together.

Worked shape: `types`, `build` and `test` all red, 41 test failures. That is one
root cause — the type error — and two shadows. Naming the 41 test failures is
noise; fixing the type error is the work. Say which one you picked and why the
others are downstream.

## 5. If everything failing is auto-fixable, say so before proposing edits

`checkride fix` runs every active adapter's fix command. The slots it can fix
are `format` (prettier, biome), `lint` (oxlint, biome, eslint), `docs`
(markdownlint) and `dead` (fallow, knip). Nothing else — `types`, `test`,
`spell`, `links`, `struct` and the packaging slots have no fix command.

- **Every failing slot is in that set** → propose `pnpm exec checkride fix`
  followed by a re-run, before writing a single hand edit. Hand-editing what a
  formatter would rewrite is wasted work.
- **Only some are** → the root cause is elsewhere. Name it first; mention `fix`
  as cleanup for the rest.

Two caveats to state when you propose it: `fix` writes to files across the whole
repo, not just the failing slots, so it wants a clean git tree or a reviewed
diff; and `dead`'s fix *deletes* code it believes is unused — read that part of
the diff rather than trusting it.

## 6. Open exactly one file

The report's `failing slots` section names each failure's raw output with its
size. Open the one belonging to your chosen root cause, and nothing else.

- If `.check/digest.md` is listed and **fresh**, read it first — it is
  checkride's own bounded excerpt of this run's failing slots, capped at 8 KB.
  Its existence always means the run that wrote it had failures. If it is
  labelled stale, it belongs to an earlier run; do not read it as this one's.
- Prefer the file the report chose. When a slot has both a `.json` and a
  `.stdout.txt`, the reader already picked the small one (`test.stdout.txt` is
  6 KB against `test.json`'s 650 KB) and the `(+1)` marks the one it passed over.
- **If the chosen file gives you a count but not a location, open the `(+1)`.**
  The reader prefers stdout because checkride's own stream discipline puts machine
  output there and progress on stderr — but not every tool obeys it.
  markdownlint-cli2 inverts it outright: `docs.stdout.txt` says
  `Summary: 1 issue in 1 file` while `docs.stderr.txt` carries the
  `file:line:rule` you actually need. A summary line is not a finding; go get the
  finding.
- **Check the size before opening.** Anything past ~50 KB gets `Grep`, not
  `Read` — search for the error text rather than loading the file.
- If a failing slot's raw output is `—`, the tool wrote nothing the reader could
  locate. Do not report "no output": re-run that slot alone
  (`pnpm exec checkride --only <slot>`) and read what it prints.

## 7. Report

Lead with provenance, then one cause, then what you left closed:

- **Gate** — the verdict, the covered-slot count, and the run's age.
- **Root cause** — one slot, one sentence, grounded in the file you opened.
- **Downstream, not read** — the failing slots you believe are shadows of it,
  and the one-line reason. Naming these is as much the product as the cause is.
- **Separate work** — failing slots that are genuinely independent (usually the
  prose lane).
- **Masked** — every caveat the report raised, because each one means a green is
  less green than it looks:
  - `baselined: N` — that many current findings are grandfathered by
    `checkride.baseline.json`. **A baselined slot passing is not clean, and you
    must say the count rather than reporting clean.** Never add to a baseline to
    make a check pass.
  - `skipped` plus its reason — that slot verified nothing this run.
  - stale artifacts — leftovers from an earlier run, not this one's output.
  - uncovered slots — configured in `checkride.config.json`, absent from this run.
- **Next** — the fix command, or the specific hand edit.

Do not produce a fixed-size list of findings. One cause is the target; two is
fine when the lanes are genuinely independent; five means you re-ranked nothing.

## What this skill does not do

- **It does not fix.** It runs the gate and reads. Proposing `checkride fix` or a
  hand edit is the deliverable; applying it is the next request.
- **It does not normalize tool output.** The raw file is the truth and the
  summary is only an index — that is checkride's thesis, and reformatting a
  tool's own bytes into something prettier is how a triage loses the detail that
  mattered.
- **It does not read `.check/` contents on spec.** Sizes and locations first,
  then exactly one file. If you find yourself opening a second artifact before
  naming a cause, that is exploration, not triage.
- **It does not touch the baseline.** `checkride baseline` hides findings
  permanently; that is the human's call, never a triage step.

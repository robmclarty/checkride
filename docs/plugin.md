# The Claude Code plugin

checkride ships a [Claude Code](https://claude.com/claude-code) plugin from the
package root: two skills — `/checkride:check` and `/checkride:qa` — and the two
readers behind them. It is **bundled**, not published separately: same npm
package, same version number, one install. The readers parse
`.check/summary.json` against a pre-1.0 contract, and shipping them beside the
engine is what keeps a reader and the format it reads from drifting apart.

The plugin **runs nothing new**. No extra CLI command, no new flag, no config
file, no hook. Both skills read what a checkride run already wrote; the check
skill additionally runs the repo's *existing* `check` script so there is
something current to read. Anything the plugin looks like it needs from
checkride is a checkride feature request, not a plugin feature.

## Why not just read `.check/summary.json`?

Reading the summary by hand is the procedure `checkride init` writes into
AGENTS.md, and it works. It is also wrong in two directions at once.

**It is unbounded.** In checkride's own repo, `mutation.json` is 2.2 MB and
`test.json` is 650 KB. Opening one spends the context you need for the fix.

**It is credulous.** Every run overwrites `summary.json`, so an `ok: true` on
disk may describe three of seventeen slots from fourteen minutes ago, and the
other artifacts beside it may belong to some other run entirely. Nothing in the
schema says so — the summary is an *index*, not evidence.

So each skill pairs a **deterministic reader** with **model judgment**. The
reader measures artifacts instead of opening them, pins `schema_version`, dates
every file against the run that claims it, and resolves a failing slot's raw
output by the documented convention when the summary names no file (which it
does not for 8 of checkride's own 17 slots, `test` among them). The skill then
does the part no script can: rank simultaneous failures into one root cause,
or decide which surviving mutant is worth a test.

## Install

```text
/plugin marketplace add robmclarty/agent-tools
/plugin install checkride@robmclarty
```

The marketplace entry points at the **published npm package** — the same tarball
you install as a dev dependency — and Claude Code reads
`.claude-plugin/plugin.json` from its root. The entry lands with the first
release that carries that manifest; until then, and in any repo where you would
rather not install a plugin at all, use the direct form below.

**There is no build step.** The readers ship prebuilt in the package's `dist/`,
so the install is a download: nothing to compile, no dependencies to fetch. They
import `node:` builtins only.

Nothing about the plugin is required. checkride's CLI, exit codes and `.check/`
contract are unchanged whether it is installed or not, and the AGENTS.md stanza
`init` writes keeps working standalone — it names `/checkride:check` as the
fuller path in one added line, and that line is the only difference.

### Without the plugin

Both readers are plain Node entry points inside the installed package, so any
agent — or you — can run them directly:

```bash
node node_modules/checkride/dist/triage/cli.js   # what /checkride:check runs
node node_modules/checkride/dist/qa/cli.js       # what /checkride:qa runs
```

Each takes one optional argument: a repo path, defaulting to the current
directory. Each writes Markdown to stdout. What you lose is the skill — the
procedure and the judgment that turn a report into a diagnosis.

## `/checkride:check` — triage a red gate

Use it whenever `pnpm check` fails, CI is red on the gate, or you need to know
what to fix first. It produces **one named root cause** plus an explicit list of
what it is deliberately not reading yet.

The reader runs the repo's own `check` script — that script is the definition of
done and may carry deliberate `--only` / `--skip` / `--changed` that a direct
`checkride` invocation would bypass — then branches on the promised 0/1/2 exit
split before reading anything. A green 17-slot run renders in about 2 KB.

It covers the contract corners a plain summary read gets wrong:

| corner | what the report does |
| --- | --- |
| exit 2 vs exit 1 | exit 2 is "the harness broke", so no check result is evidence; it folds in `checkride doctor --json` so the branch arrives with its diagnosis attached |
| an off-contract exit | not 0, 1 or 2 means something died around checkride — it renders the gate's own output tail |
| red with no failing slot | a compound `check` script (`tsc --build && node dist/cli.js`) that short-circuits writes no summary, so the table on disk is an earlier run's; the report says so and renders the captured streams, the only evidence there is |
| vacuous green | `ok: true` with `checks_run: 0` verified nothing |
| narrow green | `ok: true` over a subset — the header states covered slots and the run's age before any finding |
| `baselined: N` | that many findings are grandfathered, so the pass is not clean |
| `skipped` + `reason` | that slot verified nothing this run |
| `exit_code: -1` | a spawn failure or timeout — a harness problem wearing a failure's clothes, not a finding |
| a bumped `schema_version` | the reader is pinned to 1 and stops loudly rather than guessing |
| a stale artifact | anything older than the run's start is labelled with its age, never silently dropped |

Then the judgment: failing slots arrive in pipeline order, which is *not*
importance order, and the skill re-ranks them. When `types`, `build` and `test`
all fail, the type error is the cause and the other two are its shadows — saying
which one you picked, and why the rest are downstream, is the product. If every
failing slot is auto-fixable it proposes `checkride fix` before any hand edit.
Finally it opens **exactly one** artifact: the one belonging to the chosen root
cause, with its size checked first.

## `/checkride:qa` — read the quality signal

Use it when the question is not "is it done" but "is the suite actually testing
anything, and where is the risk". It reads the four quality artifacts checkride
already writes — `mutation.json`, `dead.json`, `dupes.json`, `health.json` —
and runs **nothing at all**: not stryker, not fallow, not the gate.

The 2.2 MB of `mutation.json` folds to a ranked page; the whole report stays
under 8 KB, the same ceiling `--digest` uses. That bound is the only reason a
mutation finding is affordable in a conversation.

It opens with a ledger rather than a finding, because three of the four
artifacts come from **opt-in** slots and checkride's own gate never runs
`mutation`:

| state | what it licenses a report to say |
| --- | --- |
| `read` | evidence, present tense |
| `STALE` | a fact about the past, with the age always attached |
| `not opted in` | nothing about that dimension — the reader prints the command or config entry that would produce it |
| `absent` | nothing; the slot is on but has not run |
| `too-large` / `unreadable` / `unrecognized` | nothing, and which of the three, because each has a different cause |

In a fresh consumer repo that ledger plus two commands is very nearly the whole
honest report — a gap is a finding here, not an edge case. Where there *is*
evidence, the skill reads it strongest-first: surviving mutants (stryker changed
the code and the suite still passed — a demonstrated hole, not an opinion), then
dead code, then structure, then its own reading of the source, and it stops
where the evidence stops. A short report is a strong one; there is no fixed-size
finding list, and zero findings is a legitimate answer.

## What the plugin deliberately does not do

- **No wrapper skills.** Nothing wraps `init`, `doctor`, `fix`, `baseline` or
  `agent-setup`. A skill that runs one command is strictly worse than the
  command, and costs a name and description resident in every session's context.
  `doctor` and `fix` fold into the triage flow at the moment each is the right
  answer; the command surface itself is the [cheat sheet](./cheatsheet.md).
- **No normalizing.** The raw file is the truth and the summary is only an index
  — that is checkride's thesis. Reformatting a tool's own bytes into something
  prettier is how a triage loses the detail that mattered. Both readers
  truncate; neither rewrites.
- **No gating.** The skills report; the gate gates. `/checkride:qa` in
  particular invents no threshold — turning a measurement into a target is how
  it stops being a measurement.
- **No fixing, and no baseline.** Proposing `checkride fix` or a specific hand
  edit is the deliverable; applying it is the next request. `checkride baseline`
  hides findings permanently and stays the human's call.

## See also

- [The contract](./contract.md) — the surfaces both readers consume, and the
  pin policy.
- [Cheat sheet](./cheatsheet.md) — the command and flag surface the skills
  refer to.
- [Tools and installation](./tools.md) — what produces each artifact the qa
  skill reads.

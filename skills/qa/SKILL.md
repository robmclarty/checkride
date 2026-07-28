---
name: qa
description: Read checkride's quality artifacts — surviving mutants, dead code, duplication and the health score — and say what the test suite actually proves. Use when asked how healthy the codebase is, whether the tests are any good, where the risk or the tech debt is, what mutation testing found, or which files need better coverage. Reads a bounded report instead of megabytes of `.check/` artifacts, runs nothing, and reports which quality dimensions were never measured rather than guessing at them.
argument-hint: "[repo-path]"
allowed-tools: Read, Grep, Glob, Bash(node *), Bash(wc *), Bash(git log *)
---

# checkride: read the quality signal

checkride's gate answers one question — is the work done? — and answers it
pass/fail. These four artifacts answer a different one: **is the suite actually
testing anything, and where is the risk?** Nothing here is red or green. No
threshold fires. That is exactly why this is the easiest report in the repo to
hallucinate: with no failure to anchor to, a plausible-sounding list of eight
issues costs nothing to write and means nothing.

So the discipline is inverted from triage. `/checkride:check` starts from a
failure and narrows to one cause. This skill starts from evidence and stops when
the evidence stops — which is sometimes after one finding, and sometimes after
none.

For a red gate, use `/checkride:check` instead. This skill reads what a *past*
run left behind and never runs the gate itself.

## 1. Run the reader

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/qa/cli.js"
```

Pass a repo path as the one optional argument to read somewhere other than the
current directory. If `CLAUDE_PLUGIN_ROOT` is unset, use the copy in the target
repo: `node node_modules/checkride/dist/qa/cli.js`.

It **runs nothing** — no stryker, no fallow, not the gate. It opens `.check/`,
folds each artifact to a ranked short list, and renders under 8 KB (the same
ceiling `--digest` uses). In checkride's own repo that is 2.3 MB of
`mutation.json` reduced to a page, which is the only reason a mutation finding
is affordable at all.

**Do not open any `.check/` file before this report names one.** Every count
below comes from a full pass over the artifact; the lists are ranked, not
truncated at random.

## 2. The ledger is the answer, not the preamble

Because the reader runs nothing, its first job is to say what it is actually
holding. Two head lines, then a table — and in a default consumer repo that is
very nearly the *whole* report.

```text
- summary: `.check/summary.json` — `schema_version` 1, 1.5m ago, 1.5s
- covered: 3 slot(s) ran — links, docs, spell
```

- **`summary`** — what the artifacts beside it belong to, and how long ago. If it
  reads `` `schema_version` is 2, not 1; STOP ``, then **stop**: the reader is
  pinned to schema 1, and guessing across a version is how you invent a finding.
- **`covered`** — the slots that run actually touched. Three of seventeen means
  the artifacts on disk mostly belong to *some other* run, and the ledger's
  staleness column is the only thing standing between you and reporting them as
  current. `covered: nothing` means there is no readable summary at all, so no
  artifact here can be dated and none of them is evidence.

**Open your report with that covered count and the run's age**, the same way
`/checkride:check` does. A quality claim without its coverage is an assertion
about the whole repo built from a fraction of it.

| state | what it means | what it licenses you to say |
| --- | --- | --- |
| `read` | fresh — written by the run whose summary sits beside it | evidence, present tense |
| `STALE` | on disk, but older than that run's start | a fact about the past, with the age always attached |
| `not opted in` | the slot is absent from `checkride.config.json`, so no run produces it | **nothing about this dimension** — name the remedy instead |
| `absent` | opted in, but no file — the slot has not run, or produced nothing | nothing; name the command |
| `too-large` / `unreadable` / `unrecognized` | the bytes are there but not usable | nothing; say which, because each has a different cause |

Two rules follow, and they are the ones that make this skill honest.

**A gap is a finding, not an edge case.** Three of the four artifacts come from
opt-in slots, and checkride's own gate never runs `mutation` at all. In a fresh
consumer repo you will find `dead.json` and nothing else. The honest report
there is the ledger plus the two commands that would produce data — *not* a page
of quality assessment extrapolated from one artifact. The reader already prints
the exact command or config entry for each gap; quote it rather than inventing
one.

**Never launder a stale number into a present-tense claim.** "Mutation score is
71%" is wrong when the file is 7.6 days old. "As of a stryker run 7.6 days ago,
71%" is right, and it carries its own warning. When a stale artifact is
load-bearing for a finding, check whether the code moved under it:

```bash
git log -1 --format=%cr -- src/init.ts
```

If the file changed more recently than the artifact, the artifact describes code
that no longer exists. Say so and stop — do not report its findings as current.

## 3. Read in evidence order — strongest proof first

The reader emits its sections in the order you should reason about them, and
that order is not arbitrary. It ranks by **how much of the claim the artifact
already proved for you**:

1. **Surviving mutants** — the strongest evidence in the repo. Stryker *changed
   the code* and the suite still passed. That is a demonstrated hole, not an
   opinion, and no amount of coverage percentage can contradict it.
2. **Dead code** — a static claim about reachability. Usually right; wrong
   exactly where entry points are dynamic, which is why `fallow.toml`'s `entry`
   list exists.
3. **Structure** (`dupes`, `health`) — measurements against thresholds somebody
   configured. A hotspot is a place to look, not a defect.
4. **Your own reading of the source** — last, and only when it names a file and
   a line.

Work down that list and stop where the evidence stops. That is the whole
anti-hallucination device: findings are sorted by proof, so a short report is a
*strong* one.

### Mutation: survived and no-coverage want different fixes

The two undetected states look alike in a table and mean opposite things.

- **No-coverage** — no test reaches the line at all. The fix is a test that
  executes it.
- **Survived** — a test *does* reach it and asserts nothing that would notice
  the change. The fix is a stronger assertion in the test that already runs.
  Adding another test that also does not look is the standard wrong answer, and
  it raises line coverage while changing nothing.

The mutator name tells you what kind of hole it is:

| mutator | what its survival proves |
| --- | --- |
| `ConditionalExpression` | a branch condition can be forced true or false and nothing notices — usually one side of the branch is decorative. The most common survivor almost everywhere (359 of them in checkride's own repo) and the most informative |
| `BlockStatement` | an entire function body was emptied and the suite passed. The loudest signal in the table |
| `EqualityOperator` | a comparison flipped undetected — a boundary case nothing exercises |
| `LogicalOperator` | one arm of an `&&` / `\|\|` is never the deciding one in any test |
| `ArrayDeclaration`, `ObjectLiteral` | a literal was emptied unnoticed — the *contents* of that data are unasserted. Common on config tables, and often low-value (see below) |
| `Regex`, `StringLiteral` | the pattern or text is unasserted; frequently a message nobody should assert on |

**Not every survivor is worth killing.** Equivalent mutants — ones with no
observable behavior difference — are real and common: log text, a default
immediately overwritten, a `??` on a value that is never null. A suite driven to
100% mutation score is a suite full of assertions on things nobody cares about.
Rank survivors by **what the mutant proves about a path a user can reach**, and
say when you are dismissing one and why.

**Rank is not priority.** The reader ranks files by undetected count, which
tracks file *size* at least as much as risk — `src/init.ts` tops checkride's own
table largely because it is the biggest file with the most mutants. Read what
the survivors are before treating the top row as the most important work.

## 4. Ground the finding, or drop it

A finding must be able to name three things: **the artifact it came from, the
file and line, and — for a mutation finding — the test that should have caught
it and did not.** If you cannot name the test file you would edit, you have a
metric, not a finding.

So for the one or two survivors that look genuinely load-bearing:

1. Open the source at the sample line the report gave you (`Read` with an
   `offset`, not the whole file).
2. Find the test that covers it — `src/__tests__/<name>.test.ts`, or `Grep` for
   the function name.
3. Read what that test asserts. The finding is the sentence that comes out:
   *"`resolveOrder` is called in three tests and all three assert only the
   length of the result, so flipping its `<=` to `<` changes nothing they
   check."*

"Coverage could be improved here" is not that sentence.

**Open at most two or three files.** If the report ranks eight, read the top one
properly rather than all eight badly — the same economy `/checkride:check` uses
when it opens exactly one artifact.

## 5. Report

- **Evidence** — the covered-slot count, the run's age, then the ledger in a
  line or two: what is fresh, what is stale and by how much, what was never
  produced. Always first. A report that opens with a finding is a report that hid
  its own uncertainty.
- **What the artifacts prove** — findings in evidence order, each grounded per
  step 4. As many as the evidence supports, and no more.
- **What would produce the missing evidence** — the reader's own command or
  config line for each gap. This is often the single most useful thing you can
  say.
- **Judgment** — clearly labelled as yours, last, and only where it names a
  file.

### The failure mode this skill exists to prevent

**Produce no fixed-size list.** Not "top 5 issues", not eight findings, not one
per artifact. The count is whatever the evidence supports, and **zero is a
legitimate answer** — a repo with a fresh, empty `dead.json` and three
unmeasured dimensions has exactly one honest thing to report: that three of four
quality dimensions are unmeasured. Padding that to five means inventing four.

Three specific ways it goes wrong:

- **Restating the metric as a finding.** "Health score is 80.9/B" is the ledger.
  A finding names which function costs the points and why.
- **Grading the grade.** No number in `health.json` is a defect; the thresholds
  are a configured opinion, and the score is 100 minus the penalties. When
  nothing is over any threshold and the whole penalty is hotspots and unit size,
  say that — do not manufacture violations to explain a B.
- **Turning a ranked list into a to-do list.** The tables are ranked so you know
  where to *look*. Copying the top five rows into "recommendations" is
  transcription wearing analysis's clothes.

## What this skill does not do

- **It runs nothing.** Not stryker (minutes to hours, and it rewrites your
  source while it works), not fallow, not the gate. Naming the command is the
  deliverable; running it is the human's call.
- **It does not gate.** None of these four dimensions has a pass/fail line, and
  inventing one — "mutation score should be above 80" — turns a measurement into
  a target, which is how it stops being a measurement.
- **It does not write tests.** Naming the unasserted branch is the deliverable.
  Writing the test is the next request, and it should start from the named
  mutant.
- **It does not triage a red gate.** That is `/checkride:check`, which runs the
  gate and reads different artifacts entirely.
- **It does not touch the baseline.** `checkride baseline` hides findings
  permanently; that is never a reading step.

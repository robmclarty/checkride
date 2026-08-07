# Reliability — why checkride can carry a gate

Most tools are used by a person who watches them run. checkride is used by
things that don't watch: a commit gate that refuses a push when the pipeline is
red, a coding agent that treats exit 0 as permission to stop, a CI job that
merges on green. When judgment is delegated like that, the tool's reliability
stops being a nicety and becomes the foundation other things stand on. A flake
in a linter is an annoyance; a flake in the thing that *decides whether the
linter passed* is a crack in the floor.

checkride also tends to be the first thing a team tries, precisely because it
asks for nothing: one command, exit 0 = done, no workflow to adopt. That makes
it an ambassador. An ambassador that burns its first adopter — a hang with no
timeout, a summary a consumer can't trust, a Node floor that contradicts
itself — doesn't get a second introduction.

This page explains the design choices that make checkride safe to build on.
The authoritative list of *what's promised* lives in
[the contract](./contract.md); this is the *why* behind it.

## The contract, and why it's frozen

A tool accumulates behavior. Some of that behavior is a deliberate promise
("exit 2 means the harness broke"); most of it is just how the code happens to
work today. The problem for anyone building on the tool is that from the
outside these look identical — you can't tell a load-bearing wall from a
decorative one until you lean on it.

checkride resolves that ambiguity by naming its promises out loud and locking
them with tests, so a promise can't drift without the build going red:

- **Exit codes are a taxonomy, not a number.** `0` means every executed check
  passed, `1` means a check failed (the work isn't done), `2` means the harness
  itself broke or was misused. The `1`-vs-`2` split is the important one: a
  gate can safely branch on "red build" versus "fix the pipeline," because that
  distinction is a documented right rather than an observed habit.
- **`summary.json` grows only by addition.** Under a given `schema_version`,
  fields are added, never renamed, removed, or retyped. A consumer written
  against version 1 keeps parsing every 1.x report. The published JSON Schema
  ships in the package and is validated in the test suite, so a new field that
  isn't in the schema fails the build — the discipline is mechanical, not a
  matter of remembering.
- **The raw output stays raw.** This is the product's core thesis and it will
  not change: each tool's own bytes land in `.check/<slot>.json` (or the text
  files beside it), never normalized into some common shape. The summary is an
  index; the raw file is the truth. Deleting the normalization layer is what
  makes checkride cheap to extend, and keeping it deleted is a promise.
- **The public surface is exactly what the package exports.** Everything
  importable from `checkride` is semver-bound; everything else is internal by
  definition, even if it's technically reachable.

The payoff of writing this down is a credible path to 1.0. The version number
is itself a trust signal — an engineering manager reads "0.x" as "may break
under me." checkride reaches 1.0 not by adding features but by letting the
contract survive contact with real consumers across a few releases, then
declaring what already held.

### Pinning

Because pre-1.0 minor versions may break by the semver rule, consumers should
pin checkride **exactly** (`"checkride": "0.3.0"`, no caret) and upgrade
deliberately. A caret range is the intended usage only after 1.0. A consumer
sitting on an exact old pin isn't behind — it's following policy correctly.

## The vacuous-green problem

Here is the most dangerous thing a definition-of-done tool can do: pass without
having checked anything. Point checkride at a repo whose shape it doesn't
recognize — no tool configs it detects — and every slot sits out. Nothing runs.
The run is, technically, not-failed, so a naive reading is exit 0: "checkride
says done" on a repo where nothing was verified. An agent stops. A gate opens.
The floor was never there.

The subtle part is that "green because everything passed" and "green because
nothing ran" are both exit 0. The distinction has to be visible to *every*
consumer, not just one that was clever enough to hand-roll a check for it.
checkride makes it visible three ways:

- **`checks_run`** in the summary counts the checks that actually executed.
  `ok: true` with `checks_run: 0` is the unmistakable signature of a vacuous
  pass — any consumer can read it.
- **A loud warning** on a zero-run names why each slot sat out (the config file
  it looked for and didn't find) and what to do about it, so the answer to "why
  didn't anything run?" doesn't require reading source. `checkride doctor`
  reports the same per-slot detection status as a first-class view.
- **`--strict`** turns a zero-run into exit 2. Anything that gates — CI, a
  commit hook, another tool — should run strict, so "nothing ran" fails loudly
  instead of passing quietly.

The default stays a warned exit 0 on purpose. A human exploring a fresh
checkout shouldn't be punished with a hard failure for a repo that isn't set up
yet; the warning tells them what's happening. The hard line is opt-in, and the
things that need the hard line are exactly the automated ones that can ask for
it.

## The failure modes that had to close

A gate is judged on its worst day, not its average one. Three failure modes
mattered enough to close by default rather than leave as configuration.

**A hung tool can't hang the definition of done.** Every check in the gate runs
under a timeout, on by default, generous enough (ten minutes) that no honest run
of a definition-of-done check trips it. A tool that does hang is killed — SIGTERM,
a short grace, then SIGKILL if it ignores the polite request — and recorded as
failed with a "timed out" note. Red, never a silent stall, never a vacuous pass.
This holds per-check under concurrency: when a wave runs its checks through the
bounded pool, each carries its own timeout and each is killed and
process-group-reaped on its own, so one hung check in a wave can neither stall nor
leak the rest. The cap is tunable per check and globally, and `0` disables it. The
one slot that ships uncapped by default is `mutation`: a real stryker run
legitimately takes fifteen to twenty minutes — past the ten-minute cap — and
because `mutation` is opt-in and never part of the definition-of-done gate the cap
protects, its adapter carries `timeout: 0` so it runs to completion instead of
being cut off mid-run. For every gating slot the safe behavior is what you get
without configuring anything, because the person most likely to be bitten by an
unbounded hang is the one who never thought to set a timeout.

**A killed run never leaves a torn artifact.** If checkride is interrupted
mid-write — a Ctrl-C, a CI timeout, a lost SSH session — a consumer parsing
`summary.json` on the next run must not find half of it. Every artifact
(`summary.json`, the raw slot files, the digest, the committed baseline) is
written to a temporary sibling and renamed into place, and rename is atomic
within a directory. So each file is always either the previous complete version
or the new complete version. This one is worth stating plainly: a half-written
summary that a gate then misreads would be a correctness bug in *the
consumer's* gate, caused by *checkride's* crash. Pushing that risk onto a
consumer is exactly the kind of thing a foundation isn't allowed to do.
`checkride recover`'s restore rides the same path — the baseline it rewrites
is temp-and-renamed like every other artifact, never edited in place.

**The interrupt story is tested, not asserted.** An end-to-end test kills a run
in flight and checks that `.check/` is either previous-run-consistent or
absent, and that the baseline is untouched. The baseline's logical safety (it
never prunes on a partial run, so an unobserved finding can't be mistaken for a
fixed one) was already covered; this covers the physical half — no torn bytes
on disk.

## What the static publish checks can't see

`publint` and `attw` read a package without running it: they lint the
`package.json` publishing surface and check that types resolve across module
systems. That's necessary and it's cheap, but it's static — and three ways a
library breaks its consumers survive a clean static pass:

- **It passes `publint` + `attw` but throws on `import`.** A bad build, a runtime
  dependency left in `devDependencies`, a top-level side effect that crashes — the
  declarations are correct, the artifact still doesn't load.
- **It ships `src/` in the tarball.** Tests, source `.ts`, a `docs/` tree, a
  stray `.env` — none of it belongs in what a consumer downloads, and none of it
  is a type error.
- **Its doc examples have rotted.** The README's headline snippet stopped
  compiling three releases ago; nobody runs the README.

The `smoke`, `pack`, and `snippets` slots close exactly those three, and they do
it against the *real* artifact: `build` (wave 10) runs first so `pack` inspects a
fresh tarball, `smoke` imports the built entry points, and `snippets`
type-checks the tagged fences. They're **opt-in**, so a repo that never publishes
never runs them and a default gate stays byte-for-byte unchanged — but a library
that turns them on has moved "the published package works" inside its definition
of done, where a gate can enforce it instead of a human remembering to.

## The signals a team actually checks

None of the following changes what checkride *does*. All of it changes whether
someone decides to depend on it — the difference between a tool that works and
a tool a cautious engineering manager is willing to bet a team's workflow on.

- **The stated Node floor matches reality.** A tool whose docs demand a newer
  Node than its manifest actually requires will burn the first adopter whose
  default is the older one — and that adopter never comes back. The supported
  floor is one number, stated the same everywhere.
- **The CI recipe is ready to paste.** [Running in CI](./ci.md) is a
  complete GitHub Actions job (with npm/yarn/bun variants), including the
  `--strict` note and the baseline note for legacy repos, so adoption is a copy
  rather than a research project.
- **Published artifacts carry provenance.** Releases publish with npm
  provenance, which links each tarball to the exact commit and workflow that
  built it — verifiable on the registry. It costs nothing and the audience that
  reads a contract is the same audience that notices.
- **The test suite is itself tested.** Line coverage says the tests *ran* the
  code; mutation testing asks whether they'd have *caught a bug*. checkride
  runs Stryker with a hard floor and wears the resulting score in the README,
  the way projects used to wear a coverage badge — a real number, not a claim.
- **The bus factor is written down, not guessed.** checkride has one
  maintainer. [CONTRIBUTING.md](../CONTRIBUTING.md) makes that a known quantity
  with a written release ritual and succession path — which two credentials a
  successor needs and nothing more — rather than an unknown a prospective
  adopter has to worry about silently.

## The tested envelope, stated honestly

A promise of "works everywhere" that hasn't been tested everywhere is worse
than a smaller promise that's true. checkride's continuous integration runs the
full suite — unit, contract, and real end-to-end (projects generated,
installed, and checked for real) — across macOS and Linux, at both the exact
supported Node floor and the current release, and the end-to-end suite
exercises all four package managers it claims to support: pnpm, npm, yarn, and
bun. That is the envelope, and the README states exactly that.

Windows is deliberately absent. It isn't tested, so it isn't claimed; it waits
for a real consumer who needs it rather than being asserted on faith. An honest
"we don't test this yet" is a trust signal too — it tells a reader that the
things checkride *does* claim were actually verified.

## What this reliability work is not

It's worth being clear about the lines it doesn't cross, because they're
deliberate:

- **No normalization.** `checks_run` and its siblings are envelope metadata
  about the run, not a reshaping of any tool's diagnostics. The raw-JSON thesis
  is the product.
- **No new breadth from the hardening itself.** The timeout, atomic-write, and
  vacuous-green work adds no slot or checker — the risk it addresses is reliance,
  not coverage. (The publish-ready bundle above *is* new coverage, but it stays
  opt-in for this same reason: the default gate a repo already depends on never
  changes shape under an upgrade.)

The thread through all of it is simple: checkride is only as valuable as a gate that can't
be talked past, and a gate that can't be talked past is only safe if the thing
enforcing it doesn't wobble. Everything here is in service of not wobbling.

# Why checkride — the case, the ROI, and the objections

Every doc in this repo explains *what* checkride does. This one explains why a
team — or a business — should want it, what it costs compared to the
alternatives, and how to answer the objections that come up when someone
proposes adding it to a repo that already has tools.

## What checkride is selling

Not a linter. Not a test runner. Not a wrapper. checkride sells one thing:

> **A portable definition of done.**

"Done" in most repositories is folklore. It lives in a `package.json` with
fifteen scripts (`lint`, `lint:fix`, `test`, `test:watch`, `typecheck`,
`check:deps`, …), in a CI file that runs a slightly different subset in a
slightly different order, and in the head of whoever set it up. Ask three
people on the same team what makes a change "done" and you get three lists.
Ask the same question in the *next* repo and the lists don't even use the same
script names.

checkride replaces that folklore with a contract: **one command, one exit
code**. `pnpm check` exits 0 when the work is complete and non-zero when it
isn't, in every repo that adopts it, with the same flags, the same output
files, and the same failure semantics. Everything else — the slot model, the
`.check/` files, the baseline, the Stop hook — is machinery in service of
making that one sentence true and keeping it true.

That's the product. The rest of this page is the argument for why that's worth
paying for.

## The fleet argument

The value of a definition of done is roughly linear in one repo and
superlinear across many. This is the part that's easiest to miss when
evaluating checkride against a single repository's setup, so it's worth
spelling out.

Consider an organization with a handful of TypeScript repos — a product
backend, a frontend, some internal tools, a couple of libraries. Each one
accumulated its own check setup at a different time, by a different person,
with different tools at different versions. Individually, each setup is fine.
Collectively, they impose four recurring costs:

- **Context-switch cost.** Moving between repos means relearning what "run the
  checks" is called here, which subset CI actually enforces, and which
  failures are real versus known-flaky. That tax is paid on every switch, by
  every person, forever.
- **Maintenance cost, multiplied.** A friction discovered in one repo — a tool
  that hangs, a flag that changed, a check that passes vacuously — has to be
  rediscovered and re-fixed in every other repo, or more realistically, isn't.
  The fleet drifts.
- **Onboarding cost.** Every repo is its own small research project. The
  knowledge doesn't transfer because the interfaces don't match.
- **Agent cost.** This is the new one. Coding agents need to be told what
  "done" means, per repo, in AGENTS.md files and hooks and prompts. When every
  repo's checks are shaped differently, every repo's agent configuration is a
  bespoke artifact that drifts like the rest.

Factoring the "check" concern into a shared package converts all four from
per-repo costs into one amortized cost:

- **Learn once, apply everywhere.** `pnpm check` means the same thing in every
  repo. The flags are the same. `.check/summary.json` has the same shape. A
  developer — or an agent — who knows one repo's check discipline knows all of
  them.
- **Fix once, upgrade everywhere.** A bug or friction found in *any* adopting
  repo gets fixed upstream, and every other repo picks it up as a one-line,
  exact-pinned version bump. The fleet stops drifting because the check
  concern has a single source of truth, the same way a shared library stops
  copy-pasted utility code from drifting.
- **Edge cases compound.** Each adopting repo pushes the tool through a
  different configuration — a monorepo here, a published library there, a
  legacy codebase with a baseline somewhere else. Every edge case one repo
  hits and fixes hardens the package for all the others. This is the standard
  open-source leverage argument, applied to the one concern every TypeScript
  repo shares.
- **The agent contract becomes uniform.** The AGENTS.md stanza, the Stop hook,
  the "exit 0 = done" rule — identical in every repo, written by
  `checkride agent-setup`, upgraded centrally. An organization adopting
  agentic tools across a fleet gets one check interface to teach its agents
  instead of one per repo.

This is the general scaling property of modular systems: an improvement to the
module is an improvement to every consumer, and learning the module means
learning every consumer's version of that concern. A bespoke per-repo setup —
even a genuinely excellent one — can't have this property, because its
excellence is trapped in the repo. Locally optimal choices and
ecosystem-optimal choices are different things, and the gap between them is
exactly what a shared contract buys back.

## The ROI, concretely

Set against the ad-hoc alternative (a pile of npm scripts plus a hand-tended
CI file), here is what checkride returns and what it costs.

**What it returns:**

- **One command replaces the script pile.** Not by deleting the tools — by
  giving them one entry point with real semantics. The scripts a repo
  accumulates have no exit-code taxonomy, no timeout discipline, no
  machine-readable summary, and no answer to "did anything actually run?".
  checkride's run has all four, [tested and frozen](./contract.md).
- **Failure modes are closed by default, once, for everyone.** A hung tool is
  killed and recorded red instead of stalling CI. A killed run never leaves a
  torn artifact. A run where every check silently sat out is flagged — and
  under `--strict`, fails — instead of passing vacuously. Each of these is a
  small incident a hand-rolled setup gets to discover in production;
  [Reliability](./reliability.md) walks through why each is closed here.
- **Adoption is a day, not a cleanup project.** `checkride init` adopts the
  tools a repo already has, and `--baseline` grandfathers existing debt so the
  repo is green on day one while any *new* debt still fails. The baseline is a
  ratchet — it only shrinks — so the debt is paid down monotonically instead
  of being either ignored or blocking adoption.
- **Org-wide policy without org-wide bureaucracy.** A shared preset
  (`"extends": "@acme/checkride-preset"`) puts the organization's rules in one
  versioned package; `detect` lets that preset stay safe across repos that
  don't all use the same tools. Rolling out a new rule to the fleet is a
  preset release, not a campaign of pull requests.
- **The agent dividend.** Checks are increasingly read by LLMs, not humans.
  checkride was designed for that consumer: raw per-tool JSON in `.check/`, a
  stable summary schema, a token-bounded digest, and a hook that stops an
  agent from declaring victory on a red pipeline. A script pile offers an
  agent a wall of interleaved text on stdout.

**What it costs:**

- One dev dependency, exact-pinned, with **no runtime dependency on any
  checked tool** — the repo keeps owning its tool versions and configs.
- Learning one command and a handful of flags.
- The discipline of treating exit 0 as the definition of done — which is a
  cost only if the team didn't want a definition of done.

**What it doesn't cost — the exit price.** This matters for the risk
calculation, so it deserves its own line: because checkride runs the repo's
own tools against the repo's own configs and never rewrites their output,
removing it is trivial. Delete the dependency, the config, and the baseline;
the tsconfig, lint config, test setup, and all the rest are still yours,
untouched, exactly as they'd be if checkride had never been installed. The
worst case of adopting checkride is ending up where you already are. Few
infrastructure decisions have a floor that soft.

## Against the named alternatives

**Plain npm scripts.** The incumbent, and the baseline for the ROI above. The
short version: scripts are a list of commands, not a contract. No exit-code
taxonomy, no vacuous-green detection, no timeouts, no atomic artifacts, no
baseline, no schema anyone promised to keep stable — and no consistency from
repo to repo, because each script pile evolved independently. Scripts also
rot silently: a `check:deps` that nobody wired into CI is a check that
doesn't exist.

**A task runner (NX, Turborepo, a Makefile).** A common category error —
these are not competitors, because they answer a different question. A task
runner answers *"how do I run tasks efficiently?"*: per-package graphs,
caching, affected-only execution. checkride answers *"what does done mean?"*:
which checks constitute the gate, what the exit codes promise, what a consumer
may parse. A monorepo can happily run checkride *through* its task runner —
or checkride can invoke tools that are themselves cache-aware. Adopting a task
runner does not give you a definition of done; it gives you a faster way to
run whatever ad-hoc definition you already had.

**A hand-rolled meta-script (`check.sh`, a `verify` script).** This is the
honest competitor — it's what checkride was before it was a package. It works
in one repo. Its problems are the fleet argument in miniature: it's
version-controlled with the repo instead of versioned as a dependency, so
fixes don't propagate; it's tested by usage instead of by a contract suite;
and its author's departure turns it from a tool into an artifact. checkride is
that script with the per-repo parts factored out and the promises written
down and locked.

**Doing nothing.** Always an option, and for a solo project with one repo,
often the right one. The costs checkride addresses are mostly fleet costs and
delegation costs (CI gates, agents). A single human, in a single repo, who
personally watches every run, feels them least. They start compounding at the
second repo and the first agent.

## The objections, answered

These come up in roughly every adoption conversation, so here they are with
straight answers.

**"It just wraps tools we already run."**
Yes — deliberately, and that's the feature. checkride adds no checker of its
own and never rewrites a tool's output; the core thesis is that each tool's
raw JSON lands in `.check/` untouched (see
[the README](../README.md#the-thesis)). What it adds is everything the tools
don't do *as a group*: a single entry point, an exit-code taxonomy, timeout
and interrupt safety, vacuous-green detection, a stable summary schema, a
baseline ratchet, and a uniform agent contract. "It's just a wrapper" is true
in the same sense that a standard library is "just wrappers around syscalls" —
the aggregation *is* the product. The test of whether that aggregation is
worth anything isn't the size of the wrapping; it's whether you could delete
checkride and keep those properties. You couldn't — you'd be back to a script
pile.

**"It's maintained by one person."**
True, stated in writing rather than discovered later — see the bus-factor
section of [Reliability](./reliability.md). Three things bound the risk.
First, the exposure is thin: checkride is a dev-only dependency with no
runtime dependency on any tool; it can't break your build in production
because it isn't in production. Second, the pin policy means nothing changes
under you — you sit on an exact version until you choose to move, and the
promised surfaces are locked by a contract test suite, not by the maintainer's
memory. Third, the exit price (above) is near zero: if the project were
abandoned tomorrow, every adopting repo keeps working on its pinned version
indefinitely, and can walk away whenever it likes, keeping all its tool
configs. Compare that honestly to the alternative: a bespoke check setup is
*also* maintained by one person — whoever built it — with no contract tests,
no changelog, and no succession doc.

**"This is someone's pet project."**
The provenance of a tool is a fair thing to weigh, but the weighing should be
against the artifact, not the author. The relevant questions are testable:
Does it have a frozen, contract-tested public surface? ([Yes](./contract.md).)
Is the tested envelope stated honestly? ([Yes](./reliability.md) — two
operating systems, two Node versions, four package managers, and Windows
explicitly not claimed.) Is the exit cheap? (Yes — see above.) Does it change
your tools' behavior? (No — it runs your pinned versions against your
configs.) A tool that clears those bars doesn't become worse because a
colleague wrote it; if anything, the maintainer being in the room is the one
bus-factor configuration where the bus is easiest to see coming.

**"We already have a task runner / monorepo tooling."**
Different concern — see the alternatives section above. Keep the task runner;
it makes execution fast. checkride makes the *gate* well-defined. They
compose.

**"Another dependency, another thing to learn."**
The dependency is dev-only, exact-pinned, and runtime-free. The thing to
learn is one command — and it *replaces* the fifteen per-repo script names
that were the actual learning burden. Net vocabulary goes down, not up. For
the fleet, it goes down once per person instead of once per person per repo.

**"Our repo is special."**
Every repo believes this, and checkride's design assumes it's partly true:
slots are zero-config-detected, any slot can be disabled or swapped for an
alternate adapter, custom checks slot in before or after the catalogue, and
`detect` lets shared config stand down gracefully where a tool is absent. The
question isn't whether your repo has unique needs — it's whether "how we run
the linter" is really one of them. It almost never is, and every unique thing
that genuinely is unique fits in a custom check without forking the contract.

**"What about non-TypeScript checks? Our repo is a TS frontend plus a
backend in a compiled server language."**
The blessed slots are TypeScript-first, but the pipeline isn't: a
[custom check](../README.md#custom-checks) runs any command with any
arguments, and its exit code participates in the gate like every built-in.
The backend's `go vet ./...` or `cargo check` becomes an entry in
`checkride.config.json`, its output lands in `.check/` beside the linter's,
and one `pnpm check` — one exit code — gates the whole repo. A mixed repo
almost always has a `package.json` already (the frontend brought one); if a
repo somehow doesn't, adding one purely to anchor the check harness is a
one-file change. What you give up for the non-TS side is only the blessed
conveniences — scaffolded configs, `fix` integration, baseline fingerprints —
not the contract: exit-code taxonomy, timeouts, atomic artifacts, the
summary schema, and the agent contract all apply to custom checks unchanged.

**"Adopting it means fixing years of debt first."**
No — this is exactly what the [baseline](../README.md#baseline) exists for.
`checkride init --baseline` grandfathers today's findings so the repo starts
green, while new findings fail immediately and fixed ones are ratcheted out
of the baseline permanently. Adoption cost is an afternoon; the debt is paid
down on whatever schedule the team chooses, with the ratchet guaranteeing it
never silently grows back.

**"What if we disagree with a blessed default?"**
The blessed defaults exist so `init` can scaffold something coherent, not to
bind you. Every opinion is overridable in `checkride.config.json` — alternate
adapters, disabled slots, custom checks, per-check timeouts. The one opinion
that isn't negotiable is the contract itself: exit 0 means done, raw output
stays raw. If a team disagrees with *that*, it doesn't want a definition of
done, and no tool choice will paper over the difference.

## The honest scope

checkride is not for everyone, and pretending otherwise would undercut the
rest of this page.

- It's TypeScript-first. Custom checks let a mixed repo gate its non-TS half
  (see the objection above), but the blessed adapters, scaffolding, and
  baseline all speak TypeScript; a first-class polyglot story may come, but
  it isn't claimed today.
- It runs the pipeline once from the repo root — there is no per-package
  orchestration. A very large monorepo whose teams need independently gated
  packages wants a task runner *underneath* whatever definition of done it
  adopts.
- A solo developer with one repo and no agents gets the least from it — the
  returns are in fleets, gates, and delegation.

Inside that scope, the pitch reduces to one line: **stop re-deciding what
"done" means in every repo, and start compounding the decision instead.**

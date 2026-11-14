# Spec: checkride 1.0.0

**Status:** draft, written 2026-11-13 against 0.22.0. Nothing here is built.
The work ships in 0.x minors, and 1.0.0 is tagged only once all of it is built
and has held still ([D4 (minors-then-one)](#d4)).

**Provenance:** two consumers are about to lean on checkride harder than any
has so far. A team at the maintainer's work wants several developers merging
agent-written code without reading hundreds of changed files by hand, and
runciter's scheduler (its repo's
`docs/specs/long-horizon-builder-roadmap.md`) lands each step through a merge queue whose only verdict is checkride's exit
code. Both want a caret range and a contract that no longer moves. A survey on
the day this was written found:

1. **No open issue, and 16 contract tests.** The feature set is enough for
   1.0. What's missing is around it: a guard, and docs a new team can
   follow.
2. **`baseline diff` can't fail.** It exits 0 whether or not a change adds
   keys, so nothing stops a pull request from grandfathering its own findings.
3. **A prerelease tag would publish as `latest`.** `publish.yaml` runs
   `npm publish` with no `--tag`, so a release candidate isn't a safe way to
   soak. The 0.x minors are.
4. **One config and one baseline for the whole repo.** Targets already let a
   web app and a Go API run different checks, but every team edits the same
   two root files. The baseline was clobbered by a back-merge at work in
   August, and runciter's steps would each prune the same file from separate
   worktrees.
5. **The README is 992 lines.** It holds the reference for commands, slots,
   config and the baseline, most of it repeated under `docs/`. A new reader
   meets the install paths for four package managers, mise and the binary
   before they see a run.
6. **The consumers are spread across ten minor versions.** atis pins 0.12.5,
   volley 0.14.0, plumbbob and runciter 0.20.0. None imports anything but the
   package root.

Confirm each site by name against HEAD before editing.

## Frame

- **Problem:** checkride is feature-complete for a 1.0, but a team can't yet
  adopt it on the strength of its front page, a pull request can still grow
  the baseline unseen, and a large monorepo funnels every team through two
  root files.
- **Smallest thing that solves it:** freeze the contract as it stands, add
  the one guard, let a target keep its config
  and its baseline in its own directory, and cut the README down to the
  shortest path from nothing to a green run.
- **Done looks like:**
  - `checkride baseline diff origin/main --fail-on-added` exits 1 on a change
    that adds a key, and the CI recipe uses it;
  - every phase below has shipped in a 0.x minor;
  - the work monorepo, runciter, plumbbob, volley and atis each run a full
    green check on the last of those minors, and it has gone fourteen days
    with no entry under a Contract heading;
  - a repo with two local targets passes with a root config that names only
    their roots, and a ratchet in one target leaves the other's baseline file
    untouched;
  - the README is under 200 lines and its first code block is the install;
  - `pnpm check`, `pnpm test:e2e` and a full mutation run are green on the
    commit that gets tagged `v1.0.0`, which differs from that minor only in
    its version and its pin policy.
- **Explicitly NOT doing:**
  - a new slot, pack or adapter;
  - a second baseline schema version, a merge driver or `merge=union`;
  - Windows or musl binaries;
  - a checkride process that spawns another checkride as a product feature
    ([D7 (one-orchestrator)](#d7));
  - a target nested inside another target of the same pack
    ([D11 (no-same-pack-nesting)](#d11)).

## Decisions

### The freeze

- <a id="d1"></a>**D1 (freeze-as-is)**: 1.0.0 freezes the surfaces in
  `docs/contract.md` as they stand, with both `schema_version` fields at `1`,
  *because* every consumer already reads them and no open issue asks for a
  break. Everything this spec adds is additive under the contract's own rule,
  except the barrel trim in [D5 (root-export-only)](#d5), which is a break a
  0.x minor may make.
- <a id="d2"></a>**D2 (fail-on-added)**: `baseline diff [<ref>]
  --fail-on-added` exits 1 when the working tree's baseline holds a key
  `<ref>`'s lacks, or counts a key more often. Without the flag it exits 0 as
  it does today. Exit 1 and never 2, *because* a grown baseline is a
  verification failure, which is what the 1-versus-2 split promises a gate.
  The flag joins `--json` and `--suite`, and walks every baseline file once
  [D10 (baseline-shards)](#d10) lands.
- <a id="d3"></a>**D3 (baseline-v1-stays)**: the baseline keeps schema
  version 1, *because* the file carries its own version and a line-oriented
  format can arrive later as version 2 without waiting on a major release of
  the package. `recover` and the red-run hint stay the answer to a bad merge.
- <a id="d4"></a>**D4 (minors-then-one)**: every change here ships in a 0.x
  minor, under the exact-pin policy the contract has today, and 1.0.0 is cut
  from the last of them once it's stable. Stable means every phase is built,
  the five consumers run green on that minor, and fourteen days pass with no
  entry under a Contract heading. *Because* a 0.x minor may still break, so
  a mistake in local targets or the shards costs a minor to fix and not a
  major. No release candidate is published: `publish.yaml` sends any tag to
  `latest`, and the minors are the candidates.
- <a id="d5"></a>**D5 (root-export-only)**: the programmatic surface stays the
  package root and `checkride/findings`, *because* the four consumers import
  the root alone. Phase 1 reads each consumer's imports and drops from the
  barrel any name none of them uses and no doc shows in an example. A name
  that stays is bound for the whole major.
- <a id="d6"></a>**D6 (platforms-as-claimed)**: macOS and glibc Linux on arm64
  and x64 are the claimed platforms, as `docs/reliability.md` says today.
  Windows isn't supported and isn't planned. No musl binary ships, and a
  musl Linux such as Alpine takes the npm channel, as `docs/distribution.md`
  says today (settled 2026-11-13, [Q2 (work-platforms)](#q2)). Node 26, which the work team runs, needs
  nothing: `engines` allows it, CI's matrix runs the full suite on it on both
  systems, and the binary embeds it.

### Config that lives with the code

- <a id="d7"></a>**D7 (one-orchestrator)**: a hierarchy of configs is
  composed into one run, and checkride never spawns itself, *because* the
  contract promises one summary, one exit code and one schedule. A nested
  process would write a second summary under the first, run the repo-scope
  slots twice, and start its own workers beside the parent's. A custom check
  whose `command` is `checkride` still works as any command does, and no doc
  recommends it.
- <a id="d8"></a>**D8 (local-targets)**: a target entry may say
  `"local": true`, and then `<root>/checkride.config.json` holds the rest of
  that target: its `lang`, `checks`, `include`, `exclude`, `timeout` and
  `extends`.

  ```json
  { "targets": { "web": { "root": "web", "local": true }, "api": { "root": "services/api", "local": true } } }
  ```

  The local file ranks where the target's own `checks` rank today, above
  `packs.<pack>.checks` and the top level. It may not hold `targets`,
  `schemas`, `unclaimed` or anything else that belongs to the whole repo, and
  a path it names is read under the containment rule in `src/contain.ts`. The
  flag is explicit, *because* repos already hold nested configs that mean
  something else: this one has twelve under `examples/`, and every fixture
  repo has one.
- <a id="d9"></a>**D9 (groups-are-files-not-names)**: a root config may list
  `"include": ["services"]`, and `services/checkride.config.json` then
  declares targets with roots relative to itself. Target names stay one flat
  set across the repo, and a name declared twice is a config error naming
  both files. The hierarchy is in where the files sit and never in the names,
  *because* `--only api`, `api:lint` in the summary and `.check/api/` are
  contract surfaces, and a path-shaped name would change all three. An
  included file may include others; a cycle is a config error.
- <a id="d10"></a>**D10 (baseline-shards)**: a local target keeps its keys in
  `<root>/checkride.baseline.json`, a schema version 1 file holding only that
  target's checks. The repo-scope slots and every target that isn't local
  stay in the root file. A full green run ratchets each file on its own.
  `baseline`, `baseline --versions`, `baseline diff`, `recover` and the
  protect hook cover every shard. *Because* two changes in two targets then
  edit two files, which is what the August incident and runciter's merge
  queue both need, and a code owner can be named per shard. This is the
  largest piece in the spec.
- <a id="d11"></a>**D11 (no-same-pack-nesting)**: two targets of one pack
  still can't nest, *because* the outer target's tool reads the inner one's
  files, so each finding would be reported and baselined twice. A module
  inside a package that wants different rules gets them from the tool's own
  overrides, or from a custom check gated by `detect`. If large modules turn
  out to need their own config, the evidence from the work monorepo decides
  the shape after 1.0.
- <a id="d12"></a>**D12 (suites-unchanged)**: a named suite keeps its three
  fixed paths at the repo root. A suite's config may use `local` and
  `include` as the default one does, and a local target's shard for the suite
  `evals` is `<root>/checkride.evals.baseline.json`.

### Docs

- <a id="d13"></a>**D13 (readme-is-the-happy-path)**: the README holds the
  pitch, one install for a repo that exists, what a run prints, what an agent
  gets from it, and links. Under 200 lines. Every other install path moves to
  `docs/getting-started.md` and `docs/distribution.md`, which hold them
  already. *Because* a reader decides in the first screen, and today that
  screen is four package managers.
- <a id="d14"></a>**D14 (the-pitch)**: the first lines read as follows, and
  the hero image stays.

  > checkride runs every check your repo has as one command. Exit 0 means the
  > work is done. An agent keeps going until it's green, and a reviewer
  > starts from green.

  Then the two commands, then the output of a real run.
- <a id="d15"></a>**D15 (reference-moves-out)**: the README's reference
  sections move to pages under `docs/`: commands to `cheatsheet.md`, slots
  and adapters to `tools.md`, the `.check/` layout to `contract.md`, and two
  new pages, `configuration.md` and `baseline.md`, for the sections that have
  no home yet. Every link into a README anchor is repointed in the same
  commit, and the `links` check proves it.
- <a id="d16"></a>**D16 (team-page)**: a new `docs/team.md` is the page for a
  team that merges agent-written code. It holds a required status check with
  `--strict`, `--annotate github`, the baseline guard, `--changed` on push
  and a full run in the merge queue, a `CODEOWNERS` line for
  `checkride*.json`, and local targets per team. It says what a green gate
  leaves for a reviewer to read, and cites runciter's finding that a fresh
  reviewer found blocking defects under a green check in five of seven lane
  reviews.
- <a id="d17"></a>**D17 (docs-by-job)**: `docs/README.md` lists pages under
  four jobs: start, adopt on a team, run in CI, and reference.
  `getting-started.md` shrinks to the ten minutes after the README, and the
  rest of its 847 lines move to the pages that own each topic.

### The rest

- <a id="d18"></a>**D18 (step-summary)**: `--summary github` writes a
  markdown table of the run to the file `GITHUB_STEP_SUMMARY` names: each
  check, its status and time, the count of new findings, and the baseline
  keys added and removed against the base. *Because* the people the work
  team wants to relieve read the pull request page, and annotations alone
  show findings without the verdict.
- <a id="d19"></a>**D19 (support-policy)**: a `SECURITY.md` says how to
  report a problem and which versions get fixes: the latest 1.x. The contract
  gains one paragraph on what a minor may do: add a field, a flag, an adapter
  or a pack, and never turn a green repo red with the same tools and config.
- <a id="d20"></a>**D20 (upgrade-note)**: the 1.0.0 changelog entry opens
  with what a repo on 0.x does to upgrade, which is to change the pin. Each
  of the maintainer's repos moves during the soak as the proof.

## Open questions

None is open. Each was settled on its lean on 2026-11-13, and the anchors stay
so the links above hold.

- <a id="q1"></a>**Q1 (what-init-pins)**: after 1.0, `init` writes a caret,
  `"checkride": "^1.0.0"`, in `package.json`, where the lockfile holds the
  exact copy, and an exact version in `mise.toml`, which has no lockfile.
  Until 1.0.0 it writes the exact pin it writes today.
- <a id="q2"></a>**Q2 (work-platforms)**: Windows isn't supported, and Alpine
  works around the missing binary through npm. See
  [D6 (platforms-as-claimed)](#d6).
- <a id="q3"></a>**Q3 (node-floor)**: raising the Node floor is a minor
  change, announced one minor ahead, and never below a Node line that still
  gets security fixes. The binary carries its own Node, so only the npm
  channel is affected. The contract's minor-version paragraph
  ([D19 (support-policy)](#d19)) says so.
- <a id="q4"></a>**Q4 (running-inside-a-target)**: run from `web/`, where a
  local config sits, `checkride` walks up to the config that claims the
  directory and runs as `--only web` from the repo root, and says so on
  stderr. Without that, a developer in `web/` gets a second, wrong verdict
  with paths keyed from the wrong root.
- <a id="q5"></a>**Q5 (runciter-and-the-prune)**: runciter commits the
  ratchet's prune with each step once shards exist, since the shard sits
  inside the step's seam. Phase 2's last step measures it, and the result is
  recorded in runciter's scheduler note, not here.

## Work plan

Each step is one commit that leaves `pnpm check` green.

### Phase 1: the guard and the surface (0.23.0)

1. **Add `--fail-on-added` to `baseline diff`.**
   Done when: a contract test shows exit 1 on an added key and on a grown count, exit 0 on removals alone, and exit 0 without the flag.
2. **Survey the consumers and trim the barrel.**
   Done when: `test/contract/exports.contract.test.ts` lists exactly the names that stay, and the contract's Programmatic surface section matches it.
3. **Add `--summary github`.**
   Done when: a contract test pins the table's columns, and this repo's own CI run shows it.

### Phase 2: config that lives with the code (0.24.0)

1. **Read a local target's config.**
   Done when: an example repo with `web` and `api` as local targets passes, and a contract test covers the ranking, the refused keys and the containment rule.
2. **Read included files, with flat names.**
   Done when: a name declared in two files is exit 2 naming both, a cycle is exit 2, and `doctor` lists each target with the file that declares it.
3. **Run from inside a target.**
   Done when: `checkride` run from `web/` writes the same `web:` entries and keys as `checkride --only web` from the root, into the root's `.check/`, and says on stderr which config it found.
4. **Shard the baseline.**
   Done when: a ratchet in `web` leaves `api`'s file byte-identical, and `baseline diff`, `recover`, `baseline --versions` and the protect hook each have a contract test over two shards.
5. **Prove it under a merge queue.**
   Done when: runciter's sandbox repo, with a baseline in each of its two packages, lands two overlapping-in-time steps with no rebuild caused by a baseline file.

### Phase 3: docs (0.25.0)

Docs come after the config work, so the pages describe what a team will run.

1. **Move the README's reference sections out.**
   Done when: `configuration.md` and `baseline.md` exist, no doc links to a README anchor that's gone, and the `links` check is green.
2. **Rewrite the README to the happy path.**
   Done when: the README is under 200 lines, opens with D14's pitch, and its install block is two commands.
3. **Write `docs/team.md`, and reorder `docs/README.md` by job.**
   Done when: the team page's workflow file is one the `snippets` or actionlint check covers, it walks the web-and-API repo below, and every page under `docs/` is reachable from the index.
4. **Add `SECURITY.md`.**
   Done when: it's linked from the README and the contract.

### Phase 4: the soak, then 1.0.0

1. **Move the five consumers to the last minor.**
   Done when: the work monorepo, runciter, plumbbob, volley and atis each record a full green run on it.
2. **Fix what the soak finds, in patches or another minor.**
   Done when: fourteen days pass with no entry under a Contract heading.
3. **Rewrite the pin policy, add the minor-version promise, and tag.**
   Done when: `docs/contract.md`, `docs/reliability.md` and what `init` writes agree on the answer to Q1, `pnpm check`, `pnpm test:e2e` and a full mutation run are green on one commit, and `/version major` has tagged it.

## A web app beside an API

The repo the team page walks, and the case phase 2 is built for:

```text
checkride.config.json          targets: web and api, both local; the repo-scope checks
checkride.baseline.json        keys for docs, spell, struct and the other repo-scope checks
web/checkride.config.json      lang ts, and web's own checks
web/checkride.baseline.json    web's keys
services/api/checkride.config.json     lang go, and the API's own checks
services/api/checkride.baseline.json   the API's keys
.check/summary.json            the last run, whatever it covered
.check/web/                    the raw output of web's checks
.check/api/                    the raw output of the API's checks
```

A frontend developer runs `checkride --only web`, or plain `checkride` from
inside `web/`, and no Go tool starts. `checkride --changed` does the same
without naming anything: it skips every check of a target nothing changed
under. Each of these is a partial run. Its summary says `partial: true`, it
leaves the other target's files under `.check/` as they were, and it never
ratchets a baseline. The full run, every target and the repo-scope checks, is
what CI and the merge queue run, and it's the only one whose exit 0 means
done.

`.check/` is ignored by git, so two developers never share one. Within one
checkout the only file both kinds of run write is `summary.json`, and it
describes the last run alone.

## After 1.0

Recorded so they aren't lost, and not planned here:

- **Which changed files no check read.** A report of the paths in a diff
  that sit outside every target and every repo-scope slot's reach, so a
  reviewer knows where to read first. This may be atis's job.
- **A line-oriented baseline, schema version 2.**
- **Per-module config inside one package**, if D11's answer turns out to be
  too little.

One correction for runciter's roadmap: its contracts table says checkride
doesn't promise the raw per-tool artifacts atis reads. It does. The contract's
"Raw output stays authoritative" paragraph names the files and promises the
bytes are the tool's own.

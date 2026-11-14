# checkride 1.0.0: the guard, local targets, docs, the soak

**Phase** (your own bookkeeping while framing): frame
**Size:** large
**Scope:** v1

*Source: [docs/spec-v1.md](../../../docs/spec-v1.md), the draft of 2026-11-13, absorbed whole.
Its Frame and its decisions D1 to D20 and Q1 to Q5 appear below under their own ids, each
settled and none reopened. The spec stays the design record; this file is the live plan.*

**Baseline.** The spec was written against checkride 0.22.0 (`e43b396`), which is this
session's baseline. Confirm each site by name against HEAD before editing.

**What the survey found** (2026-11-13, the reason for each piece of work):

1. No open issue, and 16 contract tests. The feature set is enough for 1.0; what's missing is a
   guard, and docs a new team can follow.
2. `baseline diff` can't fail. It exits 0 whether or not a change adds keys
   (`src/baseline-command.ts`, `runBaselineDiff`), so a pull request can grandfather its own
   findings.
3. A prerelease tag would publish as `latest`: `publish.yaml` runs `npm publish` with no
   `--tag`. The 0.x minors are the candidates.
4. One config and one baseline for the whole repo. Every team edits the same two root files.
   The baseline was clobbered by a back-merge at work in August, and runciter's steps would each
   prune the same file from separate worktrees.
5. The README is 992 lines, most of it reference repeated under `docs/`.
6. The consumers are spread across ten minors: atis pins 0.12.5, volley 0.14.0, plumbbob and
   runciter 0.20.0. None imports anything but the package root.

**What reading HEAD added** (2026-11-13, facts the steps lean on):

- A target entry takes `lang, root, include, exclude, checks, note` today
  (`src/targets/resolve.ts`, `TARGET_KEYS`). `timeout` and `extends` in a local file are new at
  target level.
- No top-level `include` key exists. At target level `include` and `exclude` are file globs, and
  the run flag `--include` opts checks in. The root `include` of
  [D9 (groups-are-files-not-names)](#d9) is a third meaning, on a key that is free.
- Config loading never walks up: `loadConfig` reads `join(cwd, file)`.
- The baseline path is one field, `Suite.baselineFile`, and every caller passes
  `(cwd, suite.baselineFile)`. A target's keys sit under `slots["<target>:<slot>"]`.
- `src/protect.ts`, the generated hook script (`src/agent-setup/scripts.ts`) and Cursor's
  matcher (`src/agent-setup/cursor.ts`) match a baseline only at the repo root. Claude's deny
  rules already use `**/`.
- The `links` check strips `#fragment` before it tests a link, so it can't see a dead anchor.
  `docs/ci.md` links to `../README.md#agent-integration`, which is dead today.
- There is no actionlint slot, and `snippets` typechecks only marked TypeScript fences.
- A run knows a base ref only under `--changed`, and `ci.yml` checks out with the default
  fetch depth.
- `docs-currency.test.ts` pins the README's slot table and its opt-in sentence.
- `baseline diff` and `recover` read no config and take no `--config`: each opens
  `suite.baselineFile`. `baseline diff <ref>` compares against the commit `<ref>` names, while
  `--changed` measures from the merge base.
- `init` pins checkride in a new TypeScript scaffold's `package.json` and in a Go or Rust
  scaffold's `mise.toml`. Existing-repo adoption writes no pin.

## Frame

- **Problem:** checkride is feature-complete for a 1.0, but a team can't yet adopt it on the
  strength of its front page, a pull request can still grow the baseline unseen, and a large
  monorepo funnels every team through two root files.
- **Smallest thing that solves it:** freeze the contract as it stands, add the one guard, let a
  target keep its config and its baseline in its own directory, and cut the README down to the
  shortest path from nothing to a green run.
- **Done looks like:**
  - `checkride baseline diff origin/main --fail-on-added` exits 1 on a change that adds a key,
    and the CI recipe uses it;
  - every phase has shipped in a 0.x minor: 0.23.0, 0.24.0, 0.25.0;
  - the work monorepo, runciter, plumbbob, volley and atis each run a full green check on the
    last release before step 19, and it has gone fourteen days with no entry under a Contract
    heading, counted as [D32 (soak-clock)](#d32) counts them;
  - a repo with two local targets passes with a root config that names only their roots, and a
    ratchet in one target leaves the other's baseline file untouched;
  - the README is under 200 lines and its first code block is the install;
  - `pnpm check`, `pnpm test:e2e` and a full mutation run are green on the build's last
    commit, which differs from the last minor only in its pin policy and is ready to tag;
  - the build ends there, untagged: 1.0.0 is Rob's call after it
    ([D30 (major-after-the-build)](#d30)).
- **Explicitly NOT doing:**
  - a new slot, pack or adapter;
  - a second baseline schema version, a merge driver or `merge=union`;
  - Windows or musl binaries;
  - a checkride process that spawns another checkride as a product feature
    ([D7 (one-orchestrator)](#d7));
  - a target nested inside another target of the same pack
    ([D11 (no-same-pack-nesting)](#d11));
  - after 1.0, recorded so they aren't lost: a report of which changed files no check read
    (maybe atis's job), a line-oriented baseline as schema version 2, and per-module config
    inside one package.

## Architecture sketch

The repo phase 2 is built for, and the one `docs/team.md` walks:

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

A frontend developer runs `checkride --only web`, or plain `checkride` from inside `web/`, and
no Go tool starts. `checkride --changed` skips every check of a target nothing changed under.
Each of these is a partial run: its summary says `partial: true`, it leaves the other target's
files under `.check/` as they were, and it never ratchets a baseline. The full run, every target
and the repo-scope checks, is what CI and the merge queue run, and it's the only one whose exit
0 means done. `.check/` is ignored by git; within one checkout the only file both kinds of run
write is `summary.json`, and it describes the last run alone.

One orchestrator composes every config file into one run:

```text
root config ── include ──> services/checkride.config.json ── targets (roots relative to it)
     │
     └─ targets.<name> { root, local: true } ──> <root>/checkride.config.json (lang, checks, …)
                                             └──> <root>/checkride[.<suite>].baseline.json
one run · one summary · one exit code · target names one flat set
```

## Decisions

### The freeze

- <a id="d1"></a>**D1 (freeze-as-is)**: 1.0.0 freezes the surfaces in `docs/contract.md` as they stand, with both `schema_version` fields at `1`; everything here is additive under the contract's own rule except the barrel trim of [D5 (root-export-only)](#d5), a break a 0.x minor may make, *because* every consumer already reads them and no open issue asks for a break.
- <a id="d2"></a>**D2 (fail-on-added)**: `baseline diff [<ref>] --fail-on-added` exits 1 when the working tree's baseline holds a key `<ref>`'s lacks, or counts a key more often; without the flag it exits 0 as today. Exit 1 and never 2. The flag joins `--json` and `--suite`, and walks every baseline file once [D10 (baseline-shards)](#d10) lands, *because* a grown baseline is a verification failure, which is what the 1-versus-2 split promises a gate.
- <a id="d3"></a>**D3 (baseline-v1-stays)**: the baseline keeps schema version 1, and `recover` and the red-run hint stay the answer to a bad merge, *because* the file carries its own version and a line-oriented format can arrive later as version 2 without a major release of the package.
- <a id="d4"></a>**D4 (minors-then-one)**: every change ships in a 0.x minor under today's exact-pin policy, and 1.0.0 is cut from the last of them once it's stable: every phase built, the five consumers green on that minor, and fourteen days with no entry under a Contract heading. No release candidate is published, *because* a 0.x minor may still break, so a mistake in local targets or the shards costs a minor and not a major, and `publish.yaml` sends any tag to `latest`.
- <a id="d5"></a>**D5 (root-export-only)**: the programmatic surface stays the package root and `checkride/findings`. Phase 1 reads each consumer's imports and drops from the barrel any name none of them uses and no doc shows in an example; a name that stays is bound for the whole major, *because* the four consumers import the root alone.
- <a id="d6"></a>**D6 (platforms-as-claimed)**: macOS and glibc Linux on arm64 and x64 are the claimed platforms, as `docs/reliability.md` says. Windows isn't supported or planned, no musl binary ships, and Alpine takes the npm channel. Node 26 needs nothing, *because* `engines` allows it, CI's matrix runs it and the binary embeds it.

### Config that lives with the code

- <a id="d7"></a>**D7 (one-orchestrator)**: a hierarchy of configs is composed into one run, and checkride never spawns itself; a custom check whose `command` is `checkride` still works as any command does and no doc recommends it, *because* the contract promises one summary, one exit code and one schedule, and a nested process would write a second summary, run the repo-scope slots twice and start its own workers.
- <a id="d8"></a>**D8 (local-targets)**: a target entry may say `"local": true` (`{ "targets": { "web": { "root": "web", "local": true } } }`), and then `<root>/checkride.config.json` holds the rest of that target: its `lang`, `checks`, `include`, `exclude`, `timeout` and `extends`. The local file ranks where the target's own `checks` rank today, above `packs.<pack>.checks` and the top level. It may not hold `targets`, `schemas`, `unclaimed` or anything else that belongs to the whole repo, and a path it names is read under the containment rule in `src/contain.ts`. The flag is explicit, *because* repos already hold nested configs that mean something else: this one has twelve under `examples/`, and every fixture repo has one.
- <a id="d9"></a>**D9 (groups-are-files-not-names)**: a root config may list `"include": ["services"]`, and `services/checkride.config.json` then declares targets with roots relative to itself. Target names stay one flat set across the repo, and a name declared twice is a config error naming both files. An included file may include others; a cycle is a config error. The hierarchy is in where the files sit and never in the names, *because* `--only api`, `api:lint` in the summary and `.check/api/` are contract surfaces, and a path-shaped name would change all three.
- <a id="d10"></a>**D10 (baseline-shards)**: a local target keeps its keys in `<root>/checkride.baseline.json`, a schema version 1 file holding only that target's checks. The repo-scope slots and every target that isn't local stay in the root file. A full green run ratchets each file on its own. `baseline`, `baseline --versions`, `baseline diff`, `recover` and the protect hook cover every shard, *because* two changes in two targets then edit two files, which is what the August incident and runciter's merge queue both need, and a code owner can be named per shard.
- <a id="d11"></a>**D11 (no-same-pack-nesting)**: two targets of one pack still can't nest; a module that wants different rules gets them from the tool's own overrides or a custom check gated by `detect`, *because* the outer target's tool reads the inner one's files, so each finding would be reported and baselined twice.
- <a id="d12"></a>**D12 (suites-unchanged)**: a named suite keeps its three fixed paths at the repo root. A suite's config may use `local` and `include` as the default one does, and a local target's shard for the suite `evals` is `<root>/checkride.evals.baseline.json`, *because* a suite is a name that fixes paths, and the shard follows the same naming.

### Docs

- <a id="d13"></a>**D13 (readme-is-the-happy-path)**: the README holds the pitch, one install for a repo that exists, what a run prints, what an agent gets from it, and links, in under 200 lines. Every other install path lives in `docs/getting-started.md` and `docs/distribution.md`, *because* a reader decides in the first screen, and today that screen is four package managers.
- <a id="d14"></a>**D14 (the-pitch)**: the README's first lines read "checkride runs every check your repo has as one command. Exit 0 means the work is done. An agent keeps going until it's green, and a reviewer starts from green." Then the two commands, then the output of a real run, and the hero image stays, *because* that is the wording the maintainer settled.
- <a id="d15"></a>**D15 (reference-moves-out)**: the README's reference sections move to pages under `docs/`: commands to `cheatsheet.md`, slots and adapters to `tools.md`, the `.check/` layout to `contract.md`, and two new pages, `configuration.md` and `baseline.md`. Every link into a README anchor is repointed in the same commit, *because* each of those sections is repeated under `docs/` already or has no home but the front page.
- <a id="d16"></a>**D16 (team-page)**: a new `docs/team.md` is the page for a team that merges agent-written code: a required status check with `--strict`, `--annotate github`, the baseline guard, `--changed` on push and a full run in the merge queue, a `CODEOWNERS` line for `checkride*.json`, and local targets per team. It says what a green gate leaves for a reviewer to read, and cites runciter's finding that a fresh reviewer found blocking defects under a green check in five of seven lane reviews, *because* that team is the reader the 1.0 is for.
- <a id="d17"></a>**D17 (docs-by-job)**: `docs/README.md` lists pages under four jobs: start, adopt on a team, run in CI, and reference. `getting-started.md` shrinks to the ten minutes after the README, and the rest of its 847 lines move to the pages that own each topic, *because* a reader arrives with a job and not a page name.

### The rest

- <a id="d18"></a>**D18 (step-summary)**: `--summary github` writes a markdown table of the run to the file `GITHUB_STEP_SUMMARY` names: each check, its status and time, the count of new findings, and the baseline keys added and removed against the base, *because* the people the work team wants to relieve read the pull request page, and annotations alone show findings without the verdict.
- <a id="d19"></a>**D19 (support-policy)**: a `SECURITY.md` says how to report a problem and which versions get fixes: the latest 1.x. The contract gains one paragraph on what a minor may do: add a field, a flag, an adapter or a pack, and never turn a green repo red with the same tools and config, *because* a caret range is only safe against a written promise.
- <a id="d20"></a>**D20 (upgrade-note)**: the 1.0.0 changelog entry opens with what a repo on 0.x does to upgrade, which is to change the pin, *because* each of the maintainer's repos moves during the soak as the proof.

### Settled questions, carried from the spec

- <a id="q1"></a>**Q1 (what-init-pins)**: *resolved:* 2026-11-13, after 1.0 `init` writes a caret, `"checkride": "^1.0.0"`, in `package.json`, where the lockfile holds the exact copy, and an exact version in `mise.toml`, which has no lockfile; until 1.0.0 it writes the exact pin it writes today.
- <a id="q2"></a>**Q2 (work-platforms)**: *resolved:* 2026-11-13, Windows isn't supported, and Alpine works around the missing binary through npm ([D6 (platforms-as-claimed)](#d6)).
- <a id="q3"></a>**Q3 (node-floor)**: *resolved:* 2026-11-13, raising the Node floor is a minor change, announced one minor ahead, and never below a Node line that still gets security fixes; only the npm channel is affected, and the contract's minor-version paragraph ([D19 (support-policy)](#d19)) says so.
- <a id="q4"></a>**Q4 (running-inside-a-target)**: *resolved:* 2026-11-13, run from `web/`, where a local config sits, `checkride` walks up to the config that claims the directory, runs as `--only web` from the repo root, and says so on stderr; without that a developer in `web/` gets a second, wrong verdict with paths keyed from the wrong root.
- <a id="q5"></a>**Q5 (runciter-and-the-prune)**: *resolved:* 2026-11-13, runciter commits the ratchet's prune with each step once shards exist, since the shard sits inside the step's seam; the merge-queue proof measures it, and the result is recorded in runciter's scheduler note, not here.

### Made at the plan

- <a id="d21"></a>**D21 (stops-cut-the-ranges)**: the four release ranges of the brief are cut into six build ranges, one at each stop the brief names, *because* a plumbbob range ends where a human call is due, and releases 0.23.0 and 0.24.0 each hold a call before their last step.
- <a id="d22"></a>**D22 (shards-in-six)**: [D10 (baseline-shards)](#d10) lands as steps 8 to 13: the shard map and the run's read, the ratchet, `baseline` with `--versions`, `baseline diff`, `recover`, then the protect hook with `doctor`. Between them a repo with no local target behaves byte for byte as on 0.23.0, and local targets are unreleased until step 13 lands, *because* each of the seven readers and writers is its own review, and only the released state has to be whole.
- <a id="d23"></a>**D23 (no-commit-outside)**: the merge-queue proof and the five consumer moves make no step here, and each is a hand-over at a range's stop, *because* a step is a commit in this repo and that work lands in runciter, plumbbob, volley, atis and the work monorepo.
- <a id="d24"></a>**D24 (soak-fixes-are-added)**: what the soak finds is added with `/plumbbob:step` before step 19 and ships as a patch or another minor, and the fourteen days restart only on an entry under a Contract heading, *because* the fixes can't be planned before the soak finds them.
- <a id="d25"></a>**D25 (summary-base)**: `--summary github` diffs the baseline against the base `--changed` resolves: `CHECKRIDE_BASE`, then the config's `changedBase`, then `origin/main`. When the base can't be read the table says so in place of the two counts, and when `GITHUB_STEP_SUMMARY` is unset the flag warns on stderr and writes nothing; neither changes the exit code, *because* a full run has no base of its own and a summary must never change a verdict.
- <a id="d26"></a>**D26 (anchor-proof)**: `test/integration/docs-currency.test.ts` proves every link to `README.md#…` from `docs/`, `examples/` and the fixtures names a heading the README has, and the `links` check keeps ignoring fragments, *because* teaching `links` to check them would turn green consumer repos red.
- <a id="d27"></a>**D27 (workflow-cover)**: the team page's workflow is a real file, `examples/local-targets/.github/workflows/check.yaml`, and `docs-currency.test.ts` asserts the page's fenced block equals it byte for byte and parses as YAML naming the flags the page promises, *because* no check reads YAML fences and a new actionlint slot is out of scope ([C9 (out-of-scope)](#c9)).
- <a id="d28"></a>**D28 (ratchet-moves-keys)**: the read honours a local target's keys still in the root baseline, the next full green run's ratchet writes them to the shard and prunes them from the root, `doctor` names the stray keys until then, and `checkride baseline` moves them at once, *because* turning a target local must not turn its grandfathered findings red.
- <a id="d29"></a>**D29 (suite-local-file)**: under a named suite a local target's config is `<root>/checkride.<suite>.config.json`, the file name the suite fixes at the repo root, *because* it follows the shard's naming and a suite never reads the default suite's local file.
- <a id="d30"></a>**D30 (major-after-the-build)**: the build ends when step 20 lands, and `/version major` is no part of it: no step, stop or hand-over runs it, proposes it or waits on it. Rob calls the major bump himself after the build, and may make more changes first; the gates of [D4 (minors-then-one)](#d4) and the green runs of step 20 are then re-run on whatever commit he tags, *because* Rob said so at the plan pause (2026-11-13) and the tag is the one step that can't be taken back.
- <a id="d31"></a>**D31 (guard-stays-strict)**: `--fail-on-added` has no override, and a `<ref>` with no baseline file reads as empty. `docs/ci.md` and `docs/team.md` run the guard as its own job outside the required set, so a code owner of the baseline file merges over a red guard on purpose, *because* adoption, a new target over old code and a tool upgrade each add keys honestly, and an override inside the tool would be the loophole the flag closes ([Q11 (guard-and-wanted-growth)](#q11)).
- <a id="d32"></a>**D32 (soak-clock)**: the fourteen days count entries under a Contract heading in a published release, and the entries of steps 19 and 20 are exempt by name. The five consumers are green on the last release published before step 19, whatever its number, and a release with no Contract entry doesn't restart the days, *because* step 20's entry changes the policy and no surface a consumer reads, and without the exemption [D4 (minors-then-one)](#d4) can't be met on the commit Rob tags ([Q12 (soak-clock)](#q12)).
- <a id="d33"></a>**D33 (walk-up-everywhere)**: every command that reads the config walks up from any directory inside a local target or beside an included file, and stops at the git top level. A run narrows to the targets under the directory, the other commands act on the whole repo from its root, and each says on stderr which config it found, *because* `baseline`, `doctor`, `gate` and `fix` read `<cwd>/checkride.config.json` today and would take a local file for a repo's own config, and `recover` and `baseline diff`, which read no config today, read one once shards exist ([D41 (diff-reads-config)](#d41)) ([Q13 (inside-what-exactly)](#q13)).
- <a id="d34"></a>**D34 (included-file-keys)**: an included file holds `targets`, `include`, `note` and `$schema`, and any other key is exit 2 naming the file. Under a suite it is `<dir>/checkride.<suite>.config.json`, *because* everything else belongs to the whole repo, and the name follows [D29 (suite-local-file)](#d29) ([Q14 (included-file-keys)](#q14)).
- <a id="d35"></a>**D35 (local-entry-keys)**: a local target's entry holds `root`, `local` and `note`. Any other key beside `local: true` is exit 2 naming the entry and the local file that should hold it, and a missing local file is exit 2 naming the path, *because* a key in two places has no ranking ([Q15 (local-entry-keys)](#q15)).
- <a id="d36"></a>**D36 (named-config-meets-local)**: a config named by `--config` or `CHECKRIDE_CONFIG` may declare local targets, read at `<cwd>/<root>/`, and its `include` is exit 2. A defaults file sets neither key and `--discover` proposes neither, *because* an included file's roots are relative to a file inside the repo, and a named config can sit outside it ([Q16 (named-config-meets-local)](#q16)).
- <a id="d37"></a>**D37 (shards-move-both-ways)**: the read honours a shard at the root of a declared target that is no longer local, the next full green run's ratchet writes its keys to the root file and deletes the shard, and `checkride baseline` does so at once. `doctor` names a shard no declared target owns, and nothing reads it, *because* [D28 (ratchet-moves-keys)](#d28) carries keys one way only ([Q17 (turning-back)](#q17)).
- <a id="d38"></a>**D38 (security-before-one)**: `SECURITY.md` says "the latest release" in step 18, and step 20 changes it to the latest 1.x, *because* 0.25.0 ships before any 1.x exists ([Q18 (security-before-one)](#q18)).
- <a id="d39"></a>**D39 (summary-in-ci)**: one job passes `--summary github`, ubuntu on Node 24, and `ci.yml` sets `CHECKRIDE_BASE` to the pull request's base on `pull_request` and to `github.event.before` on a push, *because* six matrix jobs would write six tables, and on a push `origin/main` is the commit being checked ([Q19 (summary-in-ci)](#q19)).
- <a id="d40"></a>**D40 (guard-base)**: `baseline diff` keeps comparing the working tree with the commit `<ref>` names, and no flag is added. The recipes in `docs/ci.md` and `docs/team.md` check out with `fetch-depth: 0` and run `checkride baseline diff "$(git merge-base origin/main HEAD)" --fail-on-added`, and say why in one sentence, *because* against the tip of `main` a key `main` pruned after the branch left it reads as added, and the merge base is exact on a pull request's merge commit, a head checkout and a merge queue ([Q20 (guard-base)](#q20)).
- <a id="d41"></a>**D41 (diff-reads-config)**: `baseline diff` and `recover` load the config as a run does: the walk-up, `--suite`, and `--config` or `CHECKRIDE_CONFIG`, which both gain. At `<ref>` they read every shard path that the config at `<ref>` or the working tree's config declares, and a named config stands for both sides. A config that can't be read warns on stderr and falls back to the root file alone, *because* neither reads a config today, shards make both depend on one, and `recover` has to work after the merge that mangled it ([Q21 (diff-reads-config)](#q21)).
- <a id="d42"></a>**D42 (preset-in-local-file)**: the refusal of [D8 (local-targets)](#d8) judges the keys a local file itself writes. From a base it extends the local file takes the keys it may hold, and each other key is dropped with the unread-key warning a config load already gives, naming the base file, *because* a team's shared preset is written for a root config ([Q22 (preset-in-local-file)](#q22)).
- <a id="d43"></a>**D43 (composed-or-as-written)**: local and included files are read where targets are resolved, so a config handed to `runChecks`, a `--config` file and the repo's own compose the same way. `loadConfig`, if step 3 keeps it, returns the root file as written after `extends`, and the contract says so, *because* plumbbob runs checkride in-process and step 3 binds the barrel before step 4 changes what a config is ([Q23 (composed-or-as-written)](#q23)).
- <a id="d44"></a>**D44 (one-root-one-local)**: two local targets at one root are exit 2 naming both, and a local target at the declaring file's own directory is exit 2 naming the file, *because* a root holds one local file, with one `lang` and one shard ([Q24 (one-root-one-local)](#q24)).
- <a id="d45"></a>**D45 (walk-up-without-git)**: with no git work tree there is no walk-up, and a command reads the directory it is run in, as today, *because* [D33 (walk-up-everywhere)](#d33) stops at the git top level, and a walk to the filesystem root could find a stray config ([Q25 (walk-up-without-git)](#q25)).
- <a id="d46"></a>**D46 (summary-variable)**: `CHECKRIDE_SUMMARY` names the summary format when `--summary` doesn't, the gate strips it as it strips `CHECKRIDE_ANNOTATE`, and the table is appended to the file under a heading that names the suite, *because* `ci.yml` runs `pnpm check` in six jobs and one of them sets it, and a second run in a step must not erase the first table ([Q26 (summary-variable)](#q26)).
- <a id="d47"></a>**D47 (mangled-shard)**: a baseline's state is per file. A shard that can't be parsed turns its own target's grandfathered findings red, the warning and the recover hint name it, and every other file masks as usual. No ratchet, move or `checkride baseline` writes over a file it couldn't parse, *because* a bad merge mangles one file, and the working tree's copy is what `recover` unions with ([Q27 (mangled-shard)](#q27)).

## Constraints

- <a id="c1"></a>**C1 (one-green-commit)**: each step is one commit that leaves `pnpm check` at exit 0.
- <a id="c2"></a>**C2 (nothing-reopened)**: every D and Q above is settled; if a step can't be built as decided, stop and say so.
- <a id="c3"></a>**C3 (contract-moves-loudly)**: a change to a surface in `docs/contract.md` updates the contract doc, its test under `test/contract/` and a `### Contract` heading in `CHANGELOG.md` in the same step; a contract test is never edited quietly.
- <a id="c4"></a>**C4 (tests-with-behaviour)**: new behaviour gets tests in the same step: unit tests in `__tests__/`, contract locks in `test/contract/`, and an example under `examples/` for local targets.
- <a id="c5"></a>**C5 (agents-md)**: follow `AGENTS.md`: no classes, named exports, `.js` import extensions, no logic in barrels, no file that nothing imports, no casual dependency.
- <a id="c6"></a>**C6 (foreground-only)**: run stryker and `pnpm test:e2e` in the foreground, never as background tasks; `pnpm check` never runs e2e, so a step whose done-when names an example runs `pnpm test:e2e` before its checkpoint.
- <a id="c7"></a>**C7 (additive-fields-listed)**: any new summary field an example's run emits joins `ADDITIVE_TOP` or `ADDITIVE_CHECK` in `test/e2e/invariance.e2e.test.ts` in the same step.
- <a id="c8"></a>**C8 (releases-are-rob's)**: `/version minor` runs only on Rob's word at a range's stop, and `/version major` never runs in this build ([D30 (major-after-the-build)](#d30)); no step bumps a version, pushes or tags.
- <a id="c9"></a>**C9 (out-of-scope)**: no new slot, pack or adapter; no second baseline schema version or merge driver; no Windows or musl binary; no checkride that spawns checkride; no nesting of two targets of one pack.
- <a id="c10"></a>**C10 (done-when-one-line)**: every step's done-when sits whole on the step's first line, with no wrapped opener.

## Steps

### 0.23.0: the guard and the surface

1. [x] feat(baseline): fail baseline diff on added keys, **done when:** a contract test shows `baseline diff --fail-on-added` exits 1 on an added key and on a grown count, exit 0 on removals alone, exit 0 without the flag, exit 1 on any key when `<ref>` holds no baseline file, and `docs/ci.md`'s recipe runs it as its own job against the merge base
   - seam: `src/baseline-command.ts`, `src/cli.ts`, `src/__tests__/baseline.test.ts`, `src/__tests__/cli.test.ts`, `test/contract/baseline.contract.test.ts`, `docs/contract.md`, `docs/ci.md`, `docs/cheatsheet.md`, `docs/consumers.md`, `README.md`, `site/api.html`, `CHANGELOG.md`
   - model: opus (the count rule: `recounted` holds decreases too, and a `from` of null means any number)
2. [ ] feat(cli): add --summary github for the step summary, **done when:** a contract test pins the table's columns, the flag's refusals, `CHECKRIDE_SUMMARY` and that a second run appends, the gate strips the variable, and `ci.yml` sets it in one job, with `CHECKRIDE_BASE` set and a checkout deep enough to reach it
   - seam: `src/orchestrator/step-summary.ts` (new), `src/orchestrator/index.ts`, `src/orchestrator/run.ts`, `src/orchestrator/context.ts`, `src/orchestrator/types.ts`, `src/cli.ts`, `src/gate.ts`, `src/__tests__/gate.test.ts`, `src/orchestrator/__tests__/step-summary.test.ts` (new), `test/contract/step-summary.contract.test.ts` (new), `test/contract/flags.contract.test.ts`, `.github/workflows/ci.yml`, `docs/contract.md`, `docs/ci.md`, `docs/cheatsheet.md`, `README.md`, `site/api.html`, `CHANGELOG.md`
   - model: opus (modelled on `--annotate github`; the base is [D25 (summary-base)](#d25), the variable and the append [D46 (summary-variable)](#d46))
3. [ ] feat(api)!: trim the barrel to the names consumers use, **done when:** `test/contract/exports.contract.test.ts` lists exactly the names that stay, and the contract's Programmatic surface section matches it
   - seam: `src/index.ts`, `src/__tests__/index.test.ts`, `test/contract/exports.contract.test.ts`, `docs/contract.md`, `docs/consumers.md`, `README.md`, `site/api.html`, `CHANGELOG.md`
   - model: opus (the survey reads atis, volley, plumbbob and runciter under `~/Projects`; the pause shows every name with who uses it and whether it stays)

### 0.24.0: config that lives with the code

4. [ ] feat(config): read a local target's config, **done when:** a contract test covers the local file's ranking above `packs.<pack>.checks` and the top level, each refused key in the local file and in the entry beside `local: true` as exit 2 naming the file, a missing local file as exit 2, two local targets at one root as exit 2, a key from an extended preset dropped with a warning, a local target declared by a `--config` file and by a config handed to `runChecks`, and the containment rule on a path it names
   - seam: `src/config.ts`, `src/targets/resolve.ts`, `src/targets/local.ts` (new), `src/targets/index.ts`, `src/contain.ts`, `schema/checkride.config.schema.json`, `schema/checkride.local.schema.json` (new), `src/schema/bundled.ts`, `src/__tests__/config-targets.test.ts`, `src/targets/__tests__/local.test.ts` (new), `test/contract/targets.contract.test.ts`, `docs/contract.md`, `docs/targets.md`, `CHANGELOG.md`
   - model: fable (the layering in `targetScope` and `layeredEntry`, and `timeout` and `extends` new at target level; composing sits where targets are resolved, [D43 (composed-or-as-written)](#d43))
5. [ ] feat(examples): add a web and api example with local targets, **done when:** `examples/local-targets`, with `web` and `api` as local targets and a root config naming only their roots, passes in `pnpm test:e2e`, and its plant fails with the expected check name
   - seam: `examples/local-targets/` (new), `examples/README.md`, `checkride.config.json`, `docs/targets.md`
   - model: sonnet (follows `examples/polyglot-stack`; the dogfood `schemas` rule gains the nested local files)
6. [ ] feat(config): read included config files with flat target names, **done when:** a name declared in two files is exit 2 naming both, a cycle is exit 2, a key an included file can't hold is exit 2 naming the file, `include` in a `--config` file is exit 2, and `doctor` lists each target with the file that declares it
   - seam: `src/config.ts`, `src/targets/resolve.ts`, `src/targets/include.ts` (new), `src/targets/index.ts`, `src/doctor.ts`, `schema/checkride.config.schema.json`, `src/targets/__tests__/include.test.ts` (new), `src/__tests__/doctor.test.ts`, `test/contract/targets.contract.test.ts`, `docs/contract.md`, `docs/targets.md`, `CHANGELOG.md`
   - model: fable (roots relative to the including file, and the containment rule on every included path)
7. [ ] feat(cli): find the repo's config from inside a target, **done when:** `checkride` run from `web/` or `web/src/` writes the same `web:` entries and keys as `checkride --only web` from the root, into the root's `.check/`, a run from `services/` covers every target its included file declares, `baseline`, `doctor`, `gate`, `recover` and `fix` run from `web/` act on the whole repo, each says on stderr which config it found, and a directory outside any git work tree is read as it is today
   - seam: `src/cli.ts`, `src/config.ts`, `src/gate.ts`, `src/orchestrator/context.ts`, `src/__tests__/cli.test.ts`, `src/__tests__/gate.test.ts`, `test/contract/targets.contract.test.ts`, `docs/contract.md`, `docs/targets.md`, `CHANGELOG.md`
   - model: opus (the walk-up stops at the git top level and never crosses a config that doesn't claim the directory)
8. [ ] feat(baseline): map each check to its shard and read them all, **done when:** a run over two local targets masks each target's findings from its own `<root>/checkride.baseline.json` and the repo-scope checks from the root file, a shard left at the root of a target that is no longer local is still read, a shard that can't be parsed turns only its own target's grandfathered findings red, and a repo with no local target reads exactly the one file it reads today
   - seam: `src/baseline/shards.ts` (new), `src/baseline/index.ts`, `src/baseline/store.ts`, `src/suite.ts`, `src/orchestrator/context.ts`, `src/__tests__/baseline.test.ts`, `src/orchestrator/__tests__/targets.test.ts`, `test/contract/baseline.contract.test.ts`, `docs/contract.md`, `CHANGELOG.md`
   - model: fable (the one module every later shard step calls; suite shard names per [D12 (suites-unchanged)](#d12))
9. [ ] feat(baseline): ratchet each shard on its own, **done when:** a full green run that prunes a key in `web` rewrites `web`'s shard and leaves `api`'s file and the root file byte-identical, a full green run moves a stray key to the file that owns it, deleting a shard its target no longer owns, and a partial run writes none of them
   - seam: `src/orchestrator/run.ts`, `src/baseline/store.ts`, `src/baseline/shards.ts`, `src/orchestrator/__tests__/targets.test.ts`, `test/contract/baseline.contract.test.ts`, `examples/local-targets/`, `docs/contract.md`, `CHANGELOG.md`
   - model: opus (`maybeRatchet`, `notePrunable` and the red-run hint each read the file)
10. [ ] feat(baseline): capture and re-record every shard, **done when:** a contract test over two shards shows `baseline` writes each target's keys to its own file, `baseline` moves stray keys both ways at once, and `baseline --versions` re-records each file's copies in place
   - seam: `src/baseline-command.ts`, `src/baseline/shards.ts`, `src/target-files.ts`, `src/__tests__/baseline.test.ts`, `test/contract/baseline.contract.test.ts`, `docs/contract.md`, `CHANGELOG.md`
   - model: opus
11. [ ] feat(baseline): walk every shard in baseline diff, **done when:** a contract test over two shards shows `baseline diff` reports a key added in either shard under the same JSON shape, `--fail-on-added` exits 1 on it, a shard only the config at `<ref>` declares is read, and a config that can't be read falls back to the root file with a warning
   - seam: `src/baseline-command.ts`, `src/cli.ts`, `src/config.ts`, `src/__tests__/cli.test.ts`, `src/baseline/history.ts`, `src/baseline/shards.ts`, `src/orchestrator/step-summary.ts`, `src/__tests__/baseline-history.test.ts`, `test/contract/baseline.contract.test.ts`, `test/contract/step-summary.contract.test.ts`, `docs/contract.md`, `docs/consumers.md`, `CHANGELOG.md`
   - model: opus (the shards at `<ref>` are the ones the config at `<ref>` or the working tree's declares, [D41 (diff-reads-config)](#d41); keys are compared by name across the union, so a key that moved between files is no change)
12. [ ] feat(recover): rebuild every shard from history, **done when:** a contract test over two shards shows `recover` rebuilds a clobbered `web` shard from git history and leaves `api`'s file byte-identical, and with a config that can't be read it warns and recovers the root file alone
   - seam: `src/recover.ts`, `src/cli.ts`, `src/config.ts`, `src/__tests__/cli.test.ts`, `src/baseline/history.ts`, `src/baseline/shards.ts`, `src/__tests__/recover.test.ts`, `test/contract/baseline.contract.test.ts`, `docs/contract.md`, `CHANGELOG.md`
   - model: opus
13. [ ] feat(protect): guard every shard from edits, **done when:** a contract test over two shards shows `protect`, the generated hook script and Cursor's matcher each refuse an edit to `web/checkride.baseline.json` and to a suite's shard, and `doctor`'s baseline row counts every shard and names one no declared target owns
   - seam: `src/protect.ts`, `src/agent-setup/scripts.ts`, `src/agent-setup/cursor.ts`, `src/doctor.ts`, `src/__tests__/protect.test.ts`, `src/agent-setup/__tests__/hooks.test.ts`, `src/__tests__/doctor.test.ts`, `test/contract/protect.contract.test.ts`, `test/e2e/hook-scripts.e2e.test.ts`, `docs/contract.md`, `docs/targets.md`, `docs/suites.md`, `CHANGELOG.md`
   - model: opus (the script can't read the config, so it matches the file name at any depth, as Claude's deny rules do)

### 0.25.0: docs

14. [ ] docs: move the README's reference sections out, **done when:** `docs/configuration.md` and `docs/baseline.md` exist, no doc links to a README anchor that's gone, and the `links` check is green
   - seam: `README.md`, `docs/configuration.md` (new), `docs/baseline.md` (new), `docs/cheatsheet.md`, `docs/tools.md`, `docs/contract.md`, `docs/presets.md`, `docs/why.md`, `docs/ci.md`, `docs/getting-started.md`, `docs/README.md`, `examples/`, `test/fixtures/invariance/examples/polyglot/README.md`, `test/integration/docs-currency.test.ts`, `src/cli.ts`
   - model: opus (the slot table and opt-in sentence `docs-currency.test.ts` pins move with their test; the anchor proof is [D26 (anchor-proof)](#d26))
15. [ ] docs(readme): rewrite the README to the happy path, **done when:** the README is under 200 lines, opens with the pitch of D14, and its install block is two commands
   - seam: `README.md`, `test/integration/docs-currency.test.ts`, `docs/getting-started.md`, `docs/distribution.md`
   - model: opus (the output block is a real run's, and the line count is pinned by a test)
16. [ ] docs(team): write the page for a team merging agent-written code, **done when:** `docs/team.md` walks the web-and-API repo, its workflow runs the baseline guard as its own job outside the required set, and the file is one a check covers
   - seam: `docs/team.md` (new), `examples/local-targets/`, `test/integration/docs-currency.test.ts`, `docs/ci.md`
   - model: opus (the workflow file and its test are [D27 (workflow-cover)](#d27))
17. [ ] docs: list the docs by job and shrink getting-started, **done when:** `docs/README.md` lists every page under `docs/` beneath one of four jobs, a test proves each page is reachable from it, and `getting-started.md` holds only the ten minutes after the README
   - seam: `docs/README.md`, `docs/getting-started.md`, `docs/configuration.md`, `docs/baseline.md`, `docs/distribution.md`, `docs/targets.md`, `docs/ci.md`, `test/integration/docs-currency.test.ts`, `site/docs.html`
   - model: opus
18. [ ] docs: add SECURITY.md, **done when:** `SECURITY.md` says how to report a problem and that the latest release gets fixes, and it's linked from the README and the contract
   - seam: `SECURITY.md` (new), `README.md`, `docs/contract.md`, `package.json`
   - model: sonnet (short and fully specified by [D19 (support-policy)](#d19))

### The soak, then ready for 1.0.0

19. [ ] feat(init): write a caret pin from 1.0.0 on, **done when:** a unit test shows `init` writes `^<version>` in `package.json` and an exact version in `mise.toml` when the product version is 1.0.0 or later, and the exact pin in both below it
   - seam: `src/init.ts`, `src/__tests__/init.test.ts`, `test/e2e/pins.e2e.test.ts`
   - model: sonnet (keyed on the product's major, so it is inert until the tag)
20. [ ] docs(contract): rewrite the pin policy and promise what a minor may do, **done when:** `docs/contract.md`, `docs/reliability.md` and what `init` writes agree on the answer to Q1, the contract's minor-version paragraph carries D19 and Q3, the changelog's unreleased entry opens with the upgrade note of D20, `SECURITY.md` names the latest 1.x, and `pnpm check`, `pnpm test:e2e` and a full mutation run are green on the commit
   - seam: `docs/contract.md`, `docs/reliability.md`, `docs/distribution.md`, `docs/getting-started.md`, `README.md`, `SECURITY.md`, `CHANGELOG.md`, `test/integration/docs-currency.test.ts`
   - model: opus (the full mutation run takes about three hours, in the foreground)

## Build order

## Build ranges

Drive the build with `/plumbbob:run`, one range at a time. Each release of the brief ends at a
stop, and 0.23.0 and 0.24.0 each hold one more call before their last range
([D21 (stops-cut-the-ranges)](#d21)).

1. `/plumbbob:build 1-2`, **stop:** push, and confirm this repo's CI run shows the step summary table on the run's page
   - model: opus
   - note: 0.23.0, first half. Step 2's done-when in the spec ends on "this repo's own CI run shows it", which only a push can show.
2. `/plumbbob:build 3`, **stop:** at step 3's pause, review the list of names the barrel trim removes before it is committed; once it lands, release 0.23.0 with `/version minor`
   - model: opus
   - note: the survey can't read the work monorepo or the private review agent; Rob answers for those two at the pause.
3. `/plumbbob:build 4-7`, **stop:** confirm the split of the baseline shards into steps 8 to 13 before any of them builds
   - model: fable
   - note: 0.24.0, first half. Run `pnpm test:e2e` in the foreground before step 5's checkpoint.
4. `/plumbbob:build 8-13`, **stop:** run the merge-queue proof in runciter's sandbox repo from the hand-over, record the result in runciter's scheduler note, then release 0.24.0 with `/version minor`
   - model: fable
   - note: the stop hands over what to run and what to record ([Q5 (runciter-and-the-prune)](#q5)): a baseline in each of the sandbox's two packages, two steps that overlap in time, and a pass when no rebuild is caused by a baseline file. Run `pnpm test:e2e` in the foreground before step 13's checkpoint.
5. `/plumbbob:build 14-18`, **stop:** review the docs and release 0.25.0 with `/version minor`; then move the five consumers to it, the work monorepo by Rob, and wait out the fourteen-day soak
   - model: opus
   - note: the soak is a wait, not a step. A fix it finds is added with `/plumbbob:step` ([D24 (soak-fixes-are-added)](#d24)).
6. `/plumbbob:build 19-20`, **stop:** review the pin policy and the minor-version promise as landed; the build ends here, untagged, and 1.0.0 waits for Rob's own call after it
   - model: opus
   - note: run this range only once the five consumers are green on the last release and fourteen days are clear by the count of [D32 (soak-clock)](#d32). Step 20 runs `pnpm test:e2e` and the full mutation run in the foreground before its checkpoint. Don't run or suggest `/version major` ([D30 (major-after-the-build)](#d30)).

## Open questions

The spec's Q1 to Q5 are settled and sit under [Decisions](#decisions). These five are holes the
spec's done-when lines left, found reading HEAD and settled on their leans at the plan pause.
None reopens a decision.

- <a id="q6"></a>**Q6 (summary-base)**: Which base does `--summary github` diff the baseline against?, *resolved:* 2026-11-13, the base `--changed` resolves ([D25 (summary-base)](#d25))
  - *plain:* A run knows a base ref only under `--changed`, so the table's added and removed keys have nothing to compare against on a full run. A CI checkout at the default depth has no `origin/main` either, and `GITHUB_STEP_SUMMARY` is unset outside Actions.
  - *lean:* Use the base `--changed` already resolves: `CHECKRIDE_BASE`, then the config's `changedBase`, then `origin/main`. When the base can't be read the table says so in place of the two counts, and when `GITHUB_STEP_SUMMARY` is unset the flag warns on stderr and writes nothing; neither changes the exit code.
- <a id="q7"></a>**Q7 (anchor-proof)**: What proves no doc links to a dead README anchor?, *resolved:* 2026-11-13, a test in `docs-currency.test.ts`, and `links` stays as it is ([D26 (anchor-proof)](#d26))
  - *plain:* The `links` check drops `#fragment` before it tests a link, so it is green over a dead anchor today, and `docs/ci.md` already holds one. Step 14's done-when leans on that check for proof it can't give.
  - *lean:* Add the proof to `test/integration/docs-currency.test.ts`: every link to `README.md#…` from `docs/`, `examples/` and the fixtures names a heading the README has. Teaching `links` to check fragments would turn green consumer repos red, so it stays as it is.
- <a id="q8"></a>**Q8 (workflow-cover)**: Which check covers the workflow file on the team page?, *resolved:* 2026-11-13, the page's block equals the example's real workflow file ([D27 (workflow-cover)](#d27))
  - *plain:* Step 16's done-when wants the page's workflow covered by `snippets` or actionlint. Neither exists for YAML: `snippets` typechecks marked TypeScript fences only, and a new actionlint slot is out of scope.
  - *lean:* Keep the workflow as a real file, `examples/local-targets/.github/workflows/check.yaml`, and have `docs-currency.test.ts` assert the page's fenced block equals it byte for byte and parses as YAML naming the flags the page promises. The example's e2e run then exercises the same commands.
- <a id="q9"></a>**Q9 (keys-when-turning-local)**: What happens to a target's keys in the root baseline when it turns local?, *resolved:* 2026-11-13, the read honours them and the ratchet moves them ([D28 (ratchet-moves-keys)](#d28))
  - *plain:* Flipping `web` to `"local": true` leaves its `web:` keys in the root file while the run now reads `web`'s shard. If nothing carries them over, every grandfathered finding turns red on the next run, on the day a team adopts the feature.
  - *lean:* The read honours a local target's keys still in the root file, and the next full green run's ratchet writes them to the shard and prunes them from the root. `doctor` names the stray keys until then, and `checkride baseline` moves them at once.
- <a id="q10"></a>**Q10 (suite-local-file)**: What is a local target's config file called under a named suite?, *resolved:* 2026-11-13, `<root>/checkride.<suite>.config.json` ([D29 (suite-local-file)](#d29))
  - *plain:* [D12 (suites-unchanged)](#d12) names the suite's shard but not the suite's local config. A builder would have to guess between one local file shared by every suite and one per suite.
  - *lean:* It follows the shard: `<root>/checkride.<suite>.config.json`, the same file name the suite fixes at the repo root, so a suite never reads the default suite's local file.

These nine came from a cold read of the plan against HEAD on 2026-11-13, after the plan pause.

- <a id="q11"></a>**Q11 (guard-and-wanted-growth)**: How does a baseline that should grow get past `--fail-on-added`?, *resolved:* 2026-11-13, the flag stays strict with no override, and the docs run the guard as its own job outside the required set
  - *plain:* Three honest changes add keys: the pull request that adopts checkride, one that adds a target over old code, and a tool upgrade that reports more. If the guard sits inside the required check of [D16 (team-page)](#d16), none of them can merge, and [D2 (fail-on-added)](#d2) names no way through.
  - *lean:* The flag stays strict, with no override and a missing file at `<ref>` read as empty. `docs/ci.md` and `docs/team.md` run the guard as its own job, kept out of the required set, so a code owner of the baseline file can merge over a red guard on purpose.
- <a id="q12"></a>**Q12 (soak-clock)**: Does step 20's own Contract entry restart the fourteen days?, *resolved:* 2026-11-13, the clock counts Contract entries in a published release, steps 19 and 20 are exempt by name, and the consumers are green on the last release before step 19
  - *plain:* Step 20 rewrites the pin policy in `docs/contract.md`, and [C3 (contract-moves-loudly)](#c3) makes that an entry under a Contract heading. It lands after the soak, so read literally [D4 (minors-then-one)](#d4) can never be met on the commit Rob tags. A soak fix shipped as 0.25.1 or 0.26.0 also leaves open whether the five consumers move again.
  - *lean:* The clock counts Contract entries in a published release, and the entries of steps 19 and 20 are exempt by name, since they change the policy and no surface a consumer reads. The five consumers are green on the last release published before step 19, whatever its number, and a release with no Contract entry doesn't restart the days.
- <a id="q13"></a>**Q13 (inside-what-exactly)**: Which directories and commands does the walk-up of Q4 cover?, *resolved:* 2026-11-13, every command that reads the config walks up from any directory inside a local target or beside an included file; a run narrows, the others act on the whole repo
  - *plain:* [Q4 (running-inside-a-target)](#q4) names a run from `web/` alone. It leaves out `web/src/`, a directory holding an included file such as `services/`, and every other command: `baseline`, `doctor`, `gate`, `recover` and `fix` each read `<cwd>/checkride.config.json` today, so from `web/` they would take the local file for a repo's own config.
  - *lean:* Every command that reads the config walks up, from any directory inside a local target or beside an included file, and stops at the git top level. A run narrows to the targets under the directory, `--only web` from `web/` and every target the file declares from `services/`; the other commands act on the whole repo from its root. Each says on stderr which config it found. Step 7's seam grows to match.
- <a id="q14"></a>**Q14 (included-file-keys)**: What may an included config file hold besides `targets`?, *resolved:* 2026-11-13, `targets`, `include`, `note` and `$schema` only, and `<dir>/checkride.<suite>.config.json` under a suite
  - *plain:* [D8 (local-targets)](#d8) lists what a local file may not hold, and [D9 (groups-are-files-not-names)](#d9) lists nothing for an included one. A builder has to guess whether `services/checkride.config.json` can set `checks`, `packs`, `schemas` or `changedBase` for the repo, and what the file is called under a named suite.
  - *lean:* An included file holds `targets`, `include`, `note` and `$schema`, and any other key is exit 2 naming the file. Under a suite it is `<dir>/checkride.<suite>.config.json`, as [D29 (suite-local-file)](#d29) names a local file.
- <a id="q15"></a>**Q15 (local-entry-keys)**: What may a local target's entry in the declaring file hold?, *resolved:* 2026-11-13, `root`, `local` and `note`; any other key, or a missing local file, is exit 2
  - *plain:* D8 shows `{ "root": "web", "local": true }` and says the local file holds the rest. It doesn't say what happens when the entry also carries `lang` or `checks`, or when `<root>/checkride.config.json` is missing.
  - *lean:* The entry holds `root`, `local` and `note`. Any other key beside `local: true` is exit 2 naming the entry and the local file that should hold it, and a missing local file is exit 2 naming the path.
- <a id="q16"></a>**Q16 (named-config-meets-local)**: Do `--config`, `--defaults` and `--discover` read local and included files?, *resolved:* 2026-11-13, a named config may declare local targets and may not `include`; a defaults file sets neither, and `--discover` proposes neither
  - *plain:* A config named by `--config` or `CHECKRIDE_CONFIG` can sit outside the repo, and its paths resolve against the repo being checked. An `include` in it has no directory of its own inside the repo, and the private review agent runs checkride this way.
  - *lean:* A named config may declare local targets, read at `<cwd>/<root>/` as its roots are. Its `include` is exit 2, since an included file's roots are relative to a file inside the repo. A defaults file can set neither key, and `--discover` proposes neither.
- <a id="q17"></a>**Q17 (turning-back)**: What reads a shard once its target stops being local?, *resolved:* 2026-11-13, the same rule both ways: the read honours the shard, the ratchet moves its keys to the root file and deletes it, and `doctor` names an orphan
  - *plain:* [D28 (ratchet-moves-keys)](#d28) carries keys from the root file to a new shard. Nothing carries them back when `"local": true` is removed or a target is deleted, so the shard is left on disk, unread, and the target's grandfathered findings turn red.
  - *lean:* The same rule both ways: the read honours a shard at the root of a target that is declared and no longer local, the next full green run's ratchet writes its keys to the root file and deletes the shard, and `checkride baseline` does so at once. `doctor` names a shard no declared target owns, and nothing reads it.
- <a id="q18"></a>**Q18 (security-before-one)**: What does `SECURITY.md` promise while it ships in 0.25.0?, *resolved:* 2026-11-13, step 18 writes "the latest release", and step 20 changes it to the latest 1.x
  - *plain:* Step 18's done-when has it say the latest 1.x gets fixes, in a release cut before any 1.x exists.
  - *lean:* Step 18 writes "the latest release", and step 20, whose seam already holds the file, changes it to the latest 1.x.
- <a id="q19"></a>**Q19 (summary-in-ci)**: Which CI jobs pass `--summary github`, and against which base?, *resolved:* 2026-11-13, one job, ubuntu on Node 24, with `CHECKRIDE_BASE` set to the pull request's base or to `github.event.before` on a push
  - *plain:* `ci.yml` runs six matrix jobs, so the run's page would carry six tables. On a push to `main` the base of [D25 (summary-base)](#d25) is the commit being checked, so the two counts are always zero at range 1's stop.
  - *lean:* One job passes the flag, ubuntu on Node 24. `ci.yml` sets `CHECKRIDE_BASE` to the pull request's base on `pull_request` and to `github.event.before` on a push.

These eight came from a second cold read against HEAD on 2026-11-13, before range 1.

- <a id="q20"></a>**Q20 (guard-base)**: Which commit does the CI guard compare the baseline against?, *resolved:* 2026-11-13, the merge base, named by the recipes; the flag and the diff stay as they are ([D40 (guard-base)](#d40))
  - *plain:* `baseline diff <ref>` compares the working tree with the tip of `<ref>`, so a key `main` pruned after a branch left it reads as added by the branch, and the guard goes red on a change that added nothing. A default `actions/checkout` also has no `origin/main`, so the recipe as the spec writes it exits 2. `--changed` already measures from the merge base (`changedPaths` in `src/git.ts`); the diff doesn't.
  - *lean:* The flag and the diff stay as they are, and the recipes name the merge base: `fetch-depth: 0`, then `checkride baseline diff "$(git merge-base origin/main HEAD)" --fail-on-added`. That is exact on a pull request's merge commit, on a head checkout and in a merge queue, and `docs/ci.md` and `docs/team.md` say why in one sentence. No new flag.
- <a id="q21"></a>**Q21 (diff-reads-config)**: Which config tells `baseline diff` and `recover` where the shards are?, *resolved:* 2026-11-13, the config a run would load, with the shard paths of both sides read at `<ref>` and the root file alone when no config can be read ([D41 (diff-reads-config)](#d41))
  - *plain:* Neither command reads a config today or takes `--config`: each opens `suite.baselineFile` and nothing else, which [D33 (walk-up-everywhere)](#d33) gets wrong about `recover`. Shards make both depend on the config, at `<ref>` as well as in the working tree, and `recover` runs at the moment a merge may have mangled that config too. A config named from outside the repo has no copy at `<ref>` at all.
  - *lean:* Both load the config as a run does: the walk-up, `--suite`, and `--config` or `CHECKRIDE_CONFIG`, which both commands gain. At `<ref>` they read every shard path that the config at `<ref>` or the working tree's config declares; a named config stands for both sides. A config that can't be read warns on stderr and falls back to the root file alone, so `recover` still works after a bad merge. Steps 11 and 12 gain `src/cli.ts` and `src/config.ts` in their seams, and D33's *because* is corrected.
- <a id="q22"></a>**Q22 (preset-in-local-file)**: What does a local file take from a preset it extends?, *resolved:* 2026-11-13, the keys a local file may hold, and the rest is dropped with a warning ([D42 (preset-in-local-file)](#d42))
  - *plain:* [D8 (local-targets)](#d8) lets a local file `extends`, and refuses any key that belongs to the whole repo. A team's shared preset is written for a root config and holds such keys (`packs`, `requirePins`, `schemas`), so read literally a local file that extends it is exit 2, and `extends` there is of no use.
  - *lean:* The refusal judges the keys the local file itself writes. From an extended base it takes the keys a local file may hold, and each other key is dropped with the unread-key warning a config load already gives, naming the base file.
- <a id="q23"></a>**Q23 (composed-or-as-written)**: Does `loadConfig`, or a config handed to `runChecks`, come composed?, *resolved:* 2026-11-13, composing happens where targets are resolved, and `loadConfig` returns the file as written ([D43 (composed-or-as-written)](#d43))
  - *plain:* Step 3 binds the barrel's names for the whole major before step 4 changes what a config is. plumbbob calls `runChecks` in-process, and `RunOptions.config` takes a config object: if composing happens inside `loadConfig`, an injected config with `"local": true` never reads its local files. No surveyed consumer imports `loadConfig`.
  - *lean:* Composing happens where targets are resolved, so an injected config, a `--config` file and the repo's own all read their local and included files the same way. `loadConfig`, if step 3 keeps it, returns the root file as written after `extends`, and the contract says so.
- <a id="q24"></a>**Q24 (one-root-one-local)**: May two local targets share a root, or one sit at `.`?, *resolved:* 2026-11-13, no, both are exit 2 ([D44 (one-root-one-local)](#d44))
  - *plain:* Targets of different packs may share a root today (`overlapProblem` in `src/targets/resolve.ts`). Two local targets at one root would share one local file with one `lang` and one shard, and a local target at `.` names the root config as its own local file.
  - *lean:* Both are exit 2: two local targets at one root name each other, and a local target at the declaring file's own directory names the file.
- <a id="q25"></a>**Q25 (walk-up-without-git)**: Where does the walk-up stop when there is no git repository?, *resolved:* 2026-11-13, there is no walk-up without a git work tree ([D45 (walk-up-without-git)](#d45))
  - *plain:* [D33 (walk-up-everywhere)](#d33) stops the walk at the git top level. A tarball checkout or a container build without `.git` has none, and walking to the filesystem root could find a stray config in a home directory.
  - *lean:* With no git work tree there is no walk-up: the command reads the directory it is run in, as it does today.
- <a id="q26"></a>**Q26 (summary-variable)**: Does `--summary` get a variable, and does it append?, *resolved:* 2026-11-13, `CHECKRIDE_SUMMARY`, stripped by the gate, and the table is appended ([D46 (summary-variable)](#d46))
  - *plain:* `ci.yml` turns annotations on with `CHECKRIDE_ANNOTATE`, since the job runs `pnpm check`, and [D39 (summary-in-ci)](#d39) wants the summary in one matrix job of six, which a variable set per job does and a flag can't cleanly. A second run in the same step, a named suite's, would overwrite the first table if the file is written and not appended.
  - *lean:* `CHECKRIDE_SUMMARY` names it as `CHECKRIDE_ANNOTATE` names annotations, and the gate strips it the same way. The table is appended, under a heading that names the suite.
- <a id="q27"></a>**Q27 (mangled-shard)**: What does a run do when one shard can't be parsed?, *resolved:* 2026-11-13, the state is per file, and nothing writes over a file it couldn't parse ([D47 (mangled-shard)](#d47))
  - *plain:* A run holds one baseline state today, and an unparseable file turns every grandfathered finding red with one warning. With shards a bad merge mangles one file, and the ratchet of [D28 (ratchet-moves-keys)](#d28) could write moved keys over it, destroying what `recover` reads from the working tree.
  - *lean:* The state is per file: that target's grandfathered findings go red, the warning and the recover hint name the shard, and every other file masks as usual. No ratchet, move or `checkride baseline` writes over a file it couldn't parse.

## Verdicts

- 2026-11-13: Q20 to Q27 → Rob took every lean, one by one, at the second refine pause; recorded as D40 to D47.
- 2026-11-13: the major bump → held out of the build for Rob's explicit call after it, since he may make more changes first (D30).
- 2026-11-13: Q11 to Q19 → Rob took every lean at the refine pause; recorded as D31 to D39.
- 2026-11-13: Q6 to Q10 → Rob took every lean at the plan pause; recorded as D25 to D29.
- 2026-11-13: spec Q1 to Q5 → each settled on its lean in `docs/spec-v1.md` before this plan; carried under Decisions with their ids.

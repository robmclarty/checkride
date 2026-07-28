# checkride bundled plugin: check and qa readers

**Phase** (your own bookkeeping while framing): frame
**Size:** medium
**Scope:** plugin

*Source: `~/Projects/agent-tools/code/agent-tools/research/plugin-candidates/check/spec.md`
(candidate 1 of 10) and `../qa/spec.md` (candidate 9). Both live in the **agent-tools**
repo, not this one — the contract facts they rest on are reproduced in `## Source` below,
corrected against checkride 0.7.0.*

## Frame

- **Problem:** checkride publishes a contract nothing consumes. `.check/summary.json` is
  `schema_version`-ed, JSON-Schema'd, contract-tested, additive-only, deterministically
  ordered and crash-consistent; exit codes 0/1/2 are promised; `--digest` is already a
  token-bounded failure excerpt. The *consumption* procedure, meanwhile, ships as a
  five-line prose stanza that `checkride init` copies into each repo's `AGENTS.md` (6 of 9
  sampled repos carry it). Being copied, it is a drift family in waiting. Worse, it is
  thin: it says "read `.check/summary.json` to find which check failed" and stops — never
  mentioning vacuous green, exit 2 vs exit 1, `baselined`, `skipped`+`reason`, or
  `exit_code: -1`, each of which is a specific wrong answer waiting to happen. And its
  "read the corresponding per-tool JSON" is unbounded: in this repo's own `.check/`, that
  is 2.3 MB (`mutation.json`), 650 KB (`test.json`), 57 KB (`attw.json`), 45 KB
  (`health.json`).
- **Smallest thing that solves it:** ship a Claude Code plugin from this package's root —
  two skills and two dependency-free readers that ride the package's existing `dist/`
  (D4 (readers-in-dist)). It runs nothing new, defines no new contract surface, and adds no
  dependency. It reads what checkride already writes.
- **Done looks like:** `/checkride:check` triages a red run in this repo — branches on the
  exit code before anything else, asserts `schema_version`, catches vacuous green, names
  one root cause and says which slots it is deliberately not reading yet.
  `/checkride:qa` reports the four quality artifacts under a stated byte ceiling and
  labels stale ones. `pnpm check` is green. `npm pack` carries
  `package/.claude-plugin/plugin.json`.
- **Explicitly NOT doing:** a runner, a `gate.mjs`, a `blocking_order` field, a `Stop`
  hook, `PostToolUse` output compression, a `.claude/check.json`, a `/check init`, or any
  normalizing of tool output — checkride owns every one of these already, and the last is
  the explicit anti-goal of the design being consumed. Also not doing: wrapper skills for
  `init`, `doctor`, `fix`, `baseline` or `agent-setup` (D10 (no-wrapper-skills)); the rest
  of `../qa/spec.md` (see D6 (qa-is-artifact-read)); support for the three hand-rolled
  `scripts/check.mjs` repos (weft, ridgeline, ts-check-scaffold — they emit a different
  schema, and bridging it would mean the normalization this design refuses); the
  agent-tools catalog entry (see C6 (catalog-after-publish)); and deploying
  `checkride agent-setup` across the fleet (a deployment task, not a build task).

## Architecture sketch

```
checkride/ (package root == plugin root)
  .claude-plugin/plugin.json   name: checkride  -> /checkride:check, /checkride:qa
  skills/check/SKILL.md        judgment: root cause, what to ignore, what is masked
  skills/qa/SKILL.md           judgment: is the suite actually testing anything
  src/artifacts/    -> dist/   shared read: parse summary, pin schema, freshness window,
                                 resolve raw output               <- C7, D11, D13
  src/triage/       -> dist/   deterministic: run gate, branch exit code, assert schema
  src/qa-extract/   -> dist/   deterministic: bounded excerpts of the big artifacts
  package.json  files: + .claude-plugin, skills   (never `scripts` — pack DENY)   <- C3

  dist/triage                                 dist/qa-extract
    detect pm -> run repo `check` script        mutation.json  2.3 MB -> ranked survivors
    capture exit code (never die on red)        health.json     45 KB -> score + hotspots
      2 -> fold in `doctor`, STOP               dead.json      2.6 KB -> non-empty buckets
      1 -> red, continue                        dupes.json      483 B -> clone families
      0 -> green: vacuous? narrow?                     |
    summary.json: schema_version === 1                 v
    fresh? mtime >= ts - duration  <- D11       present / stale / not opted in  <- D14
    baselined? skipped? raw via fallback <- D13        |
    digest.md if present, else bounded raw             v
      |                                          SKILL.md (qa) reasons
      v
    SKILL.md (check) reasons
```

## Decisions

- D1 (bundled-in-checkride): the plugin ships from this package root, not from the
  agent-tools repo — *because* the reader asserts `schema_version` against a pre-1.0
  contract, and shipping in the same package makes the reader version in lockstep with the
  engine it reads.
- D2 (reader-not-runner): the plugin still runs nothing and defines nothing — no new CLI
  command, no new flag, no config file — *because* bundling changes the vehicle, not the
  boundary; anything it seems to need from checkride is a checkride feature request.
- D3 (repo-script-preflight): preflight runs the repo's own `check` script and falls back
  to raw artifacts when no digest exists — *because* that script is the definition of done
  and may carry deliberate `--only`/`--skip` a direct `checkride --digest` would bypass.
  Note the fallback is the **common** path, not the edge: this repo's own script is
  `tsc --build && node dist/cli.js`, which passes no `--digest`.
- D4 (readers-in-dist, was `plain-node-scripts`): both readers are TypeScript modules under
  `src/`, shipped in the package's existing `dist/` and invoked as
  `node <plugin-root>/dist/<reader>/index.js` — *because* `scripts/` can never ship
  (`src/pack.ts`'s fixed `DENY` forbids it, so the tarball would fail this package's own
  `pack` slot), the published package *and* the installed plugin cache both already carry a
  built `dist/`, and living in `src/` puts the readers under the same
  `types`/`lint`/`test`/`health` gate as the engine while letting them reuse
  `src/digest/`'s truncate-never-normalize machinery. Still dependency-free: `node:`
  builtins only, and no shell, so `jq` is still irrelevant (C4 (no-new-deps)).
- D5 (bounded-reads): every raw-artifact read is bounded by a script; no whole-file `Read`
  of a `.check/` artifact — *because* this repo's own artifacts run to 2.3 MB and the
  spec's plain "read the raw file" would blow the context on the first triage.
- D6 (qa-is-artifact-read): `/checkride:qa` is a deeper read of the four checkride
  artifacts already on disk (`mutation`, `health`, `dead`, `dupes`) — *because* that is
  exactly what `../qa/spec.md`'s own open question 3 proposed; its `.claude/qa.json`
  config, its fragile/review/make-tests skills, and incremental stryker stay out of scope.
- D7 (schema-1-pin): the reader asserts `schema_version === 1` and stops loudly on any
  other value rather than guessing — *because* additive-only guarantees safety *within* a
  version and promises nothing across one.
- D8 (version-parity-test): a test asserts `plugin.json.version === package.json.version`
  — *because* two version numbers in one package is a drift family, and the publish
  workflow already gates tag-vs-package.json parity the same way.
- D9 (namespace): the skills invoke as `/checkride:check` and `/checkride:qa` — *because*
  the plugin's `name` sets the command namespace, and naming it after the engine is what
  makes the pairing legible.
- D10 (no-wrapper-skills): the plugin ships readers only; no skill wraps a CLI command —
  *because* a skill that runs one command is strictly worse than the command (indirection
  over Bash, plus a name and description resident in every session's context), and the QoL
  surface already exists as `docs/cheatsheet.md`'s command, flag and symptom→action tables.
  `doctor` and `fix` fold into the triage flow at the moment each is the right answer
  (steps 2 and 3); `baseline` — the one command carrying real judgment, and real danger,
  since a baseline hides findings permanently — is deferred until dogfooding shows whether
  `baselined` counts actually come up.
- D11 (freshness-window): an artifact belongs to the current run only when its mtime is at
  or after `Date.parse(timestamp) - total_duration_ms`; anything older is labelled stale
  with its age, never silently dropped — *because* `timestamp` is stamped when the summary
  is *built* (`src/orchestrator.ts:439`), so every artifact the run just wrote is *older*
  than it, and both fields are promised surfaces, which makes the derivation contract-legal.
- D12 (summary-is-not-evidence): triage always runs the gate itself before reading, and both
  skills state the covered slot list and the run's age before any finding — *because* every
  run overwrites `summary.json`, so a narrow `--only` run leaves `ok: true` with three of
  seventeen slots and no field in the schema says so.
- D13 (raw-output-fallback): the reader resolves a slot's raw output as `output_file`, else
  `<slot>.json`, else `<slot>.stdout.txt`/`<slot>.stderr.txt`, freshness-gates whatever it
  finds (D11 (freshness-window)), and prefers the small text file when both exist —
  *because* `output_file` is populated only when the tool emits JSON on stdout, so 8 of this
  repo's 17 slots name no file at all while their `.stdout.txt` sits in `.check/`.
- D14 (qa-reports-gaps): qa labels each of its four artifacts present / stale / not-opted-in
  and names the command or config entry that would produce a missing one, running nothing
  itself — *because* three of the four come from opt-in slots and this repo's own gate never
  runs `mutation`, so partial data is qa's normal case, not its edge case (D2
  (reader-not-runner) holds: no skill launches stryker).
- D15 (stanza-stays-standalone): the AGENTS.md stanza keeps its full prose procedure and
  gains exactly one line naming `/checkride:check` as the fuller path — *because* `init`
  runs in repos that will never install the plugin, and freezing the thin copied version
  while the real procedure lives centrally in the skill is what shrinks the drift family.

## Constraints

- C1 (no-contract-change): no change to `.check/summary.json`, the exit codes, the flag
  set, or the schema. Additive files only; nothing lands under a **Contract** heading.
- C2 (gate-stays-green): `pnpm check` green at every checkpoint — including `docs`
  (markdownlint), `spell` (cspell), `links`, `dead` (fallow) and `struct` (ast-grep) over
  the new Markdown and TypeScript.
- C3 (files-array): `.claude-plugin` and `skills` must both be in package.json `files` — or
  the published tarball carries no plugin at all and the install fails. Never `scripts`:
  `src/pack.ts`'s `DENY` forbids that path, so the `pack` slot would fail the tarball
  (D4 (readers-in-dist)).
- C4 (no-new-deps): both readers import `node:` builtins only; no `jq`, no shell, no new
  package, nothing added to `dependencies`.
- C5 (apache-2.0): the plugin ships under this package's Apache-2.0, not agent-tools' MIT.
- C6 (catalog-after-publish): the agent-tools marketplace entry cannot land until a
  checkride release carrying the manifest is on npm — that repo's CI probes the *latest*
  npm tarball for `package/.claude-plugin/plugin.json` and fails the build if absent.
- C7 (fallow-registration): each reader's entry module is listed in `fallow.toml`'s `entry`
  (as `stryker.config.mjs` already is) or `dead` fails on `unused-files`/`unused-exports`;
  and the summary/freshness/raw-output logic lives in exactly one shared module
  (`src/artifacts/`), because `dupes` runs mild at `minTokens = 50` and would flag two
  hand-copied readers — or either reader against `src/digest/` — as a clone family.
- C8 (health-budget): reader functions stay inside fallow's `[health]` thresholds
  (`maxCyclomatic`/`maxCognitive` 15, plus the CRAP and unit-size gates) — triage's
  exit-code branch tree is the one place likely to breach it, so it gets split into named
  functions rather than nested.

## Steps

1. [x] feat(plugin): ship a Claude Code plugin manifest from the package root —
   **done when:** `pnpm test` green with a new test asserting `plugin.json` parses, its
   `name` is `checkride`, its `version` equals package.json's (D8 (version-parity-test)),
   and `files` contains `.claude-plugin` and `skills` (C3 (files-array)) — plus `/version`
   bumps *both* numbers: its rewrite step and its `git add` each grow
   `.claude-plugin/plugin.json`, or the next release turns `pnpm test` red mid-bump.
   - seam: `.claude-plugin/plugin.json`, `package.json`,
     `.claude/skills/version/SKILL.md`, `test/plugin-manifest.test.ts`
   - note: the manifest test goes in `test/` — that is where repo-config tests live, beside
     `dogfood-config.test.ts`
   - model: sonnet — mechanical, fully specified by the done-when

2. [x] feat(check): add a bounded, contract-aware triage preflight reader —
   **done when:** `pnpm test` green with fixture-driven tests covering every contract
   corner the prose stanza omits — exit 2 vs exit 1, vacuous green (`ok` with
   `checks_run: 0`), **narrow green** (`ok: true` over a subset of the configured slots,
   D12 (summary-is-not-evidence)), `baselined: N`, `skipped`+`reason`, `exit_code: -1`, a
   bumped `schema_version` (D7 (schema-1-pin)), a stale artifact (D11 (freshness-window))
   and a failing slot whose raw output the summary never names (D13 (raw-output-fallback))
   — plus: the reader never dies on a red gate, and emits a compact per-check table with
   artifact sizes rather than artifact contents. On exit 2 it captures the run's stderr
   *and* folds in `checkride doctor` (read-only, same 0/1 split), so the broken-harness
   branch arrives with the diagnosis already attached instead of costing a round-trip (D10
   (no-wrapper-skills)).
   - seam: `src/artifacts/`, `src/triage/`, `src/__tests__/triage.test.ts`, `fallow.toml`
   - note: `src/artifacts/` is the shared read — parse, schema pin, freshness window,
     raw-output resolution — and it is the only copy of that logic (C7
     (fallow-registration)); `fallow.toml` gains both readers' entry modules
   - model: opus — the deterministic reader is load-bearing; pm detection, exit-code
     capture without `set -e` death, and the schema assertion are each subtle

3. [x] feat(check): add the check skill that triages a red gate —
   **done when:** `pnpm check` green (the new Markdown clears `docs`, `spell` and `links`)
   and a dogfood run — the plugin installed for real from a temporary local marketplace path
   entry (Q9 (dogfood-install)) — against a deliberately-reddened tree names one root cause,
   opens with the covered slots and the run's age (D12 (summary-is-not-evidence)), states
   which slots it is *not* reading yet, and surfaces any `baselined` count instead of
   reporting clean. An exit-2 run reports *what* `doctor` found rather than just "broken
   harness", and a red run whose failing slots are auto-fixable names `checkride fix`
   before proposing hand edits (D10 (no-wrapper-skills)).
   - seam: `skills/check/SKILL.md`
   - model: opus — the ordering judgment across simultaneous failures is the product

4. [ ] fix(check): route triage to the bytes that explain the failure —
   **done when:** two reader gaps found by step 3's dogfood are closed, with fixture tests
   for each. (a) A red gate that no slot explains — the compound `check` script
   (`tsc --build && node dist/cli.js`, the shape `init` writes) short-circuits before
   checkride runs, so the gate exits 1, writes no summary, and the verdict reads "red, 0 of
   N failed" over a stale table — renders the gate's own stderr tail, which the reader
   already captured and currently drops on the one branch where it is the only evidence.
   (b) The `failing slots` section names each alternate candidate with its size, not just
   `(+N)`, so the skill's "if the chosen file gives you a count, open the `(+1)`" rule is
   actionable without a guess. Existing triage tests stay green — this is additive
   rendering, no model change.
   - seam: `src/triage/render.ts`, `src/__tests__/triage.test.ts`
   - note: `RawOutput.candidates` already carries file, bytes and freshness for every
     alternate, so (b) needs no change to `src/artifacts/` — render-only, which is why the
     seam excludes `raw.ts`. Deliberately *not* fixing the stdout-over-stderr preference at
     `src/artifacts/raw.ts:79`: a reader cannot know which tools invert checkride's stream
     discipline without a per-adapter table, so that judgment stays in the skill's prose
     where step 3 put it.
   - model: sonnet — both changes are fully specified by the done-when

5. [ ] feat(qa): add a bounded extractor for the quality artifacts —
   **done when:** run against this repo's own `.check/`, output stays under 8 KB (matching
   `--digest`'s ceiling) while ranking the top surviving-mutant files out of 777 of 4453,
   reporting `health_score` 80.6/B with its penalty breakdown, and labelling `mutation.json`
   stale by the D11 (freshness-window) rule; fixture tests green — including the shape that
   is *normal* in a fresh consumer repo, where `mutation`, `health` and `dupes` were never
   opted in, so the extractor reports not-opted-in with the command that would produce each
   (D14 (qa-reports-gaps)).
   - seam: `src/qa-extract/`, `src/__tests__/qa-extract.test.ts`, `fallow.toml`
   - model: opus — ranking 777 survivors into a useful short list is a design call, and
     the 2.3 MB parse has to stay bounded

6. [ ] feat(qa): add the qa skill that reads quality signal —
   **done when:** `pnpm check` green and the skill grounds findings in the artifact
   priority order (surviving mutants, then dead code, then structure, then judgment last),
   opens with the present / stale / not-opted-in ledger rather than treating a gap as an edge
   case (D14 (qa-reports-gaps)), and produces no fixed-size finding list. Written with
   storium's `qa-analyze`, `qa-health` and `qa-fragile` read as input (Q2
   (storium-prior-art)) and nothing ported from the other five.
   - seam: `skills/qa/SKILL.md`
   - model: opus — the whole point is avoiding the always-8-issues failure mode

7. [ ] feat(init): point the AGENTS.md stanza at the installed skill —
   **done when:** `checkride init` and `checkride agent-setup` still write a stanza whose
   prose procedure works standalone with no plugin installed, plus exactly one added line
   naming `/checkride:check` as the fuller path (D15 (stanza-stays-standalone)); existing
   init/agent-setup tests green and updated for the new text.
   - seam: `src/init.ts` (`buildStanza`), `src/agent-setup/hook.ts`, their tests
   - model: sonnet — small prose and template edit

8. [ ] docs(plugin): document the bundled plugin and its two skills —
   **done when:** README and a `docs/` page cover install (the marketplace entry, and that
   the readers ship prebuilt in `dist/` so no consumer build step exists) and both skills,
   CHANGELOG has an `Added` entry for the release, and `pnpm check` green (`links` and
   `spell` included).
   - seam: `README.md`, `docs/`, `CHANGELOG.md`, `cspell.json`
   - model: sonnet — documenting decisions already made

## Open questions

- Q1 (stanza-rewrite-scope): *resolved:* 2026-07-24, prose stays standalone, one added
  line (D15) — how far should `checkride init`'s AGENTS.md stanza change?
  - *plain:* Replacing that copied stanza with an installed skill is the single strongest
    argument for this whole build — it is the same argument that produced the `version` and
    `commit-with-til` plugins. But `init` runs in repos that have not installed the plugin
    and may never, so the stanza cannot simply become "run `/checkride:check`" without
    breaking the plain-npm path. Getting this wrong either strands the plugin (nobody
    learns it exists) or breaks first-run for everyone who does not want it.
  - *lean:* keep the prose procedure exactly as it is — it must still work standalone — and
    add one line naming `/checkride:check` as the fuller path when the plugin is installed.
    Drift shrinks because the *thin* five-line version stays frozen while the real
    procedure lives centrally in the skill.

- Q2 (storium-prior-art): *resolved:* 2026-07-24, read qa-analyze, qa-health, qa-
  fragile; port nothing — should step 5/6 read storium's eight `qa-*` skills first?
  - *plain:* `../qa/spec.md` says read all eight before designing, and flags honestly that
    the survey found them *by name, not by quality* — they have never run outside storium.
    They are 465 lines across eight files at `~/Projects/storium/.claude/skills/qa-*`.
    Reading all eight costs context on work that may not generalize; reading none risks
    rebuilding something already solved there.
  - *lean:* read the three closest to artifact reading — `qa-analyze` (78 lines),
    `qa-health` (53), `qa-fragile` (56) — as input to steps 5 and 6, and port nothing from
    the other five. `qa-make-tests` is generation, a different job the spec already says
    not to ship alongside assessment.

- Q3 (stale-artifacts): *resolved:* 2026-07-24, freshness window off the run start (D11)
  — how should the reader treat artifacts older than the current run?
  - *plain:* Not hypothetical — in this repo's own `.check/` right now, `mutation.json` and
    `security.json` are from Jul 20 while every other artifact is Jul 24. Opt-in and slow
    slots do not run every time, and `summary.json` only lists the slots that were
    *selected*, so an unselected slot's file lingers with no entry to contradict it. A
    naive read reports four-day-old mutation data as current, which is exactly the kind of
    confidently-wrong answer this plugin exists to prevent.
  - *lean:* ~~compare each artifact's mtime against `summary.json`'s `timestamp`~~ — that
    first form was wrong, and measurably so: `timestamp` is stamped when the summary is
    *built* (`src/orchestrator.ts:439`), so the run's own artifacts are all older than it
    (summary at `02:15:16.214Z`, `links.json` at `02:15:14.852Z`) and the rule would call
    everything stale. Compare instead against `Date.parse(timestamp) - total_duration_ms`,
    the run's start — both fields are promised, so the derivation is contract-legal — and
    label anything older as stale, with its age; surface it, never silently drop it.
    Applies to both readers, so it lands in the shared module in step 2 and is reused in
    step 5 (D11 (freshness-window)).

- Q4 (reader-home): *resolved:* 2026-07-24, TypeScript in src/, shipped in dist/ (D4) —
  where does the reader code live, given `scripts/` can never ship?
  - *plain:* C3 (files-array) says put `scripts` in package.json `files`, but this
    package's own `pack` check forbids exactly that — `src/pack.ts:111`'s fixed `DENY`
    list includes `/(^|\/)scripts(\/|$)/`, so the first tarball carrying
    `scripts/triage.mjs` fails the `pack` slot and takes `pnpm check` red. C2
    (gate-stays-green) and C3 cannot both hold as written. The thing to re-examine is D4
    (plain-node-scripts), whose *because* — "a skill must run in a consumer repo with no
    build step" — does not survive contact: the published package already ships built
    `dist/`, and a plugin install carries it (plumbbob's own installed copy at
    `~/.claude/plugins/cache/robmclarty/plumbbob/0.8.18/` has `dist/` and `node_modules/`
    beside `skills/`). Two further facts cut the same way: `typecheck-tests` covers
    `src/**` + `test/**` with no `allowJs`, so a `.test.ts` cannot import a `.mjs` reader
    at all (tests would have to spawn it), and `.oxlintrc.json` already lists `scripts/**`
    under `ignorePatterns`, so a reader living there gets no lint at all. Meanwhile
    `src/digest/digest.ts` already owns the bounded-excerpt machinery (`DigestBudget`,
    truncate-never-normalize) that both readers want.
  - *lean:* write both readers as TypeScript modules under `src/`, ship them in the
    existing `dist/`, and have each SKILL.md invoke `node <plugin-root>/dist/<reader>.js`.
    C3 shrinks to `.claude-plugin` + `skills`, D4 is retired as false, and D2
    (reader-not-runner) still holds — no new CLI command, no new flag, nothing added to
    `index.ts`'s exports. If you would rather the plugin stay self-contained and
    gate-light, the alternative is `.mjs` relocated *inside* the plugin tree
    (`skills/check/triage.mjs`), tested by subprocess.

- Q5 (narrow-green): *resolved:* 2026-07-24, never trust a pre-existing summary (D12) —
  does a narrow run's green summary count as green?
  - *plain:* Verified live while refining: `.check/summary.json` in this repo right now
    lists exactly three checks (`links`, `docs`, `spell`), `ok: true`, `checks_run: 3`,
    `total_duration_ms: 1370` — the last thing to run was a narrow selection. The other
    fifteen artifacts on disk are from a full run fourteen minutes earlier;
    `mutation.json` and `security.json` are four days old. Every run overwrites
    `summary.json`, so `ok: true` can mean "three of seventeen slots passed". That is not
    vacuous green (`checks_run: 0`), it is not in step 2's fixture list, and it is the
    likeliest confidently-wrong answer in real use.
  - *lean:* triage never trusts a pre-existing summary — it runs the gate itself (D3
    (repo-script-preflight)) and only then reads — and both skills state the covered slot
    list and the run's age before any finding. Add narrow green to step 2's contract
    corners, beside vacuous green.

- Q6 (raw-output-lookup): *resolved:* 2026-07-24, the reader owns the convention
  fallback (D13) — who owns finding a failing slot's raw file?
  - *plain:* The frame rests on "the summary is an index; the raw file is the truth", but
    the index does not name most raw files. On this repo's full run, 8 of 17 checks had
    `output_file: null` (`types`, `docs`, `spell`, `typecheck-tests`, `build`, `publint`,
    `test`) while `docs.stdout.txt`, `publint.stdout.txt`, `build.stderr.txt` and
    `test.stdout.txt` all sit in `.check/` — the field is populated only "when it emits
    JSON on stdout" (`schema/checkride.summary.schema.json:52`). `test` is the slot most
    likely to need triage and it is one of the eight.
  - *lean:* the reader owns the documented convention as a fallback — `output_file`, else
    `<slot>.json`, else `<slot>.stdout.txt`/`<slot>.stderr.txt` — freshness-gates whatever
    it finds (Q3 (stale-artifacts)), and prefers the small text file when both exist
    (`test.stdout.txt` 5 KB vs `test.json` 650 KB). It must never report "no output" for a
    slot whose file it merely was not handed.

- Q7 (qa-depth-vs-optin): *resolved:* 2026-07-24, pure reader that reports gaps (D14) —
  what does `/checkride:qa` do when its artifacts were never produced?
  - *plain:* Three of qa's four artifacts come from opt-in slots, and this repo's own gate
    never runs `mutation` at all — it is absent from `checkride.config.json`, which is why
    `mutation.json` comes from a separate `pnpm mutation` run four days ago rather than
    from any `pnpm check`. In a default consumer repo, `/checkride:qa` finds `dead.json`
    and nothing else. Partial data is the skill's normal case, not its edge case.
  - *lean:* qa stays a pure reader (D2 (reader-not-runner)) — for each of the four it
    reports present / stale / not-opted-in, names the exact command or config entry that
    would produce a missing one, and never launches stryker itself. Step 6's "degrades
    explicitly when an artifact is absent" is promoted to the main path, and step 5's
    fixtures cover mutation-absent.

- Q8 (version-bump-coupling): *resolved:* 2026-07-24, keep the parity test, teach
  /version — who bumps the second version number?
  - *plain:* D8 (version-parity-test) is the right instinct and plumbbob ships the same
    pairing (`plugin.json` `version: 0.8.18` equals its package.json). But nothing would
    bump the new number: `.claude/skills/version/SKILL.md` rewrites `package.json` and
    `CHANGELOG.md` and commits exactly those two paths, so the first `/version patch`
    after this build turns `pnpm test` red mid-release, right after the changelog is
    written and before the tag.
  - *lean:* keep D8 and add `.claude/skills/version/SKILL.md` to step 1's seam — both the
    version rewrite and the `git add` grow `.claude-plugin/plugin.json`. Fix it in the
    step that creates the coupling, not in the docs step.

- Q9 (dogfood-install): *resolved:* 2026-07-24, temporary local marketplace path entry —
  how do steps 3 and 6 invoke the skills before any publish?
  - *plain:* Steps 3 and 5 are the only ones whose done-when is a live skill run, and C6
    (catalog-after-publish) means npm cannot serve the plugin until a release exists.
    Nothing currently installs it from a working tree, so as written those two done-whens
    are unverifiable.
  - *lean:* the agent-tools marketplace already mixes sources (`{"source": "npm", …}` for
    plumbbob, `"./plugins/version"` for local ones), so add a temporary uncommitted path
    entry pointing at this repo root, dogfood a real `/checkride:check`, then remove it.

## Verdicts

- 2026-07-24 — plugin home (spec open question 3): agent-tools vs bundled inside checkride
  → chose **bundled inside checkride** (D1 (bundled-in-checkride)); the reader versions in
  lockstep with the pre-1.0 contract it reads. Cost accepted: checkride ships no
  `.claude-plugin/` or `skills/` today, so this is a real build here, and the agent-tools
  catalog entry is gated behind a publish (C6 (catalog-after-publish)).
- 2026-07-24 — preflight command (spec open question 1) → chose **the repo's own `check`
  script with a raw-artifact fallback** (D3 (repo-script-preflight)); the repo script is
  the definition of done. Noted at decision time: the fallback is the common path, not the
  rare one, so it gets built properly rather than as an afterthought.
- 2026-07-24 — scope (spec open question 4, qa spec open question 3) → chose **two skills**,
  with `qa` scoped to the artifacts checkride already writes (D6 (qa-is-artifact-read)),
  not the whole of `../qa/spec.md`.
- 2026-07-24 — Q4 (reader-home): `.mjs` under `scripts/` vs TypeScript under `src/` → chose
  **TypeScript shipped in the existing `dist/`** (D4 (readers-in-dist)). Forced by a verified
  collision: `src/pack.ts`'s `DENY` forbids `scripts/` in the tarball, so C2 and C3 could not
  both hold; and D4's original *because* was false — the published package and the installed
  plugin cache both carry a built `dist/`, so no consumer build step exists either way. Cost
  accepted: the readers now sit inside this repo's own coverage, `health` and `mutation`
  surface (C8 (health-budget)), and every reader file must be registered with fallow
  (C7 (fallow-registration)).
- 2026-07-24 — Q3 (stale-artifacts) → chose **the freshness window off the run start**
  (D11 (freshness-window)); the first form of the rule (mtime vs `timestamp`) was wrong,
  because `timestamp` is stamped when the summary is built, which makes every fresh artifact
  look stale.
- 2026-07-24 — Q5 (narrow-green) and Q6 (raw-output-lookup) → chose **the summary is an
  index, not evidence** (D12 (summary-is-not-evidence), D13 (raw-output-fallback)): triage
  runs the gate itself, and it resolves raw output by the documented convention when
  `output_file` is null — which it is for 8 of this repo's 17 slots, `test` among them.
- 2026-07-24 — Q7 (qa-depth-vs-optin) → chose **a pure reader that reports its gaps**
  (D14 (qa-reports-gaps)); no skill launches stryker, and partial data is treated as qa's
  normal case since this repo's own gate never runs `mutation`.
- 2026-07-24 — Q1 (stanza-rewrite-scope) → chose **the prose procedure stays standalone**
  with one added line naming `/checkride:check` (D15 (stanza-stays-standalone)); the
  plain-npm path must keep working untouched.
- 2026-07-24 — Q2 (storium-prior-art) → chose **read three of the eight** (`qa-analyze`,
  `qa-health`, `qa-fragile`) as input to steps 5 and 6; port nothing.
- 2026-07-24 — Q8 (version-bump-coupling) → chose **keep D8 and teach `/version`**; the
  coupling is fixed in step 1, the step that creates it, not left for release day.
- 2026-07-24 — Q9 (dogfood-install) → chose **a temporary uncommitted local marketplace path
  entry** so steps 3 and 6 verify against a real install, removed once they land.
- 2026-07-28 — step 3's dogfood surfaced two reader gaps → **inserted a new step 4** and
  renumbered the qa/init/docs steps to 5–8. Both gaps are in step 2's already-checkpointed
  code, and the skill currently compensates for them in prose. The deciding argument is
  traffic, not severity: `tsc --build && node dist/cli.js` is the shape `init` writes and a
  type error is the usual way a TS repo goes red, so "red with no failing slot" is a
  high-traffic branch on which the reader drops the only evidence it holds — the same
  round-trip the `doctor` fold exists to eliminate. Sequenced before qa so the reader is
  honest before a second skill is built on the same rendering ideas. Explicitly *not*
  folded in: the stdout-over-stderr preference (the skill's prose is the right home, since
  no reader can know which tools invert the convention) and the pnpm 11 stdout pollution
  (an adapter-robustness bug affecting every pnpm 11 consumer — a different seam and its
  own build, not scope drift on this one).

## Source

The spec was written on 2026-07-24 against **checkride 0.3.x**. This package is at
**0.7.0**. What that changes, verified against `docs/contract.md`,
`schema/checkride.summary.schema.json`, `CHANGELOG.md` and `.check/` on 2026-07-24:

- **Still true, and the load-bearing fact:** `schema_version` is *still* `1`. The
  additive-only discipline held across four minors — the strongest available evidence that
  a reader pinned to schema 1 is safe (D7 (schema-1-pin)).
- **Stale in the spec:** the pin example (`"checkride": "0.3.0"`); the license — checkride
  went **Apache-2.0** in 0.7.0, previously MIT (C5 (apache-2.0)).
- **Missing from the spec:** the command set is `checkride`, `init`, `doctor`, `fix`,
  `baseline`, `agent-setup`. `fix` (runs every active adapter's fix command) and `doctor`
  both belong in a triage skill's vocabulary and were not in the spec's reading.
- **Also new since 0.3:** `optIn` per-slot override (0.6.0), `order` waves as a first-class
  promised surface (0.5.0), `links` `exclude`/`allowlist` (0.6.0), `publint`/`attw` skip
  cleanly when their tool is absent (0.6.0).

The contract this plugin consumes, unchanged:

- **`.check/summary.json`** — `schema_version`, `timestamp`, `ok`, `checks_run`,
  `total_duration_ms`, `checks[]`. Each check: `name`, `adapter` (nullable),
  `description`, `ok`, `exit_code` (`-1` spawn failure or timeout, `null` when skipped),
  `duration_ms`, `output_file` (nullable), and optionally `skipped`, `reason`,
  `baselined: N`. `additionalProperties: false`.
- **Exit codes are a promise:** `0` pass · `1` at least one check failed · `2` the harness
  broke or was misused. A consumer may safely branch on the 1-vs-2 split. An unknown slot
  in `--only`/`--skip`/`--include` is exit 2, never a silently-empty selection — "a typo
  like `--only lints` must never quietly disable the gate."
- **Vacuous green is detectable:** `ok: true` with `checks_run: 0` means nothing was
  verified. `--strict` turns it into exit 2.
- **Array order is deterministic:** group sequence (`first`s, numeric waves ascending,
  `single`s, `last`s), then catalogue position, independent of finish order.
- **Raw output stays authoritative:** `.check/<slot>.json`, else
  `<slot>.stdout.txt`/`<slot>.stderr.txt` — the tool's own bytes, never normalized. The
  summary is an index; the raw file is the truth. This is the product's thesis and will not
  change.
- **Artifacts are crash-consistent** — atomic temp-then-rename; no torn JSON to guard against.
- **`.check/digest.md`** — `--digest` writes a token-bounded Markdown excerpt of the
  *failing* slots (~10 findings per slot, 8 KB ceiling). Written only on failure; a green
  `--digest` run removes a stale one, so **the file's existence always means this run had
  failures.**
- **Stream discipline:** stdout is machine output only; progress and warnings go to stderr.
- **Slots:** types, format, lint, struct, dead, dupes, health, test, docs, links, spell,
  mutation, security, publint, attw, plus config-defined custom checks. Opt-in: format,
  dupes, health, mutation, security, publint, attw.

Measured in this repo on 2026-07-24, and the reason for D5 (bounded-reads):

| artifact | size | note |
|---|---|---|
| `mutation.json` | 2.3 MB | 777 surviving mutants of 4453; dated Jul 20, four days stale |
| `test.json` | 650 KB | vitest JSON; `test.stdout.txt` is 5 KB and usually the better read |
| `attw.json` | 57 KB | |
| `health.json` | 45 KB | `health_score` 80.6 grade B; hotspots and unit-size carry the penalty |
| `dead.json` | 2.6 KB | ~20 finding categories, most empty |
| `dupes.json` | 483 B | `clone_families`, `clone_groups`, `stats` |

The three arguments the spec makes for the plugin existing at all, kept verbatim in
substance: (1) replacing a copied AGENTS.md stanza with one centrally-updated installed
skill; (2) triaging the contract's edge cases the prose stanza never mentions; (3)
root-cause ordering across simultaneous failures — when `types` and `test` both fail, the
type error is almost certainly the cause and the test failures are noise, and saying so
is model judgment that cannot be a script.

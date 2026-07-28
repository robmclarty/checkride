# Spec: agent-setup upgrade, the CI concurrency default, and two adapter fixes

**Status:** implemented — landed on main for the next minor (see the
CHANGELOG's Unreleased section); kept as the design record.
**Provenance:** items (1)-(6) were written by a consumer of checkride 0.7.0
(a pnpm hybrid monorepo, 11 active checks, GitHub Actions gate) who hit all
six while adopting the Stop hook and standing up CI, originally read from the
published 0.7.0 dist. Items (7)-(8) were reported by a second consumer
(minga-kb-brain, adopted at 0.7.0, pnpm 10.18.1) and have been reproduced by
the maintainer — the version boundaries and exit codes cited there are
measured, not assumed. Every site below has been re-validated against source
at v0.8.1, and references are `src/` paths with 0.8.1 line numbers. Line
numbers are given only to help you locate things — confirm each site against
HEAD by name before editing; main may have moved.

Upgrade checkride's agent-setup surface, fix its CI concurrency default, and
fix two consumer-reported adapter bugs. Eight changes, in this order — each is
independently shippable, so land them as separate commits. `pnpm check` is the
definition of done here; keep the repo green at every commit.

## (1) FIX: the AGENTS.md stanza under-reports the gate

Both stanza entry points derive `buildStanza`'s active-check list from
`inventory()`, via the shared helper `writeAgentsStanza` (src/init.ts:701) —
called from `initExisting` (src/init.ts:946) and `runAgentSetup`
(src/init.ts:1007), each passing `inventory(...).filter(adopted)`.
`inventory()` (src/init.ts:174) filters out opt-in slots and passes
`config: null`, so it never reads checkride.config.json. On my repo the gate
runs 11 checks and the generated line says 8: it silently drops `format` and
`build` (opt-in slots that only a config entry opts in) and `typecheck-tests`
(a non-catalogue custom check, invisible to inventory by construction). The
stanza is the agent-facing contract, so an agent reads "format is not active"
when it is.

Derive it instead from the same selection the default run uses:
`selectChecks(resolveChecks({...}), {})`. `doctor` already does exactly this
for its `defaultActive` set (src/doctor.ts:482-483) — reuse that pattern rather
than inventing a second one. `inventory()` answers "what could this repo
adopt", which is the right input for `init --add` and the wrong input for the
stanza; leave its other callers alone. Fix both call sites — the shared
`writeAgentsStanza` helper is the natural choke point, so the fix can
centralize there as long as both callers feed it the config-aware selection.
Add a regression test with a config that opts in an opt-in slot and declares a
custom check, asserting both appear. Assert the active-check *list*, not the
full stanza text — the stanza's prose changed in 0.8.0 (it now names
`/checkride:check`) and will change again.

## (2) REFACTOR: checkride should own a hook *script*, not an inline command

`applyStopHook` (src/agent-setup/hook.ts:62) matches one sentinel
(`checkride: the gate is red`, src/agent-setup/hook.ts:31) and rewrites the
command in place, so any consumer customization is clobbered on the next
`agent-setup` — and "idempotent" only holds if nobody touched it. Move the
body into a checkride-owned `.claude/hooks/checkride-gate.sh` that checkride
writes and overwrites freely; the settings.json entry becomes a stable
one-liner invoking it. That makes refresh genuinely lossless and gives
customization a natural home (a sibling script, or an env var the generated
script reads). Migrate repos already carrying the inline form — detect by the
existing sentinel and replace, never duplicate. Preserve the property test
(`src/__tests__/init.test.ts:458`, "applying twice is a no-op (deep equal)"):
applying twice yields deep-equal settings.

## (3) FEATURE: the gate should run `--strict --digest`, not bare `<pm> run check`

The generated command is currently `${pm} run check`
(src/agent-setup/hook.ts:50). The hook IS a gate, and docs/contract.md (lines
37-38) says anything that gates should pass `--strict` — checkride's own
generated hook doesn't. `--digest` then writes the token-bounded
.check/digest.md, a far better landing spot for an agent than raw
summary.json; the contract's digest presence semantics (docs/contract.md §
`.check/summary.json`, "digest.md presence semantics") already guarantee a
green run clears any stale digest, so "digest.md exists" is a reliable signal.
Update the guidance message to point at digest.md when it exists and
summary.json otherwise, and to name `/checkride:check` as the full triage path
when the plugin is installed — the 0.8.0 stanza already blesses it, and the
hook's guidance should agree with the stanza. Keep the sentinel substring
stable so (2)'s migration detection works.

Flag-passing is PM-specific: pnpm, yarn, and bun forward
`run check --strict --digest` to the script directly, but npm requires
`npm run check -- --strict --digest`. The hook command is parameterized by
detected PM, and test/e2e/pm-quartet.e2e.test.ts will catch a miss — get all
four forms right.

## (4) FEATURE: a PostToolUse dirty-marker hook, and make the gate conditional on it

Stop fires at the end of *every* turn, including pure-conversation turns that
touched no files. On my repo that's a 7-second tax plus a
`biome format --write` over the tree for a turn that changed nothing — the
single best reason to disable the gate, so fixing it protects the feature.
Write a PostToolUse hook matching `Edit|Write|NotebookEdit` that touches a
marker under .check/ (already gitignored by `init` — src/init.ts:845); the
gate script exits 0 immediately when the marker is absent, and clears it after
a green run. This is not a new gate — it's the guard input the existing one
needs.

Name the marker outside the slot-artifact namespace — `.check/.dirty`, not
`.check/dirty` — because the orchestrator deletes `<slot>.stdout.txt`,
`<slot>.stderr.txt`, and `<slot>.json` per slot before re-running it
(`clearSlotOutputs`, src/orchestrator.ts:406-415); it never wipes the
directory, so a dot-named marker survives every run by construction.

Known, accepted gap: file mutations made through Bash (sed, heredocs,
`git checkout`) don't fire PostToolUse for Edit/Write and won't set the
marker. Widening the matcher to Bash would fire on every command, defeating
the point. Accept the gap and record it in a comment in the generated script;
the worst case is a skipped gate on a turn whose only writes bypassed the edit
tools, which the next tool-edited turn re-covers.

## (5) FEATURE: a PreToolUse deny hook for checkride.baseline.json and .check/**

"Never add to the baseline to make a check pass" is currently advice in a
README that an agent editing the file has every local incentive to ignore.
Both paths are unambiguous, so a path-based deny is exact. The deny must cover
write tools only — `Edit|Write|NotebookEdit` — and never `Read`: the stanza's
own procedure and both bundled plugin skills (`/checkride:check`,
`/checkride:qa`) *read* .check/ artifacts, so a blanket deny would break
checkride's documented triage flow. Do NOT extend this to module-boundary
enforcement: that rule lives in ast-grep rules over parsed code, and a
path-based approximation would be a second, weaker encoding that drifts from
rules/.

## (6) FIX: the default concurrency collapses to 1 on a CI runner

`defaultConcurrency()` (src/orchestrator.ts:199-200) is
`Math.min(4, Math.max(1, cpus().length - 1))`, documented as reserving a core
to keep the machine responsive. That reasoning is sound on a laptop and
inapplicable on a hosted runner, where there is no human to keep responsive —
and a standard GitHub-hosted ubuntu runner reports 2 CPUs, so the pool is 1
and a wave-scheduled config executes fully sequentially.

Measured on my repo: on CI, 27,364ms wall against 27,355ms summed across 11
checks — 1.00x, every check serialized. The same config on a 12-core laptop
does 14.9s of check time in 7.0s wall (2.1x). So checkride's own scheduling
surface — `order` waves, promised as first-class since 0.5.0 — silently does
nothing on the machine class its docs tell you to gate on, and the effect is
invisible unless you compare `total_duration_ms` against the sum of
`duration_ms`.

Don't reserve the core when `process.env.CI` is set (every CI provider sets
it; nothing in src/ reads it today). Keep the cap of 4. Verify rather than
assume that pool 2 beats pool 1 on a 2-core box: several checks are dominated
by process startup and file discovery rather than CPU, which is why
oversubscription helps, but measure it — if 2-wide on 2 cores turns out to be
a wash for CPU-bound tools, say so in the CHANGELOG instead of claiming a
speedup. `--concurrency` stays the explicit override and `--bail` keeps
overriding both. docs/ci.md should state the runner-size effect, since a
consumer currently has no way to know their waves aren't running.
docs/contract.md deliberately doesn't pin the formula ("a conservative cap
derived from the CPU count"), so this is contract-compatible with no contract
edit.

## (7) FIX: `pack` fails hard under pnpm older than 10.26

The `pack` slot's pnpm invocation (`packInvocation`, src/pack.ts:53-58) is
`pnpm pack --dry-run --json --config.ignore-scripts=true`. pnpm only learned
`pack --dry-run` in 10.26.0; every earlier pnpm rejects the flag with
`ERROR Unknown option: 'dry-run'` and the slot fails hard. Measured by probe:
10.18.1 (the reporting repo's version), 10.19.0, 10.20.0, 10.24.0, and
10.25.0 all reject it; 10.26.0 onward and 11.x accept. The 0.5.0 changelog
promises npm/pnpm support with only yarn/bun deferred, so this is a real
adapter bug on a manager checkride claims to support — and this repo's own
gate never sees it because it runs a current pnpm.

Fix by capability fallback, not version sniffing: when the `--dry-run` form
fails with the unknown-option error, rerun as a real pack —
`pnpm pack --json --pack-destination <temp dir>` — and delete the tarball
after reading the file list. Both facts that make this work are verified on
10.18.1: the destination form emits the same npm-shaped `files[].path` JSON
the dry-run form does, and it accepts `--config.ignore-scripts=true`. Keep
that flag on both forms — the prepack-suppression comment in pack.ts explains
why it is load-bearing. The destination must live outside the repo so a
failure can never leave a tarball in the tree or in another check's view, and
the tarball must be removed even when the content check then fails. CI runs a
single pnpm version, so the rejecting path can't stay covered by the e2e
suite — add a unit test that stubs the spawner to reject the first form and
asserts the fallback runs and parses.

## (8) FIX: the security slot gates at zero advisories, not `--audit-level`

The `pnpm-audit` adapter (src/adapters.ts:395-403) runs
`pnpm audit --audit-level=high --json` and judges the slot by exit code alone
(no builtin). But pnpm's JSON mode exits 1 on *any* advisory regardless of
`--audit-level` — only table mode lets the level gate the exit code.
Reproduced on 10.18.1 with a fixture whose lockfile carries exactly one
moderate advisory (`tough-cookie` 4.1.2): `--audit-level=high --json` exits
1; the same lockfile in table mode exits 0. So the shipped default gates at
zero advisories of any severity, not the declared high. The reporting repo's
`--json`-less args override was load-bearing for exactly this reason, at the
cost of the security.json artifact; this repo doesn't hit the bug only
because 0.6.0 cleared its own moderates.

Own the evaluation instead of trusting pnpm's exit code: make `security` a
builtin evaluator in the same shape as pack's — run with `--json`, parse the
output (the 0.8.1 leading-lines tolerance in tool-json.ts applies), and fail
only on advisories at or above the threshold parsed from the adapter's own
`--audit-level=<level>` arg, so a consumer who overrides the level keeps
their threshold. Distinguish "audit could not run" (registry unreachable,
malformed output — fail, surfacing the error) from "ran; every advisory sits
below the level" (green), and keep writing security.json. Test the evaluator
against canned audit JSON at each severity boundary — no network in tests.
CHANGELOG under Fixed: consumers who dropped `--json` to work around this can
return to the default args and get the artifact back.

## Explicitly OUT of scope — do not add

- `ciArgs`/`--ci`, or a per-slot `ci: false`. Discussed and rejected: `--skip`
  already covers exclusion, and a config flag that shrinks the CI run would
  pass `--strict` while quietly narrowing the gate. Wait for a second real
  consumer.
- A SessionStart `doctor` hook. Startup latency on every session for output
  that's noise when green; at most opt-in later.
- A per-file or per-package check mode. Contradicts the run-once-from-root
  model.
- Routing the hooks through the bundled plugin (see below).

## Surface for (2)-(5)

`agent-setup`/`init` grow `--hook <a,b>` to select which hooks to write
(default: all), with `--no-hook` unchanged as the escape. The CLI currently
has only the `no-hook` boolean (src/cli.ts:49), so a string-valued `--hook` is
cleanly additive. Hooks need a registry keyed by a per-hook sentinel rather
than hook.ts's single one.

## Relationship to the bundled plugin

Since 0.8.0 checkride *is* a Claude Code plugin: `.claude-plugin/plugin.json`
plus `skills/check` and `skills/qa` ship from the package root (see
docs/plugin.md). Claude Code plugins can also carry hooks — do NOT route these
hooks through the plugin manifest. The repo's stated position is that the
plugin is optional sugar ("Nothing about the CLI, the exit codes or the
`.check/` contract changes, installed or not"), and the gate must work in a
repo that never installs it, so the hooks stay `agent-setup`-written into the
consumer repo and the plugin stays readers-only. If the hook suite grows past
this, revisit: the Claude-specific writers should sit behind
src/agent-setup/claude/* with room for a sibling harness and a generic
`checkride gate` command any harness can call. A comment noting that is
enough.

## Definition of done

`pnpm check` green; new contract tests for the additive `--hook` flag in
test/contract/flags.contract.test.ts (docs/contract.md §CLI updated); e2e
generated projects still green out of the box; README command surface,
docs/getting-started.md, docs/cheatsheet.md, docs/ci.md, and docs/tools.md
(the pnpm floor-and-fallback for `pack`, the level semantics `security` now
owns) updated; CHANGELOG entry under a new minor heading (0.9.0 as of this
writing). (1), (2), (6), (7), and (8) are all user-visible — (1) is a
behavior fix, (2) rewrites a file in consumer repos, (6) changes CI
wall-clock, and (7)/(8) change what two slots fail on — so call them out
under Fixed/Changed, not just Added.

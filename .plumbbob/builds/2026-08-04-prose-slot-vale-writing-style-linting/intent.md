# prose slot: vale writing-style linting

**Phase** (your own bookkeeping while framing): frame
**Size:** medium
**Scope:** prose

## Frame

- **Problem:** checkride gates every mechanical property of a repo — types, lint,
  structure, dead code, tests, links, spelling — but nothing gates the *writing*.
  A repo whose docs are its product (this one: a 31k README, fifteen files in
  `docs/`, load-bearing doc comments in every module) has no check that catches a
  doubled word, a hedge, a weasel, or a term used two different ways. `spell`
  (cspell) answers exactly one question — "is this a word?" — and by design has no
  opinion on anything past the word boundary.
- **Smallest thing that solves it:** one new **opt-in `prose` slot**, filled by a
  `vale` adapter running the `@vvago/vale` binary against a repo-authored style
  under `.vale/styles/` (D18). Detected on `.vale.ini`/`_vale.ini`, JSON output to `.check/prose.json`,
  fingerprinted into the same baseline that already covers `lint`/`struct`/`spell`.
  No new checkride machinery: it is an ordinary registry entry plus a scaffold.
- **Done looks like:** `pnpm check` runs `prose` on this repo and exits 0; a
  planted doubled word in any `.md` or any `.ts` doc comment turns it red;
  `checkride init --add prose` scaffolds a working `.vale.ini` + `.vale/styles/` into a
  fresh repo; `docs/tools.md` documents the slot and the cspell division of labour.
- **Explicitly NOT doing:** retiring or narrowing `spell`/cspell (D1); vendoring
  third-party vale packages into this repo (D7); running `vale sync` — or any
  network call — from inside a check (C1); a `gate: 'vale'` JSON verdict (D6);
  making `prose` part of the default run (D3); an `exclude` config key for the
  adapter (D14); polyglot comment linting beyond the `[formats] ts = js` mapping.

## Architecture sketch

```
checkride.config.json  "prose": { "use": "vale", "args": [...paths] }
        │
        ▼
   SLOTS + ADAPTERS            (src/adapters.ts — pure data, the whole feature)
   { name: 'prose', optIn }
   { name: 'vale', slot: 'prose', detect: ['.vale.ini'], outputFile: 'prose.json' }
        │
        ▼
   pnpm exec vale --no-global --output=JSON <paths>
        │
        ├─► exit 1 iff error-severity alerts ──────► the verdict (D6)
        │
        └─► stdout JSON  { "<path>": [ {Check, Message, Severity, Line, Span} ] }
                  │
                  ├─► .check/prose.json               (raw, authoritative)
                  └─► fingerprint('vale', raw)        (src/baseline/fingerprint.ts)
                          key = <file>:<Check>:<Message>    ── same shape as
                          oxlint/ast-grep, so `checkride baseline` grandfathers
                          today's findings and ratchets forward

   .vale.ini ──► StylesPath = .vale/styles ──► .vale/styles/Repo/*.yml   (ours, hermetic)
                 Vale.Spelling = NO  (D2: cspell owns spelling)
                 [formats] ts = js   (D5: TS doc comments)
```

## Decisions

- D1 (keep-cspell): cspell stays, unchanged and unnarrowed — vale does not supersede it — *because* vale reads only markup and code *comments* (never identifiers or string literals), and its plain en_US Hunspell dictionary flagged `Config`, `tsconfig`, `oxlint`, and `devDeps` as errors where cspell's programming dictionaries accept them.
- D2 (spelling-one-owner): the scaffolded `.vale.ini` sets `Vale.Spelling = NO` — *because* two spell checkers means two wordlists to maintain and every unknown word reported twice; `prose` owns style, `spell` owns spelling.
- D3 (opt-in): `prose` ships `optIn: true`, like `format`/`dupes`/`health` — *because* adopting checkride must never start failing a repo on the writing style it never signed up for.
- D4 (detect-vale-ini-only): detect on the config file alone (`.vale.ini`, `_vale.ini` — vale's own discovery names), **no `detectDeps`** — *because* vale hard-errors (`E100`, exit 2) with no config file, so it is not configless-capable and the publish-bundle build's rule that `detectDeps` lands only on configless-capable adapters excludes it.
- D5 (md-plus-comments): lint `.md` plus TypeScript doc comments via `[formats] ts = js` — *because* vale has no native `.ts` format, the mapping is verified working (it caught a planted `teh` inside a docblock), and this repo's comments carry as much prose as its docs. Step 4 makes it earn its keep: source-comment findings are counted separately from markdown findings, and if the comment half is mostly directives and false positives, `.ts` drops from the path list (one line) and the slot stays markdown-only — there is no per-line escape hatch (`// vale off` verified not to work inside `.ts` comments), so the mapping survives on real numbers or not at all.
- D6 (trust-exit-code): no `gate: 'vale'`; the process exit code is the verdict — *because* unlike fallow's, vale's exit code is honest (1 iff error-severity alerts exist). The tradeoff is real and documented: demoting a rule to `warning` makes it advisory and the slot green (verified: 4 warnings, exit 0), so the scaffold ships every enabled rule at `error` (the weasel rule ships disabled — D15).
- D7 (repo-authored-styles): the scaffolded style is ours, under `.vale/styles/Repo/*.yml` (D18); no `Packages`, no `vale sync` on the default path — *because* built-in `Vale` alone found **0 findings** across this entire repo (near-vacuous), while Google + write-good + proselint fired **967** on four files, dominated by house-style opinions that fight the author's voice (331 E-Prime, 130 EmDash, 96 Parens, 67 Contractions).
- D8 (mechanical-rules-only): the shipped rules are objective ones — doubled words, weasel words, there-is, latin abbreviations, ly-hyphens, term casing — never voice opinions (passive, contractions, em-dashes, first person) — *because* a rule the author disagrees with gets suppressed, and a slot full of suppressions is ceremony.
- D9 (no-global-config): the adapter always passes `--no-global` — *because* vale otherwise loads `~/.vale.ini`, making the verdict depend on the machine, which is exactly what `docs/reliability.md` forbids of a gate.
- D10 (paths-via-args): path scoping happens through the paths passed on the command line, not the config — *because* vale reads no `.gitignore` and skips no hidden directory (verified: a bare `vale .` here walked `.stryker-tmp/`, `dist/`, `.plumbbob/`, `.claude/`, and `research/`), and path-scoped `.vale.ini` sections did not match. Default args stay `.`; this repo overrides `args` with explicit paths, exactly as it already does for `lint`. Kept honest by `test/dogfood-config.test.ts`: every tracked `.md` outside a known-excluded set must be reachable from the configured `prose` paths, so a doc the path list misses turns the check red instead of going silently unlinted.
- D11 (baseline-support): `prose` gets a fingerprint extractor keyed on adapter name `vale` — *because* a naive three-rule prototype already produced 373 findings here, and the baseline is precisely the mechanism for grandfathering today's findings and ratcheting forward.
- D12 (allow-builds): `@vvago/vale` needs an `allowBuilds` entry in `pnpm-workspace.yaml` — *because* it downloads its Go binary in a `postinstall`, which pnpm 11 blocks by default (the same treatment `@ast-grep/cli` and `fallow` already get).
- D13 (npm-no-resolver): `prose` ships with no special binary resolver; `docs/tools.md` documents the caveat — under npm, install vale yourself or use pnpm — *because* npm creates no bin shim for a binary that only exists after `@vvago/vale`'s postinstall, a `node_modules/@vvago/vale/bin/vale` fallback is real machinery (C6) for a case no one has hit, and `security` already sets the precedent of a PM-limited slot. (was Q1)
- D14 (no-exclude-key): the vale adapter gets no `exclude` config key — *because* D10's `args` override already scopes it with no new surface, the pattern is established by this repo's `lint` entry, and a second exclusion mechanism would have to be kept consistent with the first forever. Revisit only if the default `.` proves noisy for every adopter. (was Q2)
- D15 (narrow-default-rules): the shipped default enables only objective rules — doubled words (`Vale.Repetition`), there-is/there-are, latin abbreviations, `-ly` hyphens — at `error`; the weasel rule ships in the style but disabled in the scaffolded `.vale.ini`, one uncomment away — *because* built-in-only was vacuous (0 findings here), 319 of the prototype's 373 hits were weasel findings on mostly legitimate careful prose, and an adopter should opt into the subjective half deliberately. (was Q3)
- D16 (null-on-unreadable-report): `extractVale` is shape-aware and returns `null` — never the empty set — for anything that is not an alert report — *because* vale's runtime errors (`E100`/`E201`) are a flat object an alert-shaped reader sees as zero findings, and one full run against a broken config would silently prune every grandfathered prose key from the baseline; `null` means "not observed", the ratchet stands down, and the only cost is widening the internal `Extractor` type to `Fingerprint | null` (softening its "never null" doc comment), since `fingerprint()` already returns `null` and every caller honors it. (was Q4)
- D17 (terms-off): `Vale.Terms` stays off in the default scaffold — *because* its vocabulary file is a second hand-maintained wordlist through a different door, which is exactly what D2 abolishes; if casing consistency proves worth wanting, the answer is generating `accept.txt` from `cspell.json` at `init` time — one source, two consumers — and that is its own build. (was Q5)
- D18 (dot-vale-styles): the scaffolded `StylesPath` is `.vale/styles` — *because* a top-level `styles/` collides silently with the very plausible frontend meaning of that name, the dotted path is verified working, and it namespaces cleanly next to `.vale.ini`; `docs/tools.md` notes the divergence from vale's published convention. (was Q6)
- D19 (error-only-fingerprints): `extractVale` fingerprints only `Severity == "error"` alerts — *because* the verdict (D6) gates on errors alone, and fingerprinting warnings hands advisory alerts gating power in baselined repos (a new warning key blocks masking on an otherwise-grandfathered red run) while churning the ratchet with keys that can never affect any verdict. (was Q9)
- D20 (scaffold-only-add): `--add prose` stays file-scaffold-only; the three-step enable recipe — install pinned `@vvago/vale`, add its `allowBuilds` entry, add `"prose": { "use": "vale" }` (or `--include prose`) — lives in `docs/tools.md` — *because* `inventory` skips opt-in slots by design, `dupes`/`health` already work this way, and teaching `--add` to install deps or edit `pnpm-workspace.yaml` is new machinery (C6) for a path the docs can carry; revisit a printed next-steps hint only if the docs prove insufficient. (was Q10)

## Constraints

- C1 (no-network-in-check): a check never touches the network — `vale sync` is a setup command, never part of a run.
- C2 (contract-additive): a new slot is additive; `schema_version` stays 1, no contract test is edited, no promise in `docs/contract.md` changes.
- C3 (dogfood): this repo enables `prose` in `checkride.config.json` and passes it — checkride runs every check it ships.
- C4 (pinned-devdep): `@vvago/vale` is pinned exact in `devDependencies` (`save-exact=true`), with its `allowBuilds` entry (D12).
- C5 (green-check): `pnpm check` exits 0 at the end of every step.
- C6 (no-new-machinery): the feature lands as registry data + templates + one extractor. No new orchestrator branch, no new config key.

## Steps

1. [x] feat(prose): add the prose slot and vale adapter to the registry — **done when:** `pnpm check --bail --only types,lint,test` is green with `adapters.test.ts` asserting `prose` → `vale` as blessed default, `optIn: true`, `detect: ['.vale.ini', '_vale.ini']`, no `detectDeps` (D4), `outputFile: 'prose.json'`, and args carrying `--no-global` (D9), `--output=JSON`, and the trailing default path `.` (D10 — vale lints nothing without a path argument)
   - seam: `src/adapters.ts`, `src/__tests__/adapters.test.ts`, `test/e2e/defaults.e2e.test.ts`
   - model: sonnet — mechanical, fully specified by the done-when

2. [x] feat(prose): scaffold a hermetic vale config and house style — **done when:** `checkride init --add prose` into a temp dir writes `.vale.ini` plus `.vale/styles/Repo/*.yml`, running vale there against a fixture with a planted doubled word exits 1 while a clean fixture exits 0 (the weasel rule ships disabled — D15), and a scratch fixture with a real-directory `node_modules/` records in the build log whether bare `vale .` descends into it (a yes reopens D10's default `.`) (was Q11)
   - seam: `templates/shared/vale.ini`, `templates/shared/styles/Repo/`, `src/init.ts`, `src/__tests__/init.test.ts`, `cspell.json`
   - model: opus — the rule set is the product here, and D8 is a taste call

3. [x] feat(prose): fingerprint vale findings into the baseline — **done when:** `fingerprint('vale', raw)` returns `<file>:<Check>:<Message>` keys (built with the shared `key()` helper, message whitespace-collapsed) for a real vale JSON payload, fingerprints only error-severity alerts (a warnings-only payload yields the empty set — D19), returns `null` for any non-alert-report shape (pinned by an `E201` payload test — D16), and a red `prose` slot goes green after `checkride baseline` without masking a newly introduced finding
   - seam: `src/baseline/fingerprint.ts`, `src/__tests__/baseline-fingerprint.test.ts`
   - model: sonnet — mirrors the existing oxlint/ast-grep extractors

4. [x] chore(prose): enable the prose slot on checkride itself — **done when:** `pnpm check` exits 0 with `prose` green in `.check/summary.json`, having actually run over `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/`, and `src/`, with source-comment findings counted separately from markdown findings while tuning (D5 — `.ts` drops from the path list if the comment half is mostly directives and false positives), and `test/dogfood-config.test.ts` asserting every tracked `.md` outside a known-excluded set is reachable from the configured `prose` paths (D10)
   - seam: `.vale.ini`, `.vale/styles/Repo/`, `checkride.config.json`, `package.json`, `pnpm-workspace.yaml`, `cspell.json`, `test/dogfood-config.test.ts`
   - model: opus — tune the rules against Rob's actual voice first, then fix or baseline what survives; 373 findings from a naive rule set is the number to beat down, not to baseline wholesale

5. [x] docs(prose): document the prose slot and its division of labour with spell — **done when:** `pnpm check` is green and `docs/tools.md` covers the slot's row, why cspell stays (D1), the warning-severity green edge (D6), the no-gitignore path-scoping edge (D10), the npm bin-shim caveat (D13), the three-step enable recipe — pinned install, `allowBuilds` entry, config entry (D20), the `.vale/styles` divergence from vale's published convention (D18), and the `vale sync` upgrade path for third-party packages
   - seam: `docs/tools.md`, `README.md`, `docs/cheatsheet.md`, `schema/checkride.config.schema.json`
   - model: opus — the documentation prose is the deliverable, and it is the slot's own dogfood

## Open questions

- none — Q1–Q11 settled 2026-08-06, each by its lean: Q1→D13, Q2→D14, Q3→D15, Q4→D16, Q5→D17, Q6→D18, Q7→D5 (amended) + step 4, Q8→D10 (amended) + step 4, Q9→D19, Q10→D20 + step 5, Q11→step 2's done-when (verify, not decide).

## Verdicts

- 2026-08-04 — rule source: built-in-only vs. repo-authored vs. vendored packages → chose **repo-authored `styles/Repo/`** because built-in alone found 0 findings here and vendoring 372K of third-party YAML drags `docs`/`spell`/`links`/`dead` ignores along with it; documented `vale sync` as the consumer's upgrade path (D7).
- 2026-08-04 — lint scope: markdown-only vs. markdown + code comments → chose **markdown + TS doc comments** via `[formats] ts = js`, verified working (D5).
- 2026-08-04 — cspell disposition: keep / split by file type / retire → chose **keep, with `Vale.Spelling = NO`** (D1, D2). Settled by reading the rule files: `write-good` (9 rules), `proselint` (34), and `alex` (11) do **no** spell checking — proselint's `Spelling.yml` is 12 British→American pairs and `Nonwords.yml` is 32 fixed malformations; Google's `Spelling.yml` is a 4-token regex; alex is inclusive-language only. None would catch `teh` or `recieve`. The one dictionary-backed checker in the vale ecosystem is `Vale.Spelling`, which is weaker than cspell on technical vocabulary. cspell has no competitor here.
- 2026-08-06 — refine attack pass, settled wholesale (all leans and all repairs approved): Q1–Q11 → D13–D20, plus amendments to D4 (both detect filenames; the cross-build detectDeps rule spelled out instead of a dangling "D18"), D5 (comment linting must earn its keep in step 4), D6 (enabled-rules wording), D7/frame/sketch (`.vale/styles`), and D10 (dogfood path-list pin). Repairs: fingerprint key aligned to the shared `key()` helper (`<file>:<Check>:<Message>`, single colons), step 1 pins the trailing `.` path arg, step 2's seam gains `cspell.json` (templates/ is swept by the spell slot — `oxlintrc`/`sgconfig` precedent) and its fixture swaps the planted weasel for a doubled word (D15 ships weasel disabled), and step 2 records the node_modules-walk answer (was Q11).

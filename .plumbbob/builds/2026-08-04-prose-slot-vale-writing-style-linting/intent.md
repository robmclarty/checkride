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
  under `styles/`. Detected on `.vale.ini`, JSON output to `.check/prose.json`,
  fingerprinted into the same baseline that already covers `lint`/`struct`/`spell`.
  No new checkride machinery: it is an ordinary registry entry plus a scaffold.
- **Done looks like:** `pnpm check` runs `prose` on this repo and exits 0; a
  planted weasel word in any `.md` or any `.ts` doc comment turns it red;
  `checkride init --add prose` scaffolds a working `.vale.ini` + `styles/` into a
  fresh repo; `docs/tools.md` documents the slot and the cspell division of labour.
- **Explicitly NOT doing:** retiring or narrowing `spell`/cspell (D1); vendoring
  third-party vale packages into this repo (D7); running `vale sync` — or any
  network call — from inside a check (C1); a `gate: 'vale'` JSON verdict (D6);
  making `prose` part of the default run (D3); an `exclude` config key for the
  adapter (Q2); polyglot comment linting beyond the `[formats] ts = js` mapping.

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
                          key = <file>::<Check>::<Message>   ── same shape as
                          oxlint/ast-grep, so `checkride baseline` grandfathers
                          today's findings and ratchets forward

   .vale.ini ──► StylesPath = styles ──► styles/Repo/*.yml   (ours, hermetic)
                 Vale.Spelling = NO  (D2: cspell owns spelling)
                 [formats] ts = js   (D5: TS doc comments)
```

## Decisions

- D1 (keep-cspell): cspell stays, unchanged and unnarrowed — vale does not supersede it — *because* vale reads only markup and code *comments* (never identifiers or string literals), and its plain en_US Hunspell dictionary flagged `Config`, `tsconfig`, `oxlint`, and `devDeps` as errors where cspell's programming dictionaries accept them.
- D2 (spelling-one-owner): the scaffolded `.vale.ini` sets `Vale.Spelling = NO` — *because* two spell checkers means two wordlists to maintain and every unknown word reported twice; `prose` owns style, `spell` owns spelling.
- D3 (opt-in): `prose` ships `optIn: true`, like `format`/`dupes`/`health` — *because* adopting checkride must never start failing a repo on the writing style it never signed up for.
- D4 (detect-vale-ini-only): detect on `.vale.ini` alone, **no `detectDeps`** — *because* vale hard-errors (`E100`, exit 2) with no config file, so it is not configless-capable and D18's "detectDeps only on configless-capable adapters" rule excludes it.
- D5 (md-plus-comments): lint `.md` plus TypeScript doc comments via `[formats] ts = js` — *because* vale has no native `.ts` format, the mapping is verified working (it caught a planted `teh` inside a docblock), and this repo's comments carry as much prose as its docs.
- D6 (trust-exit-code): no `gate: 'vale'`; the process exit code is the verdict — *because* unlike fallow's, vale's exit code is honest (1 iff error-severity alerts exist). The tradeoff is real and documented: demoting a rule to `warning` makes it advisory and the slot green (verified: 4 warnings, exit 0), so the scaffold ships every rule at `error`.
- D7 (repo-authored-styles): the scaffolded style is ours, under `styles/Repo/*.yml`; no `Packages`, no `vale sync` on the default path — *because* built-in `Vale` alone found **0 findings** across this entire repo (near-vacuous), while Google + write-good + proselint fired **967** on four files, dominated by house-style opinions that fight the author's voice (331 E-Prime, 130 EmDash, 96 Parens, 67 Contractions).
- D8 (mechanical-rules-only): the shipped rules are objective ones — doubled words, weasel words, there-is, latin abbreviations, ly-hyphens, term casing — never voice opinions (passive, contractions, em-dashes, first person) — *because* a rule the author disagrees with gets suppressed, and a slot full of suppressions is ceremony.
- D9 (no-global-config): the adapter always passes `--no-global` — *because* vale otherwise loads `~/.vale.ini`, making the verdict depend on the machine, which is exactly what `docs/reliability.md` forbids of a gate.
- D10 (paths-via-args): path scoping happens through the paths passed on the command line, not the config — *because* vale reads no `.gitignore` and skips no hidden directory (verified: a bare `vale .` here walked `.stryker-tmp/`, `dist/`, `.plumbbob/`, `.claude/`, and `research/`), and path-scoped `.vale.ini` sections did not match. Default args stay `.`; this repo overrides `args` with explicit paths, exactly as it already does for `lint`.
- D11 (baseline-support): `prose` gets a fingerprint extractor keyed on adapter name `vale` — *because* a naive three-rule prototype already produced 373 findings here, and the baseline is precisely the mechanism for grandfathering today's findings and ratcheting forward.
- D12 (allow-builds): `@vvago/vale` needs an `allowBuilds` entry in `pnpm-workspace.yaml` — *because* it downloads its Go binary in a `postinstall`, which pnpm 11 blocks by default (the same treatment `@ast-grep/cli` and `fallow` already get).

## Constraints

- C1 (no-network-in-check): a check never touches the network — `vale sync` is a setup command, never part of a run.
- C2 (contract-additive): a new slot is additive; `schema_version` stays 1, no contract test is edited, no promise in `docs/contract.md` changes.
- C3 (dogfood): this repo enables `prose` in `checkride.config.json` and passes it — checkride runs every check it ships.
- C4 (pinned-devdep): `@vvago/vale` is pinned exact in `devDependencies` (`save-exact=true`), with its `allowBuilds` entry (D12).
- C5 (green-check): `pnpm check` exits 0 at the end of every step.
- C6 (no-new-machinery): the feature lands as registry data + templates + one extractor. No new orchestrator branch, no new config key.

## Steps

1. [ ] feat(prose): add the prose slot and vale adapter to the registry — **done when:** `pnpm check --bail --only types,lint,test` is green with `adapters.test.ts` asserting `prose` → `vale` as blessed default, `optIn: true`, `detect: ['.vale.ini', '_vale.ini']`, no `detectDeps` (D4), `outputFile: 'prose.json'`, and args carrying `--no-global` (D9) and `--output=JSON`
   - seam: `src/adapters.ts`, `src/__tests__/adapters.test.ts`, `test/e2e/defaults.e2e.test.ts`
   - model: sonnet — mechanical, fully specified by the done-when

2. [ ] feat(prose): scaffold a hermetic vale config and house style — **done when:** `checkride init --add prose` into a temp dir writes `.vale.ini` plus `styles/Repo/*.yml`, and running vale there against a fixture with a planted weasel word exits 1 while a clean fixture exits 0
   - seam: `templates/shared/vale.ini`, `templates/shared/styles/Repo/`, `src/init.ts`, `src/__tests__/init.test.ts`
   - model: opus — the rule set is the product here, and D8 is a taste call

3. [ ] feat(prose): fingerprint vale findings into the baseline — **done when:** `fingerprint('vale', raw)` returns `<file>::<Check>::<Message>` keys for a real vale JSON payload, and a red `prose` slot goes green after `checkride baseline` without masking a newly introduced finding
   - seam: `src/baseline/fingerprint.ts`, `src/__tests__/baseline-fingerprint.test.ts`
   - model: sonnet — mirrors the existing oxlint/ast-grep extractors

4. [ ] chore(prose): enable the prose slot on checkride itself — **done when:** `pnpm check` exits 0 with `prose` green in `.check/summary.json`, having actually run over `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/`, and `src/`
   - seam: `.vale.ini`, `styles/Repo/`, `checkride.config.json`, `package.json`, `pnpm-workspace.yaml`, `cspell.json`, `test/dogfood-config.test.ts`
   - model: opus — tune the rules against Rob's actual voice first, then fix or baseline what survives; 373 findings from a naive rule set is the number to beat down, not to baseline wholesale

5. [ ] docs(prose): document the prose slot and its division of labour with spell — **done when:** `pnpm check` is green and `docs/tools.md` covers the slot's row, why cspell stays (D1), the warning-severity green edge (D6), the no-gitignore path-scoping edge (D10), the npm bin-shim caveat (Q1), and the `vale sync` upgrade path for third-party packages
   - seam: `docs/tools.md`, `README.md`, `docs/cheatsheet.md`, `schema/checkride.config.schema.json`
   - model: opus — the documentation prose is the deliverable, and it is the slot's own dogfood

## Open questions

- Q1 (npm-bin-shim): does `prose` work under npm/yarn/bun, or is it pnpm-only in practice? — *resolve by:* decide
  - *plain:* `@vvago/vale` downloads its binary in a `postinstall`, so `bin/vale` does not exist when the package manager links binaries. Verified: pnpm links `node_modules/.bin/vale` correctly (with a warning about a nested path) and `pnpm exec vale` works; **npm creates no shim at all**, so `npx --no-install vale` fails outright — and checkride's own local-tree resolution looks for exactly that missing `node_modules/.bin/vale`. Getting this wrong means an npm-based consumer enables `prose` and sees "command not found" with no idea why. The precedent exists: `security` is already gated to npm/pnpm by `isAvailableUnder`.
  - *lean:* ship it without a special resolver and document the caveat in `docs/tools.md` — "under npm, install vale yourself or use pnpm". Adding a `node_modules/@vvago/vale/bin/vale` fallback to the resolver is real machinery (C6) for a case no one has hit yet; revisit when someone does.

- Q2 (adapter-exclude-key): should the vale adapter get an `exclude` config key like the `links` built-in has? — *resolve by:* decide
  - *plain:* vale walks everything it is pointed at — no `.gitignore`, no hidden-directory skip. A repo that points it at `.` gets `dist/`, `.stryker-tmp/`, and every vendored `.md` linted. `links` solved the same problem with a per-check `exclude` array carried through the adapter. Doing it again for vale is a second config key and a second exclusion mechanism to keep consistent.
  - *lean:* no key — D10's `args` override already scopes it, it needs no new surface, and the pattern is already established in this repo's `lint` entry. Revisit only if the default `.` proves noisy enough that every adopter has to override.

- Q3 (default-rule-breadth): how wide should the shipped `styles/Repo/` rule set be? — *resolve by:* decide during step 2
  - *plain:* the tradeoff is measured. Built-in `Vale` alone: 0 findings on this repo — nothing to fix, nothing verified. A naive three-rule prototype (weasel + there-is + latin): 373 findings across 75 files, of which the 319 `Weasel` hits are mostly legitimate uses of "just"/"only" in careful prose. Third-party packages: 967 findings on four files, dominated by voice opinions. Ship too little and the slot is vacuous green; ship too much and adopters suppress it or baseline it wholesale, which is the same thing with extra steps.
  - *lean:* start narrow and objective — doubled words (`Vale.Repetition`), there-is/there-are, latin abbreviations, `-ly` hyphens, plus `Vale.Terms` driven by a project vocabulary. Leave weasel words out of the *shipped* default and offer them as a commented-out block in the scaffolded `.vale.ini`, so an adopter opts into the subjective half deliberately.

- Q4 (unreadable-report-ratchet): what must `extractVale` return when vale's output is a *runtime error* rather than an alert report? — *resolve by:* decide before step 3
  - *plain:* vale emits two different JSON shapes. An alert report is `{"<path>": [ …alerts ]}`; a runtime error (`E100` missing `.vale.ini`, `E201` bad `StylesPath`, a typo in one of our own rule YAMLs) is a **single flat object** `{Line, Path, Text, Code, Span}` — verified both. An extractor written for the first shape reads the second as *zero findings*, which is indistinguishable from "clean". Traced through the existing machinery, that splits two ways. The verdict is safe: `applyBaseline`'s `current.size > 0` guard (`src/baseline/store.ts:102`) keeps an empty fingerprint from flipping a failed run green. The **ratchet is not**: `maskOutcome` returns `observed: current` for any non-null fingerprint (`src/orchestrator.ts:670-673`), `isPartialRun` gates only on `--only`/`--skip`/`--changed`/`--bail`, and `ratchet` keeps only the keys present in the observed set — so one full `pnpm check` against a broken vale config silently prunes **every grandfathered prose key** from `checkride.baseline.json`. The slot goes red, you fix the config, and now several hundred previously-baselined findings are new failures with no record of what happened. This is the exact hazard `fallowVerdict` was written to prevent ("an unrecognized report fails loudly").
  - *lean:* make the extractor shape-aware and return `null` — not an empty set — for anything that is not an alert report, so the run is never *observed* and the ratchet leaves the baseline untouched. `fingerprint()` already documents `null` as "unsupported, don't observe" and every caller honors it, so this needs no new machinery (C6). Cover it with a test that feeds an `E201` payload and asserts `null`, not `∅`.

- Q5 (terms-vocab-vs-cspell): does `Vale.Terms` reintroduce the second wordlist that D2 exists to abolish? — *resolve by:* decide during step 2
  - *plain:* Q3's lean reaches for `Vale.Terms` (catches a term written two ways — `checkride`/`Checkride`, `pnpm`/`PNPM`), which is genuinely valuable in a docs-heavy repo. But `Vale.Terms` fires *only* when a `Vocab` is configured, and a vocab is `styles/config/vocabularies/<name>/accept.txt` — a flat list of project words. That is a near-copy of `cspell.json`'s 90-word `words` array, maintained separately, drifting independently. D2 turned `Vale.Spelling` off precisely so there would be one wordlist; enabling `Vale.Terms` hands the second one back through a different door.
  - *lean:* ship `Vale.Terms` off in the default scaffold and keep the promise of D2 intact. If the casing-consistency check proves worth wanting later, the right answer is generating `accept.txt` from `cspell.json` at `init` time (one source, two consumers), not maintaining both by hand — and that is its own build, not this one.

- Q6 (styles-path-collision): should the scaffolded `StylesPath` be `styles/` or `.vale/styles/`? — *resolve by:* decide during step 2
  - *plain:* vale's own convention is a top-level `styles/`, and that is what its docs and every tutorial use. In an arbitrary consumer repo it is also a *very* plausible name for something else — CSS, design tokens, theme files. `checkride init --add prose` dropping a `styles/Repo/` into a frontend repo that already has `styles/button.css` is a bad first impression, and the collision is silent: vale just reads whatever is there. Verified that a dotted path works fine (`StylesPath = .vale/styles` linted correctly).
  - *lean:* scaffold `.vale/styles/` — it namespaces cleanly next to `.vale.ini`, cannot collide, and matches how every other tool in the catalogue keeps its config out of the way. Note the divergence from vale's published convention in `docs/tools.md` so a reader who knows vale is not confused.

- Q7 (comment-noise-no-suppression): is linting TS comments (D5) worth it given there is no per-line escape hatch? — *resolve by:* decide, possibly reversing D5
  - *plain:* the `[formats] ts = js` mapping extracts comments with a regex, so it lints **everything** in a comment — including commented-out code, license headers, and tool directives. Measured: a line reading `// oxlint-disable-next-line no-await-in-loop -- one-shot scaffolding …` gets prose-linted like prose, and `// const old = doThing(); // there is a leftover` fires too. Worse, the usual escape hatch is missing: wrapping a line in `// vale off` / `// vale on` **did not suppress it** in a `.ts` file (verified — the markers work in markup, not in the comment scanner). So a false positive in a source comment can only be resolved by rewording the comment, deleting the rule, or dropping the file from the path list. This repo has ~80 source files whose doc comments are its best writing; it also has directives and commented-out code in them.
  - *lean:* keep D5, but earn it — go into step 4 with the source-comment findings counted *separately* from the markdown ones, and if the comment half is mostly directives and false positives, drop `.ts` from the path list and keep the slot markdown-only. The cost of reversing is one line in `.vale.ini`, so this is a decision worth deferring to real numbers rather than making twice.

- Q8 (path-list-staleness): how does the explicit path list (D10) stay honest as the repo grows? — *resolve by:* decide during step 4
  - *plain:* D10 scopes vale by naming paths on the command line because vale reads no `.gitignore` and skips no hidden directory. That works today and rots quietly: the day someone adds `SECURITY.md` or `docs/adr/`, it is simply not linted, and nothing anywhere says so. `prose` reports green over a file it never opened. That is the vacuous-green failure this project already has a contract section about — and unlike a missing tool, there is no signal at all.
  - *lean:* pin it in `test/dogfood-config.test.ts` — assert that every tracked `.md` outside a known-excluded set is reachable from the configured `prose` paths. The test already exists to pin this repo's config against drift, this is the same job, and it converts a silent gap into a red check.

## Verdicts

- 2026-08-04 — rule source: built-in-only vs. repo-authored vs. vendored packages → chose **repo-authored `styles/Repo/`** because built-in alone found 0 findings here and vendoring 372K of third-party YAML drags `docs`/`spell`/`links`/`dead` ignores along with it; documented `vale sync` as the consumer's upgrade path (D7).
- 2026-08-04 — lint scope: markdown-only vs. markdown + code comments → chose **markdown + TS doc comments** via `[formats] ts = js`, verified working (D5).
- 2026-08-04 — cspell disposition: keep / split by file type / retire → chose **keep, with `Vale.Spelling = NO`** (D1, D2). Settled by reading the rule files: `write-good` (9 rules), `proselint` (34), and `alex` (11) do **no** spell checking — proselint's `Spelling.yml` is 12 British→American pairs and `Nonwords.yml` is 32 fixed malformations; Google's `Spelling.yml` is a 4-token regex; alex is inclusive-language only. None would catch `teh` or `recieve`. The one dictionary-backed checker in the vale ecosystem is `Vale.Spelling`, which is weaker than cspell on technical vocabulary. cspell has no competitor here.

# Spec: a test layout that `init` scaffolds and enforces

**Status:** draft (not yet built). Written 2026-10-04, to be absorbed by `/plumbbob:plan`.

**Provenance:** found while scaffolding `@robmclarty/keyframes` with `checkride init --shape flat`
(0.13.0). That repo is the working reference: its `rules/` and
`test/integration/layout-rules.test.ts` already implement and verify this layout, and the rules
are adapted from runciter's and lodestar's identical copies. Four things surfaced:

1. **The starter files break checkride's own conventions.** `init` writes a value into the
   `src/index.ts` barrel and puts `src/index.test.ts` loose in `src/`
   (`writeNewScaffold`, `src/init.ts:702-712`; `writePackage`, `src/init.ts:604-609`). This repo
   colocates every unit test in `__tests__/`, and `docs/deep-modules.md:111` tells users their
   `rules/` holds a `no-logic-in-barrel` rule that `init` never ships
   (`src/init.ts:600` writes four rules).
2. **Nothing says where tests outside `src/` go.** The maintainer's repos converge on
   `test/{integration,e2e,contract,fixtures}` plus a shared-code folder, but nothing enforces it,
   and four of them have loose test files directly in `test/`. This one has six.
3. **Fixtures aren't data to any tool.** A deliberately broken plan or fake repo under
   `test/fixtures/` gets linted by oxlint, markdownlint, cspell, fallow, the `links` slot and the
   ast-grep rules, and fails the gate.
4. **Tests outside `src/` are never type-checked** in a scaffolded repo, because `tsconfig.json`
   includes `src/` only. This spec defers that ([Q3 (test-typecheck)](#q3)).

Line numbers are against 0.13.0. Confirm each site by name against HEAD before editing.

## Frame

- **Problem:** `init` scaffolds a repo whose starter files break the conventions checkride
  documents and dogfoods, and it says nothing about where tests outside `src/` belong. Agents
  working in a scaffolded repo then learn the layout from the starter files, which is the wrong
  layout.
- **Smallest thing that solves it:** in new-project mode only, ship six more rules (four that
  constrain *where* a file lives, plus `src-never-imports-test` and `no-logic-in-barrel`), make
  the starter files obey them, and carve `test/fixtures/` out of every scaffolded tool.
- **Done looks like:**
  - all three shapes still pass `init → pnpm install → checkride` with exit 0;
  - a deliberately broken `test/fixtures/` probe in each shape stays green;
  - each location rule fires on a misplaced file and stays silent on sanctioned paths, as proven
    by a scan of a real tree;
  - `docs/deep-modules.md` names exactly the rules `init` ships.
- **Explicitly NOT doing:**
  - existing-project mode, whose writes are unchanged;
  - type-checking `test/` in scaffolded repos ([Q3 (test-typecheck)](#q3));
  - narrowing the scaffold's vitest `include`;
  - any change to the exit codes, `summary.json`, the baseline format or the CLI flags;
  - an `init --add` path for the layout rules.

## Decisions

- <a id="d1"></a>**D1 (new-mode-only)**: the layout rules ship in new-project mode only, *because*
  existing mode is additive ("writes only what is missing", `docs/getting-started.md`), and an
  existing repo's test layout is its own. volley's `test/unit/` and night-shift's flat `test/`
  would turn red on adoption.
- <a id="d2"></a>**D2 (six-rules)**: the new rules are `colocate-unit-tests`,
  `tests-dir-is-src-only`, `test-dir-layout`, `no-spec-suffix`, `src-never-imports-test` and
  `no-logic-in-barrel`, for ten in total, *because* the first five define and protect the layout,
  and the sixth closes the drift between `docs/deep-modules.md:111` and `src/init.ts:600`.
- <a id="d3"></a>**D3 (test-dir-five)**: `test/` holds `integration/`, `e2e/`, `contract/`,
  `helpers/` and `fixtures/`, and nothing else, *because* that is the union across the
  maintainer's repos, and this repo already uses `contract/`, `e2e/` and `fixtures/`.
- <a id="d4"></a>**D4 (helpers-not-support)**: shared test code lives in `test/helpers/`,
  *because* "fixtures are data, helpers are code" reads as a pair. (runciter, lodestar and
  fascicle use `support/`; plumbbob and volley use `helpers/`.)
- <a id="d5"></a>**D5 (shape-agnostic-globs)**: the rules glob `**/src/**` and `**/test/**`, and
  ignore `**/test/fixtures/**`, *because* the monorepo and hybrid shapes put `src/` and `test/`
  under packages. The monorepo fallow template already expects per-package `test/`
  (`templates/monorepo/fallow.toml`). The ignore also keeps fixture repos' own `src/` out.
- <a id="d6"></a>**D6 (fixtures-are-data)**: every scaffolded tool skips `test/fixtures/`
  (oxlint `ignorePatterns`, markdownlint `ignores`, cspell `ignorePaths`, fallow `ignorePatterns`,
  the rules' `ignores`, and the `links` slot), *because* fixtures hold deliberately broken inputs.
  keyframes found all of these tools would otherwise fail on them.
- <a id="d7"></a>**D7 (starter-conforms)**: the starter files obey the rules they ship with:
  - the value moves to a named module (`src/<name>.ts`);
  - `index.ts` re-exports it;
  - the smoke test moves to `src/__tests__/<name>.test.ts` and imports `'../index.js'`.

  *Because* a scaffold that fails its own rules teaches the opposite of its docs.
- <a id="d8"></a>**D8 (location-rules-by-scan)**: the location rules are verified by scanning a
  real temp tree built from the shipped templates, not by `ast-grep test`, *because* `ast-grep
  test` runs snippets with no path and ignores `files` and `ignores`. A `kind: program` rule can't
  have an honest `valid:` case. (Verified 2026-10-04 against ast-grep 0.45.3.)
- <a id="d9"></a>**D9 (include-unchanged)**: the scaffold's vitest `include` stays broad,
  *because* a misplaced test now fails `struct` loudly. Narrowing `include` would add a second
  place that must agree with the rules.

## Constraints

- <a id="c1"></a>**C1 (existing-mode-untouched)**: `initExisting` writes exactly what it writes
  today.
- <a id="c2"></a>**C2 (green-out-of-the-box)**: every shape passes `init → pnpm install →
  checkride` with exit 0 (`test/e2e/shapes.e2e.test.ts:40`).
- <a id="c3"></a>**C3 (no-contract-change)**: no surface in `docs/contract.md` changes. The release
  is a minor, noted under the CHANGELOG's Changed heading.
- <a id="c4"></a>**C4 (docs-name-what-ships)**: `docs/deep-modules.md` and
  `docs/getting-started.md` describe exactly the rules and layout `init` ships, held by a test.
- <a id="c5"></a>**C5 (house-style)**: functional only, named exports, type aliases, tests in
  `__tests__/`, and the repo's own `pnpm check` green at every commit (AGENTS.md).

## Steps

1. [ ] feat(init): ship the six layout and barrel rules in new-project mode, **done when:**
   `init.test.ts` asserts the new-mode scaffold writes all ten rules, and the existing-mode
   assertions are unchanged
   - seam: `templates/shared/rules/`, `src/init.ts`, `src/__tests__/init.test.ts`
   - model: sonnet (port the reference rules with the D5 globs)
2. [ ] feat(init): make the starter files obey the rules they ship, **done when:**
   `shapes.e2e.test.ts` is green for flat, monorepo and hybrid, and `init.test.ts`'s expected file
   list names `src/<name>.ts` and `src/__tests__/<name>.test.ts`
   - seam: `src/init.ts`, `src/__tests__/init.test.ts`, `test/e2e/shapes.e2e.test.ts`
   - model: sonnet (fully specified by D7)
3. [ ] feat(init): carve test/fixtures out of every scaffolded tool, **done when:** an e2e case
   scaffolds each shape, plants a broken `test/fixtures/probe/`, and checkride still exits 0. The
   probe holds malformed markdown, a dead link, a typo, a default export, an `it.only` and a
   loose test file.
   - seam: `templates/shared/`, `templates/flat/fallow.toml`, `templates/monorepo/fallow.toml`,
     `templates/hybrid/fallow.toml`, `src/links.ts`, `test/e2e/shapes.e2e.test.ts`
   - model: opus (seven tools, each with its own ignore syntax)
4. [ ] test(init): verify the location rules by scanning a real tree, **done when:** for flat and
   monorepo paths, each location rule fires on a misplaced file and stays silent on sanctioned
   and fixture paths. The scan runs over a temp tree built from `templates/shared/rules/`.
   - seam: `test/e2e/layout-rules.e2e.test.ts`
   - model: sonnet (port keyframes' `test/integration/layout-rules.test.ts`)
5. [ ] docs(init): describe the shipped layout and rules, **done when:** a test fails if a file in
   `templates/shared/rules/` goes unnamed in `docs/deep-modules.md`, and `getting-started.md`
   shows the test layout
   - seam: `docs/deep-modules.md`, `docs/getting-started.md`, `test/docs-currency.test.ts`,
     `CHANGELOG.md`
   - model: sonnet (docs plus one currency assertion)
6. [ ] chore(test): adopt the layout in this repo, **done when:** this repo's `rules/` carries the
   layout rules, its six loose `test/*.test.ts` files have moved, and `pnpm check` is green
   ([Q2 (dogfood)](#q2))
   - seam: `rules/`, `test/`
   - model: sonnet (moves plus import-path fixes)

## Open questions

- <a id="q1"></a>**Q1 (links-default-exclude)**: should `fixtures` join the `links` slot's built-in
  exclude set (`DEFAULT_EXCLUDE_DIRS`, `src/links.ts:56-65`)? *resolve by:* decide
  - *plain:* new-project mode writes no `checkride.config.json`, because the provenance spec's
    feature 2 is unbuilt. So a scaffolded repo can't carry `links.exclude` without one. Changing
    the built-in default changes behavior for every user: markdown under any `fixtures/`
    directory stops being link-checked.
  - *lean:* add `fixtures` to the built-in default. Markdown under a fixtures directory is test
    data in practice, and a broken link there is usually deliberate. A repo that wants it checked
    can't opt back in today, so record that limit in `docs/tools.md`.
- <a id="q2"></a>**Q2 (dogfood)**: does this repo adopt the layout in this build (step 6)?
  *resolve by:* decide
  - *plain:* six test files sit directly in `test/` (`conventions`, `docs-currency`,
    `dogfood-config`, `plugin-manifest`, `resolution.fixture`, `site`). Shipping a rule the
    maintainer's own repo breaks is the very contradiction this build fixes. Moving them churns
    imports and any doc that cites their paths.
  - *lean:* yes, as the last step. Most of them hold the repo to its own promises, so they move to
    `test/contract/`, and the rest to `test/integration/`.
- <a id="q3"></a>**Q3 (test-typecheck)**: should scaffolded repos type-check `test/`?
  *resolve by:* decide
  - *plain:* the scaffold's `tsconfig.json` includes `src/` only, so `test/integration/` and the
    other test folders are never type-checked. This repo solves it with `tsconfig.test.json` plus
    a `typecheck-tests` custom check. That needs a `checkride.config.json`, which new-project mode
    doesn't write.
  - *lean:* a separate build, after the provenance spec's feature 2 makes `init` write
    `checkride.config.json`. Then `typecheck-tests` is one more entry in it.

## Reference: the rules

These are ported from `@robmclarty/keyframes` `rules/`, with D5's shape-agnostic globs. All are
`severity: error`. Every rule except `src-never-imports-test` also ignores
`**/test/fixtures/**`.

| Rule | Kind | `files` | `ignores` (besides fixtures) |
| --- | --- | --- | --- |
| `colocate-unit-tests` | location (`kind: program`) | `**/src/**/*.test.ts` | `**/src/**/__tests__/**` |
| `tests-dir-is-src-only` | location | `**/__tests__/**/*.ts` | `**/src/**` |
| `test-dir-layout` | location | `**/test/**/*.ts` | `**/test/{integration,e2e,contract,helpers}/**`, one entry each |
| `no-spec-suffix` | location | `**/*.spec.ts` | — |
| `src-never-imports-test` | import string matching `^['"](\.\./)+test/`, in a static import, export or `import()` | `**/src/**/*.ts` | `**/src/**/__tests__/**` |
| `no-logic-in-barrel` | declarations in `index.ts`, including exported `const` | `**/src/**/index.ts` | — |

One porting trap, found while building the reference: don't share one metavariable across
`any:` branches under a `constraints:` regex. ast-grep binds the first pattern that matches
structurally, and if the regex then rejects it, ast-grep doesn't try the next branch. keyframes'
`writes-only-in-init` missed every `fs.mkdirSync(…)` until its fixture caught it. Match the node
directly with `has:` and `regex:` instead.

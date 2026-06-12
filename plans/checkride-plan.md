# Checkride — v1 build plan

A self-contained plan for building a new repository from scratch. Written to be handed
to a coding agent (Sonnet or Opus) in a fresh context window with no prior conversation.

**Name: `checkride`** (aviation: the practical exam a pilot must pass to be certified).
**The name is claimed** — a placeholder `checkride@0.0.0` (MIT, owner robmclarty) was
published to npm on 2026-06-11 and npm's similarity gate accepted it. The **first real
release must bump above 0.0.0** (this plan targets `0.1.0`). The placeholder's source
lives at `/Users/robmclarty/Projects/ts-check-scaffold/checkride-npm-placeholder/`;
Phase 6 overwrites it with the real package on publish.

**How to use this document:** create an empty git repo, copy this file into it, and
start the agent with: *"Read checkride-plan.md and implement it phase by phase. Do not
start a phase until the previous phase's gate passes. Ask before deviating from any
decision in section 2."*

**Reference implementation:** `/Users/robmclarty/Projects/ts-check-scaffold/code/ts-check-scaffold`
is the prior repo this product is extracted from. Port from it rather than reinventing:

- `scripts/check.mjs` — the orchestrator (becomes the core of this product)
- `scripts/check-links.mjs` — becomes the built-in `links` check
- `scripts/scaffold-check.mjs` — becomes `checkride doctor`
- `rules/*.yml` — the deep-modules ast-grep ruleset (ships inside this package)
- `AGENTS.md` — the agent contract (becomes the generated stanza, and this repo's own contract)
- All tool configs (`tsconfig*`, `vitest.config.ts`, `fallow.toml`, `cspell.json`,
  `.oxlintrc.json`, `.markdownlint-cli2.jsonc`, `sgconfig.yml`) — seed material for templates

---

## 1. What this is

Checkride is an **agent harness for TypeScript repositories**, delivered as one npm
package. It has two pillars:

1. **A definition of done.** One command runs the whole verification pipeline (types,
   lint, structure, dead code, tests, docs, links, spelling). Exit 0 means the work is
   complete. Agents stop guessing when to stop.
2. **Structured boundaries.** The deep-modules pattern — every first-level directory
   under `src/` is a module whose only public surface is its `index.ts` — enforced
   mechanically. Boundaries keep LLM agents inside lanes and let multiple humans/agents
   work in parallel with minimal merge conflicts.

It installs into brand-new projects (generating everything) **and** into existing
projects (adopting what is already there). Users get opinionated defaults but can swap
any tool (biome for oxlint, knip for fallow), drop checks, or add custom ones.

### Design principles (these explain every decision below)

- **The consumer is an LLM.** Diagnostics are never normalized into a common format.
  Each tool writes its own raw JSON to `.check/`; agents read whatever the tool emits.
  This deletes the layer that makes every prior meta-runner expensive to extend.
- **Detect tools, not shapes.** The orchestrator never knows whether a repo is flat or
  a monorepo. Shape knowledge lives exclusively in tool configs (tsconfig, fallow.toml,
  vitest globs), which the project owns.
- **Generation, not transformation.** `init` writes files once; the project owns them
  afterward. Checkride never parses or rewrites an existing config file. (The prior
  repo's 714-line config-transformation script is the cautionary tale.)
- **Additive, never destructive.** On an existing repo, `init` writes only missing
  files and proposes the rest.
- **The orchestrator stays dumb.** It spawns commands, captures output, reports exit
  codes. All intelligence lives in the tools and in the agent reading the results.

---

## 2. Decisions already made — do not relitigate

1. **Thin core.** The package has zero runtime dependencies on any checked tool. It
   spawns `pnpm exec <tool>`; projects own their tool devDependencies (pinned versions
   written by `init`).
2. **TypeScript source**, strict, ESM, NodeNext resolution, compiled with `tsc` to
   `dist/`, published with a `bin` entry. No classes; named exports only; `.js`
   extensions on relative imports. The product must dogfood the conventions it enforces.
3. **The product repo itself is flat** (single package, no workspace) and uses the
   deep-modules layout under `src/`. It runs checkride on itself.
4. **pnpm** is the package manager; Node `>=24`.
5. **Raw tool output passthrough** (see principles). `.check/summary.json` is the only
   file checkride authors, and it carries a `schema_version`.
6. **One blessed default per slot.** Alternates (biome, knip, eslint, jest) get
   adapters so checkride can *run* them, but `init` only *generates* config for the
   blessed defaults. "We'll run your biome; we author oxlint configs."
7. **Every `init` preset must produce a green check out of the box**, enforced by an
   end-to-end test. (The prior scaffold's init produced packages with no tests, so its
   own `pnpm check` failed immediately on a fresh project — first impressions of a
   verification tool cannot be a red build. This invariant is permanent.)
8. **Consumers alias it.** Generated `package.json` includes `"check": "checkride"` so
   daily usage is `pnpm check` regardless of the product name.

---

## 3. CLI surface

```text
checkride                  Run default checks. Exit 0 pass / 1 fail / 2 orchestrator error.
  --only <a,b>  --skip <a,b>  --bail  --json  --changed  --all  --include <a,b>
checkride init             Set up a project (new or existing — auto-detected).
  --shape flat|monorepo|hybrid   (new-directory mode; default flat)
  --name <project> --scope <@scope> --license <id> --author <name>
  --dry-run
checkride doctor           Verify environment + tooling (read-only, exit 0/1).
checkride fix              Run every active adapter's fixArgs (oxlint --fix, fallow fix, ...).
```

Flag semantics are identical to the reference `check.mjs` (port its `parseArgs` block,
`select_checks`, and bail/only/skip/include/all behavior). `--changed` appends each
adapter's `changedArgs` rather than hardcoding vitest, which is what the reference does.

---

## 4. Core model: slots and adapters

### Slots

A slot is a *role* in the pipeline. The catalogue (order matters — cheapest first):

| Slot       | Role                                   | Blessed default      | Wired alternates     |
| ---------- | -------------------------------------- | -------------------- | -------------------- |
| `types`    | Type checking                          | `tsc --build`        | —                    |
| `lint`     | Linting                                | `oxlint` type-aware  | `biome`, `eslint`    |
| `struct`   | Structural rules (incl. deep modules)  | `ast-grep`           | —                    |
| `dead`     | Dead code, deps, cycles, boundaries    | `fallow`             | `knip`               |
| `test`     | Tests + coverage                       | `vitest`             | `jest`               |
| `docs`     | Markdown lint                          | `markdownlint-cli2`  | —                    |
| `links`    | Relative md links resolve              | built-in             | —                    |
| `spell`    | Spelling                               | `cspell`             | —                    |
| `mutation` | Mutation testing (opt-in)              | `stryker`            | —                    |
| `security` | Dependency audit (opt-in)              | `pnpm audit`         | —                    |

### Adapter record

A plain data object in a registry module — not a plugin system:

```ts
type Adapter = {
  name: string;                      // 'biome'
  slot: string;                      // 'lint'
  detect: string[];                  // config files whose presence activates it: ['biome.json', 'biome.jsonc']
  command: string;                   // usually 'pnpm'
  args: string[];                    // ['exec', 'biome', 'check', '--reporter=json']
  outputFile: string | null;         // '.check/lint.json' target when stdout is JSON; null if tool writes its own file
  changedArgs?: string[];            // appended when --changed
  fixArgs?: string[];                // used by `checkride fix`
  optIn?: boolean;
  devDeps: Record<string, string>;   // pinned versions init writes into package.json
};
```

Launch registry: `tsc`, `oxlint`, `biome`, `eslint`, `ast-grep`, `fallow`, `knip`,
`vitest`, `jest`, `markdownlint-cli2`, `cspell`, `stryker`, `pnpm-audit`, plus the
built-in `links` check (port `check-links.mjs` into `src/links/`).

### Configuration: `checkride.config.json` (optional)

Zero-config behavior: for each slot, run the first adapter whose `detect` file exists;
skip slots with no detected tool. A repo only adds config to deviate:

```jsonc
{
  "checks": {
    "lint": "biome",                // string  → use this adapter for the slot
    "spell": false,                 // false   → disable the slot
    "dead": "knip",
    "licenses": {                   // object  → custom check (no adapter needed)
      "command": "node",
      "args": ["scripts/check-licenses.mjs"]
    },
    "test": {                       // object with `use` → adapter with overrides
      "use": "vitest",
      "changedArgs": ["--changed", "origin/master"]
    }
  }
}
```

Resolution rule per slot: config entry wins; otherwise detection; otherwise the slot is
skipped (skipped ≠ failed — record it in the summary as `"skipped": true` with a reason).

### Output contract: `.check/`

Port the reference behavior exactly, plus `schema_version`:

- `summary.json` — `{ schema_version: 1, timestamp, ok, total_duration_ms, checks: [{ name, adapter, description, ok, skipped?, exit_code, duration_ms, output_file }] }`
- `<slot>.json` — raw tool JSON when stdout parses as JSON; otherwise `<slot>.stdout.txt` / `<slot>.stderr.txt`
- Tools that write their own files (vitest `--outputFile`, stryker) keep doing so.

This is a public API for agents. Treat schema changes as breaking.

---

## 5. `init` design

`init` detects its mode: a directory with no `package.json` (or only a fresh `git init`)
gets **new-project mode**; anything else gets **existing-project mode**.

### New-project mode

Three shape presets. Almost everything is shared; exactly three files differ:

| File                  | flat                    | monorepo                       | hybrid                          |
| --------------------- | ----------------------- | ------------------------------ | ------------------------------- |
| `tsconfig.json`       | single project          | solution config + per-pkg refs | root project + refs to packages |
| `fallow.toml`         | root entries, no zones  | per-pkg entries, apps/libs zones | root + pkg entries, one rule  |
| `pnpm-workspace.yaml` | absent                  | `apps/*`, `libs/*`             | `packages/*`                    |

Everything else is identical across shapes: `vitest` config with shape-agnostic globs
(`**/src/**/*.{test,spec}.ts`, excluding `node_modules`), `cspell`, `.oxlintrc.json`,
`.markdownlint-cli2.jsonc`, `sgconfig.yml`, `rules/` (copied from the package's bundled
deep-modules ruleset), `.gitignore` (including `.check/`), `LICENSE`, `README` stub,
`AGENTS.md` + `CLAUDE.md`, and `package.json` with pinned devDeps from the active
adapters plus `"scripts": { "check": "checkride", ... }`.

Seed the templates from the reference repo's configs (flat variants were validated
there by its flatten script's output). Hybrid = root app in `src/` + internal packages
under `packages/*`.

**Every generated package/module includes a smoke test** (e.g. `src/index.test.ts`
asserting on an exported constant) so tests exist, coverage thresholds (70%) pass on
the one-line surface, and the green-out-of-the-box invariant holds.

### Existing-project mode

1. Inventory: which slots have a detectable tool config; which have nothing.
2. Write only what is missing and non-invasive: `checkride.config.json` reflecting
   adopted tools, `.check/` gitignore entry, the AGENTS.md stanza, the `check` script
   alias. Never modify an existing tool config. Offer (flag-gated, e.g.
   `--add lint,spell`) to generate blessed-default configs for empty slots.
3. Run each adopted check once. Slots that fail get written as `false` in the config,
   and the final report lists them: "enable as you fix." Installing is easy; greening
   an existing repo is agent work, guided by the contract.

### The AGENTS.md stanza

`init` writes (and on re-run, refreshes) a block between `<!-- checkride:begin -->` and
`<!-- checkride:end -->` markers, leaving the rest of the file untouched. Contents: the
contract (exit 0 = done; never claim done otherwise), how to read `.check/`, the tight
feedback loop flags, the deep-modules rules in agent-facing language, and the list of
active slots in this repo. Port the prose from the reference repo's AGENTS.md — it is
already well-tuned. If no AGENTS.md exists, create one that is just the stanza; also
write a one-line CLAUDE.md pointing at AGENTS.md if absent.

---

## 6. `doctor` design

Read-only environment verification, ported from the reference `scaffold-check.mjs`:
node/pnpm/git present and at required versions, each *active* slot's tool resolvable
via `pnpm exec <tool> --version`, config file presence per slot, `.check/` writable.
Output: human-readable table + `--json`. Exit 0 when everything required is present.

---

## 7. Product repo layout

```text
src/
  cli/            arg parsing, command dispatch (bin entry)
  orchestrator/   slot selection, spawning, .check/ writing  (port of check.mjs)
  adapters/       the registry (one module, data-only)
  config/         checkride.config.json loading + resolution + detection
  init/           shape presets, existing-repo adoption, AGENTS stanza
  doctor/
  links/          built-in links check (port of check-links.mjs)
templates/        shape preset files + shared config templates + rules/*.yml (bundled in the published package via "files")
test/
  fixtures/       see §9
  e2e/
rules/            this repo's own copy (dogfood)
AGENTS.md  CLAUDE.md  README.md  LICENSE  package.json  tsconfig.json  ...
```

Each `src/` subdirectory is a deep module: `index.ts` is its only public surface.
The CLI imports only module index files. Practice what we enforce.

---

## 8. Build phases and gates

Work strictly in order. Each phase ends with its gate passing; commit per phase.

**Phase 0 — Bootstrap.** Copy tool configs (flat shape) from the reference repo; adapt
`AGENTS.md`/`CLAUDE.md` for this repo; port `check.mjs` + `check-links.mjs` verbatim
into `scripts/` as an *interim* pipeline; `package.json` with pinned devDeps;
`pnpm install`.
*Gate: `node scripts/check.mjs` exits 0 on the bootstrapped repo.*

**Phase 1 — Orchestrator core.** Implement `src/orchestrator/`, `src/config/`,
`src/adapters/` (registry with the blessed defaults only), `src/links/`, and the `run`
command in `src/cli/`. Behavior-port from `scripts/check.mjs`: flags, ordering,
bail, output persistence, summary (now with `schema_version`, `adapter`, `skipped`).
Unit tests for slot resolution (config vs detection vs skip) and flag selection.
*Gate: `pnpm exec tsc --build && node dist/cli/index.js` exits 0 on this repo, and its
`.check/summary.json` matches the interim script's results check-for-check.*

**Phase 2 — Alternates + fix.** Add `biome`, `knip`, `eslint`, `jest` adapters and
`checkride fix`. Fixture-test that a repo with `biome.json` resolves `lint → biome` and
that `"dead": "knip"` config overrides detection.
*Gate: unit + fixture tests green via the new CLI itself.*

**Phase 3 — Doctor.** Port `scaffold-check.mjs` logic into `src/doctor/`.
*Gate: `checkride doctor` exits 0 on this repo; reports a missing tool correctly in a
fixture with a gutted `node_modules`.*

**Phase 4 — Init.** Templates for the three shapes; new-project mode; existing-project
mode; AGENTS stanza writer (idempotent — running twice produces no diff); deep-modules
ruleset bundling.
*Gate: unit tests for stanza idempotency and adoption inventory pass.*

**Phase 5 — Dogfood switch + e2e.** Point this repo's `"check"` script at the built
CLI; delete `scripts/check.mjs` and `scripts/check-links.mjs`. Build the e2e harness
(§9) and make the green-out-of-the-box invariant a permanent test for all three shapes
plus the existing-repo fixtures.
*Gate: `pnpm check` (now running checkride on itself) exits 0, and all e2e fixtures pass.*

**Phase 6 — Docs + publish prep.** README leading with the thesis (definition of done +
boundaries for agent-driven repos), the slot/adapter table, the `.check/` contract doc,
`CHANGELOG.md`, `"files"`/`"bin"`/`"exports"` correctness, `npm publish --dry-run` clean.
*Gate: `pnpm check` green; dry-run publish contains dist/, templates/, no test files.*

---

## 9. Testing strategy

- **Unit:** config resolution, detection, flag selection, stanza idempotency, summary
  schema. Fast, no subprocesses where avoidable.
- **Fixtures** (`test/fixtures/`): `flat-fresh/`, `monorepo-fresh/`, `hybrid-fresh/`
  (generated by init during e2e, not checked in), `existing-biome/` (has biome.json +
  passing setup), `existing-failing/` (has a deliberate unused export so the `dead`
  slot fails — asserts init disables it and reports).
- **E2e harness:** for each shape — temp dir, `checkride init --shape <s> --name t`,
  `pnpm install` (use a shared pnpm store for speed), `checkride` → **must exit 0**.
  Mark these as slow tests; they still run in CI and before any release.
- The e2e suite is the encoded lesson of the predecessor: a verification product whose
  fresh output fails its own verification is broken, regardless of what else works.

## 10. Non-goals for v1 (parking lot — do not build)

Baseline/ratchet mode for legacy repos; config *generation* for non-blessed tools; a
`checkride modules` map command; an MCP server; release/versioning tooling (`/version`
stays in consumer repos); Claude plugin packaging; watch mode; diagnostic normalization
(permanently out, not just v1).

## 11. Open items for Rob (the human)

- Final name + claim it on npm immediately (`checkride` and `check-ride` were both free
  2026-06-11; squatting risk is real). Decide scoped vs unscoped publish.
- License (predecessor is MIT), npm publish access/2FA, CI provider for the e2e suite.
- Whether ts-check-scaffold gets retired or converted into a thin consumer template
  once this ships.

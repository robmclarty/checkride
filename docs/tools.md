# Tools and installation

checkride has **no runtime dependency on any tool it runs**. For each slot it
spawns `<pm> exec <tool>` — where `<pm>` is your repo's package manager (see
[Package managers](#package-managers) below) — so the tools are ordinary project
`devDependencies`, pinned and owned by your repository. "Installing a missing
tool" therefore means adding an npm package — not a separate system binary.

The tooling has two layers:

1. **System prerequisites** — installed outside the project, once per machine.
2. **Slot tools** — installed into the project with pnpm.

## System prerequisites

| Tool | Minimum | Install |
| ---- | ------- | ------- |
| Node | `>=22.18` | <https://nodejs.org> or `nvm install 22 && nvm use 22` (24 works too) |
| a package manager | pnpm `>=9` (default) / npm / yarn / bun | pnpm: `corepack enable && corepack prepare pnpm@latest --activate` |
| git  | any | <https://git-scm.com/downloads> |

The commands in this doc use pnpm's forms; on another manager, substitute yours
per the [Package managers](#package-managers) table below.

Check them with `pnpm exec checkride doctor`.

## Package managers

checkride detects your repo's package manager and runs each tool through it, so
pnpm is the default but not a requirement. Detection uses the `packageManager`
field in `package.json` first, then the lockfile:

| Lockfile | Manager | Exec form |
| -------- | ------- | --------- |
| `pnpm-lock.yaml` | pnpm (default) | `pnpm exec <tool>` |
| `package-lock.json` | npm | `npx --no-install <tool>` |
| `yarn.lock` | yarn | `yarn <tool>` |
| `bun.lock` / `bun.lockb` | bun | `bunx --no-install <tool>` |

With no lockfile or field, checkride falls back to pnpm. `doctor` prints the
detected manager at the top of its report and verifies that manager is on your
PATH (pnpm keeps its `>=9` floor; the others are presence-only for now).

**A check never fetches a tool from the registry.** `npx` and `bunx` will
otherwise download a missing package and run it — and because a check is
spawned without a TTY, neither stops to ask first, so a gate could silently
pull an unpinned `latest` for a tool the repo never declared. checkride passes
`--no-install` to both; a tool that has to be downloaded now fails its slot.

**A slot's tool must be a dependency of your repo.** `--no-install` stops the
*download*, not every fallback: both launchers will still run a copy sitting in
their global cache from some earlier, unrelated `npx`/`bunx` invocation on that
machine. That leaves the weaker guarantee "nothing new is fetched mid-run"
rather than "only what this repo declared" — and a gate resting on it reports a
different verdict per machine, passing for a developer whose cache happens to
hold a tool and failing on the clean checkout that is your CI runner.

So before spawning under `npx`/`bunx`, checkride resolves the tool's binary in
the local tree — `node_modules/.bin/<tool>`, searched from the check's directory
upward, so a tool hoisted to a workspace root counts. The search **stops at the
repo root** (a `.git` or a lockfile): a stray `node_modules` in some parent of
your checkout is the launcher-cache problem wearing a different hat, and
accepting one would put the verdict back on machine state. A slot whose tool
doesn't resolve fails there — exit 1, a finding like any other — naming the tool
and the install command, rather than handing you the launcher's own error.
`pnpm exec` and `yarn` resolve from the project tree already and are not
pre-flighted, which also keeps Yarn PnP, where there is no `node_modules/.bin`
to find, working as before.

The practical consequence: **adding a tool's config file is not enough to turn
its slot on.** Install the tool too (`doctor` reports which active slots are
missing theirs).

### Yarn Plug'n'Play

A PnP project has no `node_modules/` at all — the install artifact is
`.pnp.cjs`, and binaries resolve through Yarn's runtime rather than a
`node_modules/.bin` directory. `doctor` detects that layout and changes both of
its questions accordingly: `install` is satisfied by `.pnp.cjs` plus the
lockfile, and each slot's tool is resolved with `yarn bin <tool>` instead of a
path test. A tool that genuinely does not resolve is still reported missing, so
the looser question does not become a softer one. A `yarn bin` that times out is
reported `unknown` rather than missing — the probe not answering is not evidence
the tool is absent, and "install it" would be the wrong advice.

Detection is gated on yarn, so a `.pnp.cjs` left behind by a migration *off*
Yarn will not reroute an npm or pnpm repo.

The one manager-specific slot is `security`: it runs `pnpm audit`, whose flags
and JSON shape don't port across managers, so on npm/yarn/bun the slot is
reported **unavailable** until a per-manager audit adapter lands. checkride
evaluates the audit JSON itself and gates at the `--audit-level` the adapter's
args declare — pnpm's own JSON-mode exit code fails on *any* advisory
regardless of level, so it is never trusted as the verdict. Every other slot
runs identically regardless of manager.

### Launcher quirks checkride works around

Two of these are the kind of thing you only find by debugging a failure, so
they are recorded here rather than rediscovered.

**pnpm narrates its dependency check on stdout.** Before `run` and `exec`, pnpm
verifies dependencies and prints `Already up to date` / `Done in Xms using pnpm
vN` — to **stdout**, ahead of the tool's own output — whenever no outer pnpm
process has already done so. That preamble lands in front of a tool's JSON. The
symptom is memorable: running `node dist/cli.js` directly failed `dead`,
`dupes` and `health` with "did not emit valid JSON", while the identical gate
under `pnpm run check` passed, because there the outer pnpm had already
verified and the inner `exec` stayed quiet.

checkride prepends `--config.verify-deps-before-run=false` to every `pnpm
exec`/`pnpm run` it spawns. That override is the only form that works:
`--silent` and `--reporter=silent` do not suppress the narration, the
`npm_config_verify_deps_before_run` environment variable is not read, and the
flag must come *before* `exec` — after it, pnpm treats it as the tool's own
argument and fails. Unknown config keys are accepted and ignored by every pnpm
in the supported range (`engines.pnpm >= 9`, verified against 9, 10 and 11), so
it is applied unconditionally rather than gated on a version.

Belt and braces: checkride's JSON reader tolerates a leading preamble anyway,
because a consumer's launcher is not checkride's to pin. See
[the contract](./contract.md#checksummaryjson) for exactly how much it skips.

**`npx` and `bunx` install what they cannot find.** Covered above — this is why
both carry `--no-install`.

**`pnpm run` enforces `engines`; `pnpm exec` does not.** In a repo with
`engines.node` (and `engineStrict`), `pnpm run <script>` aborts with
`ERR_PNPM_UNSUPPORTED_ENGINE` and **exit 1** before the script runs, while
`pnpm exec <tool>` on the same repo and the same Node runs fine. That asymmetry
is why the failure surfaces where it does: the generated hook script's
`pnpm exec checkride gate` succeeds, and the `pnpm run check` that `gate` spawns
is what dies — so the symptom is checkride's own `✘ red in 265ms`, not a hook
that never started. Exit 1 is also a red pipeline's code, which is why the gate
reads the output rather than the status to tell them apart. See
[Node pins and hook context](#node-pins-and-hook-context).

## Node pins and hook context

Agent harnesses run their hooks in a **non-login shell**. A version manager puts
its shims on `PATH` from a shell rc file, so the hook never sees them: it gets
whatever `node` the machine defaults to, not the one your terminal has. With
`nvm alias default 24` and a repo pinning `>=22 <23`, every hook arrives on the
wrong Node — and in a repo with `engineStrict`, the package manager then refuses
to run anything at all.

checkride handles this in two halves.

**It aligns, when it can.** Before running the check script, if the repo names an
exact interpreter and the running Node does not satisfy it, checkride prepends a
matching installed Node's `bin` to the child's `PATH`:

```text
checkride: running the check on Node 22.22.3 from ~/.nvm/versions/node/v22.22.3/bin
(.nvmrc pins 22.22.3; this hook started on 24.9.0).
```

The rules are deliberately narrow, because which interpreter a pipeline runs on
is not a thing to change quietly:

| Rule | Why |
| ---- | --- |
| Only `.nvmrc` / `.node-version` | These name an exact version. `engines.node` is a *range* — a compatibility declaration, not an instruction to switch interpreters — so it is read only to explain a failure. An alias (`lts/*`, `node`) is not resolvable without the version manager, and is treated as no pin. |
| Only when the running Node fails the pin | A healthy environment is never touched. |
| Only an already-installed interpreter | Searched under `~/.nvm`, `~/.local/share/fnm`, `~/.fnm`, `~/.nodenv`, `~/.asdf`, `~/.volta`, `~/n`. Nothing is downloaded, and no version manager is invoked — under a non-login shell `nvm` is a shell function, not a binary. |
| Never silently | The line above is printed on every aligned run, red or green. |

**It names the cause, when it cannot.** If nothing satisfying the pin is
installed, checkride changes nothing and the gate reports `could not run` rather
than a red, naming the pin, the Node the hook got, and the lever. What it must
never do is report a launch that never happened as a verdict on your code.

Since no edit can put a Node on the hook's `PATH`, that verdict **stands down**
rather than blocking: it exits 0 with no `decision`, having said that nothing was
verified. Blocking would re-ask the same agent every turn for a fix it cannot
make. See [the contract](./contract.md) for the full split.

`CHECKRIDE_NODE_BIN` is the escape hatch, and the wrapping point for a layout
checkride does not know:

```bash
CHECKRIDE_NODE_BIN=/opt/node/22.22.3/bin   # prepend this, whatever the repo pins
CHECKRIDE_NODE_BIN=off                      # never align; leave PATH alone
```

`checkride doctor` reports what it can see of this from your shell — the `node
pin` row names the install a hook would be aligned to, or says none was found.
It is never required, so it flags the risk without failing a repo that works.

Two pnpm-version notes for the publish slots: `pack` prefers
`pnpm pack --dry-run` (added in pnpm 10.26.0) and, on an older pnpm that
rejects the flag, falls back automatically to a real pack into a temp
directory outside the repo, deleting the tarball after reading the file list —
same verdict either way.

## Slot tools

Each slot is filled by one tool. A slot runs only when its detect file is
present (built-in checks always run). The default tool per slot:

| Slot | Tool | Install with | Detect file |
| ---- | ---- | ------------ | ----------- |
| `types` | `tsc` | `pnpm add -D typescript @types/node` | `tsconfig.json` |
| `format` | `prettier` (opt-in) | `pnpm add -D prettier` | `.prettierrc.json` |
| `lint` | `oxlint` | `pnpm add -D oxlint oxlint-tsgolint` | `.oxlintrc.json` |
| `struct` | `ast-grep` | `pnpm add -D @ast-grep/cli` | `sgconfig.yml` |
| `dead` | `fallow` (dead-code) | `pnpm add -D fallow` | `fallow.toml` |
| `dupes` | `fallow` (duplication, opt-in) | `pnpm add -D fallow` | `fallow.toml` |
| `health` | `fallow` (complexity, opt-in) | `pnpm add -D fallow` | `fallow.toml` |
| `test` | `vitest` | `pnpm add -D vitest @vitest/coverage-v8` | `vitest.config.ts` |
| `docs` | `markdownlint-cli2` | `pnpm add -D markdownlint-cli2` | `.markdownlint-cli2.jsonc` |
| `links` | built-in | — (always available) | — |
| `spell` | `cspell` | `pnpm add -D cspell` | `cspell.json` |
| `prose` | `vale` (opt-in) | `pnpm add -D @vvago/vale` | `.vale.ini` |
| `mutation` | `stryker` | `pnpm add -D @stryker-mutator/core @stryker-mutator/vitest-runner` | `stryker.config.mjs` |
| `security` | `pnpm audit` | — (built into pnpm) | — (opt-in) |
| `publint` | `publint` | `pnpm add -D publint` | — (opt-in) |
| `attw` | `attw` | `pnpm add -D @arethetypeswrong/cli` | — (opt-in) |
| `build` | consumer's `build` script (opt-in) | — (built-in) | `scripts.build` |
| `pack` | built-in (opt-in) | — (built-in) | `exports`/`main`/`types`/`bin` + `README` |
| `smoke` | built-in (opt-in) | — (built-in) | `exports` (fallback `main`) |
| `snippets` | built-in (opt-in) | — (built-in) | tagged doc fences (README + `docs/*.md`) |

Note the npm package names differ from the binary names: `ast-grep` ships in the
`@ast-grep/cli` package, `stryker` ships in `@stryker-mutator/core`, `attw`
ships in `@arethetypeswrong/cli`, and `vale` ships in `@vvago/vale`.

The `mutation` slot ships **uncapped** (`timeout: 0`) by default — the one
catalogue slot that does. A real stryker run legitimately takes fifteen to twenty
minutes, past the ten-minute cap every other slot runs under, and because
`mutation` is opt-in and never part of the definition-of-done gate that cap
protects, letting it run to completion costs the gate nothing. It also runs
`single` (exclusive, nothing else in flight) because stryker saturates every core.

And `fallow`, the one unfamiliar name in the table: a Rust-native
codebase-intelligence tool (unused code, duplication, circular dependencies,
complexity hotspots, architecture drift). checkride splits it across three slots
so each analysis gates and baselines on its own:

| Slot | fallow analysis | Default? |
| ---- | --------------- | -------- |
| `dead` | `fallow dead-code` — unused code, cycles, boundary violations | on (when `fallow.toml` present) |
| `dupes` | `fallow dupes` — code duplication (clones) | opt-in |
| `health` | `fallow health` — function complexity / maintainability | opt-in |

`dupes` and `health` are **opt-in** (like `format`) so adopting checkride never
fails a repo on duplication or complexity it never signed up for. Enable them by
naming them in `checkride.config.json` (`"dupes": "fallow"`) or with `--include
dupes,health` / `--all`. All three share the one `fallow.toml`.

**checkride owns the pass/fail decision for fallow.** Unlike every other slot —
where the tool's exit code is the verdict — checkride reads fallow's JSON and
gates on the issue count. That is deliberate: fallow's JSON/combined modes exit
`0` even with findings (and `fallow dupes` never fails on its own), so keying off
the exit code would let a green ✔ hide real issues. Reading the count gates all
three analyses uniformly, and an **unrecognized report fails loudly** rather than
passing silently.

This needs **fallow ≥ 3.5** (JSON `schema_version` 7); checkride pins `3.9.1`.
An older fallow (2.x emitted `schema_version` 4) fails the slot with an explicit
"unsupported schema_version" message — upgrade with `pnpm up fallow`.

Baselines work two ways, and you can use either:

- **checkride's own baseline** (`checkride baseline`) fingerprints each fallow
  finding (kind + file + symbol) into `checkride.baseline.json`, grandfathering
  today's findings so only *new* ones fail. This is the same baseline that covers
  `lint`/`struct`/`spell`, and it ratchets: a fixed finding is dropped on the
  next full run.
- **fallow's native suppression baseline** (`fallow dead-code --save-baseline
  <file>`, then gate with `--baseline <file>`) is an alternative if you prefer
  fallow to own the grandfathering. Prefer `--save-baseline` (exact-finding
  suppression) over the count-based `--save-regression-baseline`.

One number people go looking for: the `test` slot's coverage thresholds live in
`vitest.config.ts` (`test.coverage.thresholds` — the scaffold sets 70 across
the board), not in `checkride.config.json`. checkride just runs vitest; it has
no coverage setting of its own.

Some slots accept alternates that checkride will also run if it detects their
config: `format` → `biome`; `lint` → `biome` or `eslint`; `dead` → `knip`; `test`
→ `jest`. The blessed default is the one `init` scaffolds; the rest just need their
own config file present.

The `format` slot is **opt-in**: `checkride init --add format` scaffolds
`.prettierrc.json`, then enable it by naming it in `checkride.config.json`
(`"format": "prettier"`) or with `--include format`. Keeping it opt-in means
adopting checkride never fails a repo on formatting it never signed up for.

### Tuning the links check

The built-in `links` check walks every `*.md` under the repo (minus a built-in
exclude set — `node_modules`, `dist`, `.git`, the tool caches) and fails on any
relative Markdown link whose target doesn't exist on disk. Links inside fenced
code blocks and inline code spans are skipped — a `[text](target)` shown as an
example isn't a link to verify. Two config knobs adapt it to repos that would
otherwise false-positive, so you can retire a bespoke link-checker script:

```jsonc
"links": {
  "use": "links",
  "exclude": ["docs", "research", ".ridgeline"],  // skip these dirs on top of the built-ins
  "allowlist": ["^\\$\\{", "example\\.com"]        // regex sources; a matching target is never a miss
}
```

- **`exclude`** adds directory *names* to skip — for generated or vendored
  markdown (a `.ridgeline/` build store, illustrative specs under `research/`).
- **`allowlist`** is a list of regular-expression sources tested against each
  link *target*; a match is treated as valid. For deliberately illustrative
  links — template placeholders or example targets that never resolve on disk. A
  pattern that doesn't compile is a friendly `invalid checkride.config.json`
  error (exit 2), not a crash mid-run.

Both are ignored on any slot other than `links`.

## The publish-ready bundle

Four opt-in slots take the definition of done past static publishing lint
(`publint`, `attw`) and out to the artifact a consumer actually installs. Each is
a **built-in** (or runs the consumer's own `build`/`tsc`), so enabling them adds
**zero devDependencies** — nothing to install, nothing to pin.

| Slot | Wave | What it catches |
| ---- | ---- | --------------- |
| `build` | 10 | The package won't build — runs the consumer's `build` script so the checks below inspect fresh output, not stale `dist/`. |
| `pack` | 20 | The tarball ships the wrong files — packs a dry-run and fails if a required file (a resolved `exports`/`main`/`types`/`bin` target, or `README`) is missing, or a forbidden one (`src/`, tests, `.ts` sources) is present. |
| `smoke` | 20 | The built package throws on `import` — loads every `exports` entry through the package's own resolution and asserts each declared value export is live at runtime. |
| `snippets` | 20 / any | Doc examples have rotted — type-checks the fenced code blocks tagged `<!-- snippet: check -->` in `README.md` and `docs/*.md`. |

Because they carry waves, the bundle **orders itself with no config**: `build`
runs first (wave 10), then `pack`, `smoke`, `snippets`, `publint`, and `attw`
share wave 20 and run concurrently against the built artifact. Enable the bundle
with `--all`, with `--include build,pack,smoke,snippets`, or by naming the slots
in `checkride.config.json`; `checkride init` on a library can scaffold it for you.

### Configure a slot without opting it in

Naming an opt-in slot in `checks` normally opts it into every run — which is a
problem when you only want to *configure* it. Giving `attw` an `esm-only`
profile, for instance, shouldn't drag `attw` (and, if you also name them,
`build`/`pack`/`smoke`) into the default `checkride` run. Add `"optIn": true` to
the entry to break that coupling:

```jsonc
"attw": {
  "use": "attw",
  "profile": "esm-only",   // shortcut for appending --profile esm-only to attw's args
  "optIn": true            // configured here, but runs only under --all / --include attw
}
```

The slot keeps its configuration but stays out of the default run, reachable with
`--all` or `--include attw`. The field is general: `"optIn": true` on a
normally default slot (or on a heavy custom check like an integration suite)
demotes it to full-sweep-only, and `"optIn": false` forces an opt-in slot into
the default run. `checkride doctor` reflects the result — a slot held back this
way lists as **opt-in**, not **default**.

The `profile` shortcut above is `attw`-specific: it appends `--profile <name>`
(for example `esm-only` for an ESM-only package, `node16`) to the attw invocation so you
don't retype the whole `args` array just to set one flag. It is ignored on any
other slot.

Two details worth knowing:

- **`snippets` has two modes.** The default `snippets` adapter checks the fenced
  examples against your **source**; naming `snippets-dist` instead
  (`"snippets": "snippets-dist"`) checks them against the built `.d.ts`, which is
  what a consumer sees. A slot opted in with **no** tagged fence anywhere is a
  hard error (opting in with nothing to check is a misconfiguration, not a
  vacuous pass) — tag a fence, or don't enable the slot.
- **`pack` is npm/pnpm only.** It shells the manager's `pack --dry-run`, whose
  JSON shape is shared by npm and pnpm; on yarn/bun the slot reports
  **unavailable** until a per-manager adapter lands, exactly like `security`.

## When to write a custom check

The slot catalogue covers what most repos share. A genuinely repo-specific
invariant is a **custom check** — a config entry keyed by a name that isn't a
built-in slot, running a plain command (see the [README](../README.md#custom-checks)
for the config shape).

A worked example: the origin repo (`fascicle`) enforces that every provider SDK
is declared as an *optional* peer dependency and that the root manifest never
carries `"private": true`. That's a manifest-shape rule no catalogue slot knows
about, so it lives in a `scripts/check-deps.mjs` and is wired as a custom check:

```jsonc
{
  "checks": {
    "deps": {
      "command": "node",
      "args": ["scripts/check-deps.mjs"]
    }
  }
}
```

That's the boundary: reach for a custom check when the rule is specific to *your*
repo's manifest, layout, or conventions. When the rule is one many packages
share — "the tarball is clean", "the built package imports" — prefer a slot, so
the whole ecosystem gets it once rather than re-implementing it per repo.

## When `doctor` reports a missing tool

`doctor` prints a row per slot. A slot whose tool is not installed shows `not
installed` with a hint. Two cases:

### The tool should already be there

You have the config file (so the slot is active) but the package is gone — for
example after a fresh clone or a pruned `node_modules`. Restore everything from
the lockfile:

```bash
pnpm install
```

### Adding a tool that is not in the project yet

Say you want the `dead` (fallow) or `struct` (ast-grep) slot but the repo never
had it. Scaffold the config, then install the package:

```bash
pnpm exec checkride init --add dead,struct   # writes fallow.toml, sgconfig.yml, rules/
pnpm add -D fallow @ast-grep/cli              # installs the tools
pnpm check                                    # the slots now run
```

`init --add` writes only the config files; it does not touch
`devDependencies` — that is the `pnpm add -D` step. Once both the config and the
package exist, the slot is detected automatically on the next run.

For `struct` that means `sgconfig.yml` and `rules/no-deep-sibling-import.yml` —
the boundary rule, and nothing that legislates style. A repo that uses classes
or default exports is not adopting a broken convention, and a check that fails
on adoption for reasons unrelated to the check reads as checkride being wrong.
New-mode `init` is the exception: it writes the full rule set because it is
creating the package, so there is no prior decision to override.

## ast-grep, specifically

ast-grep is also distributed as a standalone binary (for example via Homebrew or
cargo). checkride invokes it through `pnpm exec ast-grep`, so for this project
prefer the npm package:

```bash
pnpm add -D @ast-grep/cli
```

That keeps the version pinned in your lockfile and resolvable at
`node_modules/.bin/ast-grep`, which is exactly what `doctor` probes for.

### The `struct` slot runs *your* rules

`struct` is not tied to any one convention. It runs `ast-grep scan` over the
rule files in your repo — the `rules/` directory, per `sgconfig.yml`'s
`ruleDirs` — so the convention is whatever those files encode. `init` scaffolds
checkride's default deep-module pack (a barrel `index.ts` per folder, siblings
importing only the index; see `rules/no-deep-sibling-import.yml`), but you own
those files:

- **A different convention, same language.** Edit or replace the rules to match
  how your repo is organized — public/private folders, a naming prefix, an
  allowed-import list. `struct` enforces the new rules with no change to
  checkride itself.
- **Another language.** ast-grep is polyglot; set each rule's `language`
  (`typescript`, `python`, `go`, `rust`, …) and the same slot enforces
  boundaries in that language.
- **Beyond ast-grep.** When a boundary lives in another ecosystem's linter —
  `import-linter` (Python), `depguard` (Go), `dependency-cruiser` (JS) —
  express it as a [custom check](#when-to-write-a-custom-check) that runs that
  tool, rather than forcing it into an ast-grep rule.

## The `prose` slot: writing style

`prose` gates the writing itself — doubled words, sentence-initial `There is`,
Latin abbreviations, hyphenated `-ly` adverbs, the lexical fingerprints of
model-generated prose — across markdown **and TypeScript doc comments**. It runs `vale` against a house style your repo owns
under `.vale/styles/`, detected on `.vale.ini` (or `_vale.ini`, vale's other
discovery name). The slot is **opt-in**, like `format`: adopting checkride
never starts failing a repo on writing style it never signed up for.

### Enabling it

`init --add prose` writes the config files only, like every `--add` — the tool
is its own install, and under pnpm the package needs a build approval first,
because `@vvago/vale` downloads its Go binary in a `postinstall` script that
pnpm blocks by default. Three steps:

```yaml
# 1. pnpm-workspace.yaml — approve the postinstall
allowBuilds:
  '@vvago/vale': true
```

```bash
# 2. scaffold the style, install the tool (pinned exact)
pnpm exec checkride init --add prose   # writes .vale.ini + .vale/styles/Repo/
pnpm add -D -E @vvago/vale
```

```jsonc
// 3. checkride.config.json — opt the slot in
"checks": {
  "prose": { "use": "vale" }
}
```

Skip step 3 to keep the slot out of the default run and reach it with
`--include prose` or `--all` instead.

### Why cspell stays

vale does not supersede `spell`, and the scaffold makes sure the two never
compete. vale reads only markup and code *comments* — never an identifier,
never a string literal — so it cannot replace a spell checker that covers
code. And its plain `en_US` dictionary flags the technical vocabulary
(`tsconfig`, `oxlint`, `devDeps`) that cspell's programming dictionaries
accept, so you would not want it to. The scaffolded `.vale.ini` sets
`Vale.Spelling = NO` and `Vale.Terms = NO`: one wordlist, one owner per
question — `spell` answers "is this a word?", `prose` answers "does this
sentence stumble?".

### The verdict, and the `warning` edge

vale's exit code is honest — non-zero exactly when error-severity alerts
exist — so checkride trusts it as the verdict, where the fallow slots get
their JSON read instead. The edge worth knowing: demote a rule to `warning`
and it keeps printing while losing the power to turn the slot red. That is a
deliberate advisory tier, but it means severity is the on/off switch for
gating — which is why the scaffold ships every enabled rule at `error`, and
sets `MinAlertLevel = suggestion` so the advisory levels stay visible.
Raising `MinAlertLevel` stops the reporting, not the rule.

Findings land in the shared baseline: `checkride baseline` fingerprints each
error-severity alert (file + rule + message) into `checkride.baseline.json`,
grandfathering today's findings and ratcheting forward exactly as it does for
`lint`/`struct`/`spell`. Warnings are never fingerprinted — an alert that
cannot gate has no business in a gate's ledger.

### Scoping: vale reads no `.gitignore`

vale walks everything under the paths it is handed — no `.gitignore`, no
hidden-directory skip — so a bare `vale .` descends into `dist/`, tool
caches, and agent scratch directories. The default args end with `.` so a
fresh repo works at all; scope a real one by overriding `args` with explicit
paths, the same move this repo's `lint` entry makes:

```jsonc
"prose": {
  "use": "vale",
  "args": ["exec", "vale", "--no-global", "--output=JSON",
           "README.md", "docs", "src"]
}
```

Keep `--no-global` — it stops vale loading `~/.vale.ini`, which would hang the
verdict on machine state — and keep `--output=JSON`, which is how findings
reach `.check/prose.json`. The paths are the only scoping mechanism; the slot
has no `exclude` key, so a second mechanism never has to be kept consistent
with the first.

TypeScript rides on the scaffolded `[formats] ts = js` mapping: vale has no
native `.ts` format, and JavaScript mode lints doc comments while leaving code
and string literals alone. For markdown only, drop the source directories from
the path list.

### Where the styles live — and `vale sync`

The scaffold sets `StylesPath = .vale/styles` and writes the house rules to
`.vale/styles/Repo/`. vale's published convention is a top-level `styles/`
directory; checkride diverges on purpose, because a top-level `styles/`
collides with what that name means in a frontend repo. Everything in vale's
documentation still applies — only the path moved.

The shipped rules are plain YAML committed to your repo: no download, no
upstream, nothing to keep in sync. Each enabled rule is mechanical — a doubled
word is a doubled word in anyone's voice — and the one taste rule,
`Repo.Weasel`, ships disabled in `.vale.ini`, one edit from on, so the
subjective half is opted into deliberately. Disagree with a rule? Edit or
delete its file rather than suppressing findings line by line.

Two of the shipped rules are drift control rather than grammar. `Repo.Drift`
flags the documented fingerprints of model-generated text — vocabulary that
runs at many times its human base rate (`delve`, `tapestry`, `meticulous`) and
the stock `It's not just X — it's Y` frame — and `Repo.Minted` swaps the
minted corporate dialect back to plain English (`the ask`, `learnings`, the
verb `leverage`). The point is the loop, not the words: generated prose
becomes the next session's context, so every fingerprint that lands is the
example the next generation copies. Both lists are deliberately short and
high-precision — a hit is close to proof of provenance — and both are meant to
grow the tells your own repo accumulates.

To adopt a published third-party style — Google, Microsoft, `write-good` —
add a `Packages` line to `.vale.ini` and run `pnpm exec vale sync` yourself:
it downloads packages into `StylesPath`, so re-run it when you add or bump a
package. It is a setup command, never part of a check — a check never touches
the network — which is also why the scaffold's default path needs no sync at
all.

### Voice exemplars

The rules above catch the lexical half of style drift — the words and frames
generated prose reaches for. The voice itself (rhythm, register, the sound of
a sentence) has no mechanical check, and the reliable way to keep
machine-written prose in your voice is to hand the model genuine samples of
that voice while it writes: style-imitation studies find real exemplars beat
bare instructions by an order of magnitude. The `exemplars` key names a
directory of them:

```jsonc
"prose": { "use": "vale", "exemplars": "docs/voice" }
```

Naming it does two things. `agent-setup` (and `init`) add a section to the
AGENTS.md stanza telling writing sessions to read the exemplars first and
imitate them — and never to edit or add to them, because a generated
"improvement" to an exemplar replaces the human original with a copy of the
model's own register. And the `prose` check goes red when the directory is
missing or empty: the exemplars are load-bearing anchor texts, and a config
that points at nothing should fail rather than quietly gate nothing.

Write the exemplars by hand — a few short passages in your own voice, in the
register you want the repo's prose to hold. What checkride never does is score
prose against them: no model judges voice at the gate, deliberately. A model
grading style approves its own register, and a passing voice score would
invite the one gate that works — a human reading the words — to stand down.
Presence is checked; imitation is prompted; judgment stays with the reader.

### Under npm

`@vvago/vale` produces its binary in that `postinstall` script, and npm writes
no bin shim for a binary that exists only after install scripts run — so under
npm, `npx --no-install vale` has nothing to resolve and the slot fails at tool
resolution, naming the tool. Run this slot under pnpm, or install vale by a
route that leaves a runnable `node_modules/.bin/vale`. Like `security`, it is
a manager-limited slot that says so rather than degrading quietly.

## Turning a slot off

If a slot is irrelevant to a repo, disable it in `checkride.config.json` rather
than leaving its tool half-installed:

```jsonc
{
  "checks": {
    "spell": false
  }
}
```

`doctor` then reports that slot as `disabled in config` instead of a failure.

See the [cheat sheet](./cheatsheet.md) for the full command and flag reference,
and the [README](../README.md) for the slot/adapter model in depth.

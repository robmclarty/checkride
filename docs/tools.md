# Tools and installation

checkride has **no runtime dependency on any tool it runs**. For each slot it
spawns `<pm> exec <tool>` — where `<pm>` is your repo's package manager (see
[Package managers](#package-managers) below) — so the tools are ordinary project
`devDependencies`, pinned and owned by your repository. "Installing a missing
tool" therefore means adding an npm package — not a separate system binary.

There are two layers:

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
| `mutation` | `stryker` | `pnpm add -D @stryker-mutator/core @stryker-mutator/vitest-runner` | `stryker.config.mjs` |
| `security` | `pnpm audit` | — (built into pnpm) | — (opt-in) |
| `publint` | `publint` | `pnpm add -D publint` | — (opt-in) |
| `attw` | `attw` | `pnpm add -D @arethetypeswrong/cli` | — (opt-in) |
| `build` | consumer's `build` script (opt-in) | — (built-in) | `scripts.build` |
| `pack` | built-in (opt-in) | — (built-in) | `exports`/`main`/`types`/`bin` + `README` |
| `smoke` | built-in (opt-in) | — (built-in) | `exports` (fallback `main`) |
| `snippets` | built-in (opt-in) | — (built-in) | tagged doc fences (README + `docs/*.md`) |

Note the npm package names differ from the binary names: `ast-grep` ships in the
`@ast-grep/cli` package, `stryker` ships in `@stryker-mutator/core`, and `attw`
ships in `@arethetypeswrong/cli`.

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
normally-default slot (or on a heavy custom check like an integration suite)
demotes it to full-sweep-only, and `"optIn": false` forces an opt-in slot into
the default run. `checkride doctor` reflects the result — a slot held back this
way lists as **opt-in**, not **default**.

The `profile` shortcut above is `attw`-specific: it appends `--profile <name>`
(e.g. `esm-only` for an ESM-only package, `node16`) to the attw invocation so you
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

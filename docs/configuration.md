# Configuration

`checkride.config.json` sits at the repo root, and it's optional: add it only
to change the defaults. With no config, each slot runs the first tool whose
config file the repo has, and a slot with no tool sits out (see
[Tools and installation](./tools.md#slots-and-adapters)). A repo with more
than one language declares [targets](./targets.md), and a repo with more than
one set of checks declares [suites](./suites.md). The committed baseline is
the config's sibling, and [its page](./baseline.md) covers it.

A config that uses most of what it can hold:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/robmclarty/checkride/v0.15.0/schema/checkride.config.schema.json",
  "extends": "@acme/checkride-preset", // inherit a shared preset, then override below
  "timeout": 1200,          // global per-check timeout in seconds (default: 600)
  "changedBase": "origin/develop", // what --changed measures from (default: origin/main, else HEAD)
  "checks": {
    "format": "prettier",   // enable the opt-in format slot (blessed: prettier)
    "lint": "biome",        // pick an alternate adapter
    "spell": false,         // disable a slot
    "test": { "use": "vitest", "timeout": 0, "changedArgs": ["--changed", "{base}"] },
    "tidy": {           // a bespoke custom check that runs FIRST, ahead of the built-ins
      "command": "pnpm",
      "args": ["exec", "some-formatter", "--write"],
      "order": "first"
    },
    "licenses": {           // a custom check (runs last by default)
      "command": "node",
      "args": ["scripts/check-licenses.mjs"],
      "description": "License audit",     // rendered beside the check in the output
      "note": "Legal asked for this in RFC-114; drop it when the SBOM job lands."
    }
  }
}
```

## `description` vs `note`

Two strings, deliberately not one. **`description`** is user-facing: it is the
text a run prints beside the check in its status line and records in
`.check/summary.json`, so it wants to be short. **`note`** is the opposite —
maintainer commentary that never renders anywhere, the JSON-comment this file
otherwise has no room for. Put "why is this check here", "revisit after the
2.0 upgrade", or a ticket number in `note` and keep the output readable.

`note` is accepted on any check entry — an adapter override (`{ "use": … }`) or
a custom check (`{ "command": … }`) — and at the top level of the file for a
note about the config as a whole. It is validated as a string (a typo is a
config error, not silence) and then dropped: no code path carries it onto an
adapter, so it cannot reach the CLI output or the summary.

## The `$schema` pointer

The `"$schema"` pointer is optional but recommended: it turns on validation and
autocompletion for `checkride.config.json` in editors that understand JSON
Schema (VS Code and friends). `checkride init` writes a version-pinned pointer
into the config it generates; the schema itself ships in the package at
[`schema/checkride.config.schema.json`](../schema/checkride.config.schema.json).

## Targets and per-pack config

A repo with more than one language declares its parts as `targets`, each a
pack and a root. `packs` sets one pack's checks for every target of it, and
`unclaimed.ignore` names the markers no target has to claim:

```jsonc
{
  "targets": {
    "web": { "lang": "ts", "root": "web" },
    "api": { "lang": "go", "root": "api", "checks": { "lint": "staticcheck" } },
    "infra": { "lang": "terraform", "root": "infra" }
  },
  "packs": {
    "terraform": { "checks": { "format": "terraform-fmt" } } // opts every terraform target into fmt
  },
  "requirePins": true,                          // a tool only PATH provides fails its check
  "unclaimed": { "ignore": ["package.json"] }   // the root package.json only installs tools
}
```

A target's slot takes its tool from the target's own `checks`, then
`packs.<pack>.checks`, then the top level, then detection at the target's
root. Once targets exist, a top-level entry for a target slot may only turn it
off or tune it (`optIn`, `timeout`, `order`), since the tool depends on the
pack. `checkride target add` writes a target for you, and
[Targets](./targets.md) holds the rules.

A team that owns a target can keep its config beside its code: a target
marked `"local": true` reads `<root>/checkride.config.json`, and a top-level
`include` reads more config files from the directories it names. Both are in
[Targets § Local targets](./targets.md#local-targets) and
[§ Included config files](./targets.md#included-config-files).

## Validate data files

`schemas` is a list of rules for the `schema` slot, each a set of globs and
the JSON Schema their files must satisfy:

```jsonc
{
  "schemas": [
    { "files": ["skills/*/SKILL.md"],       "schema": "checkride:agent-skill" },      // bundled; reads the frontmatter
    { "files": ["config/*.json"],           "schema": "schemas/service.schema.json" },
    { "files": [".github/workflows/*.yml"], "schema": "schemas/workflow.schema.json" }
  ]
}
```

A file is read by its extension, or by the rule's `format`: `json`, `jsonc`,
`yaml` or `frontmatter`. Schemas are draft 2020-12 or draft-07, and a `$ref`
may reach a sibling file but never a URL, since a check makes no network
call.

The package still has no runtime dependency. The slot validates with the
`ajv` (8.x), `yaml` (2.x) and `jsonc-parser` (3.x) the repo installs, each
only when a rule needs it, and a missing one fails the check with the install
command. The standalone binary bundles all three.
[The `schema` slot](./tools.md#the-schema-slot-data-files-against-json-schemas)
covers the formats, the bundled schemas and the report.

## Custom checks

A custom check (one keyed by a name that isn't a built-in slot) runs *after* the
built-in catalogue by default. Set `"order": "first"` to run it ahead of every
built-in check instead — handy for a **bespoke** formatter that should normalize
the tree before the linters and tests look at it. `"order": "last"` is the explicit
form of the default. Within each group, custom checks run in the order they appear
in the config.

A custom check that can't run everywhere can say so. Give it a `skipExitCode`
(an integer from 1 to 255; 77 is the usual one) and exit with that code, and
the run records the check as skipped, not failed, with its last stderr line as
the `reason`. A skipped check stays out of `checks_run`, so `--strict` still
refuses a run in which every check skipped itself. See
[Tools § A custom check that can't run everywhere](./tools.md#a-custom-check-that-cant-run-everywhere).

For formatting, the blessed `format` slot (prettier, or biome-format) is the paved road —
enable it with `"format": "prettier"` and `checkride fix` writes formatting for you.
The `order: "first"` custom-check hatch coexists with it, for a one-off formatter the
slot doesn't cover; the slot didn't retire it.

## Gating a custom check with `detect`

Add `"detect": ["<file>", …]` to a custom check to gate it on marker files: it
runs only when at least one listed file exists in the repo, and is skipped —
skipped, not failed — otherwise. This keeps a shared config safe across repos
that don't all use the same tools: a check for a tool a given repo lacks quietly
stands down instead of lighting up red. `detect` applies only to custom checks
that run alongside the catalogue; a custom check that fills a built-in slot
always runs.

## Sharing presets with `extends`

Use `"extends"` to inherit a shared preset — a file path (`"./base.json"`) or an
installed package (`"@acme/checkride-preset"`), or an array of them to layer
several. Bases merge left to right and your local config wins over all of them:
objects deep-merge (so overriding one field of a check keeps the rest), while
arrays and scalars replace outright — arrays are **not** concatenated. A
preset's top-level tool pick that a repo can't take at its top level, because
it declares targets or its root's pack lacks that tool, lands in that tool's
`packs.<pack>.checks` block instead, so `"lint": "oxlint"` in a fleet preset
lints the TypeScript repos and leaves a Go repo's golangci-lint alone. Pair it
with `detect` above to publish one org-wide preset that stays safe across repos
that don't all use the same tools. An `extends` that can't be found, or a config
that extends itself in a loop, fails fast with
`invalid checkride.config.json: <reason>`.

For operating a preset across many repos — versioning it, rolling a rule out as
a release, and automating the per-repo bump — see
[Running a fleet with shared presets](./presets.md).

## Timeouts

A per-check timeout guards against a hung tool, and it is **on by default**: a
definition-of-done gate that can hang forever fails its one job on the worst
day. The default cap is a generous **600 seconds per check**; a check that hits
it gets SIGTERM (then SIGKILL after a short grace) and is recorded as failed
with a `timed out after 600s` note — red, never vacuous. Tune it with a global
`timeout` (seconds), override it per check (`"timeout": <n>`), or set
`"timeout": 0` (globally or per check) to disable the cap. Give `dead` and
`test` a higher cap — or `0` — on a large repo where they legitimately run
long. The `mutation` adapters, stryker and cargo-mutants, ship uncapped.

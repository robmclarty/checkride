# Adopting checkride in a polyglot repo — a worked example

This page walks one repo from no checkride to a green gate. The repo holds a
TypeScript web app, a Go API, OpenTofu infrastructure and the shell scripts
that deploy them. Each part ends up checked from its own root by its own
language's tools, at the versions the repo pins, under one `pnpm check`. Every
line of output below came from running checkride on this repo.
[Targets](./targets.md) and [Packs and pins](./packs.md) are the
reference for each rule the walk meets; this page is the order you meet them
in.

## The repo

```text
acme/
├── package.json         ← the workspace root: installs checkride, nothing else
├── pnpm-workspace.yaml  ← packages: [web]
├── README.md
├── web/                 ← a TypeScript app: package.json, tsconfig.json, src/
├── api/                 ← a Go module: go.mod, .golangci.yml, cmd/, internal/
├── infra/               ← an OpenTofu root module: main.tf, .terraform.lock.hcl,
│                          .tflint.hcl, .opentofu-version, modules/naming/
└── scripts/             ← deploy.sh and a .shellcheckrc
```

[`examples/polyglot-stack`](../examples/polyglot-stack/) is a smaller copy,
without the infrastructure, and
[`examples/terraform-roots`](../examples/terraform-roots/) holds the
infrastructure's half. The end-to-end suite runs both on every push.

## Install checkride at the root

checkride runs from the repo root, so that's where it's installed. A repo
with Node adds it to the root `package.json`, the workspace root most
JavaScript monorepos already have:

```bash
pnpm add -D -E -w checkride   # -w puts it in the workspace root
```

A repo with no Node, say one holding only the API, the infrastructure and the
scripts, pins checkride in a root `mise.toml` instead, beside a `node` for it
to run on, and runs `mise exec -- checkride` wherever this page runs
`pnpm exec checkride` or `pnpm check`; [Installing
checkride](./distribution.md) shows the pin. Its root holds no `go.mod` or
`.tf` file of its own, and `init` still reads it as an existing repo, from the
projects discovery finds below the root, so every step below works the same
there.

## Preview what checkride would check

Before anything is written, `--discover` shows the targets the repo's own
files propose:

```bash
pnpm exec checkride doctor --discover
```

```text
  mode: multi-target (4 targets)

  TARGETS
    web      ts         web
    api      go         api
    infra    terraform  infra
    scripts  bash       scripts
```

The rows further down list what each target would run, and the workspace row
at the end says `unclaimed` holds, since every toolchain marker sits in one of
those targets or in `unclaimed.ignore`:

```text
  WORKSPACE
  ✔ unclaimed              every marker sits in a target
```

`pnpm exec checkride --discover` runs those targets' checks the same way,
writing nothing but the run's output in `.check/`.

## Run init, and read what it proposes

```bash
pnpm exec checkride init
```

```text
checkride init: adopted 1 slot(s); wrote 8 file(s).
  package manager: pnpm (detected)
  discovered targets:
    "targets": {
      "web": {
        "lang": "ts",
        "root": "web"
      },
      "api": {
        "lang": "go",
        "root": "api"
      },
      "infra": {
        "lang": "terraform",
        "root": "infra"
      },
      "scripts": {
        "lang": "bash",
        "root": "scripts"
      }
    }
    targets.web: a ts target rooted at web
    targets.api: a go target rooted at api
    targets.infra: a terraform target rooted at infra
    targets.scripts: a bash target rooted at scripts
    unclaimed.ignore: package.json, a root that runs no ts tool of its own, so no ts target claims it
```

`init` wrote those targets into `checkride.config.json`, added a `check`
script to the root `package.json`, put `.check/` in `.gitignore`, and wrote the
agent contract: the AGENTS.md stanza and the Claude Code hooks. The stanza's
last line lists the checks the gate runs:

```text
Active checks in this repo: web:types, api:types, infra:types, api:lint, infra:lint, scripts:lint, api:test, links, unclaimed.
```

Two of those decisions are worth knowing, because a repo shaped a little
differently gets different ones:

- **`web` is a target of its own, and the root is none.** The root
  `package.json` only installs checkride: no `tsconfig.json`, linter or test
  config sits beside it, and it lists no such tool. A root like that runs no
  ts tool of its own, so discovery proposes each package below it instead,
  and lists the root `package.json` under `unclaimed.ignore`, since no ts
  target can claim it once its packages have targets of their own. A root
  that does run one, say with a `tsconfig.json` whose `references` name each
  package, is one ts target at `.` that claims every package and checks them
  all from the root with `tsc --build`, which is the shape `init --shape
  monorepo` scaffolds.
- **`scripts` is a bash target.** Discovery proposes one for the shell files
  that sit outside every other target's root. Under a ts target at `.`, they
  would sit inside it, and the scripts would go unchecked until
  `checkride target add scripts --lang bash --root scripts` declared them.

Either way the config is yours to edit, and `checkride target add` adds a
target to it later, as the section on a growing repo shows.

## The first run

```bash
pnpm check
```

```text
  ✘ infra:types      36ms  terraform validate: Terraform configuration  [detected: .terraform.lock.hcl]
           terraform-validate reads .terraform/, which `tofu init -backend=false` writes, and checks never run it: run `tofu init -backend=false` here first
```

A check never downloads anything, and `tofu init` fetches providers, so it's
the repo's setup step, not the check's. The line under the ✘ is the reason a
check gives when it's refused before it spawns, and `.check/summary.json`
records the same text as that check's `reason`. Run the setup once, and keep
the directory it writes out of git:

```bash
tofu -chdir=infra init -backend=false
echo '.terraform/' >> .gitignore
pnpm check
```

```text
  ○ web:lint          skip  no tool detected for slot
  ✔ api:types       261ms  go build: Go compilation  [detected: go.mod]
  ✔ infra:lint      135ms  tflint: Terraform lint  [detected: .tflint.hcl]
  ✔ api:lint        388ms  golangci-lint: Go linters  [detected: .golangci.yml]
  ○ struct            skip  no tool detected for slot
  ○ web:dead          skip  no tool detected for slot
  ○ api:dead          skip  no tool detected for slot
  ○ web:test          skip  no tool detected for slot
  ✔ scripts:lint     22ms  ShellCheck: shell script analysis  [detected: .shellcheckrc]
  ○ docs              skip  no tool detected for slot
  ✔ links             2ms  Relative markdown link targets exist on disk  [config]
  ○ spell             skip  no tool detected for slot
  ✔ unclaimed        30ms  Every toolchain marker sits inside a target that checks it  [built-in]
  ✔ api:test        108ms  go test: Go tests  [detected: go.mod]
  ✔ infra:types     556ms  terraform validate: Terraform configuration  [detected: .terraform.lock.hcl]
  ✔ web:types       583ms  TypeScript type checking (incremental, via project references)  [detected: tsconfig.json]
✔ all checks passed in 584ms — only 9 of 16 checks ran, 7 skipped
```

Those are the finished lines; the run also prints one as each check starts.
A target's checks are named `<target>:<slot>`, while `struct`, `docs`,
`links`, `spell`, `prose` and `unclaimed` check the repo as a whole and keep
their bare names. Each line ends with why the check runs: `[detected: <file>]`
when a tool's config at the target's root picked it, `[config]` when
`checkride.config.json` names it, and `[built-in]` for a check that needs no
tool. A slot with no tool sits out with `○`, so the repo's next step is
visible in the run: a `.oxlintrc.json` in `web/` turns on `web:lint`, and an
`sgconfig.yml` at the root turns on `struct`. `doctor` names the file each one
needs.

Each target writes under its own directory in `.check/`, and the repo-wide
checks write at the top:

```text
.check/
├── summary.json
├── links.json
├── unclaimed.json
├── api/
│   ├── lint.json
│   └── test.jsonl
├── infra/
│   ├── lint.json
│   └── types.json
└── scripts/
    └── lint.json
```

A check whose tool printed nothing, as tsc does on success, leaves no file.

## Pin every tool

Every check records which copy of its tool ran. From `.check/summary.json`
after that run:

| Check | Tool | `pin_source` | `tool_version` |
| --- | --- | --- | --- |
| `web:types` | tsc | `js-lockfile` | `6.0.3` |
| `api:types`, `api:test` | go | `path` | none |
| `infra:types` | tofu | `tf-version` | `1.13.1` |
| `api:lint` | golangci-lint | `path` | none |
| `infra:lint` | tflint | `path` | none |
| `scripts:lint` | shellcheck | `path` | none |

tsc came from the lockfile and tofu from `.opentofu-version`, so those two run
the same release on every machine. The three linters ran whatever `PATH`
held, and `doctor` lists each under **unpinned tools** with the command that
pins it. Pin them, and Go with them, in a root `mise.toml`:

```toml
[tools]
go = "1.27.2"
golangci-lint = "2.14.0"
tflint = "0.64.0"
shellcheck = "0.11.0"
```

After `mise trust` and `mise install`, those checks run as
`mise exec -- golangci-lint …` and record `pin_source: "mise"`. Add
`"requirePins": true` to `checkride.config.json`, and a tool nothing pins
fails its check instead of running the machine's copy. With `shellcheck`
left out of the `mise.toml`:

```text
  ✘ scripts:lint      1ms  ShellCheck: shell script analysis  [detected: .shellcheckrc]
           shellcheck is not pinned; pin it with: mise use shellcheck@<version>
```

A toolchain is the exception: `go`, `cargo` and the Terraform or OpenTofu CLI
still run from `PATH` under `requirePins`, since the repo's own files set the
version they accept (`go.mod`'s `go` line, `.opentofu-version`) and the pack's
environment stops each from fetching another. [Packs and pins](./packs.md)
lists every pin source and the environment each pack's checks run with.

## The daily loop

A target's name selects all of its checks:

```bash
pnpm check --only api
```

```text
  ○ api:dead       skip  no tool detected for slot
  ✔ api:test     157ms  go test: Go tests  [detected: go.mod]
  ✔ api:types    285ms  go build: Go compilation  [detected: go.mod]
  ✔ api:lint     328ms  golangci-lint: Go linters  [detected: .golangci.yml]
✔ all checks passed in 360ms — only 3 of 16 checks ran, 13 skipped
```

`<target>:<slot>` selects one check, and a bare slot selects that slot in
every target, so `--only api:lint,scripts` runs golangci-lint and every
scripts check, and `--only lint` runs each target's linter.

`--changed` skips every target a change didn't touch. Here an edit under
`api/` broke a test; the run spends nothing on `web`, `infra` or `scripts`,
and the repo-wide checks still run (lines for slots with no tool trimmed):

```text
  ○ web:types         skip  no changes under web
  ○ infra:types       skip  no changes under infra
  ○ infra:lint        skip  no changes under infra
  ○ scripts:lint      skip  no changes under scripts
  ✔ links            40ms  Relative markdown link targets exist on disk  [config]
  ✔ unclaimed        19ms  Every toolchain marker sits inside a target that checks it  [built-in]
  ✔ api:types       239ms  go build: Go compilation  [detected: go.mod]
  ✔ api:lint        399ms  golangci-lint: Go linters  [detected: .golangci.yml]
  ✘ api:test        712ms  go test: Go tests  [detected: go.mod]
```

It measures from the merge base with `origin/main`. Name another base with
`--base <ref>`, the `CHECKRIDE_BASE` variable or `changedBase` in the config;
where `origin/main` doesn't resolve, as in this repo with no remote, it
measures from `HEAD` and says so on stderr.

## When the repo grows

Someone adds a code generator as a second Go module, `tools/gen/go.mod`. No
target checks it, and `unclaimed` fails the run rather than let it go
unread. `.check/unclaimed.json` names the target that would claim it:

```json
{
  "unclaimed": [
    {
      "path": "tools/gen/go.mod",
      "kind": "go",
      "suggest": { "name": "gen", "lang": "go", "root": "tools/gen" }
    }
  ]
}
```

```bash
pnpm exec checkride target add gen --lang go --root tools/gen
```

The next run checks `gen:types` and `gen:test`, and `unclaimed` is green.

## Debt the repo already has

A repo with findings it can't fix today grandfathers them, as a single-language
repo does: `pnpm exec checkride init --baseline` at adoption, or
`checkride baseline` once the targets are set. A target's keys sit under
`<target>:<slot>` and name files from the repo root:

```json
{
  "schema_version": 1,
  "slots": {
    "api:lint": [
      "api/cmd/api/cleanup.go:errcheck:Error return value of `os.Remove` is not checked"
    ],
    "infra:lint": [],
    "scripts:lint": [
      "scripts/deploy.sh:SC2086:Double quote to prevent globbing and word splitting."
    ]
  }
}
```

Both checks go green while only those findings remain, and a new one still
fails. Before merging a branch that touches the file,
`checkride baseline diff` lists what it grandfathers:

```text
# checkride baseline diff: HEAD (3da867c) to the working tree

2 key(s) added, 0 removed.

## api:lint: 1 added, 0 removed

+ api/cmd/api/cleanup.go:errcheck:Error return value of `os.Remove` is not checked

## scripts:lint: 1 added, 0 removed

+ scripts/deploy.sh:SC2086:Double quote to prevent globbing and word splitting.
```

## In CI

The job installs both halves: the Node workspace through pnpm, and the tools
the `mise.toml` pins through mise. Add `opentofu = "1.13.1"` to that file so
CI has the CLI `.opentofu-version` names. Then the setup steps the checks
never run, then the gate:

```yaml
name: check

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    env:
      # mise loads no mise.toml it hasn't trusted; this one is the repo's own.
      MISE_TRUSTED_CONFIG_PATHS: ${{ github.workspace }}
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6 # reads the version from packageManager
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile

      # go, opentofu and the linters the mise.toml pins
      - uses: jdx/mise-action@v5

      # checks run offline, so fetch what they read first
      - run: go -C api mod download
      - run: tofu -chdir=infra init -backend=false -input=false

      - run: pnpm exec checkride --strict

      - if: failure()
        uses: actions/upload-artifact@v7
        with:
          name: check-report
          path: .check/
```

[Running in CI](./ci.md) explains `--strict` and the recipe for a repo with no
Node at all.

## Where agents come in

Nothing here changes for an agent. The stop gate `init` wrote runs the repo's
`check` script, so it checks every target, and the stanza tells the agent
where a target's output lands: `.check/<target>/`. `checkride triage` and the
`/checkride:check` skill read those directories too, and name each check the
way the run does, `api:test` rather than `test`.

## Where to go next

- [Targets](./targets.md) for every rule about declaring, discovering and
  selecting targets, and what `unclaimed` counts.
- [Packs and pins](./packs.md) for each pack's slots and tools, every pin
  source, and the environment each pack's checks run with.
- [Running checkride from outside a repo](./consumers.md) for a reviewer or CI
  job checking a checkout it didn't write, with its own tools.
- The examples: [`go-module`](../examples/go-module/),
  [`go-workspace`](../examples/go-workspace/),
  [`rust-workspace`](../examples/rust-workspace/),
  [`python-project`](../examples/python-project/),
  [`terraform-roots`](../examples/terraform-roots/) and
  [`polyglot-stack`](../examples/polyglot-stack/), each a pack or a mix of
  them, run end to end on every push.

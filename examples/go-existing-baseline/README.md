# Example: adopting checkride on a Go repo that already has debt

The Go version of
[`existing-repo-baseline`](https://github.com/robmclarty/checkride/tree/main/examples/existing-repo-baseline).
A Go module with lint findings adopts checkride with `init --baseline`: the
findings it has today are grandfathered, a new one fails, and fixing one
prunes it from the baseline.

This example has no `package.json`, on purpose. checkride picks a repo's
implicit pack from the markers at its root, and a `package.json` comes first,
so one here would make this a TypeScript repo. With only `go.mod` at the root,
the go pack's checks run under their bare slot names: `types`, `lint` and
`test`.

## Run it

It needs `go` and `golangci-lint` on `PATH`; `mise install` at the repo root
installs the versions this repo pins. Build checkride once from the repo root,
since the example runs the working tree rather than a published release:

```bash
pnpm install && pnpm build
```

Then:

```bash
cd examples/go-existing-baseline
node ../../dist/cli.js
```

It exits **0**, reporting `3 baselined (grandfathered)` on the `lint` check.

## The debt

Three abandoned variables, spread across two packages, which golangci-lint's
`unused` linter reports:

| File | Finding |
| ---- | ------- |
| [`internal/report/report.go`](./internal/report/report.go) | `legacyPadding` is unused |
| [`internal/report/report.go`](./internal/report/report.go) | `staleTimestampFormat` is unused |
| [`internal/parse/parse.go`](./internal/parse/parse.go) | `legacyLocale` is unused |

[`checkride.baseline.json`](./checkride.baseline.json) records them, and it
is committed:

```json
{
  "schema_version": 1,
  "slots": {
    "lint": [
      "internal/parse/parse.go:unused:var legacyLocale is unused",
      "internal/report/report.go:unused:var legacyPadding is unused",
      "internal/report/report.go:unused:var staleTimestampFormat is unused"
    ]
  }
}
```

Each key is `file:linter:message`, with no line or column, as in the
TypeScript example. The linter is the one golangci-lint names for the
finding, so an `errcheck` finding and an `unused` one in the same file are
different keys.

## How it was adopted

The baseline above is what `init --baseline` writes. In a copy of this
directory without `checkride.baseline.json`:

```bash
node ../../dist/cli.js init --baseline
```

`init` finds `go.mod`, adopts the go pack's tools, and runs each adopted check
once. `lint` fails on the three findings, and since golangci-lint's findings
can be keyed, the check stays enabled and its findings are written to the
baseline:

```text
baseline: wrote checkride.baseline.json — 3 diagnostic(s) across lint
  grandfathered failing slots into checkride.baseline.json: lint
```

It also writes `checkride.config.json`, `AGENTS.md`, `CLAUDE.md`, a
`.gitignore` and the stop hook. This example commits only the baseline: the
checks the config names are the ones detection picks without it.

The end-to-end suite runs that adoption and asserts it writes this exact
baseline, so the committed file can't drift from what `init` produces.

## Prove the three properties

### 1. A new finding fails, and only the new one is listed

```bash
printf 'package report\n\nimport "os"\n\n// Prune removes a stale report.\nfunc Prune() {\n\tos.Remove("stale")\n}\n' > internal/report/prune.go
node ../../dist/cli.js
```

Exit 1:

```text
✘ lint    golangci-lint: Go linters
     3 baselined (grandfathered)
     1 new, not in baseline:
       internal/report/prune.go:errcheck:Error return value of `os.Remove` is not checked
```

Delete `internal/report/prune.go` to get back to green.

### 2. Fixing debt ratchets the baseline down

Delete the `legacyPadding` line from `internal/report/report.go`, then run
checkride again:

```text
baseline: ratcheted checkride.baseline.json to 2 grandfathered diagnostic(s)
```

The fixed entry leaves the committed file. Put the example back with
`git checkout -- internal/report/report.go checkride.baseline.json`.

### 3. A partial run never prunes

`--only`, `--skip`, `--changed`, and a `--bail` that stops early leave the
baseline alone, as in the TypeScript example.

## Where Go differs

- golangci-lint fails on every issue it reports and has no warning tier, so
  every finding it prints is a key.
- `types` (`go build`) and `test` (`go test`) never appear in a baseline. A
  compile error or a failing test fails its check outright.
- golangci-lint prints each path relative to the directory of the config it
  found. checkride detects golangci-lint by a config at the module root, so
  the paths, and the keys, name files from there. A config further up the
  tree would shift every path in the keys.

## See also

- [`existing-repo-baseline`](https://github.com/robmclarty/checkride/tree/main/examples/existing-repo-baseline),
  the same story in TypeScript, with the trade-offs of a position-free key
- [The go pack](https://github.com/robmclarty/checkride/blob/main/docs/packs.md)

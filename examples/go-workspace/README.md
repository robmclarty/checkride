# Go workspace

A Go workspace checked from its root as one go target, `shop`. `go.work`
uses two modules: `greet`, a library with a test, and `api`, a command that
imports it.

A workspace root's own `./...` names none of its modules, so every Go check
names each module `go.work` uses instead: `go build` runs over
`./greet/... ./api/...`, and so do golangci-lint and `go test`. The summary's
`argv` shows the patterns. Under `--changed`, `go build` and `go test` narrow
to the modules a change touched and every module that depends on them, and
record what they ran as `narrowed`.

```bash
pnpm install
pnpm check
```

The `go.mod` files under the root sit inside the target, so `unclaimed`
passes. The root `package.json` only links checkride from this repo, so
`unclaimed.ignore` lists it.

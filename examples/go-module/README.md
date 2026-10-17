# Go module

A Go module checked from its root as one go target, `greeter`. Nothing here
names a tool: each check comes from what the module holds.

- `greeter:types` runs `go build -json` over `./...`, writing nothing into the
  module, since `-o /dev/null` discards the binary.
- `greeter:lint` runs golangci-lint, because `.golangci.yml` is here.
- `greeter:dead` runs deadcode as `go tool deadcode`, because `go.mod` declares
  it in a `tool` directive, and records the version `go.mod` requires. deadcode
  lists what it finds and exits 0, so any output fails the check.
- `greeter:test` runs `go test -json`.

Every check runs with `GOPROXY=off` and `GOTOOLCHAIN=local`, so nothing
downloads during a run. Fetch the modules first:

```bash
pnpm install
go mod download
pnpm check
```

The root `package.json` only links checkride from this repo, so
`unclaimed.ignore` lists it.

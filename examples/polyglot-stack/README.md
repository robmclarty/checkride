# Polyglot stack

A TypeScript app in `web/`, a Go service in `api/` and shell scripts in
`scripts/`, checked as three targets, each from its own root and by its own
pack's tools:

- `web:types` runs tsc from `web/`.
- `api:types`, `api:lint` and `api:test` run `go build`, golangci-lint and
  `go test` from `api/`, offline.
- `scripts:lint` runs shellcheck over the shell scripts under `scripts/`.

The checks of the repo as a whole run once: `links` reads every markdown file,
the skill in `skills/` included, `struct` runs the Go dialect rules in
`rules/go/`, and `unclaimed` fails on a toolchain marker no target checks,
such as a new `go.mod` outside `api/`.

```bash
pnpm install
pnpm check
```

The root `package.json` installs tsc and ast-grep and links checkride from
this repo, so `unclaimed.ignore` lists it.

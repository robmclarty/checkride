/**
 * The go pack: Go modules and workspaces, checked from the directory that
 * holds a `go.mod` or `go.work` (R5.5). Every adapter that names packages
 * takes them through `{go-packages}`, which a run expands to `./...` for a
 * module root and to `./<dir>/...` for each `use` directive at a `go.work`
 * root, since a workspace root's `./...` matches none of its modules.
 *
 * `go` and `gofmt` are the toolchain's own, run through the `go` a `mise.toml`
 * pins, else the one on `PATH`. A Go tool resolves through the `go.mod` `tool`
 * directive first, run as `go tool <bin>`, then a `mise.toml` pin, then `PATH`
 * (R6.1); golangci-lint is pinned as a binary, never as a `go tool`. Every
 * check of the pack, a target's custom checks included, runs with Go's
 * downloads switched off (R6.4): `GOTOOLCHAIN=local` fails a module that asks
 * for a newer Go than the one installed, rather than fetch it, and
 * `GOPROXY=off` fails a module missing from the module cache, rather than
 * download it, so a repo runs `go mod download` first. `GOFLAGS` is left alone:
 * Go 1.24 already refuses to rewrite `go.mod` during a build, and
 * `-mod=readonly` would make Go ignore a module's `vendor/` (D54).
 *
 * Each row's flags were checked against the versions this repo's `mise.toml`
 * pins (go 1.27.2, golangci-lint 2.14.0) and the latest `go get -tool` copies
 * (staticcheck 0.8.2, deadcode from x/tools 0.52.0, govulncheck 1.9.0).
 */

import type { Pack } from './types.js';

/** The detect files that say a directory holds Go code. */
const GO_ROOT = ['go.mod', 'go.work'];

export const GO_PACK: Pack = {
  name: 'go',
  markers: GO_ROOT,
  pins: ['go-mod-tool', 'mise', 'path'],
  env: { GOTOOLCHAIN: 'local', GOPROXY: 'off' },
  adapters: [
    {
      name: 'go-build',
      slot: 'types',
      description: 'go build: Go compilation',
      detect: GO_ROOT,
      command: 'go',
      // `-json` prints each package's compiler output as one event per line.
      // `-o /dev/null` discards the binary that a module with a single main
      // package would otherwise write into the checkout.
      args: ['build', '-o', '/dev/null', '-json', '{go-packages}'],
      outputFile: 'types.jsonl',
      devDeps: {},
    },
    {
      name: 'gofmt',
      slot: 'format',
      description: 'gofmt: Go formatting',
      detect: GO_ROOT,
      command: 'gofmt',
      // `-l` lists each file that would change and exits 0 anyway, so the
      // listing itself is the finding.
      args: ['-l', '.'],
      outputFile: null,
      failOnOutput: true,
      fixArgs: ['-w', '.'],
      devDeps: {},
    },
    {
      name: 'golangci-lint',
      slot: 'lint',
      description: 'golangci-lint: Go linters',
      detect: ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json'],
      command: 'pnpm',
      // `--show-stats=false` keeps the per-linter tally off stdout, where it
      // would follow the JSON. Two runs at once fail without
      // `--allow-serial-runners`, and the lock keeps them from waiting on each
      // other's timeouts. A `go.work` root's own `./...` matches none of its
      // modules, so the packages are named.
      args: ['exec', 'golangci-lint', 'run', '--output.json.path=stdout', '--show-stats=false', '--allow-serial-runners', '{go-packages}'],
      outputFile: 'lint.json',
      fixArgs: ['exec', 'golangci-lint', 'run', '--fix', '--allow-serial-runners', '{go-packages}'],
      lock: 'golangci-lint',
      devDeps: {},
    },
    {
      name: 'staticcheck',
      slot: 'lint',
      description: 'staticcheck: Go static analysis',
      detect: [],
      detectPin: 'staticcheck',
      command: 'pnpm',
      args: ['exec', 'staticcheck', '-f', 'json', '{go-packages}'],
      outputFile: 'lint.jsonl',
      devDeps: {},
    },
    {
      name: 'deadcode',
      slot: 'dead',
      description: 'deadcode: Go functions no main or test reaches',
      detect: [],
      detectPin: 'deadcode',
      command: 'pnpm',
      // deadcode lists what it finds and exits 0. Reachability is whole
      // program, so its packages never narrow.
      args: ['exec', 'deadcode', '-test', '{go-packages}'],
      outputFile: null,
      failOnOutput: true,
      devDeps: {},
    },
    {
      name: 'go-test',
      slot: 'test',
      description: 'go test: Go tests',
      detect: GO_ROOT,
      command: 'go',
      args: ['test', '-json', '{go-packages}'],
      outputFile: 'test.jsonl',
      devDeps: {},
    },
    {
      name: 'govulncheck',
      slot: 'security',
      description: 'govulncheck: known vulnerabilities your Go code calls',
      detect: [],
      detectPin: 'govulncheck',
      command: 'pnpm',
      // Text output, because `-format json` exits 0 even when the code calls
      // a vulnerable function; text exits 3. It reads the Go vulnerability
      // database, so it runs with the network.
      args: ['exec', 'govulncheck', '{go-packages}'],
      outputFile: null,
      network: true,
      devDeps: {},
    },
  ],
};

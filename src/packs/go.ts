/**
 * The go pack: Go modules and workspaces, checked from the directory that
 * holds a `go.mod` or `go.work`.
 *
 * A Go tool resolves through the `go.mod` `tool` directive first, run as
 * `go tool <bin>`, then a `mise.toml` pin, then `PATH` (R6.1). Every check of
 * the pack, a target's custom checks included, runs with Go's downloads
 * switched off (R6.4): `GOTOOLCHAIN=local` fails a module that asks for a newer
 * Go than the one installed, rather than fetch it, and `GOPROXY=off` fails a
 * module missing from the module cache, rather than download it, so a repo runs
 * `go mod download` first. `GOFLAGS` is left alone: Go 1.24 already refuses to
 * rewrite `go.mod` during a build, and `-mod=readonly` would make Go ignore a
 * module's `vendor/` (D54).
 */

import type { Pack } from './types.js';

export const GO_PACK: Pack = {
  name: 'go',
  markers: ['go.mod', 'go.work'],
  pins: ['go-mod-tool', 'mise', 'path'],
  env: { GOTOOLCHAIN: 'local', GOPROXY: 'off' },
  adapters: [],
};

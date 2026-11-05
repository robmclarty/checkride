/**
 * The odin pack: Odin packages, each checked from its own directory, since
 * an Odin package is one directory and every `.odin` file in it belongs to
 * it. A repo with several packages declares one target each, a package
 * nested in another's directory included (`nests`), and discovery proposes
 * one per directory holding `.odin` files.
 *
 * Every row runs the compiler itself, `odin`, which a `mise.toml` pins
 * through mise's registry entry for it (`mise use odin@dev-2026-11a`), else
 * the copy on `PATH`; there's no config file to detect, so each row is on in
 * every odin target. `odin check` type-checks a package with its imports and,
 * under the `-vet` flags, vets it; `odin test` builds the package, links it
 * and runs its `@(test)` procedures, which makes it a build check for a
 * package with none ("No tests to run.", exit 0). `-no-entry-point` lets a
 * library package, one with no `main`, check as a program does.
 *
 * `-json-errors` prints every error to stderr as JSON, which one parser reads
 * for the three check rows; `-max-error-count` lifts the compiler's cap of
 * 36, so the baseline sees every error; and `-thread-count:1` keeps the
 * checker on one thread, since dev-2026-07 hung now and then checking a
 * package that imports another, and a check costs a tenth of a second
 * either way. Each row was checked against odin dev-2026-07-nightly:819fdc7.
 *
 * The vet of unused procedures names the package it vets, through
 * `{odin-package}`, which the orchestrator reads from the package clause, so
 * a dependency's procedures are never flagged; it flags every procedure
 * nothing in the program calls, so it runs only where a `main` procedure
 * makes the package a program, and sits a library out with its reason. The
 * lint row leaves `-vet-tabs` and `-disallow-do`, two style opinions, to the
 * repo, which adds them by overriding the row's args in its config.
 */

import type { Pack } from './types.js';

/** What every `odin check` row runs: the package at the root, a library allowed, every error as JSON, one thread, no cap. */
const CHECK: readonly string[] = ['check', '.', '-no-entry-point', '-json-errors', '-thread-count:1', '-max-error-count:100000'];

export const ODIN_PACK: Pack = {
  name: 'odin',
  markers: ['*.odin'],
  pins: ['mise', 'path'],
  env: {},
  // A package in another's directory is a package of its own, which its
  // own target checks and tests; the outer target's rows never reach it,
  // so a nested target switches nothing off.
  nests: { off: [] },
  adapters: [
    {
      name: 'odin-check',
      slot: 'types',
      description: 'odin check: Odin compilation',
      detect: [],
      command: 'odin',
      args: [...CHECK],
      outputFile: null,
      devDeps: {},
    },
    {
      name: 'odin-vet',
      slot: 'lint',
      description: "odin check -vet: the compiler's vet",
      detect: [],
      command: 'odin',
      // `-vet` is unused variables and imports, shadowing and `using`
      // statements; `-vet-cast` a cast to a value's own type; `-vet-style`
      // and `-vet-semicolon` the style the compiler itself recommends. A
      // warning exits 0 unless `-warnings-as-errors`, which makes it a
      // finding that gates.
      args: [...CHECK, '-vet', '-vet-cast', '-vet-style', '-vet-semicolon', '-warnings-as-errors'],
      outputFile: null,
      devDeps: {},
    },
    {
      name: 'odin-unused',
      slot: 'dead',
      description: 'odin check -vet-unused-procedures: procedures nothing calls',
      detect: [],
      command: 'odin',
      args: [...CHECK, '-vet-unused-procedures', '-vet-packages:{odin-package}'],
      outputFile: null,
      devDeps: {},
    },
    {
      name: 'odin-test',
      slot: 'test',
      description: 'odin test: Odin tests',
      detect: [],
      command: 'odin',
      // The runner's log stays plain; its binary is cleaned up after the run.
      args: ['test', '.', '-define:ODIN_TEST_FANCY=false'],
      outputFile: null,
      devDeps: {},
    },
  ],
};

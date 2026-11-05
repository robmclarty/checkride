# Example: an Odin program and its library on the odin pack

Two Odin packages, a program at `app/` with one test and the library it
imports at `kit/`, checked as two odin targets. There's no `package.json`
here and no `.odin` file at the root, so the targets in
`checkride.config.json` say what to check, and a packs block adds two style
opinions to the vet row for both:

```json
{
  "targets": {
    "app": { "lang": "odin", "root": "app" },
    "kit": { "lang": "odin", "root": "kit" }
  },
  "packs": {
    "odin": {
      "checks": {
        "lint": {
          "use": "odin-vet",
          "args": [
            "check", ".", "-no-entry-point", "-json-errors", "-thread-count:1", "-max-error-count:100000",
            "-vet", "-vet-cast", "-vet-style", "-vet-semicolon", "-vet-tabs", "-warnings-as-errors", "-disallow-do"
          ]
        }
      }
    }
  }
}
```

## Run it

You need `odin` on your `PATH`; `mise install` at the repo root installs the
release this repo pins (dev-2026-11a), and `mise exec --` puts it on `PATH`.
Build checkride once from the repo root, since the example runs the working
tree rather than a published release:

```bash
pnpm install && pnpm build
```

Then check it:

```bash
cd examples/odin-package
mise exec -- node ../../dist/cli.js
```

It exits **0**:

```text
✔ app:types    odin check: Odin compilation  [built-in]
✔ kit:types    odin check: Odin compilation  [built-in]
✔ app:lint     odin check -vet: the compiler's vet  [config]
✔ kit:lint     odin check -vet: the compiler's vet  [config]
✔ app:dead     odin check -vet-unused-procedures: procedures nothing calls  [built-in]
○ kit:dead       skip  no main procedure in kit: unused procedures are vetted from a program
✔ app:test     odin test: Odin tests  [built-in]
✔ kit:test     odin test: Odin tests  [built-in]
✔ links        Relative markdown link targets exist on disk  [built-in]
✔ unclaimed    Every toolchain marker sits inside a target that checks it  [built-in]
```

## 1. A package is a directory, and a target checks one

An Odin package is one directory, and every `.odin` file in it belongs to
it, so an odin target checks one package from its directory and a repo with
several declares one target each. `kit` has no `main`: every check row runs
`-no-entry-point`, so a library checks and tests as a program does, and its
`test` builds and links it even with no `@(test)` procedure ("No tests to
run.", a build check).

## 2. The compiler is every row

There's no linter or test runner to install beside the compiler: `types` is
`odin check`, `lint` the same under the compiler's vet flags with
`-warnings-as-errors`, `dead` its vet of unused procedures, and `test` is
`odin test`. `-json-errors` prints each error to stderr as JSON, which
checkride reads: a finding at its file, line and column, keyed on the file
and the message, since the compiler names no rule. A syntax error stops the
compiler before it checks anything, so such a run stops short and the
baseline neither masks nor prunes with it.

The unused-procedure vet names the package it vets through `{odin-package}`,
read from the `package` clause, so `app`'s run vets `app`'s procedures and
never `kit`'s. It flags every procedure nothing in the program calls, so it
runs only where a `main` makes the package a program, and `kit:dead` stands
down with that reason. `app_test.odin` opens with `#+test`, which keeps it
out of `odin check`: without the tag the vet would flag `twice_doubles`,
which nothing calls.

## 3. The packs block adds the style opinions

Tabs and a ban on `do` are opinions the pack leaves to the repo. The packs
block restates the vet row's args with `-vet-tabs` and `-disallow-do` added,
which applies to every odin target at once; `use` keeps the row's name, so
the same parser reads its output. Keep `-json-errors` in such an override:
without it the compiler prints text the parser can't read.

## Prove each check bites

`expected.json` plants one violation per check, and the examples suite runs
each: an import nothing uses fails `app:lint`, a `do` fails it too, a
procedure nothing calls fails `app:dead`, a failing test fails `app:test`,
and a directory of `.odin` files outside every target fails `unclaimed`,
which suggests the target that would check it.

## See also

- [Packs and pins: the odin pack](https://github.com/robmclarty/checkride/blob/main/docs/packs.md#the-odin-pack)
- [Targets](https://github.com/robmclarty/checkride/blob/main/docs/targets.md)

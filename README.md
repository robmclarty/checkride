![A robot pilot labeled AGENT approaches a runway signed DONE. Eight approach lights, one per check (types, lint, struct, dead, test, docs, links, spell) and all run by pnpm check, are green, so the checkride control tower signals exit 0, cleared to land. A dashed loop marks the earlier approach, where a failed test meant exit 1 and a go-around.](./hero.png)

# checkride

checkride runs every check your repo has as one command. Exit 0 means the work
is done. An agent keeps going until it's green, and a reviewer starts from
green.

In a repo that has a `package.json`:

```bash
pnpm add -D checkride
pnpm exec checkride init
```

`init` adopts the tools the repo already has, writes a `checkride.config.json`
naming each one, and adds a `check` script, so the gate is `pnpm check` from
then on. A check that already fails is set aside so the first run is green;
`init --baseline` keeps it on and grandfathers today's findings instead. npm,
yarn and bun, a new project, a repo with no Node, and the standalone binary
are each in [Getting started](./docs/getting-started.md) and
[Installing checkride](./docs/distribution.md).

## What a run prints

This is a real run of [`examples/agent-loop`](./examples/agent-loop/), a repo
left red on purpose, with one unused variable and one call to a function that
was never written:

```text
$ pnpm check

Running 8 check(s)...

  ▸ types  TypeScript type checking (incremental, via project references)
  ▸ lint  Oxlint, type-aware with oxlint-tsgolint
  ○ struct        skip  no tool detected for slot
  ○ dead          skip  no tool detected for slot
  ○ test          skip  no tool detected for slot
  ○ docs          skip  no tool detected for slot
  ▸ links  Relative markdown link targets exist on disk
  ○ spell         skip  no tool detected for slot
  ✔ links        16ms  Relative markdown link targets exist on disk  [built-in]
  ✘ types      1347ms  TypeScript type checking (incremental, via project references)  [detected: tsconfig.json]
           src/checkout.ts:19:33  Cannot find name 'shippingCents'.  [TS2304]
           full output: .check/types.stdout.txt
  ✘ lint       1536ms  Oxlint, type-aware with oxlint-tsgolint  [detected: .oxlintrc.json]
           src/checkout.ts:17:9  Variable 'taxCents' is declared but never used. Unused variables should start with a '_'.  [eslint(no-unused-vars)]
           full output: .check/lint.json

✘ one or more checks failed in 1557ms — only 3 of 8 checks ran, 5 skipped
report: .check/summary.json
digest: .check/digest.md
```

It exits 1. Fixing one of the two defects leaves it at 1, because the exit
code judges the whole job and not the last edit. Exit 2 means the run itself
couldn't reach a verdict, such as a config it can't read, so a gate never
mistakes a broken setup for a failing change.

Each tool writes its own output to `.check/`, untouched, and that file stays
the authority; the line under each red check is an excerpt that points at it.
`.check/summary.json` holds the verdict, and `--digest` writes a short
`digest.md` of the failures. Progress goes to stderr, so stdout carries only
what `--json` asks for and is safe to pipe.

During iteration, narrow the loop: `checkride --bail` stops at the first
failure, `--only types,lint` runs those checks alone, and `--changed` runs
what a change touched.

## What an agent gets

`init` also writes the contract an agent works to:

- **An AGENTS.md stanza** that says exit 0 means done, and where to look when
  it isn't. CLAUDE.md gains one line, `@AGENTS.md`, since Claude Code reads a
  CLAUDE.md in AGENTS.md's place.
- **A guard hook** for Claude Code and Cursor that refuses an agent's edit to
  `checkride.baseline.json` or `.check/`, so it can't make the gate green by
  rewriting the record.
- **A stop gate**, opt-in with `checkride hooks add`, that runs the check when
  the agent tries to finish and sends it back while the run is red.

The stanza is usually enough. Running in CI, see
[Running in CI](./docs/ci.md): `--strict` makes a run where nothing ran an
error rather than a pass, and `baseline diff --fail-on-added` fails a change
that grandfathers its own findings.

The package is also a [Claude Code plugin](./docs/plugin.md), whose
`/checkride:check` skill triages a red run and `/checkride:qa` reads the
quality reports:

```text
/plugin marketplace add robmclarty/checkride
/plugin install checkride@checkride
```

## The thesis

Agents are good at writing code and bad at knowing when to stop. checkride
gives them two things they otherwise lack:

1. **A definition of done.** One command runs the whole pipeline: types, lint,
   structure, dead code, tests, docs, links and spelling, and any check you
   add. Exit 0 means the work is complete.
2. **Lanes to stay inside.** The `struct` and `dead` checks hold module
   boundaries mechanically, so parallel changes stay inside one module each
   and rarely collide.

checkride never normalizes diagnostics to reach a verdict. The reader is an
LLM, which reads whatever a tool emits, so each tool's raw output stays
authoritative, and adding a tool needs no adapter to translate it.
[Why checkride](./docs/why.md) makes the longer case.

## Conventions

`init` scaffolds one default, [deep modules](./docs/deep-modules.md): a file
is a module, a module grows into a folder whose `index.ts` is its only public
surface, and siblings import that index and never its internals. Nothing about
it is hardcoded. The `struct` check runs whatever ast-grep rules sit in the
repo's `rules/`, so editing those rules changes the convention, and a rule
ast-grep can't express runs as a
[custom check](./docs/tools.md#when-to-write-a-custom-check).

## More than TypeScript

Go, Rust, Python, Terraform, Odin and shell code are checked through
[language packs](./docs/packs.md), each running its tools from the copy the
repo pins. A mixed-language monorepo declares its parts as
[targets](./docs/targets.md), each checked from its own root, and a target can
keep its config and baseline in its own directory.
[A polyglot repo, end to end](./docs/polyglot.md) takes one from install to a
green gate.

## Tested envelope

Every push runs the unit, contract and end-to-end suites on macOS and Linux,
at Node 22.18.0 (the supported floor), Node 24 and Node 26. The end-to-end
suite generates projects and checks them for real under pnpm, npm, yarn and
bun, and runs every language pack against its real tools. Windows isn't tested
and isn't claimed. Mutation testing runs with a hard floor of 68; the last full
run scored 83%.

## Docs

[docs/](./docs/README.md) holds the rest. The pages most readers want next:

- [Getting started](./docs/getting-started.md): the first run and the daily
  loop.
- [Configuration](./docs/configuration.md): every key `checkride.config.json`
  takes.
- [The baseline](./docs/baseline.md): grandfathering findings, and the ratchet
  that shrinks them.
- [Cheat sheet](./docs/cheatsheet.md): every command and flag on one screen.
- [The contract](./docs/contract.md): exit codes, `summary.json`, the
  programmatic API, and the pin policy.

[examples/](./examples/) holds runnable repos, each showing one thing, each
asserted by the end-to-end suite on every push. See [AGENTS.md](./AGENTS.md)
for the contract agents follow in this repo,
[CONTRIBUTING.md](./CONTRIBUTING.md) for the release ritual,
[SECURITY.md](./SECURITY.md) for reporting a security problem, and
[CHANGELOG.md](./CHANGELOG.md) for release notes.

## License

[Apache-2.0](./LICENSE)

# The baseline

Adopting checkride on an existing repo shouldn't be a cleanup project. A
**baseline** grandfathers the diagnostics a repo has *today* so day-one runs pass,
while any *new* diagnostic still fails — "don't make it worse" as the definition of
done for legacy code.

```bash
checkride baseline        # record current diagnostics into checkride.baseline.json
```

## The file

`checkride.baseline.json` lives at the repo root beside `checkride.config.json` and
**is committed** — it must be in version control to work. It records a per-slot set
of stable *fingerprints* (a `file:rule:message` key that survives line moves), not
raw output, and how many findings each key grandfathers when it's more than one:

```jsonc
{
  "schema_version": 1,
  "slots": {
    "lint":  ["src/legacy.ts:typescript(no-explicit-any):Unexpected `any`. Specify a different type."],
    "spell": ["docs/old.md::teh"]
  },
  "counts": {
    "lint":  { "src/legacy.ts:typescript(no-explicit-any):Unexpected `any`. Specify a different type.": 2 },
    "spell": {}
  }
}
```

A target's checks key under their own names, such as `api:lint`, and every
key names its file from the repo root, so a key stays valid wherever the tool
ran from. A key has no line in it, so two of the same finding in one file
share it: `counts` says how many findings each key grandfathers, two above,
and one for a key it doesn't list. A third `any` in that file is new, and
fails. A file an earlier release captured has no `counts`, and each of its
keys grandfathers any number of findings, as every key did then, until the
next `checkride baseline` counts them.

The file's shape is a promised surface — see
[the contract](./contract.md#checkridebaselinejson). A
[local target](./targets.md#local-targets) keeps its keys in a file of its
own beside its config, a shard of the baseline; every command on this page
reads, ratchets and writes each shard the way it does the root file, and
[Targets § A local target's baseline](./targets.md#a-local-targets-baseline)
has the rules.

## Every run reads it

Once it exists, every normal run is **baseline-aware**:

- Each slot's current findings have the grandfathered ones subtracted. A slot is
  **green when only baselined findings remain**, and **fails listing only the new
  ones** — the raw `.check/<slot>.json` still holds everything, and the failing
  check gains a `"baselined": <n>` count.
- The baseline is a **ratchet**: fixing a grandfathered finding prunes it from the
  file (it only ever shrinks), so debt can't silently creep back. Fixing one of
  a key's several findings lowers its count the same way. A partial run
  (`--only`, `--skip`, `--changed`, or a `--bail` that stops early) never prunes —
  it can't tell an unobserved finding from a fixed one, so it leaves the baseline
  untouched.
- Never add to the baseline to make a check pass; fix the finding, or re-run
  `checkride baseline` deliberately to re-grandfather.

A crash or empty output is never masked — a slot only goes green when there
are findings and all of them are grandfathered.

## When the tool's version moves

A key carries the tool's own wording, so another version of a tool can key
the same debt differently. The file's `captured_with` records which copy of
each check's tool captured its keys: the pin source and version a run
records, such as `{ "pin_source": "nix", "tool_version": "2.11.4" }`, and
for a go check the Go release it ran on, as `toolchain_version`, since a new
Go minor can re-key findings too. A run
with another copy still fails on a new key, but its digest and a `baseline:`
line on stderr name both copies, and the ratchet prunes none of that check's
keys, since the copy that captured them may still report them. Run under the
same copy, or, once the repo pins the new one, run
`checkride baseline --versions`: for each check that reported no key the
file lacks, and no key more often than the file counts it, under a copy the
repo pins, it records that copy and prunes the keys it no longer reports. It never adds a key, so an agent may run it; a
check with new keys is left for a human's review and `checkride baseline`.

## Re-baselining, and reviewing what it adds

`checkride baseline` re-records
*everything* currently failing — including brand-new debt you might rather
fix — so treat re-running it as a reviewed change: do it deliberately (say,
after adopting a stricter rule set) and read the `checkride.baseline.json`
diff in the PR like code. `checkride baseline --only <checks>` (or `--skip`)
re-records just the checks it selects and leaves every other check's entry as
it was, so adopting one check per commit touches only that check in the diff.

`checkride baseline diff [<ref>]` lists the keys the
working tree adds and drops against `<ref>`'s copy (default `HEAD`), per check,
and each key whose count changed, or as JSON under `--json`, so a reviewer sees
exactly what a change grandfathers. `--fail-on-added` makes it a guard: exit 1
when a key was added or a count grew, which
[Running in CI](./ci.md#guard-the-baseline) runs as a job of its own
against the merge base.

## Merge conflicts and recovery

The file is canonical (slots and
keys are sorted), so parallel branches usually merge cleanly; when they do
conflict, resolve by keeping both sides' entries and running a full
`checkride` — the ratchet prunes anything already fixed, so an over-generous
union self-heals, while a dropped entry that still fails simply resurfaces as
a red check. When a merge went badly anyway — entries deleted wholesale, or a
file so mangled it no longer parses (a run says so on stderr and treats it as
no baseline at all) — the run diagnoses what it can: a red run whose "new"
findings were grandfathered until a recent commit prints a `hint:` line naming
that commit. `checkride recover` then rebuilds candidate states from the
file's git history and restores one additively; see `checkride recover --help`
and [the cheat sheet](./cheatsheet.md#checkride-recover).

## Which checks it keys

Only slots whose tool has a parser the baseline keys with participate, and a
capture doesn't run the others: tsc for `types`, oxlint, eslint, biome,
golangci-lint, staticcheck, clippy, shellcheck, ruff and tflint for `lint`,
ast-grep for `struct`, markdownlint-cli2 and rumdl for `docs`, cspell and typos
for `spell`, vale for `prose`, and fallow for `dead`, `dupes` and `health`,
each keying only the findings that can fail the slot. A custom check whose
`name` is one of these adapters' is keyed the same way, so an eslint rule set
run as a check of its own, with `"name": "eslint"`, can be adopted with
findings it already has (see
[Tools § A custom check whose findings the baseline keys](./tools.md#a-custom-check-whose-findings-the-baseline-keys)).

A tsc key holds the error's file, its code and its message's first line, with
what tsc filled into it written `…`: each quoted span, the list a "following
…:" message ends on, and every number, since that text changes on edits
elsewhere: `src/a.ts:TS2322:Type '…' is not assignable to type '…'.`, or
`src/a.ts:TS2554:Expected … arguments, but got ….` Two such errors in one file
share a key, and `counts` holds both. Since the key no longer says which name
or type an error is about, a run lists each new key's findings beneath it as
tsc printed them, the first ten keys of a check and then how many more, and so
does the digest. A run that
stopped tsc short of some errors masks nothing and prunes nothing, and its
check's `reason` says why: a syntax error, which leaves its whole project
unchecked, a tsconfig tsc rejected, a reference it didn't build (`TS6305`),
a tsc killed or crashed part way, or any error from a build that skips each
project depending on one with errors, under `--stopBuildOnErrors` or, before
TypeScript 5.6, under a `--build` of project references, which 5.6 and later
check whole. The other type checkers, go build,
cargo check, mypy and basedpyright, are never grandfathered, since each can
stop before it reports every error, and neither are tests, so those slots
never appear in the baseline.

## Adopting on an existing repo

To adopt on an existing repo, `checkride init --baseline` grandfathers today's
failing (fingerprintable) slots into the baseline and keeps them enabled, instead of
writing them off as `false`; a failing slot with no extractor still falls back to a
disable. A slot that fails before it reaches a verdict, a declared tool nothing
installed, a setup step not yet run, a crash or a timeout, is neither: `init`
leaves it on, names what stopped it, and a `checkride baseline` once it runs
grandfathers what it finds. A tsc run that stopped short is left on too, on a
line of its own naming what stopped it: once that's fixed, `checkride
baseline` grandfathers the rest.
[`examples/existing-repo-baseline`](../examples/existing-repo-baseline/) walks
it end to end.

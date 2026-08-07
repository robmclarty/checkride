# Running a fleet with shared presets

This doc is for the person who owns code quality across *many* repos, not one.
It explains how to put your organization's checkride rules in a single versioned
package, roll changes out to the whole fleet as a release instead of a campaign
of pull requests, and keep that one shared config safe across repos that don't
all use the same tools.

It elaborates one bullet from [Why checkride](./why.md) — *"org-wide policy
without org-wide bureaucracy"* — into an operating procedure. For the field-level
mechanics of the two features it leans on, see
[Sharing presets with `extends`](../README.md#sharing-presets-with-extends) and
[Gating a custom check with `detect`](../README.md#gating-a-custom-check-with-detect)
in the root README; this doc assumes them and focuses on the workflow.

## The shape of it

Three moving parts:

1. **One preset package** — say `@acme/checkride-preset` — holds the rules every
   repo should enforce. It is an ordinary npm package whose payload is a
   checkride config.
2. **Each repo extends it.** A repo's `checkride.config.json` is small: it
   inherits the preset and adds only what is local.

   ```json
   {
     "$schema": "./node_modules/checkride/schema/checkride.config.schema.json",
     "extends": "@acme/checkride-preset",
     "checks": {
       "test": { "timeout": 120000 }
     }
   }
   ```

3. **`detect` keeps the shared rules safe.** The preset can carry checks for
   tools that only *some* repos use; each check gated on a marker file quietly
   stands down where that tool is absent instead of failing.

The result: the rules live in one place, every repo runs the subset that applies
to it, and updating the fleet is a `pnpm publish` of the preset.

## Authoring the preset package

The package is just a checkride config shipped under a name. A minimal one:

```text
@acme/checkride-preset/
  package.json      // "main": "preset.json"  (or an "exports" map)
  preset.json       // a checkride config: { "checks": { … } }
```

`preset.json` is the same shape as a repo's `checkride.config.json`, minus the
`$schema` pointer. Point the package's `main` (or an `exports` entry) at it so
`"extends": "@acme/checkride-preset"` resolves. You can also expose several
named configs — `@acme/checkride-preset/strict.json`,
`@acme/checkride-preset/library.json` — and let a repo extend the one that fits.

Presets compose. `extends` accepts an array that layers left to right (later
entries and then the repo's own keys win), and a preset may itself `extends`
another preset — so a `strict` preset can build on a `base` preset. checkride
resolves the whole chain, catches a cycle, and fails fast on a preset it can't
resolve.

## Keeping the preset safe across a heterogeneous fleet

A single org-wide preset will list checks for tools that not every repo has —
a Terraform check, a Rust check, a Python check. Without gating, those checks
would light up red in a repo that has no Terraform. `detect` closes that:

```json
{
  "checks": {
    "terraform-fmt": {
      "command": "terraform",
      "args": ["fmt", "-check", "-recursive"],
      "detect": [".terraform.lock.hcl", "main.tf"]
    }
  }
}
```

The check runs only when at least one listed file exists in the repo, and is
**skipped, not failed**, otherwise. Two things to keep in mind when writing
`detect` lists for a shared preset:

- **Entries are literal file paths relative to the repo root, not globs.**
  checkride tests each with a plain existence check, so `"*.tf"` will not match —
  list real marker files a repo of that type actually has (`Cargo.toml`,
  `go.mod`, `pyproject.toml`, `tsconfig.json`, `.terraform.lock.hcl`). List
  several when a tool has more than one plausible marker; any one present is
  enough.
- **`detect` gates custom checks that run alongside the built-in catalogue.**
  A custom check that fills a built-in slot always runs, so reserve `detect` for
  the extra, tool-specific checks a preset adds — which is exactly the fleet case.

This is what lets the preset hold the *union* of every tool in the org while
each repo runs only its own subset.

## Rolling out a change to the fleet

This is the payoff, and the reason the preset exists. To add or tighten an
org-wide rule:

1. Edit the preset — add the check, raise a threshold, swap an adapter.
2. Publish a new version of `@acme/checkride-preset`.
3. Each repo picks the change up when it bumps the dependency.

That's it. No per-repo edit, no fan-out of near-identical pull requests,
no chasing down the repos that were missed. One release propagates to everyone on
the next bump. Retiring a rule is symmetric: delete it from the preset, publish,
done.

Because a repo can only fail on a rule once it has actually adopted the new
version, the rollout is also *paced by design* — a repo stays green on the old
version until it bumps, so nothing breaks the moment you publish. Pair a new rule
with a `detect` gate and it lands even more gently: repos without the relevant
tool never see it.

## Versioning the preset

Treat the preset's version as a policy contract, because that is what repos pin
to.

- **A new or stricter check can turn a previously green repo red.** That is the
  point of the release, but it means "add a rule" is not a patch-level change in
  spirit — bump at least the minor version and say so in the preset's release
  notes, so a repo owner reading the bump knows new failures may be intentional.
- **Pin deliberately in each repo.** An exact pin (`1.4.0`) makes a repo's gate
  fully reproducible and makes adopting a new rule an explicit, reviewable bump.
  A range (`^1`) trades that for automatic adoption. Fleets usually want the
  former for reproducibility and let an update bot (below) turn each bump into a
  reviewable PR.
- **Ship a grace path for big changes.** When a new rule will fail many repos at
  once, lean on checkride's own ratchet: land the rule, let each repo adopt with
  `checkride --baseline` to grandfather existing debt so it is green on day one
  while any *new* violation still fails. See the baseline note in
  [Running in CI](./ci.md).

## Automating the bump

The rollout is only as good as the mechanism that carries a new preset version
into each repo. Two pieces:

- **An update bot opens the bump PRs.** Point Renovate or Dependabot at the
  preset package and it raises a version-bump pull request in every repo when you
  publish. Group the preset with your other dev-dependency updates, or give it
  its own labelled PR so a policy change is easy to spot.
- **CI makes each PR self-reporting.** Every repo already runs `checkride
  --strict` in CI (see [Running in CI](./ci.md)), so the bump PR is green when
  the repo already complies and red, with the specific failing check named, when
  the new rule bites. The repo owner sees exactly what the new policy costs them
  before merging — no separate audit needed.

Together these turn "roll a rule out to 80 repos" into "publish the preset, then
review 80 auto-generated PRs as they go green."

## When a repo needs to opt out

A shared preset is a floor, not a straitjacket. Local config always wins over an
inherited preset, so a repo can adjust without forking the preset:

- **Tweak one field** — objects deep-merge, so
  `"test": { "timeout": 300000 }` overrides just the timeout and keeps the
  inherited command and args.
- **Replace a list** — arrays replace rather than concatenate, so setting
  `args` or `detect` locally supplies the whole new list.
- **Drop an inherited check** — set its key to `false` (or any value without a
  `command`) and it falls out of the run; use the same `"slot": false` form to
  turn off a built-in slot the preset enabled.

Keep these overrides rare and visible — a repo that overrides half the preset has
quietly left the fleet. When an override recurs across many repos, that is a
signal to change the preset instead.

## See also

- [Sharing presets with `extends`](../README.md#sharing-presets-with-extends) —
  the merge semantics and resolution rules.
- [Gating a custom check with `detect`](../README.md#gating-a-custom-check-with-detect)
  — the field reference.
- [Running in CI](./ci.md) — the `--strict` gate and the baseline ratchet the
  rollout relies on.
- [Why checkride](./why.md) — the case this doc turns into a procedure.

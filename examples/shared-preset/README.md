# Example: a shared preset across a fleet

When you own code quality across many repos, the expensive part is never
writing the rule — it's rolling it out. A **preset** puts the rules in one
versioned package. Each repo inherits it, and changing the fleet becomes a
`pnpm publish` instead of a campaign of near-identical pull requests.

This example is one such repo, next to the preset it extends.

## Run it

From the repo root, build checkride once:

```bash
pnpm install && pnpm build
```

Then:

```bash
cd examples/shared-preset
pnpm install
pnpm check
```

It exits **0**:

```text
○ python-format    skip  no detect file present
○ terraform-fmt    skip  no detect file present
✔ license-headers  org policy (strict tier): every source file carries a license header
✔ no-todos         org policy: no TODO comments (waived for src/legacy until Q3)
✔ types            TypeScript type checking
✔ lint             Oxlint
```

## The shape of it

[`preset/`](./preset/) is an ordinary npm package whose payload is a checkride
config. Here it is linked from next door; in a real fleet it is published as
`@acme/checkride-preset` and every repo depends on a version of it. The
resolution path is identical either way.

```text
preset/
  package.json    exports "." -> preset.json, "./strict.json" -> strict.json
  preset.json     the base tier: what every Acme repo must pass
  strict.json     an extra tier repos can opt into
  scripts/        the rules themselves, shipped with the config
```

This repo's [`checkride.config.json`](./checkride.config.json) is four lines of
inheritance and one local override:

```json
{
  "extends": ["@acme/checkride-preset", "@acme/checkride-preset/strict.json"],
  "checks": {
    "no-todos": {
      "description": "org policy: no TODO comments (waived for src/legacy until Q3)"
    }
  }
}
```

## What that demonstrates

**One package can carry more than one standard.** `extends` accepts a package
specifier *and* a subpath, so `@acme/checkride-preset/strict.json` is a second
named tier in the same package. A repo picks the tiers that apply to it.

**Bases layer left to right, and local wins over all of them.** The run output
above shows `no-todos` with *this repo's* description, not the preset's — while
its `command` and `args` still come from the preset. Objects **deep-merge**, so
overriding one field of a check keeps the rest. Arrays and scalars **replace
outright**; they are not concatenated, which is the rule most likely to
surprise you.

**Rules ship with the config, not copied into each repo.** The checks invoke
scripts inside the preset package:

```json
"command": "node",
"args": ["node_modules/@acme/checkride-preset/scripts/no-todo-comments.mjs"]
```

So fixing a rule is a preset release. Nothing is vendored into the repos, and
nothing drifts.

**`detect` keeps one config safe across a heterogeneous fleet.** The preset
carries a Python check and a Terraform check. This repo has neither
`pyproject.toml` nor `main.tf`, so both are **skipped, not failed**:

```text
○ python-format  skip  no detect file present
```

Look at what that skip proves: neither `ruff` nor `terraform` is installed here.
Without the gate, checkride would try to spawn binaries that don't exist and the
run would go red. A green run is the evidence the gate works — which is why the
preset can hold the *union* of every tool in the org while each repo runs only
its own subset.

## Rolling out a change

1. Edit the preset — add a check, tighten a threshold, swap an adapter.
2. Publish a new version.
3. Each repo picks it up when it bumps the dependency.

No per-repo edit, no fan-out of pull requests, nobody missed. Retiring a rule is
symmetric: delete, publish, done.

The rollout is also *paced by design*. A repo can only fail a new rule once it
has adopted the version carrying it, so nothing breaks the moment you publish —
and a new rule paired with a `detect` gate lands more gently still, since repos
without the relevant tool never see it.

## Try it yourself

Add a `TODO` comment to [`src/inventory.ts`](./src/inventory.ts) and run
`pnpm check` — the org-wide rule fails a repo that never defined it locally:

```text
✘ no-todos
    TODO/FIXME comments are not allowed in shipped source:
      src/inventory.ts:6: // TODO: handle partial shipments
```

Then create an empty `pyproject.toml` and run again: `python-format` stops
standing down and tries to run `ruff`, which isn't installed — the failure mode
`detect` exists to prevent.

## See also

- [Running a fleet with shared presets](https://github.com/robmclarty/checkride/blob/main/docs/presets.md)
- [Sharing presets with `extends`](https://github.com/robmclarty/checkride/blob/main/README.md#sharing-presets-with-extends)

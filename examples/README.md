# Examples

Runnable projects, each demonstrating one thing checkride does. They are
separate packages, not workspace members: `cd` into one, install it, run it,
and nothing else in this repo is involved.

Every example is exercised by [`test/e2e/examples.e2e.test.ts`](../test/e2e/examples.e2e.test.ts)
on every push. An example that stops behaving as its README claims fails CI,
which is the only reason to trust anything written here.

| Example | Shows | Exits |
| ------- | ----- | ----- |
| [`agent-loop/`](./agent-loop/) | What an agent reads when the gate is red — `summary.json`, the token-bounded `digest.md`, the Claude Code Stop hook that blocks it from finishing anyway | `1` (on purpose) |
| [`existing-repo-baseline/`](./existing-repo-baseline/) | Adopting checkride on a repo that already has findings: grandfather today's debt, fail on anything new, ratchet down as it is fixed | `0` |
| [`custom-checks/`](./custom-checks/) | The escape hatch: a bespoke formatter running ahead of the built-ins, `detect`-gated checks that stand down, and a rule no off-the-shelf linter could express | `0` |
| [`shared-preset/`](./shared-preset/) | One versioned preset package carrying org-wide policy across a fleet — two tiers, deep-merged local overrides, and `detect` keeping it safe in repos with different toolchains | `0` |
| [`polyglot/`](./polyglot/) | A Python repo: the TypeScript built-ins stand down, ast-grep enforces boundaries in Python, and custom checks run the ecosystem's own tools | `0` |
| [`module-boundaries/`](./module-boundaries/) | Domain boundaries enforced inside one deployment — directed dependencies, hidden internals, no unzoned escape hatch — and how that compares to splitting into services | `0` |
| [`dal-boundaries/`](./dal-boundaries/) | A Drizzle/Postgres data-access layer where only a domain's single writer may write its tables, and cross-domain readers get a read-only pool | `0` |

## Running one

Examples link to the working tree rather than a published release, so build
checkride once from the repo root first:

```bash
pnpm install && pnpm build
```

Then any example runs on its own:

```bash
cd examples/agent-loop
pnpm install
pnpm check
```

Each example carries its own `pnpm-workspace.yaml`. That is load-bearing:
without it, pnpm walks up to the repo root, finds *that* workspace, and installs
the root project instead — leaving the example with no `node_modules` and no
error to explain why.

Example lockfiles are not committed (they are gitignored), so the first install
resolves fresh against the exact versions pinned in each `package.json`.

## The `expected.json` contract

An example that isn't executed is a claim nobody checks. Each one therefore
declares what a correct run looks like, and the end-to-end suite asserts it:

```json
{
  "args": ["--digest"],
  "exitCode": 1,
  "checks": {
    "types": { "ok": false },
    "lint": { "ok": false },
    "spell": { "ok": true, "skipped": true }
  },
  "digestContains": ["src/checkout.ts"]
}
```

| Field | Meaning |
| ----- | ------- |
| `args` | Flags passed to the CLI for this example's canonical run |
| `exitCode` | The exit code the run must produce |
| `checks` | Partial assertions against `.check/summary.json` — only the named slots are checked, on any of `ok`, `description`, `skipped`, `reason`, `baselined` |
| `firstCheck` / `lastCheck` | The check that must come first or last in pipeline order, for examples that set `"order"` |
| `digestContains` | Substrings that must appear in `.check/digest.md` |
| `requires` | Binaries that must be on PATH; the example is skipped (loudly) when they are not |
| `ratchet` | Optional multi-step scenario: introduce a finding, then fix one, asserting the exit code and baseline size at each step |
| `violations` | Deliberate rule-breaking edits that must fail the build, each asserting the exit code, which checks failed, and which fallow counter or ast-grep rule fired |

`violations` is what keeps an *enforcement* example honest. A boundary rule that
silently stops matching still looks like a rule in review, so each example that
claims to enforce something applies the violation, runs it, and asserts the
specific finding — not merely that something went red. Edits are reverted after
each violation, so they stay independent.

`checks` is deliberately partial. Pinning every slot of every example would make
the suite fail on unrelated additions to the pipeline; pinning the slots each
example is *about* keeps it honest without making it brittle.

## Adding an example

1. Create `examples/<name>/` with a `package.json` (`"private": true`, and
   `"checkride": "link:../.."`), a `pnpm-workspace.yaml`, an `.oxlintrc.json`, a
   `README.md`, and an `expected.json`.
2. Run it and confirm the behavior is real before writing it down.
3. `pnpm test:e2e` — the suite discovers the directory automatically; there is
   no list to register it in.

Keep the dependency footprint small. Every devDependency is installed once per
example per CI matrix cell, so reach for the smallest tool that demonstrates the
point.

## Three tripwires worth knowing about

All are caught by the suite, so you will find out immediately rather than
subtly — but the reasoning is easier to read here than to reverse-engineer from
a failure.

**A relative Markdown link may not point outside its own example.** Each example
is copied somewhere else before it runs, so `../other-example/` resolves in the
repo and breaks in the copy — and the built-in `links` check turns that into a
red run. Link to a sibling example (or to the main docs) by full URL. Links
*within* an example are fine, and are checked.

**Every example needs its own `.oxlintrc.json`.** Without one, oxlint walks up
the directory tree and the example silently inherits the root repo's config —
it stops being standalone, and behaves differently in-tree than it does copied
somewhere else.

**The root pipeline has to opt out of oxlint's nested-config discovery.** The
flip side of the same mechanism: an `.oxlintrc.json` under `examples/` governs
its own subtree when the root run reaches it, which voids the root
`ignorePatterns` there and lints the deliberately broken sources. So this repo's
`checkride.config.json` overrides the `lint` argv to add
`--disable-nested-config`, and [`test/dogfood-config.test.ts`](../test/dogfood-config.test.ts)
keeps that override in step with the shipped adapter.

Examples are otherwise excluded from the root pipeline's `lint` and `dead`
scanning — but their Markdown is *not* excluded: example prose is linted,
spell-checked, and link-checked along with the rest of the docs.

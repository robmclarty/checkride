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
| `checks` | Partial assertions against `.check/summary.json` — only the named slots are checked, on any of `ok`, `skipped`, `baselined` |
| `digestContains` | Substrings that must appear in `.check/digest.md` |
| `ratchet` | Optional multi-step scenario: introduce a finding, then fix one, asserting the exit code and baseline size at each step |

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

## Two tripwires worth knowing about

Both are enforced by tests, so you will find out immediately rather than
subtly — but the reasoning is easier to read here than to reverse-engineer from
a failure.

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

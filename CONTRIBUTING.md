# Contributing

checkride currently has one maintainer. This file exists so that number is a
known quantity with a written succession path, not a mystery: everything needed
to develop, verify, and release lives here and in the repo.

## Development

```bash
pnpm install
pnpm check        # the definition of done — exit 0 or it isn't finished
```

`pnpm check` is checkride running on itself: types, lint, structure, dead code,
duplication, complexity health, tests + coverage, docs, links, spelling, and
incremental mutation testing. For faster iteration: `pnpm check --bail`, `pnpm
check --only types,lint`, `pnpm check --changed`. Always finish with a full
`pnpm check`.

Slower suite, run before a release (CI runs it on every push):

```bash
pnpm test:e2e     # generates projects, installs them, runs the built CLI
```

`pnpm mutation` still exists to run Stryker on its own (e.g. to refresh the
mutation score), but mutation is part of `pnpm check` — not a separate gate.

Conventions (enforced mechanically — see [AGENTS.md](./AGENTS.md)): deep
modules with barrel `index.ts` surfaces, named exports only, no classes, `.js`
extensions on relative imports, tests colocated or under `test/`.

## The contract

[docs/contract.md](./docs/contract.md) names the surfaces consumers may rely
on; [`test/contract/`](./test/contract/) locks them. Two rules:

1. A change that breaks a contract test is a **breaking change**. It needs a
   deliberate version decision (pre-1.0: minor bump; post-1.0: major), an
   update to `docs/contract.md`, and — never — a quiet edit that just moves
   the test.
2. Any contract-touching change (breaking or additive) must name itself in
   `CHANGELOG.md` under a **Contract** heading in that release's notes. New
   `summary.json` fields must land in the same commit as their
   [`schema/checkride.summary.schema.json`](./schema/checkride.summary.schema.json)
   entry — the summary contract test enforces this.

## Release ritual

Releases are tagged `vX.Y.Z`; the root `package.json` version is the source of
truth. With Claude Code, `/version <major|minor|patch>` performs steps 1–3
and 5; step 4 is still by hand.

1. Start from a clean tree on `main` with `pnpm check` green.
2. Bump `package.json` `version` (semver — pre-1.0, breaking changes take a
   minor bump, and consumers are told to pin exactly).
3. Prepend a `CHANGELOG.md` section summarizing every commit since the last
   tag, with a **Contract** heading when any apply.
4. Refresh the hand-maintained README numbers so they don't drift a release
   behind: the `$schema` example pin (to the new version) and the mutation
   score (from the latest `pnpm mutation` run).
5. Commit as `vX.Y.Z`, tag (annotated) `vX.Y.Z`, push the commit and the tag.
6. The tag push triggers
   [.github/workflows/release.yml](./.github/workflows/release.yml): full
   check + e2e, then `npm publish --provenance` — every published tarball is
   provenance-attested to its commit. Auth is npm **Trusted Publishing**
   (OIDC): no token exists anywhere, so there is nothing to leak, rotate, or
   bypass 2FA with. One-time setup on npmjs.com: package settings → Trusted
   Publisher → GitHub Actions, repository `robmclarty/checkride`, workflow
   filename `release.yml`.
7. Smoke-test the published package (`npx checkride@latest --version`).

## Succession

If someone else needs to take this over, the required credentials are exactly
two: npm publish rights on the `checkride` package and push rights on this
repository. There is no other infrastructure — no external CI accounts, no
servers. The build history lives in `.plumbbob/` and `CHANGELOG.md`; consumer
expectations live in `docs/contract.md`.

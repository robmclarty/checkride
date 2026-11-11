# Contributing

checkride currently has one maintainer. This file exists so that number is a
known quantity with a written succession path, not a mystery: everything needed
to develop, verify, and release lives here and in the repo.

## Licensing and sign-off

checkride is [Apache-2.0](./LICENSE). Under section 5 of that license, anything
you intentionally submit for inclusion is contributed under those same terms,
with no separate CLA to sign.

What that section cannot do is grant rights you do not hold. If you write
checkride code on an employer's time or equipment, or within your scope of
employment, **your employer owns that copyright and you cannot license it on
their behalf** — get their written go-ahead first.

So every commit needs a Developer Certificate of Origin sign-off:

```bash
git commit -s      # appends: Signed-off-by: Your Name <you@example.com>
```

That line asserts you have the right to submit the work under this license.
Read what you are certifying at [developercertificate.org](https://developercertificate.org/).

## Development

```bash
pnpm install
pnpm check        # the definition of done — exit 0 or it isn't finished
```

`pnpm check` is checkride running on itself: types, lint, structure, dead code,
duplication, complexity health, tests + coverage, docs, links, spelling, prose,
a type check of the tests, and the publish-ready bundle (build, publint, attw,
pack, smoke, snippets). For faster iteration: `pnpm check --bail`,
`pnpm check --only types,lint`, `pnpm check --changed`. Always finish with a
full `pnpm check`.

Slower suites, run before a release (CI runs e2e on every push):

```bash
pnpm test:e2e     # generates projects, installs them, runs the built CLI
pnpm mutation     # Stryker mutation testing (incremental) — opt-in, not in `pnpm check`
```

Mutation is deliberately not in the default gate: a cold run has no warm
`stryker.incremental.json` (it is gitignored), so a full pass would time out
`pnpm check` in CI. Run it locally, or refresh the score with `pnpm mutation`.

### E2e toolchains

Each language pack's e2e cases run that pack's real tools, pinned in the root
[`mise.toml`](./mise.toml): Go, Rust, Python and uv, shellcheck, shfmt,
golangci-lint, typos, rumdl, vale, ast-grep, OpenTofu, tflint, trivy and
Odin. Node
isn't among them; `engines.node` and CI's matrix own it. Fetch the pins once
(this needs the network), then run the suite with them on `PATH`:

```bash
mise install
mise exec -- pnpm test:e2e
```

A pack whose tools don't run skips its e2e cases and says why on stderr, so
the suite still runs on a machine that has only some of them. CI installs
every pin with `jdx/mise-action` and sets `CHECKRIDE_REQUIRE_TOOLCHAINS=1`,
which turns that skip into a failure; set it locally to prove a full install.
[`test/helpers/toolchains.ts`](./test/helpers/toolchains.ts) lists what each
pack needs, and a test holds that list equal to `mise.toml`'s pins.

Without rustup, mise installs one for the Rust pin into `~/.cargo` and
`~/.rustup`, and its `cargo` then shadows any other on a `PATH` that lists
`~/.cargo/bin`. To keep it inside mise's own directories, set its homes before
the first install:

```bash
mise settings set rust.cargo_home ~/.local/share/mise/rust/cargo
mise settings set rust.rustup_home ~/.local/share/mise/rust/rustup
```

Conventions (enforced mechanically — see [AGENTS.md](./AGENTS.md)): deep
modules with barrel `index.ts` surfaces, named exports only, no classes, `.js`
extensions on relative imports, tests colocated or under `test/`.

### The standalone binary

`pnpm build:sea` builds the [standalone
binary](./docs/distribution.md#the-standalone-binary) for the machine it runs
on, into the gitignored `.sea/`, and prints its path on stdout:

```bash
pnpm build:sea          # tsc --build, then build/sea/build.mjs
.sea/checkride doctor   # channel: binary (embedded Node <version>)
```

[`build/sea/build.mjs`](./build/sea/build.mjs) bundles `dist/cli.js` into one
ES module with esbuild, embeds `package.json` and every file under
`templates/`, `schema/` and `skills/` as assets under the path
`src/resources.ts` reads each by, and runs `node --build-sea`, which injects
both into a copy of Node. On macOS it then signs the result ad hoc. It isn't
part of `pnpm check`, and nothing it writes reaches the npm tarball.

The Node it embeds is pinned in
[`build/sea/.node-version`](./build/sea/.node-version), the Active LTS line,
and that Node also does the embedding. Under any other Node the script
reaches the pinned one through `mise exec node@<version>`, which installs it
on first use, so the build needs mise or that exact Node, and
`CHECKRIDE_SEA_NODE` names a Node binary to use instead. Bump the file on
purpose, then run the binary's tests.

The binary's differences from the npm CLI all ask `src/channel.ts`, and the
unit tests cover them by faking `node:sea` (`test/helpers/sea.ts`, used by
`src/__tests__/binary-channel.test.ts`). The e2e case builds a real one and
runs it beside the npm CLI, on a `PATH` with no `node`:

```bash
pnpm exec tsc --build
pnpm exec vitest run --config vitest.e2e.config.ts test/e2e/binary.e2e.test.ts

# or against a binary that's already built
CHECKRIDE_BIN="$PWD/.sea/checkride" pnpm exec vitest run --config vitest.e2e.config.ts test/e2e/binary.e2e.test.ts
```

It's part of `pnpm test:e2e`, and it never skips: the build runs in the
file's `beforeAll`, and a build that fails, for want of mise or the pinned
Node, fails every case, so a green e2e run always ran a binary. One run
leaves it out on purpose, and says so: `publish.yaml` passes
`--exclude test/e2e/binary.e2e.test.ts`, since a failed download of the
build's Node mustn't block the npm publish. `ci.yml` runs it on every push,
and `release.yaml` runs it against each platform's binary.

A pull request that touches the build (`build/sea/`, `release.yaml`,
`src/channel.ts`, `src/resources.ts`, the binary's e2e test, `package.json`
or the lockfile) also runs `release.yaml`'s `binaries` job as a dry run: all
four platforms build, test and pack a tarball, and nothing is released,
attested or attached. The attestation and the upload first run on a real tag.

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
6. The tag push triggers two independent workflows, kept separate so the npm
   credential surface and the release-authoring surface never share a job:
   - [.github/workflows/publish.yaml](./.github/workflows/publish.yaml):
     a `build` job runs the full check + e2e and packs the tarball, with no
     way to publish; then a `publish` job runs `npm publish --provenance` on
     that tarball — every published tarball is provenance-attested to its
     commit. Auth is npm **Trusted Publishing** (OIDC): no token exists
     anywhere, so there is nothing to leak, rotate, or bypass 2FA with, and
     the identity never shares a job with the repo's dependencies. The
     `publish` job runs in the `npm-publish` GitHub Environment and **pauses
     for a required-reviewer approval** — the CI equivalent of the old local
     MFA prompt. Approve it from the run page (or the repo's Environments
     tab) to release.
   - [.github/workflows/release.yaml](./.github/workflows/release.yaml):
     creates the GitHub Release for the tag, with notes pulled from the
     matching `CHANGELOG.md` section. It also builds the standalone binary
     on a native runner for each of `darwin-arm64`, `darwin-x64`,
     `linux-x64` and `linux-arm64`, runs the binary e2e and a smoke test of
     the packed tarball there, and fails unless the tag, `package.json` and
     the version the binary prints are equal. Separate jobs then attest each
     `checkride-<version>-<os>-<arch>.tar.gz` and attach them, with
     `SHA256SUMS`, to the release. Binaries never hold the npm publish or
     the release back, and each target stands alone: the tarballs that
     passed attach, `SHA256SUMS` lists exactly the ones the release holds,
     and a target that failed leaves the run red. A manual run with a `tag`
     input rebuilds and re-attaches them for a tag released earlier.

   One-time setup, both required for the first run: **npmjs.com** — package
   settings → Trusted Publisher → GitHub Actions, repository
   `robmclarty/checkride`, workflow filename `publish.yaml`, environment
   `npm-publish`; **GitHub** — repo Settings → Environments → `npm-publish`
   with a required reviewer (yourself).
7. Approve the paused `publish` run, then smoke-test the published package
   (`npx checkride@latest --version`). A few minutes later, check the
   `release.yaml` run is green and the release page holds four tarballs and
   `SHA256SUMS`
   (`gh attestation verify <tarball> --repo robmclarty/checkride` checks one).
   A red run names the target that failed; re-run it for the tag.

## Succession

If someone else needs to take this over, the required credentials are exactly
two: npm publish rights on the `checkride` package and push rights on this
repository. No other infrastructure exists — no external CI accounts, no
servers. The build history lives in `.plumbbob/` and `CHANGELOG.md`; consumer
expectations live in `docs/contract.md`.

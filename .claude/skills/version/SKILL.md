---
name: version
description: Bump checkride's version (major, minor, or patch), summarize every commit since the last release into a new CHANGELOG.md section, commit as vX.Y.Z, and create plus push an annotated tag. checkride is a single package, so the root package.json version is the source of truth and the bundled plugin manifest mirrors it.
argument-hint: "[major|minor|patch]"
disable-model-invocation: true
allowed-tools: Read, Edit, Glob, Bash(git status*), Bash(git log*), Bash(git describe*), Bash(git rev-list*), Bash(git add *), Bash(git commit *), Bash(git tag *), Bash(git push origin v*), Bash(git restore *), Bash(node -e *), Bash(node -p *), Bash(pnpm check*), Bash(cat *)
---

# version

Bump checkride's version, prepend a `CHANGELOG.md` section summarizing every
commit since the last release, commit, and tag. checkride is one package: the
root `package.json` `version` is the source of truth, the changelog lives at
`CHANGELOG.md`, and releases are tagged `vX.Y.Z`.

The package root is also the root of the bundled Claude Code plugin, so
`.claude-plugin/plugin.json` carries a second copy of the version. It is not
independent: `test/plugin-manifest.test.ts` asserts the two are equal, so a bump
that moves only `package.json` turns `pnpm test` red mid-release. This skill
moves both, in the same commit.

The deterministic work — clean-tree check, semver math, the version rewrite — is
done with `node` one-liners and `git`, never by hand. The model's job is to
summarize commits into release prose and run the git steps.

## Arguments

`$ARGUMENTS` is exactly one of `major`, `minor`, or `patch`. Anything else (a
package name, a flag, nothing at all) is a usage error: tell the user the valid
forms and stop.

## Steps

1. **Validate the bump type.** It must be `major`, `minor`, or `patch`. If not,
   stop with the usage message — make no changes.

2. **Require a clean working tree.** Run `git status --porcelain`. If it prints
   anything, stop: a release must be a single reviewable commit. Show the dirty
   files and tell the user to commit or stash first. Do not proceed.

3. **Read the current version:**

   ```bash
   node -p "require('./package.json').version"
   ```

   Call this `OLD`.

4. **Compute the new version** (never do the arithmetic yourself):

   ```bash
   node -e "const v=require('./package.json').version.split('.').map(Number),t=process.argv[1],n=t==='major'?[v[0]+1,0,0]:t==='minor'?[v[0],v[1]+1,0]:[v[0],v[1],v[2]+1];console.log(n.join('.'))" <type>
   ```

   Call this `NEW`. Also get today's date for the heading:

   ```bash
   node -e "console.log(new Date().toISOString().slice(0,10))"
   ```

5. **Find the previous release.** Run
   `git describe --tags --abbrev=0 --match "v[0-9]*"`. If it prints a tag, that
   tag is `SINCE`. If it errors (no version tag yet), this is the initial
   release and `SINCE` is empty.

6. **Collect the commit range** with `--no-merges`:

   - With a previous tag: `git log SINCE..HEAD --no-merges --pretty=format:"%h %s"`
   - Initial release: `git log --no-merges --pretty=format:"%h %s"`

   If the range is empty (nothing since the last release), stop and tell the
   user there is nothing to release. Make no changes.

7. **Draft the changelog section** in the existing Keep a Changelog format, using
   `NEW` and the date from step 4:

   ```markdown
   ## [X.Y.Z] - YYYY-MM-DD

   ### Added
   - <one line per user-visible addition>

   ### Changed
   - <behavior changes, refactors that matter externally>

   ### Fixed
   - <bug fixes>

   ### Internal
   - <tooling, tests, docs — keep short or omit>
   ```

   Rules: group by impact, not by commit (collapse the commits that together
   land one feature into one bullet); omit any empty section; one line per
   bullet; write for a reader who did not follow the work. For an initial
   release, title it `## [X.Y.Z] - YYYY-MM-DD` and summarize the whole history.

   **If `CHANGELOG.md` already carries an `## [Unreleased]` section**, that is
   release prose someone wrote *during* the work, describing the same commits
   step 6 just collected. Do not draft alongside it and do not restate it: start
   from its bullets, keep their wording and their `###` groupings, and add only
   what the commit range covers and they miss. The section you print is the
   merged result — one draft, not two.

   **Print the drafted section back to the user** as a fenced `markdown` block,
   verbatim, before editing any file — their one chance to read the prose in
   isolation. Continue automatically after printing; do not wait.

8. **Apply the changes** (three files only):

   - `package.json`: edit `"version": "OLD"` to `"version": "NEW"`.
   - `.claude-plugin/plugin.json`: edit its `"version": "OLD"` to
     `"version": "NEW"` as well. Same string, same commit — the parity test
     fails the release otherwise.
   - `CHANGELOG.md`: insert the new section immediately below the intro
     paragraph and above the current top `## [...]` section, keeping the single
     `# Changelog` heading at the very top. **When that top section is
     `## [Unreleased]`, replace it instead of inserting above it** — its heading
     becomes `## [X.Y.Z] - YYYY-MM-DD` and its body becomes step 7's merged
     draft. Inserting above would strand an `Unreleased` block *below* a dated
     release, which reads as debt that shipped and then un-shipped. Leave no
     empty `## [Unreleased]` shell behind: the next one gets written when the
     next unreleased change lands. Then add a link reference for the new version
     directly above the existing top one at the bottom of the file:
     `[X.Y.Z]: https://www.npmjs.com/package/checkride/v/X.Y.Z`.

9. **Verify before staging:** `pnpm check` — the full gate, not a narrowed one.
   The narrowing this step used to do (`--only docs,links,spell,test`) saved
   about 2.7s of a 23s run, because `test` dominates the critical path and the
   other slots finish in its shadow. That is not worth hand-maintaining a
   blast-radius list against config that moves: `CHANGELOG.md` is excluded from
   `docs` (`.markdownlint-cli2.jsonc`), `spell` (`cspell.json` `ignorePaths`)
   and `prose` (the path args in `checkride.config.json`, pinned by
   `test/dogfood-config.test.ts`), so three of those four could not fail on a
   release diff at all. A red tag is the expensive failure here — it parks
   Publish at its approval gate and leaves a stray GH Release, and the fix is
   forward-only. Buy the coverage. If it exits 0, continue. If it fails, roll
   back so the user can fix and re-invoke — `git restore package.json
   .claude-plugin/plugin.json CHANGELOG.md` — show the relevant `.check/*.txt`
   diagnostic, and stop.

10. **Stage exactly those three files and commit.** The commit message is
    literally the tag, no body:

    ```bash
    git add package.json .claude-plugin/plugin.json CHANGELOG.md
    git status --short
    git commit -m "vX.Y.Z"
    ```

    Confirm `git status --short` shows nothing unexpected staged before
    committing. If it does, stop and hand back to the user.

11. **Create an annotated tag and push it:**

    ```bash
    git tag -a vX.Y.Z -m "vX.Y.Z"
    git push origin vX.Y.Z
    ```

    Push only the tag (branch pushes are the user's call). If `git tag` fails
    because the tag exists, stop — do not force. If `git push` fails (no remote,
    auth, network), the local commit and tag still exist: tell the user, show the
    error, and suggest re-running `git push origin vX.Y.Z`. Do not delete the tag.

12. **Report:** old version, new version, commit SHA, tag, number of commits
    summarized, and whether the tag push succeeded.

## When to use this skill

- Cutting a checkride release: `/version patch`, `/version minor`, `/version major`.
- The user asks to "bump the version", "cut a release", or "tag a new version".

## When NOT to use this skill

- Nothing has changed since the last release (step 6 finds an empty range).
- The user wants to edit an existing changelog entry or retro-tag an old commit —
  that is a different, manual workflow.

## Edge cases

- **First release.** No `v*` tag yet, so `SINCE` is empty and the whole history
  is summarized. The repo ships at `0.1.0` untagged; a first `/version patch`
  moves to `0.1.1` — if you instead want to tag the current `0.1.0`, do that by
  hand (`git tag -a v0.1.0`), this skill always bumps.
- **`pnpm check` fails in step 9.** Only two slots can fail on the diff itself,
  so read them first. `test/plugin-manifest.test.ts` means step 8 moved
  only one of the two version strings — fix that rather than editing the test.
  `links` means a changelog bullet carries a relative link whose target is not
  on disk (it walks every `*.md`, excluding directories only). Anything else is
  a pre-existing red the narrowed gate used to hide. It is not the release's
  fault, but it is the release's problem: tag over it and the recovery is
  forward-only. Note `security` runs `pnpm audit` against
  the network, so a newly-published advisory can turn a release red on its own.
  The roll-back in step 9 leaves the tree clean; the user fixes and re-invokes.
- **An `## [Unreleased]` section is present.** It is folded into the new release
  section, never kept beside it (steps 7 and 8). Where its bullets and the commit
  range disagree — a bullet describing work that was later reverted, say — the
  commits win; say what you dropped when you print the draft.
- **A commit reads `BREAKING` but the user asked for `patch`/`minor`.** Surface it
  and ask whether they meant `major` before applying step 8.

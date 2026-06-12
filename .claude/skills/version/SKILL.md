---
name: version
description: Bump checkride's version (major, minor, or patch), summarize every commit since the last release into a new CHANGELOG.md section, commit as vX.Y.Z, and create plus push an annotated tag. checkride is a single package, so the root package.json version is the source of truth.
argument-hint: "[major|minor|patch]"
disable-model-invocation: true
allowed-tools: Read, Edit, Glob, Bash(git status*), Bash(git log*), Bash(git describe*), Bash(git rev-list*), Bash(git add *), Bash(git commit *), Bash(git tag *), Bash(git push origin v*), Bash(git restore *), Bash(node -e *), Bash(node -p *), Bash(pnpm check*), Bash(cat *)
---

# version

Bump checkride's version, prepend a `CHANGELOG.md` section summarizing every
commit since the last release, commit, and tag. checkride is one package: the
root `package.json` `version` is the source of truth, the changelog lives at
`CHANGELOG.md`, and releases are tagged `vX.Y.Z`.

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

   **Print the drafted section back to the user** as a fenced `markdown` block,
   verbatim, before editing any file — their one chance to read the prose in
   isolation. Continue automatically after printing; do not wait.

8. **Apply the changes** (two files only):

   - `package.json`: edit `"version": "OLD"` to `"version": "NEW"`.
   - `CHANGELOG.md`: insert the new section immediately below the intro
     paragraph and above the current top `## [...]` section, keeping the single
     `# Changelog` heading at the very top. Then add a link reference for the new
     version directly above the existing top one at the bottom of the file:
     `[X.Y.Z]: https://www.npmjs.com/package/checkride/v/X.Y.Z`.

9. **Verify before staging:** `pnpm check --only docs,links,spell --bail`. A
   version-plus-changelog diff can only fail those three. If it exits 0,
   continue. If it fails (commonly a word missing from `cspell.json`), roll back
   so the user can fix and re-invoke — `git restore package.json CHANGELOG.md` —
   show the relevant `.check/*.txt` diagnostic, and stop.

10. **Stage exactly those two files and commit.** The commit message is literally
    the tag, no body:

    ```bash
    git add package.json CHANGELOG.md
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
- **`pnpm check` fails in step 9.** Almost always a new changelog word missing
  from `cspell.json`'s `words`. The roll-back in step 9 leaves the tree clean; the
  user adds the word and re-invokes.
- **A commit reads `BREAKING` but the user asked for `patch`/`minor`.** Surface it
  and ask whether they meant `major` before applying step 8.

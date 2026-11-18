# Local targets

A web app in `web/` and an API in `services/api/`, owned by two teams. The
root `checkride.config.json` names the two roots and nothing else:

```json
{
  "targets": {
    "web": { "root": "web", "local": true },
    "api": { "root": "services/api", "local": true }
  },
  "unclaimed": { "ignore": ["package.json"] }
}
```

`"local": true` hands the rest of each target to the config file at its
root, which that team edits without touching the root file:

- [`web/checkride.config.json`](./web/checkride.config.json) says `lang: ts`,
  picks tsc, sets a timeout for web's checks, and adds `web:greeting`, a check
  only the web team runs.
- [`services/api/checkride.config.json`](./services/api/checkride.config.json)
  says `lang: go`, picks golangci-lint, and adds `api:vet`.

```bash
pnpm install
pnpm check
```

The run is one run: one summary, one exit code. `web:types` and
`web:greeting` run from `web/`; `api:types`, `api:lint`, `api:test` and
`api:vet` run from `services/api/`; and `links` and `unclaimed` run once for
the repo. `pnpm check --only web` runs the web team's checks alone, and no Go
tool starts.

A local file holds its target's `lang`, `checks`, `include`, `exclude`,
`timeout` and `extends`. A key that belongs to the whole repo, such as
`requirePins` or `schemas`, is exit 2 naming the file, and so is a key in the
root entry beside `"local": true`.

A baseline follows the same split. Each team's grandfathered findings sit in
`web/checkride.baseline.json` and `services/api/checkride.baseline.json`, and
the root `checkride.baseline.json` holds the keys of the repo-scope checks. A
full run prunes each file on its own, so a finding fixed in `web/` changes
`web/`'s file and no other. This example is clean, so it has none of the
three.

The root `package.json` installs tsc and links checkride from this repo, so
`unclaimed.ignore` lists it.

[`.github/workflows/check.yaml`](./.github/workflows/check.yaml) is the
workflow a team would run over this repo: one required check, `--changed` on
each push and the full run in the merge queue, and the baseline guard as a job
of its own. [checkride on a team](https://github.com/robmclarty/checkride/blob/main/docs/team.md) walks it. GitHub reads
workflows from a repo's root only, so here it's an example and never runs.

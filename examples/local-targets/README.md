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

The root `package.json` installs tsc and links checkride from this repo, so
`unclaimed.ignore` lists it.

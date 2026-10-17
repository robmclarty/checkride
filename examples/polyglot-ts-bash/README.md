# polyglot-ts-bash

A TypeScript app and the shell scripts beside it, checked as two **targets**:
each part of the repo is checked from its own root by the pack that knows its
language.

```json
{
  "targets": {
    "web": { "lang": "ts", "root": "web" },
    "scripts": { "lang": "bash", "root": "scripts" }
  },
  "unclaimed": { "ignore": ["package.json"] }
}
```

- `web:types` runs `tsc --build` from `web/`, the ts pack's `types` slot,
  detected by `web/tsconfig.json`. Every other slot of `web` stands down,
  because nothing configures its tool.
- `scripts:lint` runs shellcheck from `scripts/` over the target's file list:
  every `.sh` and `.bash` file and each extensionless file with a shell
  shebang, so `deploy.sh` and `release` both. `scripts/.shellcheckrc` is what
  turns the slot on; shellcheck itself comes from `PATH`, and the summary
  records `pin_source: "path"` for it. Pin it with `mise use shellcheck` and it
  records `mise`.
- `unclaimed` fails when a toolchain marker, a `package.json` here, sits
  outside every target that could check it. The root `package.json` only
  installs the tools, and two ts targets can't nest, so the config lists it in
  `unclaimed.ignore`.

Each check of a target writes under `.check/<target>/`: shellcheck's report is
`.check/scripts/lint.json`.

## Run it

```bash
pnpm install
pnpm check
```

shellcheck has to be on `PATH`.

## What breaks it

`expected.json` plants three violations, and the end-to-end suite asserts each
one fails the check it should:

| Violation | Fails |
| --- | --- |
| `echo $target` instead of `"$target"` in `scripts/deploy.sh` (SC2086) | `scripts:lint` |
| A string where `web/src/app.ts` declares a number | `web:types` |
| A new `tools/x/package.json` | `unclaimed` |

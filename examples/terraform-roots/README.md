# Example: Terraform roots on the terraform pack

Two Terraform root modules, `envs/staging` and `envs/production`, and the
shared child modules they call, under `modules/`, checked as three terraform
targets. There's no `package.json` here and no `.tf` file at the root, so
the targets in `checkride.config.json` say what to check:

```json
{
  "targets": {
    "staging": { "lang": "terraform", "root": "envs/staging" },
    "production": { "lang": "terraform", "root": "envs/production" },
    "modules": { "lang": "terraform", "root": "modules" }
  },
  "packs": {
    "terraform": { "checks": { "format": "terraform-fmt" } }
  }
}
```

## Run it

You need `tofu` (OpenTofu 1.13.1, the release `.opentofu-version` names) and
`tflint` on your `PATH`; `mise install` at the repo root installs the versions
this repo pins. Build checkride once from the repo root, since the example
runs the working tree rather than a published release:

```bash
pnpm install && pnpm build
```

Then install each root module's providers, which is the one step that needs
the network, and check it:

```bash
cd examples/terraform-roots
tofu -chdir=envs/staging init -backend=false
tofu -chdir=envs/production init -backend=false
node ../../dist/cli.js
```

It exits **0**:

```text
○ modules:types        skip  no .terraform.lock.hcl marks a root module here
✔ staging:format       terraform fmt: Terraform formatting  [config]
✔ production:format    terraform fmt: Terraform formatting  [config]
✔ modules:format       terraform fmt: Terraform formatting  [config]
✔ staging:types        terraform validate: Terraform configuration  [detected: .terraform.lock.hcl]
✔ production:types     terraform validate: Terraform configuration  [detected: .terraform.lock.hcl]
✔ staging:lint         tflint: Terraform lint  [detected: .tflint.hcl]
✔ links                Relative markdown link targets exist on disk  [built-in]
✔ unclaimed            Every toolchain marker sits inside a target that checks it  [built-in]
✔ production:lint      tflint: Terraform lint  [detected: .tflint.hcl]
✔ modules:lint         tflint: Terraform lint  [detected: .tflint.hcl]
```

## 1. A lock file marks a root module

`terraform validate` needs the providers and modules `init` installs, so it
checks a root module and nothing else. Each `envs/` directory commits the
`.terraform.lock.hcl` its `init` wrote, which pins the `hashicorp/random`
provider it uses and marks it as a root, so `validate` fills its `types`
slot. The `modules` target has no lock file, so its `types` slot stands down
with that reason rather than fail on modules that are only ever called.

Skip `init` and each root's `types` check fails before anything runs, naming
`tofu init -backend=false`. A check never runs `init` itself, since `init`
downloads providers, and `-backend=false` installs them without touching any
state backend.

## 2. One version file pins the CLI for every target

`.opentofu-version` at the repo root names OpenTofu 1.13.1. Every target
finds it by walking up from its own root, so each `terraform` check runs
`tofu`, and checkride asks the `tofu` on `PATH` for its version before the
check runs. A different release fails the check, naming both, rather than
run a copy the repo didn't ask for, and the summary records
`pin_source: "tf-version"` with the release.

## 3. The packs block applies to every target

`format` is opt-in, so naming it in `packs.terraform.checks` turns
`terraform fmt` on for all three targets at once. tflint needs no opting in:
each target's `.tflint.hcl` detects it, and enables the terraform ruleset that
ships inside tflint.

## Prove each check bites

`expected.json` plants one violation per check, and the examples suite runs
each: an unformatted line fails `staging:format`, a variable nothing reads
fails `modules:lint`, a reference to a resource that isn't declared fails
`production:types`, and a directory of `.tf` files outside every target fails
`unclaimed`, which suggests the target that would check it.

## See also

- [Packs and pins: the terraform pack](https://github.com/robmclarty/checkride/blob/main/docs/packs.md#the-terraform-pack)
- [Targets](https://github.com/robmclarty/checkride/blob/main/docs/targets.md)

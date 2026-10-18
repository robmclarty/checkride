/**
 * The terraform pack: Terraform and OpenTofu configurations, checked from a
 * root module's directory (R5.8).
 *
 * A `.terraform-version` or `.opentofu-version` at or above a target's root
 * declares the CLI, `terraform` or `tofu`, and the version it must be, which
 * a check confirms before it runs (R6.1). Otherwise the CLI resolves through
 * a `mise.toml` pin, then `PATH`, and a `mise.toml` that pins OpenTofu makes
 * it `tofu`. tflint and trivy resolve through a `mise.toml` pin, then `PATH`.
 * Every check of the pack, a target's custom checks included, runs
 * without prompts or calls home (R6.4): `CHECKPOINT_DISABLE` stops
 * Terraform's version check, `TF_IN_AUTOMATION` and `TF_INPUT=0` keep its
 * output plain and never ask for input, the two `*ENV_AUTO_INSTALL` variables
 * stop tfenv and tofuenv downloading a CLI, and `TRIVY_SKIP_CHECK_UPDATE`
 * keeps trivy on the checks it ships with.
 *
 * `terraform validate` reads the providers and modules `terraform init`
 * installs under `.terraform/`, so it checks only a root module, which its
 * `.terraform.lock.hcl` marks, and fails naming `init -backend=false`, which
 * touches no backend, where that directory is missing. Each row was run
 * against OpenTofu 1.13.1, tflint 0.64.0 and trivy 0.76.0.
 */

import type { Pack } from './types.js';

/** The file that marks a root module, the directory `terraform init` runs in. */
const LOCK_FILE = '.terraform.lock.hcl';

export const TERRAFORM_PACK: Pack = {
  name: 'terraform',
  markers: [LOCK_FILE, '*.tf'],
  pins: ['tf-version', 'mise', 'path'],
  env: {
    CHECKPOINT_DISABLE: '1',
    TF_IN_AUTOMATION: '1',
    TF_INPUT: '0',
    TFENV_AUTO_INSTALL: 'false',
    TOFUENV_AUTO_INSTALL: 'false',
    TRIVY_SKIP_CHECK_UPDATE: 'true',
  },
  adapters: [
    {
      name: 'terraform-fmt',
      slot: 'format',
      description: 'terraform fmt: Terraform formatting',
      detect: [],
      command: 'terraform',
      // `-check` lists each file that would change, with `-diff` its diff, and
      // exits 3 when any would. `-recursive` passes over hidden directories,
      // `.terraform/` among them.
      args: ['fmt', '-check', '-recursive', '-diff'],
      outputFile: null,
      fixArgs: ['fmt', '-recursive'],
      static: true,
      devDeps: {},
    },
    {
      name: 'tflint',
      slot: 'lint',
      description: 'tflint: Terraform lint',
      detect: ['.tflint.hcl'],
      detectPin: 'tflint',
      command: 'pnpm',
      // Exits 2 when an issue is at or above `--minimum-failure-severity`,
      // which by default fails every issue, a notice included, and 1 when
      // tflint itself fails, as where a plugin `tflint --init` installs is
      // missing. `--recursive` lints each directory under the root, hidden
      // ones aside.
      args: ['exec', 'tflint', '--recursive', '--format=json'],
      outputFile: 'lint.json',
      static: true,
      // A plugin other than the bundled terraform ruleset is a binary that
      // `tflint --init` downloads and tflint runs.
      codeKeys: [{ file: '.tflint.hcl', keys: ['plugin'], value: '^(?!terraform$)' }],
      devDeps: {},
    },
    {
      name: 'terraform-validate',
      slot: 'types',
      description: 'terraform validate: Terraform configuration',
      detect: [LOCK_FILE],
      onlyWith: { file: LOCK_FILE, skip: `no ${LOCK_FILE} marks a root module here` },
      // Without `.terraform/`, validate reports each provider and module as
      // missing and names a bare `init`, which would reach for the backend.
      setup: { dir: '.terraform', args: ['init', '-backend=false'], variable: 'TF_DATA_DIR' },
      command: 'terraform',
      // `-json` prints one object, its `diagnostics` the errors and warnings;
      // an error exits 1.
      args: ['validate', '-json'],
      outputFile: 'types.json',
      devDeps: {},
    },
    {
      name: 'trivy-config',
      slot: 'security',
      description: 'trivy config: Terraform misconfigurations',
      detect: [],
      detectPin: 'trivy',
      command: 'pnpm',
      // `--exit-code 1` fails on a misconfiguration at any severity, and the
      // default exits 0 whatever it finds. A cache directory under the
      // check's own, which trivy never writes for a config scan, keeps it on
      // the checks it ships with: a checks bundle a past scan cached would
      // otherwise stand in for them, so one machine's findings would differ
      // from another's.
      args: ['exec', 'trivy', 'config', '--format', 'json', '--exit-code', '1', '--skip-check-update', '--cache-dir', '{out}/trivy-cache', '.'],
      outputFile: 'security.json',
      static: true,
      devDeps: {},
    },
  ],
};

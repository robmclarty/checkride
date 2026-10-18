/**
 * The terraform pack: Terraform and OpenTofu configurations, checked from a
 * root module's directory.
 *
 * A `.terraform-version` or `.opentofu-version` at or above a target's root
 * declares the CLI, `terraform` or `tofu`, and the version it must be, which
 * a check confirms before it runs (R6.1). Otherwise the CLI resolves through
 * a `mise.toml` pin, then `PATH`, and a `mise.toml` that pins OpenTofu makes
 * it `tofu`. Every check of the pack, a target's custom checks included, runs
 * without prompts or calls home (R6.4): `CHECKPOINT_DISABLE` stops
 * Terraform's version check, `TF_IN_AUTOMATION` and `TF_INPUT=0` keep its
 * output plain and never ask for input, the two `*ENV_AUTO_INSTALL` variables
 * stop tfenv and tofuenv downloading a CLI, and `TRIVY_SKIP_CHECK_UPDATE`
 * keeps trivy on the checks it ships with.
 */

import type { Pack } from './types.js';

export const TERRAFORM_PACK: Pack = {
  name: 'terraform',
  markers: ['.terraform.lock.hcl', '*.tf'],
  pins: ['tf-version', 'mise', 'path'],
  env: {
    CHECKPOINT_DISABLE: '1',
    TF_IN_AUTOMATION: '1',
    TF_INPUT: '0',
    TFENV_AUTO_INSTALL: 'false',
    TOFUENV_AUTO_INSTALL: 'false',
    TRIVY_SKIP_CHECK_UPDATE: 'true',
  },
  adapters: [],
};

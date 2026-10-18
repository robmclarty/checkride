# tflint: `lint` reads this file. The terraform ruleset ships inside tflint,
# so it runs with no `tflint --init`. A plugin block for another ruleset, such
# as tflint-ruleset-aws, needs `tflint --init` before a check runs, and it is
# code tflint runs, so `--static-only` skips `lint` once one is added.
plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

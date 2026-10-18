# tflint: each target's `lint` reads the .tflint.hcl at its root. The
# terraform ruleset ships inside tflint, so no `tflint --init` is needed.
plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

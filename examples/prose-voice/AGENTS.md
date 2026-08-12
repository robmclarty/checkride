<!-- checkride:begin hash=v1b02b8bf37c8d2274 -->

## Checkride: the definition of done

`pnpm check` is the single source of truth for "done". Exit 0 means the work is
complete; any other exit code means it is not. Never claim a task is finished while
`pnpm check` is red.

When it fails:

1. Read `.check/summary.json` to see which check failed.
2. Read that check's raw output (`.check/<slot>.json` or `.check/<slot>.stdout.txt`).
3. Fix the root cause, then re-run.

`pnpm exec checkride triage` runs this procedure in full and reads `.check/` for you
(`/checkride:check` and `/checkride-check` are the same thing as a skill).

Tight feedback loops: `pnpm check --bail`, `pnpm check --only types,lint`, and
`pnpm check --changed`.

If a stop-gate hook is configured (`.claude/settings.json` or `.cursor/hooks.json`),
it runs the check when a turn ends — so while iterating, prefer the narrow commands
above rather than running the full check yourself every loop. Read the gate's verdict
rather than assuming it covered everything: a repo can narrow the gate with `gate` in
`checkride.config.json`, and a narrowed one prints `NOT the full check` in every
verdict. That green is not the "done" defined above; run `pnpm check` in full before you
claim the work is finished.

### Baseline

If `checkride.baseline.json` is present, checkride grandfathers the diagnostics it
lists: a slot is green as long as only baselined findings remain, while a genuinely
new diagnostic still fails it. Fixing a baselined finding prunes it from the file —
the ratchet, so the baseline only ever shrinks. Never add to the baseline to make a
check pass; fix the finding.

### Prose voice

Before writing or editing prose (markdown, doc comments), read the exemplars in
`docs/voice` and imitate their voice — sentence rhythm, word choice, register.
They are hand-written and human-owned: never edit, rewrite, or add to them, and
never generate new ones. When your draft and an exemplar disagree about how a
sentence should sound, the exemplar wins.

Active checks in this repo: links, prose.

<!-- checkride:end -->

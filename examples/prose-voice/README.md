# Example: the `prose` slot — house style, drift control, a voice to imitate

The `prose` slot gates writing the way `lint` gates code: vale runs a house
style this repo owns, across markdown **and TypeScript doc comments**, and the
baseline grandfathers the legacy doc that predates the gate. This example is
green *while carrying eight prose findings* — and goes red the moment one new
sentence drifts.

## Run it

From the repo root, build checkride once (the example links to the working
tree, not to a published release):

```bash
pnpm install && pnpm build
```

Then:

```bash
cd examples/prose-voice
pnpm install
pnpm check
```

It exits **0**, reporting `8 baselined (grandfathered)` on the `prose` slot.

Two pieces of setup are worth noticing before anything runs:

- [`pnpm-workspace.yaml`](./pnpm-workspace.yaml) approves `@vvago/vale`'s
  `postinstall` build — the package downloads its Go binary there, and pnpm
  blocks that until it is allowed. Without the stanza the install "succeeds"
  and leaves no runnable `vale`.
- [`.vale.ini`](./.vale.ini) and [`.vale/styles/Repo/`](./.vale/styles/Repo/)
  are what `checkride init --add prose` scaffolds: six plain-YAML rules the
  repo owns outright. No download, no `vale sync`, no upstream to track.

## The debt

[`docs/history.md`](./docs/history.md) is the legacy page, written in the full
model dialect. Its eight findings live in
[`checkride.baseline.json`](./checkride.baseline.json), fingerprinted as
`file:rule:message` exactly like `lint` findings:

| Rule | What it caught |
| ---- | -------------- |
| `Repo.Drift` × 4 | `In today's`, `ever-evolving`, `seamless`, and the stock `It's not just X — it's Y` frame — the lexical fingerprints of generated prose |
| `Repo.Minted` × 2 | `leveraged`, `learnings` — the corporate dialect, swapped back to plain English |
| `Repo.Latin` | `e.g.` for `for example` |
| `Repo.ThereIs` | a sentence-initial `There is`, postponing its subject |

## What turns the run red

Each of these is a `violations` entry in [`expected.json`](./expected.json),
so the end-to-end suite applies it, asserts the exit code *and which vale rule
fired*, and reverts it. Try one by hand:

```bash
printf '# Launch notes\n\nWe delve into the tapestry of quota management.\n' > docs/launch.md
pnpm check   # exit 1: Repo.Drift, twice, in a file the baseline has never seen
rm docs/launch.md
```

The second violation edits a **doc comment in
[`src/quota.ts`](./src/quota.ts)** instead of markdown. Vale has no TypeScript
format of its own; the scaffolded `[formats] ts = js` mapping lints comments
while leaving code and string literals alone — so `There is a check that runs
here, i.e. the quota math.` fails the gate from inside a `/** ... */` block,
on `Repo.ThereIs` and `Repo.Latin` at once.

The third is pure mechanics: `newly-created` (an `-ly` adverb takes no hyphen)
and a doubled `the the` (`Vale.Repetition`, from vale's built-in style).

And the ratchet works here exactly as it does for `lint`: delete the
`There is a dashboard that tracks adoption.` line from `docs/history.md`, run
`pnpm check`, and the baseline is pruned to seven — debt only ever shrinks.

## The voice anchor

Rules catch the *lexical* half of style drift. The voice itself — rhythm,
register, the sound of a sentence — has no mechanical check, so the config
names a directory of hand-written samples instead:

```jsonc
"prose": { "use": "vale", "exemplars": "docs/voice" }
```

That one key does two things:

- [`AGENTS.md`](./AGENTS.md) (written by `checkride init`) carries a **Prose
  voice** section telling writing sessions to read
  [`docs/voice/`](./docs/voice/) and imitate it — and never to edit, rewrite,
  or add to it. A generated "improvement" to an exemplar would replace the
  human original with a copy of the model's own register, which is the drift
  the directory exists to prevent.
- The check **fails when the directory is missing or empty**. Try it:
  `mv docs/voice docs/voices && pnpm check` exits 1 and names the path, because
  a config pointing the imitate-this instruction at nothing should not stay
  green. (`mv` it back after.)

Checkride never scores prose against the exemplars — no model judges voice at
the gate. Presence is checked; imitation is prompted; judgment stays with a
human reading the words.

## Scoping, and why this README is exempt

Vale reads no `.gitignore`, so the config swaps the shipped trailing `.` for
an explicit path list — `docs` and `src` — the same move a real repo makes to
keep it out of `dist/` and tool caches. This README sits outside that list on
purpose: it quotes the drift tells while documenting them, and a doc about the
drift rules cannot survive the drift rules. The paths are the only scoping
mechanism the slot has, and this is the honest edge of that design.

The `spell` slot is a deliberate absence here, not an oversight: vale ships
with `Vale.Spelling = NO` in the scaffolded config because cspell owns
spelling. One wordlist, one owner per question — see
[the tools guide](https://github.com/robmclarty/checkride/blob/main/docs/tools.md#the-prose-slot-writing-style)
for the full division of labour.

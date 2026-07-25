# Example: the agent loop

**This repo is red on purpose.** That is the whole demonstration: it shows what
a coding agent actually reads when `check` fails, and what stops it from
declaring victory anyway.

Everything here was produced by checkride itself — `AGENTS.md` and
`.claude/settings.json` are verbatim `checkride agent-setup` output, not
hand-written prose about what it might write.

## Run it

From the repo root, build checkride once (the example links to the working tree,
not to a published release):

```bash
pnpm install && pnpm build
```

Then:

```bash
cd examples/agent-loop
pnpm install
pnpm check
```

It exits **1**. That is a pass for this example — see `expected.json`, which the
end-to-end suite asserts against so this README cannot quietly stop being true.

## What is broken

One function in [`src/checkout.ts`](./src/checkout.ts), with two independent
defects — the shape of half-finished work:

```ts
export function totalCents(items: readonly LineItem[], destination: string): number {
  const taxCents = Math.round(subtotalCents(items) * 0.05);

  return subtotalCents(items) + shippingCents(destination);
}
```

- `taxCents` is computed and never used — caught by the `lint` slot (oxlint)
- `shippingCents` is never defined — caught by the `types` slot (tsc)

A tax calculation started and never wired in, and a helper called but never
written: neither is exotic, and neither announces itself.

Fix either one alone and the pipeline stays red. The exit code is a verdict on
the job, not on the last edit, which is precisely the property that makes it
usable as a stopping rule.

## What the agent reads

Three artifacts, in widening order of cost.

**The exit code** answers "am I done?" — and nothing else. It is the only signal
that needs no parsing.

**`.check/digest.md`** (written because the check script passes `--digest`) is a
token-bounded index of just the failures:

```text
## types — tsc

Raw: `.check/types.stdout.txt`

src/checkout.ts(19,33): error TS2304: Cannot find name 'shippingCents'.

## lint — oxlint

Raw: `.check/lint.json` — 1 finding(s)

- src/checkout.ts:eslint(no-unused-vars):Variable 'taxCents' is declared but never used.
```

It truncates — 10 findings per slot, 8 KB total — and it never normalizes. Each
section points back at the raw file rather than replacing it, so a fully-red
repo costs roughly two thousand tokens to triage instead of an unbounded dump.

**`.check/summary.json`** is the machine-readable verdict: one entry per slot,
each with `ok`, `exit_code`, and the `output_file` holding that tool's own raw
JSON. Note the five skipped slots — `struct`, `dead`, `test`, `docs`, `spell`
stood down because this example installs no tool for them. Skipped counts as
`ok`, but `checks_run` is `3`, which is how a gate tells a real green from a
vacuous one.

## What stops the agent

[`.claude/settings.json`](./.claude/settings.json) holds a Claude Code **Stop
hook**:

```json
"command": "pnpm run check || { echo 'checkride: the gate is red ...' >&2; exit 2; }"
```

Exit 2 from a Stop hook blocks the agent from ending its turn and feeds the
message back to it. So the loop closes without depending on the agent's
judgment: it cannot decide it is finished while the pipeline disagrees.

`AGENTS.md` carries the same contract in prose, for agents that read
instructions but do not run hooks.

## Make it green

Write the missing helper, and use the tax that was already computed:

```ts
function shippingCents(destination: string): number {
  return destination === 'CA' ? 0 : 1500;
}

export function totalCents(items: readonly LineItem[], destination: string): number {
  const taxCents = Math.round(subtotalCents(items) * 0.05);

  return subtotalCents(items) + taxCents + shippingCents(destination);
}
```

`pnpm check` now exits 0, and `.check/digest.md` is deleted — the file's
presence always means "this run had failures", so a stale one can never mislead
the next reader.

## See also

- [Getting started](https://github.com/robmclarty/checkride/blob/main/docs/getting-started.md)
- [The `.check/` contract](https://github.com/robmclarty/checkride/blob/main/docs/contract.md)

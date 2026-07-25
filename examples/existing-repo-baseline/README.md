# Example: adopting checkride on a repo that already has debt

A repo with existing findings can adopt checkride without a cleanup project
first. The **baseline** grandfathers what is broken *today* so day-one runs
pass, while anything new still fails — "don't make it worse" as the definition
of done for legacy code.

This example is green, and it is green *while still containing three lint
findings*. That is the mechanism, not a loophole.

## Run it

From the repo root, build checkride once (the example links to the working tree,
not to a published release):

```bash
pnpm install && pnpm build
```

Then:

```bash
cd examples/existing-repo-baseline
pnpm install
pnpm check
```

It exits **0**, reporting `3 baselined (grandfathered)` on the `lint` slot.

## The debt

Three abandoned variables, deliberately spread across two files:

| File | Finding |
| ---- | ------- |
| [`src/legacy-report.ts`](./src/legacy-report.ts) | `legacyPadding` is never used |
| [`src/legacy-report.ts`](./src/legacy-report.ts) | `staleTimestampFormat` is never used |
| [`src/legacy-parse.ts`](./src/legacy-parse.ts) | `legacyLocale` is never used |

[`checkride.baseline.json`](./checkride.baseline.json) records them — and it is
**committed**, which is what makes it work at all:

```json
{
  "schema_version": 1,
  "slots": {
    "lint": [
      "src/legacy-parse.ts:eslint(no-unused-vars):Variable 'legacyLocale' is declared but never used. ...",
      "src/legacy-report.ts:eslint(no-unused-vars):Variable 'legacyPadding' is declared but never used. ...",
      "src/legacy-report.ts:eslint(no-unused-vars):Variable 'staleTimestampFormat' is declared but never used. ..."
    ]
  }
}
```

Each entry is a **fingerprint** — `file:rule:message`, with no line or column —
so a finding keeps its identity when unrelated edits push it up or down the
file. Only the finding's own text matters, which is why the two findings in
`legacy-report.ts` are distinct entries: the variable name is part of the
message.

## Prove the three properties

Each of these is asserted by the end-to-end suite, so they cannot silently stop
being true.

### 1. A new finding fails, and only the new one is listed

Add a file with a fresh violation:

```bash
printf 'export function summarize(rows: readonly string[]): number {\n  const pendingRewrite = true;\n  return rows.length;\n}\n' > src/new-feature.ts
pnpm check
```

Exit 1, and the report separates the two populations:

```text
✘ lint    Oxlint with tsgolint type-aware rules
     3 baselined (grandfathered)
     1 new, not in baseline:
       src/new-feature.ts:eslint(no-unused-vars):Variable 'pendingRewrite' is declared ...
```

The failing check also carries `"baselined": 3` in `.check/summary.json`, and
`.check/lint.json` still holds *all four* findings — the baseline changes the
verdict, never the raw output.

Delete `src/new-feature.ts` to get back to green.

### 2. Fixing debt ratchets the baseline down

Delete the unused `legacyPadding` line from `src/legacy-report.ts`, then run
`pnpm check`:

```text
baseline: ratcheted checkride.baseline.json to 2 grandfathered diagnostic(s)
```

The fixed entry is pruned from the committed file. Debt cannot creep back in
under cover of an entry that was already spent — the baseline only ever shrinks.

(Restore the line and run `pnpm exec checkride baseline` to put the example
back.)

### 3. A partial run never prunes

`--only`, `--skip`, `--changed`, and a `--bail` that stops early all leave the
baseline untouched. A run that didn't observe a finding can't tell "fixed" from
"not looked at", so it declines to guess.

## One honest caveat

Because a fingerprint is `file:rule:message` with no position, **two identical
findings in the same file share one key**. A second unused variable in
`src/legacy-parse.ts` also named `legacyLocale` — in a different function —
produces a key that is already baselined, so it passes.

That is the deliberate trade for line-independence: the baseline is a ratchet
against *new kinds* of debt per file, not a counter. Slots participate only when
their tool has a fingerprint extractor — currently `lint` (oxlint), `struct`
(ast-grep), `spell` (cspell), and the fallow slots `dead`/`dupes`/`health`.
`types` and `test` never appear in a baseline, so they are all-or-nothing.

## Adopting this way yourself

On a real repo, let `init` do it in one step:

```bash
pnpm add -D -E checkride
pnpm exec checkride init --baseline
```

Without `--baseline`, a failing slot is written off as **disabled** — blunt, and
easy to forget. With it, the slot stays **enabled** and its current findings are
grandfathered, so the debt stays visible and shrinking. A failing slot whose
tool has no extractor still falls back to a disable.

Never add to a baseline to make a check pass. Re-running `checkride baseline`
re-records *everything* currently failing, including debt you would rather fix,
so treat it as a reviewed change and read the diff in the pull request.

## See also

- [Baseline reference](https://github.com/robmclarty/checkride/blob/main/README.md#baseline)
- [Getting started](https://github.com/robmclarty/checkride/blob/main/docs/getting-started.md)

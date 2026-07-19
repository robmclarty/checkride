# Ordering waves in practice — a worked example

[The contract](./contract.md#check-ordering-and-concurrency) defines *what*
`order` promises. This doc shows what those promises *buy* on a real repository:
the ordering surface added in 0.5 is not just a scheduling detail, it is a set of
knobs that make a gate faster to read and cheaper to run. The evidence below is a
set of back-to-back measurements on a real TypeScript project (plumbbob, a sibling
of checkride) — nothing synthetic.

## The starting point: an invisible schedule

With `order` omitted, every active slot resolves to `'any'` — one undifferentiated
group fed through the bounded pool (a conservative cap derived from the CPU count;
`min(4, cores − 1)`, so **4 lanes** on an 8-core machine). The run is correct, but
the *schedule is emergent*: which checks actually run together, and in what tiers,
falls out of catalogue order and pool width and is written down nowhere. A reviewer
reading `checkride.config.json` learns the tool list — not the execution plan.

Here is that repo's gate, measured straight from `.check/summary.json` on a run
where nothing had an `order`:

| slot     | adapter             | duration | character                          |
| -------- | ------------------- | -------- | ---------------------------------- |
| `test`   | vitest              | 48,078ms | dominates; saturates every core    |
| `types`  | tsc                 | 1,493ms  | single-threaded                    |
| `docs`   | markdownlint-cli2   | 1,225ms  | light                              |
| `dead`   | fallow              | 467ms    | fast; parallelizes internally      |
| `struct` | ast-grep            | 369ms    | fast                               |
| `lint`   | oxlint              | 368ms    | fast                               |
| `links`  | built-in            | 14ms     | trivial                            |

Two facts jump out. `test` is ~99% of the wall clock **and** it saturates every
core. Everything else is cheap and falls into two natural tiers: a sub-500ms band
(`lint`, `struct`, `dead`, `links`) and a ~1–1.5s band (`types`, `docs`). The data
is telling you the shape of the schedule; `order` lets you write it down.

## The three knobs

Waves turn that emergent schedule into three explicit levers:

1. **The wave number** — group checks into tiers with a barrier between tiers, so
   the plan reads top-to-bottom instead of being inferred from pool arithmetic.
2. **`single`** — take a check that wants the whole machine off the shared pool
   entirely, so it never fights lighter checks for cores. (The catalogue already
   does this for `mutation`; a heavy `test` suite has the same appetite.)
3. **Sizing a wave to the pool** — put roughly *pool-width* checks of *similar
   duration* in one wave, so the wave's barrier isn't held open by one straggler
   while the other lanes sit idle.

## The config, made explicit

Applying all three to the repo above — plus the `$schema` pointer, so editors
render the hover-docs for `order` right where you're choosing it:

```json
{
  "$schema": "./node_modules/checkride/schema/checkride.config.schema.json",
  "checks": {
    "lint":   { "use": "oxlint", "order": 1 },
    "struct": { "use": "ast-grep", "order": 1 },
    "dead":   { "use": "fallow", "order": 1 },
    "links":  { "use": "links", "order": 1 },

    "types":  { "use": "tsc", "order": 2 },
    "docs":   { "use": "markdownlint-cli2", "order": 2 },

    "test":   { "use": "vitest", "order": "single" },

    "spell": false
  }
}
```

- **Wave 1** — the four sub-500ms static analyzers, which is exactly the 4-lane
  pool width, so all four run at once with no queueing and no straggler.
- **Wave 2** — the two ~1s checks, paired so neither idles a lane waiting on the
  other.
- **`test`** — `single`, because vitest saturates every core; it runs exclusively
  after the numeric waves, sharing its lane with nothing.

The keys are grouped by wave and the `order` values are right there in the file —
the config now *is* the execution plan.

## What it looks like at runtime

The waves are visible as the run happens. The `▸` markers show a whole wave
launching as a set; the `✔` lines show it draining before the next wave starts:

```text
Running 8 check(s)...

  ○ spell         skip  disabled in checkride.config.json
  ▸ lint     ▸ struct     ▸ dead     ▸ links      ← wave 1 launches as a set
  ✔ links        10ms
  ✔ struct      342ms
  ✔ lint        344ms
  ✔ dead        418ms                             ← barrier: wave 1 fully drains
  ▸ types    ▸ docs                               ← wave 2 launches as a set
  ✔ docs        946ms
  ✔ types      1192ms                             ← barrier
  ▸ test                                          ← runs alone
  ✔ test      39186ms

✔ all checks passed in 40803ms
```

A reviewer who has never seen the config can read the schedule off the terminal.
That legibility is the primary win, and it costs nothing to keep.

## The payoff, measured

**Legibility (the point).** Both the config and the live output now state the plan
outright, instead of leaving it to be reverse-engineered from catalogue order and
`min(4, cores − 1)`.

**An uncontended heavy check (the bonus).** Isolating `test` means vitest gets all
eight cores from the first file instead of sharing startup with `tsc`, `fallow`,
and the rest. Same repo, same commit, back to back:

| run                     | `test`   | total    |
| ----------------------- | -------- | -------- |
| implicit `any`          | 48,078ms | 48,453ms |
| explicit waves          | 39,186ms | 40,803ms |

The honest reading: waves **structurally add** ~1.6s here, because wave 1 + wave 2
(~1.6s of cheap work) now run *before* `test` rather than overlapping its early
phase in spare lanes. That cost is absorbed — and then some — because `test` no
longer competes for cores. vitest wall-time swings run to run, so treat the ~7.6s
delta as *indicative, not guaranteed*; the durable claim is the safe one:
**isolating a core-saturating check does not make the gate slower, and removes a
source of contention that only ever hurt it.**

**Why marking *everything* `single` is worse.** The isolation win and the grouping
win are separable, and setting every slot to `single` — the whole gate run one
check at a time — keeps the first while discarding the second. A third run, every
slot `single`, holds `test`'s isolation constant and varies only whether the cheap
tail is parallelized:

| run            | `test`   | total    | cheap tail (total − `test`)   |
| -------------- | -------- | -------- | ----------------------------- |
| implicit `any` | 48,078ms | 48,453ms | ~375ms — overlaps `test`      |
| all `single`   | 38,861ms | 42,000ms | ~3,140ms — fully sequential   |
| explicit waves | 39,186ms | 40,803ms | ~1,617ms — two parallel waves |

Two readings fall out. First, all-`single` and explicit-waves hand `test` the same
wall time (38.9s vs 39.2s — inside the run-to-run swing), which pins the ~9s `test`
speedup on *isolation alone*, not on the wave structure. Second, waves still beat
all-`single` by ~1.2s total, and that gap *is* the cheap tail — 3.1s serialized
versus 1.6s compressed into two pool-width waves. The two knobs stack: `single`
isolates the heavy check, and grouping recovers the parallelism that marking
everything `single` throws away. All-`single` is still 6.5s ahead of implicit `any`
(isolation dominates), just strictly behind grouping the tail.

**No straggler stalls a barrier.** Because each wave holds checks of similar cost,
no lane finishes in 14ms and then idles for a second waiting on a wavemate — the
sub-500ms checks retire together, and the ~1s checks retire together.

## A second shape: waves that encode a dependency

The run above tiers purely by *duration* — every check is independent, and the
waves exist only to group similar-cost work and isolate the core-hog. checkride's
own gate adds a second reason to wave: some checks *cannot* start until another
has finished, because they read its output.

checkride ships a publish bundle — `build`, then `publint`, `attw`, `pack`,
`smoke`, and `snippets-dist`. `build` compiles `src/` to `dist/`; the other five
all inspect `dist/` — the packed tarball, the built `.d.ts`, the importable
artifact. Putting them in `build`'s wave would race the compiler against its own
consumers, so the dependency *is* the wave boundary:

```json
{
  "build": { "use": "build", "order": 4 },

  "publint": { "use": "publint", "order": 5 },
  "attw": { "use": "attw", "order": 5 },
  "pack": { "use": "pack", "order": 5 },
  "smoke": { "use": "smoke", "order": 5 },
  "snippets": { "use": "snippets-dist", "order": 5 }
}
```

Here the numbers are not a cost tier — an incremental `build` is one of the
*cheapest* checks in the gate. It leads because wave 5 is meaningless without it.
Read this way, `order` documents the data-flow, not just the schedule:
`snippets-dist` sits in the publish wave even though it reads like a docs check,
because it type-checks tagged fences against the *built* `.d.ts` — its input is
`dist/`, so its wave is `dist/`'s.

The two reasons compose. Wave 5 is both a dependency barrier (after `build`) and
a duration tier — short post-build checks sized to the pool. The built-in
catalogue already defaults `build` ahead of the tarball and type-resolution
checks, so the barrier survives even a config that never writes `order`; spelling
it out just makes the data-flow legible, and lets you pin a straggler like
`snippets-dist` into the wave its input actually belongs to.

## The method (apply it to your repo)

1. **Measure first.** Run the gate once and read `duration_ms` for each slot from
   `.check/summary.json`. Order by cost — you are looking for the shape, not
   precise numbers.
2. **Isolate the core-hogs.** Any check that saturates every core (a real test
   suite, `mutation`, a `build`) belongs on `single` — it wants the whole machine,
   and pairing it with anything just slows both.
3. **Tier the rest by duration, sized to the pool.** Group the remaining checks
   into waves of roughly *pool-width* members with *similar* durations, so a wave's
   barrier waits on a genuine ceiling rather than one slow outlier.
4. **Keep it cheapest-first.** Order the waves ascending by cost. Under `--bail`,
   waves are ignored and the run goes fully sequential in catalogue order — so a
   cheapest-first catalogue still surfaces the fast, likely failures first during
   iteration.

## What it does *not* change

Ordering is a scheduling surface, not a verdict surface. The set of checks that
run and their pass/fail results are identical with or without `order`; the
`summary.json` `checks` array stays in the deterministic group sequence regardless
of finish order; and `--bail` still takes the fully sequential fail-fast path.
Waves change *when* checks run relative to each other — nothing about *whether the
work is done*.

See [the contract](./contract.md#check-ordering-and-concurrency) for the normative
definition of every `order` value and the concurrency guarantees referenced above.

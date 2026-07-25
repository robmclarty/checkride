# Example: the same DAL policy, with no custom script

The [`dal-boundaries`](https://github.com/robmclarty/checkride/tree/main/examples/dal-boundaries)
example enforces table ownership with a small Node script, on the grounds that
fallow's zones cannot express it. That is true of zones. It is not true of the
toolchain.

This example enforces the **same policy** — read-only pool for cross-domain
reads, one writer per domain, writers touching only their own tables — using
nothing but `fallow.toml` and three ast-grep rules. No script, no `node_modules`
logic, nothing to unit-test.

It also closes a hole the scripted version has. More on that below.

## Run it

```bash
pnpm install && pnpm build          # from the repo root
cd examples/dal-boundaries-declarative
pnpm install
pnpm check
```

Exits **0**. The source tree is identical to `dal-boundaries`; only the
enforcement differs.

## The idea: two axes, two tools

One fact about fallow drives the whole design: **a file belongs to exactly one
zone.** Zones are a partition, not a set of overlapping labels. So zoning has to
choose an axis, and this policy has two:

- the **domain** axis — `orders`, `customers`, `reports`
- the **role** axis — `writer.ts`, `reader.ts`, `schema.ts`

Zone by role and you can say "only writers hold the write pool", but every
domain's schema shares one `schemas` zone, so `orders/schema.ts` importing
`customers/schema.ts` is an *intra-zone* import and passes. Zone by domain and
you get the opposite: cross-domain imports are caught, but nothing distinguishes
a reader from a writer.

`dal-boundaries` takes the role axis, so it needs a script for the domain half.
This example takes the domain axis in [`fallow.toml`](./fallow.toml) and puts
the role half in [`rules/`](./rules/) — because **ast-grep scopes by file glob
and does not care about zones at all.** The two mechanisms are orthogonal, which
is exactly what makes them compose.

| Rule | Mechanism | Axis |
| --- | --- | --- |
| Only `writer.ts` may import the write pool | ast-grep `only-writers-hold-the-write-pool` | role |
| Nobody else may call `.insert`/`.update`/`.delete` | ast-grep `no-writes-outside-writers` | role |
| A writer imports only its own `./schema.js` | ast-grep `writer-owns-only-its-tables` | role |
| Exactly one writer per domain | falls out of the two rules above | role |
| No domain may reach into another, by any route | fallow zone rules | domain |
| No file may sit outside every zone | fallow `coverage.requireAllFiles` | domain |

## The two techniques worth stealing

### Let the path convention carry the ownership

A writer's own schema is the one it reaches without leaving its directory:

```yaml
files:
  - src/domains/*/writer.ts
rule:
  all:
    - kind: import_statement
    - regex: "from\\s+['\"][^'\"]*schema\\.js['\"]"
    - not:
        regex: "from\\s+['\"]\\./schema\\.js['\"]"
```

`'./schema.js'` is mine; anything else is not. That is the entire ownership
rule, and because it names no domain, it covers every domain — including the
ones added after it was written. It also catches the dodge: a determined
`'../../domains/customers/schema.js'` fails the same regex.

### Write rules as exemptions, not lists

```yaml
files:
  - src/**/*.ts
ignores:
  - src/domains/*/writer.ts
```

The rule applies to *everything* and exempts writers, rather than listing the
files that are forbidden. A file added next Tuesday is covered without anyone
remembering to update a list — the same closed-by-default property
`requireAllFiles` gives the zones.

It also buys the "single writer" rule for free. The exemption names `writer.ts`
exactly, so a `writer-bulk.ts` that imports the write pool trips **both** role
rules. Nothing has to count files.

## The hole this closes

Zoning by role leaves one gap, and it is reachable by accident:

```ts
// orders/schema.ts
export { customers } from '../customers/schema.js';   // intra-zone: allowed

// orders/writer.ts
import { customers, orders } from './schema.js';      // looks entirely legal
```

Now orders' writer writes the customers table, and both files pass a role-zoned
config *and* a path-based ownership check — the writer really does import only
`'./schema.js'`. The laundering happens one file away from where either rule is
looking.

Zoning by domain catches it, because `orders/schema.ts` importing anything under
`customers/` is a cross-zone import:

```text
✘ dead    boundary_violations: 1
```

The end-to-end suite asserts this violation, so the fix is verified rather than
argued.

## Which version should you use?

Both are legitimate. The trade is real:

**Prefer this declarative version when** the rule can be stated in terms of
paths and syntax. There is no code to maintain, no tests to write for the
checker itself, and the policy is data — reviewable in a diff, and shippable in
a [shared preset](https://github.com/robmclarty/checkride/blob/main/docs/presets.md)
alongside the rule files.

**Prefer a custom check when** you need something these cannot see, or when the
message matters more than the mechanism:

- **Better diagnostics.** `orders: 2 writers (writer-bulk.ts, writer.ts) — a
  domain may have only one` explains itself. `no-writes-outside-writers` tells
  you a rule fired, and you infer the rest.
- **Logic that isn't a path or a pattern.** Reading the *table name* out of
  `pgTable('orders', ...)` and checking it against the directory, rather than
  trusting the file layout. Cross-referencing a migrations directory. Anything
  needing state across files.
- **It can be tested.** A checker with edge cases deserves its own tests; a
  regex in a YAML file gets whatever confidence you have in reading it.

In practice: start declarative, and reach for a script when a rule stops fitting
or when a bad message is costing people time. Note that a custom check can also
*co-exist* with these rules — nothing here is exclusive.

## Limits

The same ones as any static analysis, and worth restating because this example
looks airtight and is not:

- A rule keyed on `.insert(` does not see `sql\`INSERT INTO ...\``, a query
  built by string concatenation, or a write issued by a migration script.
- `ignores: [src/domains/*/writer.ts]` is a filename convention. It is enforced
  by `requireAllFiles` on the fallow side, which is why the two halves need each
  other rather than being alternatives.
- Nothing here sees runtime. **The read-only Postgres role remains the
  guarantee**; these rules are the fast feedback loop that keeps violations out
  of the branch in the first place.

## See also

- [`dal-boundaries`](https://github.com/robmclarty/checkride/tree/main/examples/dal-boundaries) — the same policy with a custom ownership check
- [`module-boundaries`](https://github.com/robmclarty/checkride/tree/main/examples/module-boundaries) — the general case for enforcing boundaries without splitting the deployment
- [Conventions](https://github.com/robmclarty/checkride/blob/main/README.md#conventions)

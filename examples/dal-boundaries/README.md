# Example: making a DAL violation a build error

The design: two Postgres roles, and a rule about who may use which.

- A **read-only role** backs a read-only pool. Cross-domain modules — reporting,
  search, anything that needs to join across domains — get this one.
- A **read/write role** backs a write pool. Exactly one module per domain, its
  **single writer**, may use it, and only for its own tables.

Postgres enforces the roles absolutely, at runtime. What it cannot do is tell
you on a Tuesday afternoon that the pull request you are reviewing broke the
rule. This example does that: **every violation below is a red `pnpm check`.**

Each is verified by the end-to-end suite — applied, run, and asserted to fail
for the stated reason — so none of it is a claim about what checkride would
catch.

## Run it

From the repo root, build checkride once:

```bash
pnpm install && pnpm build
```

Then:

```bash
cd examples/dal-boundaries
pnpm install
pnpm check
```

Exits **0**. No database required — the pools use drizzle's `pg-proxy` driver,
because everything enforced here is static.

## The layout

```text
src/
  db/
    read-pool.ts        readDb  — read-only role
    write-pool.ts       writeDb — read/write role
  domains/
    orders/     schema.ts  reader.ts  writer.ts  index.ts
    customers/  schema.ts  reader.ts  writer.ts  index.ts
  reports/
    monthly.ts          cross-domain: reads any schema, writes nothing
  app.ts
```

Two decisions make this enforceable, and both are worth stealing.

**The privilege lives in a module, not a parameter.** `writeDb` is obtained by
importing `src/db/write-pool.ts`. An import is visible to the dependency graph;
a handle threaded through three call frames is not. Putting the privilege behind
an import is what makes "who may write" a question a tool can answer.

**Zones are named by role, not by domain.** `writers`, `readers`, `schemas` —
not `orders`, `customers`. Zones are a fixed list; domains are added constantly.
Zoning by role means a new domain is covered the moment its files match the
naming convention, with no config change and nothing to remember.

## What enforces what

Three mechanisms, deliberately. The interesting part is *why* it takes three.

### fallow zone rules — who may import the write pool

```toml
[[boundaries.rules]]
from = "writers"
allow = ["db-write", "schemas"]

[[boundaries.rules]]
from = "readers"
allow = ["db-read", "schemas"]

[[boundaries.rules]]
from = "reports"
allow = ["db-read", "schemas"]
```

Point a reader at the write pool and:

```text
✘ dead    boundary_violations: 1
```

Note what `reports` gets: every schema, and the read-only pool. "Read anything,
write nothing" is a privilege split expressed in three lines, rather than as a
separate service with its own deployment.

### fallow forbidden calls — writes with no import to catch

The import rule stops a reader from *importing* the write pool. It does nothing
about a writable handle that arrives another way — passed in as a parameter,
pulled off a request context, returned by a factory. The import graph cannot see
those. A call-site rule can:

```toml
[[boundaries.calls.forbidden]]
from = "readers"
callee = ["*.insert", "*.update", "*.delete"]
```

```ts
// in a reader — no import of the write pool anywhere in the file
export async function sneakyWrite(db: { insert: ... }): Promise<void> {
  await db.insert(customers).values({ ... });
}
```

```text
✘ dead    boundary_call_violations: 1
```

This is the one that surprises people. The write is invisible to every
import-based tool, and it still fails the build.

### A custom check — table ownership

Here is the rule the zone system *cannot* express, and it is worth
understanding why rather than working around it.

Zone rules answer "may zone A import zone B?" — a question about two fixed
names. Table ownership is a question about a *relationship*: may
`domains/orders/writer.ts` import `domains/customers/schema.ts`? Both files sit
in zones (`writers`, `schemas`) whose rule already says yes, because a writer
must be able to import *some* schema. Which one is exactly what a zone cannot
see.

So it goes in [twenty lines of path arithmetic](./scripts/check-table-ownership.mjs),
wired as a custom check:

```json
"table-ownership": {
  "command": "node",
  "args": ["scripts/check-table-ownership.mjs"],
  "description": "Each domain has one writer, and it writes only its own tables"
}
```

It enforces both halves of "single writer":

```text
✘ table-ownership
    src/domains/orders/writer.ts imports the customers domain's schema —
    only the customers domain's writer may write those tables
```

```text
✘ table-ownership
    orders: 2 writers (writer-bulk.ts, writer.ts) — a domain may have only one
```

Like the zones, it scales by convention: add a domain folder and it is covered,
with no config to update.

### And one more, free

`boundaries.coverage.requireAllFiles = true` means a file matching no zone is
itself a violation. Without it, the whole policy would only constrain files that
happen to match a pattern, and `src/services/` would be a legal way around all
of it.

## The five violations

| What someone does | Caught by | Finding |
| --- | --- | --- |
| A reader imports the write pool | fallow zones | `boundary_violations` |
| A reader writes via a handle passed in | fallow calls | `boundary_call_violations` |
| Reporting caches its output into a table | fallow calls | `boundary_call_violations` |
| Orders' writer touches customers' tables | custom check | `table-ownership` |
| A second writer appears in one domain | custom check | `table-ownership` |

## Wiring it into CI

Nothing special — that is the point. `pnpm check` is already the gate, so a DAL
violation fails the same build as a type error:

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm check --strict
```

`--strict` matters here: it exits 2 if *zero* checks ran, so a misconfiguration
that quietly disables the pipeline can't read as a pass. For a repo that gates
data-access rules this way, a vacuous green is the failure mode to fear.

For the agent loop, the same rules arrive as `.check/dead.json` and the custom
check's stderr, and the Stop hook refuses to let an agent finish while any of it
is red.

## Adapting it to your DAL

1. **Split the pools into two modules** — `read-pool.ts` and `write-pool.ts` —
   even if they point at the same database today. Everything else depends on
   privilege being an import.
2. **Name files by role**: `writer.ts`, `reader.ts`, `schema.ts` under
   `domains/<name>/`. The zone patterns are globs over these names; the
   convention is what makes new domains free.
3. **Copy [`fallow.toml`](./fallow.toml)'s boundaries block** and rename zones to
   match your tree.
4. **Copy the ownership check** and adjust the two regexes to your import style.
5. Turn on `requireAllFiles` last — it will find the files nobody has thought
   about in a while, which is the point, but you want the rest passing first.

The one thing worth doing before any of it: confirm the read-only role really is
read-only in every environment. The static rules are the fast feedback loop;
the database grant is the guarantee. Keep both.

## Limits

Static analysis sees imports and call sites. It does not see a raw
`sql\`UPDATE ...\`` string, a dynamic import, or a write issued by a migration
script or a psql session. This is precisely why the read-only Postgres role
stays the backstop rather than being replaced by these rules — and why a reader
that legitimately needs `sql` for a read expression is a case to review by hand.

Defense in depth, with the cheap layer running first: the build tells you in
seconds, the database tells you absolutely.

## See also

- [`module-boundaries`](https://github.com/robmclarty/checkride/tree/main/examples/module-boundaries) — the same argument for domain boundaries generally
- [Custom checks](https://github.com/robmclarty/checkride/blob/main/README.md#custom-checks)
- [Running in CI](https://github.com/robmclarty/checkride/blob/main/docs/ci.md)

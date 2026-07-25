# Example: enforcing domain boundaries without splitting the deployment

A common position, and not a silly one: *the only way to really enforce a
boundary is to make it physical — separate services, separate databases.
Anything inside one codebase is a convention, and conventions rot.*

The second half of that is right. Conventions do rot — a convention is a thing
people remember, and eventually one of them is in a hurry. The conclusion is
what this example is about, because "not a convention" and "a separate
deployment" are not the same option. There is a third: **make the boundary a
build error.**

This is one deployable, three domains, four rules. Every rule below is verified
by the end-to-end suite — each violation is applied, run, and asserted to fail
for the stated reason, so nothing here is a claim about what checkride would
catch.

## Run it

From the repo root, build checkride once:

```bash
pnpm install && pnpm build
```

Then:

```bash
cd examples/module-boundaries
pnpm install
pnpm check
```

It exits **0**. The interesting part is what happens when you break it.

## The architecture

```text
src/
  app.ts                 composition root — the only file that sees every domain
  domains/
    billing/    index.ts + invoice.ts
    catalog/    index.ts + product.ts
    identity/   index.ts + customer.ts
  shared/       index.ts + money.ts
```

The rules live in [`fallow.toml`](./fallow.toml) as zones and directed
dependencies:

```toml
[[boundaries.rules]]
from = "billing"
allow = ["catalog", "shared"]

[[boundaries.rules]]
from = "catalog"
allow = ["shared"]
```

Billing may read catalog. Catalog may not read billing. That direction is a
*property of the build* now, not a paragraph in a wiki.

## The four things it enforces

Each of these is a real violation you can reproduce in about ten seconds.

### 1. Dependencies run one direction only

Add an import of billing to `src/domains/catalog/product.ts`:

```text
✘ dead    Fallow: unused code, cycles, and boundary violations
            boundary_violations: 1
            circular_dependencies: 1
```

Caught twice, in fact — the illegal direction, and the cycle it creates.

### 2. Nobody reaches past a public surface

Billing is *allowed* to depend on catalog. It still may not reach inside it.
Change billing's import from `'../catalog/index.js'` to
`'../catalog/product.js'`:

```text
✘ struct  no-deep-sibling-import
            src/domains/billing/invoice.ts
```

This is the rule people assume requires a network boundary. It requires
[nine lines of ast-grep](./rules/no-deep-sibling-import.yml).

Allowed to depend on is not the same as allowed to reach into — a distinction
worth keeping, because it is the one that decides whether catalog can change its
internals next quarter without a coordinated release.

### 3. The shared folder can't become the place domains meet

`shared` is declared a leaf: `allow = []`. Have `shared/money.ts` import a
domain and the build fails.

This one is worth dwelling on, because it is how boundaries usually die in
practice. Nobody proposes coupling billing to catalog. Someone adds a helper to
`shared/` that needs a `Product`, and six months later `shared/` imports every
domain and every domain imports `shared/`. Every step was reasonable. The rule
makes step one impossible.

### 4. There is no escape hatch

The obvious objection to all of the above: *fine, but I'll just put my code
somewhere the rules don't mention.* Add `src/services/rogue.ts` and import it:

```text
✘ dead    boundary_coverage_violations: 1
            src/services/rogue.ts
            Add this file to a boundary zone pattern or move it under an existing zone
```

That is `boundaries.coverage.requireAllFiles`. A file belonging to no zone is
itself the violation, so the policy is closed rather than a list of things that
happen to be mentioned.

## The comparison

| | Modules + checkride | Separate services / DB per domain |
| --- | --- | --- |
| When you find out | build, in seconds | integration, staging, or production |
| What a violation costs | a red CI run | an incident, or silent coupling nobody sees |
| Direction enforced (A→B but not B→A) | yes, declared in one file | no — any service may call any other |
| Internals hidden | yes, at module granularity | yes, at service granularity |
| Unowned code has nowhere to hide | yes, coverage rule | no — new services need new policy |
| Refactoring across the boundary | one atomic commit | versioned API, migration window, two deploys |
| Cost of the mechanism | a config file | network calls, partial failure, eventual consistency, deploy coordination, distributed tracing |

## Where physical separation genuinely wins

Not everything, and pretending otherwise loses the argument:

- **Independent deploy and scale.** If billing needs to ship four times a day
  and catalog once a quarter, or billing needs ten times the memory, that is a
  real operational argument no static rule addresses.
- **Failure and resource isolation.** A memory leak in one module takes the
  process down. In one service it takes that service down.
- **Hard isolation for compliance.** When "this data must be unreachable" has to
  survive an auditor rather than a code reviewer, a separate database with
  separate credentials is a stronger claim than any lint rule.
- **Runtime enforcement of what static analysis can't see.** Reflection, dynamic
  imports, raw SQL strings, a network call to another service's endpoint.

Notice these are *operational* arguments. They are good reasons to split a
service. None of them is "and that is how we enforce boundaries" — boundaries
come along for the ride, at a price set by the other four rows.

## Where it doesn't

- **A network boundary makes crossing expensive, not illegal.** Nothing stops
  service A from calling service B synchronously in a loop. That is the
  distributed monolith, and it is the common outcome: the same coupling, now
  with retries, timeouts, and partial failure.
- **Separate databases don't stop shared writes.** They stop *direct* ones.
  Service A can still drive B's write endpoint into an inconsistent state, and
  now the invariant spans two transactions that cannot be one.
- **Nothing enforces the direction.** Once B can call A over HTTP, "catalog must
  not depend on billing" is back to being a convention — enforced by code review,
  in a codebase nobody can see whole.

## The synthesis worth arguing for

These are not opposed, and the ordering matters:

**A cleanly enforced module boundary is the precondition for a cheap service
extraction, not an alternative to it.** Extracting `catalog` from this example
is tractable precisely because the rules already guarantee nothing reaches into
its internals and nothing depends on it in the wrong direction. Its public
surface is one file, and that file is the API you would expose.

Extracting a domain from a codebase *without* these rules is the expensive
project everyone has been on — the one where the boundary turns out to be
imaginary and the six-week estimate becomes nine months.

So: enforce the boundaries now, mechanically, for free. Split the deployment
when you have an operational reason — independent scaling, independent release
cadence, failure isolation, team autonomy at a size where that binds. Splitting
in order to *obtain* boundaries is paying a distributed-systems tax for
something a config file already gives you.

## Be honest about the limits

Static enforcement sees imports and call sites. It does not see reflection,
`await import(name)` with a computed name, a raw SQL string, or an HTTP call to
another module's endpoint. Where a guarantee has to be absolute, back it with a
runtime mechanism and keep the static rule as the fast feedback loop.

That pairing is the subject of the
[`dal-boundaries`](https://github.com/robmclarty/checkride/tree/main/examples/dal-boundaries)
example: a Postgres read-only role makes the guarantee, and checkride makes the
violation a build error instead of an incident.

## See also

- [Deep modules](https://github.com/robmclarty/checkride/blob/main/docs/deep-modules.md)
- [Conventions](https://github.com/robmclarty/checkride/blob/main/README.md#conventions)

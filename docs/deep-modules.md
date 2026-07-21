# Deep modules

The design idea behind checkride's structural rules — and the default convention
that enforces it. The idea is universal; the convention checkride ships is a
sensible default you can swap. This page covers both: the concept first, then
how checkride's `struct` and `dead` slots hold it in place, and finally how to
adapt it to a different convention or language.

## The idea (John Ousterhout)

"Deep module" is John Ousterhout's term, from *A Philosophy of Software Design*
(2018). His central claim is that the hardest limit on building software is our
ability to understand the complexity of what we've built, and that the main way
to fight complexity is good modular design — so it's worth being precise about
what makes a module good.

Every module has two parts: an **interface** (what you must know to use it) and
an **implementation** (the code that does the work). A module's value is the
functionality it provides *minus* the cost of the interface you have to learn to
get at it. Picture each module as a rectangle: the area is the total
functionality, and the top edge is the interface.

- A **deep** module is a tall, narrow rectangle: a small interface hiding a
  large implementation. You learn a little and get a lot. The classic example is
  Unix file I/O — `open`, `read`, `write`, `close` — five simple calls that hide
  disk layout, buffering, permissions, caching, and scheduling. Enormous
  functionality, tiny interface.
- A **shallow** module is a short, wide rectangle: its interface is nearly as
  complicated as its implementation. It costs about as much to learn as it saves
  you. A method that just forwards its arguments to another method is the limit
  case — pure interface, no hidden work.

Depth is what makes an abstraction pay off, and the technique for achieving it is
**information hiding** (a term that predates Ousterhout — it's David Parnas's,
from his 1972 paper on decomposing systems into modules). Each module should
encapsulate a design decision — a data format, an algorithm, a dependency — so
that decision does not leak into its interface or into other modules. The
opposite, **information leakage**, is when one decision is reflected in several
modules at once; change the decision and you have to edit all of them. A related
maxim is **pull complexity downward**: when something is unavoidably messy,
prefer to absorb the mess inside a module so its callers don't have to deal with
it, even if that makes the module's own code a little harder.

None of this is about a particular language, directory layout, or file named
`index.ts`. It's a property of interfaces: *keep the surface small and the
implementation hidden.* Everything below is one concrete way to make a codebase
obey that property mechanically.

## checkride's default convention

checkride's `init` scaffolds one embodiment of the deep-module idea, tuned for
TypeScript. The unit of encapsulation is a **module**:

- A single file is a module. Its exported names are its interface; everything
  else in the file is implementation.
- When a file grows internals worth hiding, promote it to a **folder module**
  whose only public surface is a barrel `index.ts`. The barrel re-exports what's
  public and holds no logic of its own; the rest of the folder is internal.

A one-file folder is just ceremony — stay a single file until there's something
to hide.

```text
src/
├── index.ts            ← package interface (the public API)
├── auth/               ← folder module
│   ├── index.ts        ← module interface
│   ├── login.ts        ← implementation
│   └── tokens.ts       ← implementation
├── payments/           ← folder module
│   ├── index.ts
│   ├── invoices.ts
│   └── ledger.ts
└── config.ts           ← single-file module
```

Within a module, files import each other freely. Across sibling modules, code
goes through the interface — `../payments/index.js` — never an internal file.

```ts
import { format } from './tokens.js';         // same module — fine
import { user } from './sub/user.js';         // same module, nested — fine
import { verify } from '../auth/index.js';    // sibling via its interface — fine

import { hash } from '../auth/tokens.js';     // reaches into a sibling's guts — rejected
import { verify } from '../auth';             // extensionless — rejected (NodeNext needs .js)
```

The explicit `.js` is required because NodeNext ESM resolution does not
synthesize extensions or directory indexes; it's enforced separately so the two
failure modes give targeted messages.

## How it's enforced

Two tools, covering different scopes. Everything runs as part of `pnpm check`.

| Scope     | Tool     | Rule                                                    |
| --------- | -------- | ------------------------------------------------------- |
| Symbol    | `tsc`    | Only what a module exports is reachable at all          |
| Module    | ast-grep | Siblings are reachable only through their `index.js`    |
| Extension | ast-grep | Relative imports carry an explicit `.js` / `.mjs`       |
| Package   | `fallow` | In a monorepo, `libs/*` may not import from `apps/*`    |

The ast-grep rules live in your repo under `rules/` and run through the `struct`
slot:

- `rules/no-deep-sibling-import.yml` — flags any import of the form
  `'../<sibling>/<not-index>.js'`.
- `rules/no-logic-in-barrel.yml` — keeps `index.ts` a pure re-export surface.
- `rules/require-js-extension.yml` — enforces the NodeNext extension.
- `rules/no-default-export.yml`, `rules/no-class.yml` — named exports and a
  functional style, so the interface is a set of stable, discoverable names.

The cross-package boundary is fallow's, not ast-grep's, and it only applies to
the **monorepo** shape: fallow's `boundary-violation` rule enforces that
reusable `libs/*` never import from deployable `apps/*`. The **flat** shape has
no such split — its boundaries are entirely the within-package module rules
above. (Naming every sibling module as its own fallow zone would be unwieldy;
ast-grep's structural patterns fit the per-package convention far better, which
is why the two tools divide the work this way.)

## Why it pays off

The abstract benefits of deep modules show up as concrete properties here:

1. **Refactor without ripple.** Renaming `tokens.ts` to `jwt.ts` inside `auth/`
   cannot break another module — nothing outside `auth/` was allowed to name it.
   The hidden implementation is genuinely free to change.
2. **The reader's mental model stays shallow.** Someone working in `payments/`
   sees `auth`'s interface and nothing else. They never have to hold `auth`'s
   internals in their head to make progress.
3. **Agents find the right edit point.** Asked "where does authentication
   happen?", an agent reads `auth/index.ts` and has the surface area at once,
   instead of wandering through internals guessing what's public.
4. **Parallel work stays out of each other's way.** Because the only shared
   contact point between two modules is a low-churn barrel, two changes in two
   modules touch disjoint files — so humans and agents working different tickets
   rarely collide, and merge conflicts stay rare.

The cost is one extra file per folder module and one import hop. The benefit
compounds with codebase size.

## Working in this layout

**Add a module.** Create `src/<name>/index.ts`, re-export what's public, add
implementation files beside it, and import it elsewhere as `'../<name>/index.js'`.
Then `pnpm check`.

**Promote a file to a folder module.** When `src/foo.ts` outgrows a single
file: make `src/foo/`, move the code into focused internal files (split as
needed), add `src/foo/index.ts` re-exporting the public symbols, and update
outside imports from `'./foo.js'` to `'./foo/index.js'`. Then `pnpm check`.

**When a sibling needs deep access — don't grant it.** A sibling reaching for
another sibling's internals almost always means the abstraction is wrong in one
of three ways: the two modules are really one (collapse them), the shared piece
belongs in a third module (extract it), or the interface is missing an export
(add it to the `index.ts`). Suppressing the rule is a last resort and is itself a
smell to revisit — the point of the boundary is to force this conversation.

## Making it your own

The deep-module *principle* is universal; the *rule pack above is a default*,
not something baked into checkride. The `struct` slot simply runs whatever
ast-grep rules live in your `rules/` directory, so you own the convention:

- **A different convention, same language.** Maybe you hide internals behind a
  `public/` folder, a naming prefix, or an explicit allowed-import list instead
  of a barrel. Edit or replace the rules in `rules/`; `struct` enforces the new
  shape with no change to checkride.
- **Another language.** ast-grep is polyglot. Set each rule's `language`
  (`typescript`, `python`, `go`, `rust`, …) and the same slot enforces module
  boundaries there.
- **Beyond ast-grep.** When a boundary is easier to express in another
  ecosystem's tool — `import-linter` (Python), `depguard` (Go),
  `dependency-cruiser` (JS) — wire it up as a
  [custom check](./tools.md#when-to-write-a-custom-check) instead of forcing it
  into an ast-grep pattern.

Whatever the encoding, the target is the same one Ousterhout describes: a small
interface in front of a substantial, hidden implementation. See
[AGENTS.md](../AGENTS.md) for the conventions as agents receive them, and
[docs/tools.md](./tools.md) for the tools that enforce them.

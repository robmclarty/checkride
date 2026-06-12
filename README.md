# checkride

An agent harness for TypeScript repositories, delivered as one npm package. It has two pillars:

1. **A definition of done.** One command runs the whole verification pipeline — types, lint, structure, dead code, tests, docs, links, spelling. Exit 0 means the work is complete, so agents stop guessing when to stop.
2. **Structured boundaries.** The deep-modules pattern — every first-level directory under `src/` is a module whose only public surface is its `index.ts` — enforced mechanically, keeping agents inside lanes and letting humans and agents work in parallel with minimal merge conflicts.

## Status

Under construction, built phase by phase per `plans/checkride-plan.md`. The interim pipeline lives in `scripts/`; the real CLI replaces it once it can run on itself.

Daily usage, once installed:

```bash
pnpm check        # run the pipeline; exit 0 = done
```

See [AGENTS.md](./AGENTS.md) for the contract agents follow in this repository, and [LICENSE](./LICENSE) for terms (MIT).

# Security

## Reporting a problem

Report a security problem in private, through GitHub's
[Report a vulnerability](https://github.com/robmclarty/checkride/security/advisories/new)
form, which is also under the repository's Security tab. Please don't open a
public issue for it, since an issue is readable before a fix exists.

A report is easiest to act on when it says:

- the version (`checkride --version`), and whether it's the npm package or the
  standalone binary;
- the `checkride.config.json` involved, or the smallest one that shows the
  problem;
- what happened, and what you expected instead.

checkride has one maintainer, so there's no promised response time. A report
that holds up gets a fix, a release, and a published advisory that credits you
unless you'd rather it didn't.

## Which versions get fixes

The latest 1.x release gets fixes. A fix ships as a new release, and an older
release isn't patched, a 0.x one included, so the way to take a fix is to
upgrade. [The contract](./docs/contract.md#versioning-and-pin-policy) says
how to pin and what an upgrade may change.

## What belongs somewhere else

checkride runs the tools a repo's config names and adds none at runtime. A
problem in one of those tools, such as tsc, oxlint or vale, belongs with that
tool's maintainers. If checkride makes the problem worse, by the way it runs
the tool or reads its output, that part belongs here.

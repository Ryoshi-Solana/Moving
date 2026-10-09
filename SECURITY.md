# Security notes

## Production dependency gate

GitHub Actions blocks changes when `npm audit --omit=dev --audit-level=high`
finds a high-severity or critical advisory in production dependencies. The workflow
also audits the full dependency tree, runs offline tests, lint, typecheck, and a
production build.

## Known development-tool advisory (2026-10-10)

The full dependency audit currently reports
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) for
`braces <= 3.0.3`. The current lockfile pins `braces@3.0.3` as a transitive
development dependency. The production-only audit is a separate required gate.
The upstream advisory currently lists no patched release.

This repository does **not** claim the dependency has been fixed, does not
override to another affected version, and does not install an unreviewed fork.
Instead, the full audit temporarily allows only this exact high-severity finding
when the lockfile confirms `braces@3.0.3` is dev-only. Any other high/critical
finding, a changed version, or this package appearing as a production dependency
fails CI. The policy is covered by automated tests.

This is a narrow audit exception, not a vulnerability fix. Re-check the advisory
and dependency tree when upgrading dependencies. Remove the exception only after
a maintainer-reviewed patched release or a tested safe replacement is available.

## Reporting

Do not commit API keys or other credentials. The CoinMarketCap key must be
configured only as `CMC_API_KEY` in the deployment environment; never use a
`NEXT_PUBLIC_` prefix for secrets.

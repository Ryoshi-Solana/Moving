# Security notes

## Production dependency gate

GitHub Actions blocks changes when `npm audit --omit=dev --audit-level=high`
finds a high-severity or critical advisory in production dependencies. The same
workflow runs the offline test suites, lint, typecheck, and a production build.

## Known development-tool advisory (2026-10-09)

The full dependency audit currently reports
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) for
`braces <= 3.0.3`. The package is a transitive development dependency in the
current lockfile; the production-only audit is clean. The upstream advisory lists
no patched release as of this date.

The repository intentionally does **not** claim that overriding to `3.0.3`
fixes the issue (that is the affected version), and it does not install an
unreviewed fork. The full audit is reported as a non-blocking warning until the
upstream package has a maintainer-reviewed patched release or a safe replacement
can be tested. Re-check the advisory and dependency tree on the next upgrade.

## Reporting

Do not commit API keys or other credentials. The CoinMarketCap key must be
configured only as `CMC_API_KEY` in the deployment environment; never use a
`NEXT_PUBLIC_` prefix for secrets.

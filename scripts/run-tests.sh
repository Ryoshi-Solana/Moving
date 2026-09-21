#!/usr/bin/env bash
# Runs the offline test suites on plain Node (>=22) using type stripping.
# Node cannot resolve the "@/..." tsconfig alias or extensionless imports, so we
# stage a flat copy with rewritten specifiers and run that. The `server-only`
# import is a Next build-time guard with no runtime behaviour, so it is dropped
# in the staged copy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp "$ROOT"/analysis/*.ts "$ROOT"/lib/*.ts "$ROOT"/services/*.ts "$ROOT"/scripts/*.ts "$STAGE/"
cp "$ROOT/types/index.ts" "$STAGE/"

cd "$STAGE"
sed -i \
  -e "s#'@/types'#'./index.ts'#g" \
  -e "s#'@/analysis/\([a-z-]*\)'#'./\1.ts'#g" \
  -e "s#'@/lib/\([a-z-]*\)'#'./\1.ts'#g" \
  -e "s#'@/services/\([a-z-]*\)'#'./\1.ts'#g" \
  -e "/^import 'server-only';$/d" \
  ./*.ts

status=0
for suite in test-analysis test-resolution test-integration; do
  echo "=============== $suite ==============="
  node --experimental-strip-types --no-warnings "./$suite.ts" || status=1
  echo
done
exit $status

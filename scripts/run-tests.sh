#!/usr/bin/env bash
# Runs the pure-logic test suites on plain Node, no framework needed.
#
# Node's --experimental-strip-types removes TypeScript syntax but does not
# resolve the project's "@/..." path aliases, so this script stages a flat
# copy of every pure module the tests depend on and rewrites imports to
# plain relative paths before running each test script against that copy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Flatten every pure (non-React, non-route) module the tests touch.
cp "$ROOT"/analysis/*.ts "$STAGE"/
cp "$ROOT"/analysis/questions/*.ts "$STAGE"/
cp "$ROOT"/lib/*.ts "$STAGE"/
cp "$ROOT"/services/*.ts "$STAGE"/
cp "$ROOT"/types/index.ts "$STAGE"/
cp "$ROOT"/scripts/test-*.ts "$STAGE"/

# Rewrite "@/..." import specifiers to flat relative paths, and drop the
# server-only guard import (meaningless outside a real Next.js server build).
sed -i \
  -e "s#'@/types'#'./index.ts'#g" \
  -e "s#'@/analysis/questions/\([a-zA-Z-]*\)'#'./\1.ts'#g" \
  -e "s#'@/analysis/\([a-zA-Z-]*\)'#'./\1.ts'#g" \
  -e "s#'@/lib/\([a-zA-Z-]*\)'#'./\1.ts'#g" \
  -e "s#'@/services/\([a-zA-Z-]*\)'#'./\1.ts'#g" \
  -e "/^import 'server-only';\$/d" \
  "$STAGE"/*.ts

pass=true
for script in test-analysis test-resolution test-server-config test-public-links test-integration test-questions test-market-feeds test-dexscreener; do
  echo ""
  echo "─── ${script} ───────────────────────────────────────────────"
  if ! node --experimental-strip-types "$STAGE/${script}.ts"; then
    pass=false
  fi
done

echo ""
if $pass; then
  echo "✔ All test suites passed."
  exit 0
else
  echo "✘ One or more test suites failed."
  exit 1
fi

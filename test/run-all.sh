#!/usr/bin/env bash
# Runs the full pi-vigilant test suite against the real index.ts.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$HERE/setup.sh" >/dev/null || { echo "setup failed"; exit 1; }

fail=0
for t in test-regression.mjs test-stale.mjs test-resume.mjs test-length-loop.mjs test-compaction-fallback.mjs; do
  echo "── $t ─────────────────────────────────────────"
  # Bounded: the suites are pure in-process simulation and finish in seconds.
  if timeout 300 node "$HERE/$t"; then :; else fail=1; fi
  echo ""
done
[ $fail -eq 0 ] && echo "ALL SUITES PASSED" || echo "SUITE FAILURES"
exit $fail

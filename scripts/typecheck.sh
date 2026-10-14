#!/usr/bin/env bash
# Real typecheck for pi-vigilant.
#
# Two failure modes this replaces:
#   1. `tsc --noCheck` — parses the file and checks nothing. It reported success
#      even while the tree had no compiler and while 9 real type errors sat in
#      index.ts. A check that cannot fail is not a check.
#   2. `tsc` not resolvable at all. node_modules here is a hand-built symlink
#      tree pointing at the global pi install (so the extension resolves the
#      host's own modules), and `npm install` cannot reconcile that tree — so
#      the declared devDependency was never installed and the script died in a
#      way nobody read.
#
# The compiler is therefore resolved from the usual places and, if absent,
# installed once into .tools/ (gitignored) at the version pinned in
# devDependencies. The version actually used is printed: a gate that silently
# runs a different compiler than the one declared is not the gate you think you
# ran.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

VERSION=$(node -p "require('./package.json').devDependencies.typescript" 2>/dev/null || echo "5.9.3")

find_tsc() {
  local c
  for c in \
    "$HERE/node_modules/typescript/bin/tsc" \
    "$HERE/.tools/node_modules/typescript/bin/tsc" \
    "$(command -v tsc 2>/dev/null || true)"
  do
    if [ -n "$c" ] && [ -f "$c" ]; then echo "$c"; return 0; fi
  done
  return 1
}

TSC="$(find_tsc || true)"
if [ -z "$TSC" ]; then
  echo "typescript not installed — fetching typescript@$VERSION into .tools/"
  npm install --prefix "$HERE/.tools" "typescript@$VERSION" --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || true
  TSC="$(find_tsc || true)"
fi
if [ -z "$TSC" ]; then
  echo "FAIL: no typescript compiler available (offline, and none installed)"
  echo "      fix: npm install --prefix .tools typescript@$VERSION"
  exit 2
fi

echo "typecheck: $(node "$TSC" --version)"

FILES=(index.ts)
if [ -d lib ]; then
  while IFS= read -r f; do FILES+=("$f"); done < <(find lib -name '*.ts' | sort)
fi

# --noCheck is deliberately absent.
node "$TSC" --noEmit \
  --target ES2022 \
  --module NodeNext \
  --moduleResolution NodeNext \
  --skipLibCheck \
  --allowImportingTsExtensions \
  "${FILES[@]}"
status=$?

if [ $status -eq 0 ]; then
  echo "typecheck: OK (${#FILES[@]} files)"
else
  echo "typecheck: FAILED (exit $status)"
fi
exit $status

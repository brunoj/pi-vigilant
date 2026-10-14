#!/usr/bin/env bash
# Real typecheck for pi-vigilant.
#
# Three failure modes this replaces:
#   1. `tsc --noCheck` — parses the file and checks nothing. It reported success
#      while real type errors sat in index.ts. A gate that cannot fail is not a
#      gate.
#   2. `tsc` not resolvable at all. node_modules here is a hand-built symlink
#      tree pointing at the global pi install (so the extension resolves the
#      host's own modules), and `npm install` cannot reconcile that tree — so
#      the declared devDependency was never installed and the script died in a
#      way nobody read.
#   3. Even with a compiler, the host API resolved to `any`: the local
#      @earendil-works/pi-ai is a 0.0.0-test stub with no declarations. The
#      check was typing the extension against a test double.
#
# So the compiler AND the pinned peer packages are installed once into
# .tools/ (gitignored) at the versions declared in devDependencies, and
# tsconfig.typecheck.json maps them explicitly. The versions actually used are
# printed: a gate that silently runs a different compiler, or different host
# types, than the ones declared is not the gate you think you ran.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

TOOLS="$HERE/.tools"
PEERS=(typescript @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-agent-core typebox)

# Resolve the pinned version for each peer from devDependencies.
declare -A WANT=()
for p in "${PEERS[@]}"; do
  v=$(node -p "require('./package.json').devDependencies['$p']" 2>/dev/null)
  [ -n "$v" ] && [ "$v" != "undefined" ] || { echo "FAIL: $p has no pinned devDependency version"; exit 2; }
  WANT["$p"]="$v"
done

missing=()
for p in "${PEERS[@]}"; do
  [ -f "$TOOLS/node_modules/$p/package.json" ] || missing+=("$p@${WANT[$p]}")
done
[ -d "$TOOLS/node_modules/@types/node" ] || missing+=("@types/node@22")

if [ ${#missing[@]} -gt 0 ]; then
  echo "installing into .tools/: ${missing[*]}"
  npm install --prefix "$TOOLS" "${missing[@]}" --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || true
  for p in "${PEERS[@]}"; do
    [ -f "$TOOLS/node_modules/$p/package.json" ] || { echo "FAIL: could not obtain $p@${WANT[$p]} (offline?)"; exit 2; }
  done
fi

TSC="$TOOLS/node_modules/typescript/bin/tsc"
[ -f "$TSC" ] || { echo "FAIL: typescript missing from .tools/"; exit 2; }

echo "typecheck: $(node "$TSC" --version), host types $(node -p "require('$TOOLS/node_modules/@earendil-works/pi-coding-agent/package.json').version")"

node "$TSC" -p "$HERE/tsconfig.typecheck.json"
status=$?

if [ $status -eq 0 ]; then
  echo "typecheck: OK"
else
  echo "typecheck: FAILED (exit $status)"
fi
exit $status

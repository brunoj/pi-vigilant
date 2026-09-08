#!/usr/bin/env bash
#
# Prepares the local dependencies the test harness needs to load index.ts.
#
# The extension is loaded through jiti exactly as pi loads it, so the tests
# exercise the real shipped source rather than a reimplementation. That needs:
#   - jiti + typebox : borrowed from the installed pi-coding-agent
#   - @earendil-works/pi-ai : a thin package that re-exports pi's real dist,
#     exposing both `require` and `import` conditions (jiti resolves `require`)
#
# Safe to re-run.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Node resolves bare imports from the importing file's directory upward, and
# the extension under test is the repo-root index.ts — so deps must live in
# the repo-root node_modules, not under test/.
NM="$(cd "$HERE/.." && pwd)/node_modules"

PI_ROOT="${PI_ROOT:-$(npm root -g 2>/dev/null)/@earendil-works/pi-coding-agent}"
if [ ! -d "$PI_ROOT" ]; then
  echo "error: cannot find pi-coding-agent. Set PI_ROOT to its install path." >&2
  exit 1
fi

PI_NM="$PI_ROOT/node_modules"
for dep in jiti typebox; do
  if [ ! -d "$PI_NM/$dep" ]; then
    echo "error: $PI_NM/$dep not found" >&2
    exit 1
  fi
done

mkdir -p "$NM/@earendil-works/pi-ai"
ln -sfn "$PI_NM/jiti" "$NM/jiti"
ln -sfn "$PI_NM/typebox" "$NM/typebox"

# Locate the compat entry point the extension imports.
COMPAT_JS="$(node -e '
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const root = process.argv[1];
for (const p of [
  "node_modules/@earendil-works/pi-ai/dist/compat.js",
  "node_modules/@earendil-works/pi-ai/dist/index.js",
]) {
  const f = join(root, p);
  if (existsSync(f)) { console.log(f); process.exit(0); }
}
process.exit(1);
' "$PI_ROOT")" || {
  echo "error: could not locate the pi-ai compat build under $PI_ROOT" >&2
  exit 1
}

cat > "$NM/@earendil-works/pi-ai/package.json" <<JSON
{
  "name": "@earendil-works/pi-ai",
  "version": "0.0.0-test",
  "type": "commonjs",
  "main": "./compat.cjs",
  "exports": {
    "./compat": {
      "require": "./compat.cjs",
      "import": "./compat.cjs",
      "default": "./compat.cjs"
    },
    ".": {
      "require": "./compat.cjs",
      "import": "./compat.cjs",
      "default": "./compat.cjs"
    }
  }
}
JSON

cat > "$NM/@earendil-works/pi-ai/compat.cjs" <<JS
// Re-export the REAL implementation shipped with pi, so error classification
// under test is the same code that runs in production.
module.exports = require(${COMPAT_JS@Q});
JS

# The extension type-imports the host package; jiti resolves it at runtime even
# though only types are used, so link the installed copy.
ln -sfn "$PI_ROOT" "$NM/@earendil-works/pi-coding-agent"

node -e '
const m = require(process.argv[1]);
if (typeof m.isRetryableAssistantError !== "function") {
  console.error("error: isRetryableAssistantError missing from the pi-ai re-export");
  process.exit(1);
}
console.log("test dependencies ready");
' "$NM/@earendil-works/pi-ai/compat.cjs"

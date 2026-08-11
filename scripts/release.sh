#!/usr/bin/env bash
# pi-vigilant release script — auto-version + changelog + tag + push + publish.
#
# Usage:   npm run release [patch|minor|major]   (default: patch)
# Requires: npm login (done once), git remote configured, gh CLI for PR-less push
#   or a configured git remote with push access.
set -euo pipefail

LEVEL="${1:-patch}"
case "$LEVEL" in
  patch|minor|major) ;;
  *) echo "Usage: npm run release [patch|minor|major]" >&2; exit 1 ;;
esac

# Must be run from the repo root
cd "$(dirname "$0")/.."

# Sanity checks
[ -f package.json ] || { echo "package.json not found" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git repo" >&2; exit 1; }
git diff --quiet || { echo "working tree dirty — commit or stash first" >&2; exit 1; }
npm whoami >/dev/null 2>&1 || { echo "not logged in to npm — run 'npm login' first" >&2; exit 1; }

OLD_VERSION=$(node -p "require('./package.json').version")
NEW_VERSION=$(npm version "$LEVEL" --no-git-tag-version)

# Update changelog: insert new version section under [Unreleased]
TODAY=$(date +%Y-%m-%d)
node - "$NEW_VERSION" "$TODAY" <<'EOF'
const fs = require('fs');
const [v, today] = process.argv.slice(2);
const vv = v.replace(/^v/, '');
let cl = fs.readFileSync('CHANGELOG.md', 'utf-8');
if (!cl.includes(`## [${vv}]`)) {
  const entry = `## [${vv}] - ${today}\n\n### Added\n\n- (describe changes for ${vv})\n\n`;
  cl = cl.replace('## [Unreleased]\n', `## [Unreleased]\n\n${entry}`);
  fs.writeFileSync('CHANGELOG.md', cl);
}
EOF

git add package.json CHANGELOG.md
[ -f package-lock.json ] && git add package-lock.json
git commit -m "chore: release $NEW_VERSION"
git tag "$NEW_VERSION"

# Push and publish
git push --follow-tags
npm publish

echo ""
echo "✅ Released $OLD_VERSION → $NEW_VERSION"
echo "   Tag:   $NEW_VERSION"
echo "   npm:   npm:pi-vigilant@$NEW_VERSION"
echo "   NOTE:  Update CHANGELOG.md's '### Added' section if needed, then commit."

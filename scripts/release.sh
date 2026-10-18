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

# The gates run before anything is versioned, tagged or published. They used to
# live only in habit: a release could ship with a type error or a red suite
# because nothing between "npm run release" and npm publish ever ran them.
echo "── gate: typecheck ──────────────────────────────────────────"
npm run --silent check || { echo "release refused: typecheck failed" >&2; exit 1; }
echo "── gate: test suite ─────────────────────────────────────────"
npm test || { echo "release refused: test suite failed" >&2; exit 1; }

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
# Annotated on purpose: `git push --follow-tags` only pushes annotated tags, so a
# lightweight tag here would leave the release untagged on GitHub.
git tag -a "$NEW_VERSION" -m "Release $NEW_VERSION"

# Push and publish
git push --follow-tags
git push origin "$NEW_VERSION"
npm publish

# Gate: the publish actually landed. `npm publish` exits 0 when npm ACCEPTS the
# upload, but npm can hold a version in its staging queue (security review) and
# never make it public — and then re-publishing the same version fails with
# `409 Cannot publish over previously staged version`. This script used to print
# "✅ Released" on the strength of the exit code alone, so a release that never
# reached anyone looked exactly like one that did. Poll the registry for the
# version itself; a tag and a commit are not a release.
echo "── gate: publish landed ─────────────────────────────────────────"
PKG_NAME=$(node -p "require('./package.json').name")
node - "$PKG_NAME" "${NEW_VERSION#v}" <<'EOF' || exit 1
const [name, version] = process.argv.slice(2);
const url = `https://registry.npmjs.org/${encodeURIComponent(name)}?t=${Date.now()}`;
const has = async () => {
  const res = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
  if (!res.ok) return false;
  const doc = await res.json();
  return !!doc.versions?.[version] && doc["dist-tags"]?.latest === version;
};
const DEADLINE = Date.now() + 180_000;
(async () => {
  let attempt = 0;
  while (Date.now() < DEADLINE) {
    attempt++;
    if (await has()) {
      console.log(`published: ${name}@${version} is live on the registry`);
      return;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  console.error(
    `release INCOMPLETE: ${name}@${version} is not on the registry after 3 minutes.\n` +
      `npm most likely holds it in its staging queue (security review), or rejected it.\n` +
      `The git tag exists but nobody can install this version — check\n` +
      `https://www.npmjs.com/package/${name} and the security-holds page, then\n` +
      `re-publish (a still-staged version cannot be re-published: it 409s).`,
  );
  process.exit(1);
})();
EOF

# Gate: the PUBLISHED artifact. Every gate above reads the working tree, which is
# how a package can ship a tarball missing a module its own entry point imports
# with a green suite (pi-aia-browser 0.2.1). This installs the version from the
# registry into a throwaway prefix and imports the installed extension.
if [ "${BMX_SKIP_PUBLISHED_VERIFY:-}" != "1" ]; then
  echo "── gate: published artifact verified ─────────────────────"
  node scripts/verify-published.mjs "${NEW_VERSION#v}" || {
    echo "release INCOMPLETE: ${NEW_VERSION} is on the registry but the installed artifact does not load" >&2
    exit 1
  }
fi

echo ""
echo "✅ Released $OLD_VERSION → $NEW_VERSION"
echo "   Tag:   $NEW_VERSION"
echo "   npm:   npm:pi-vigilant@$NEW_VERSION"
echo "   NOTE:  Update CHANGELOG.md's '### Added' section if needed, then commit."

#!/usr/bin/env bash
set -euo pipefail
# draft-release.sh -- create (or refresh) a DRAFT GitHub release for the
# current prod promotion. Called by the prod deploy make targets so every
# deploy leaves a pre-filled draft: version title, the commits since the
# last release as bullets, and placeholder prose for the maintainer to rewrite
# before publishing (images paste straight into the GitHub editor).
#
# Never publishes. Publishing the release is always a human action --
# same rule as merging to main.

REPO="mdeguzis/proton-pulse-web"
VERSION="v$(node -e "console.log(require('./package.json').version)")"
SHA="$(git rev-parse --short=7 HEAD)"

# Commits since the last (published or draft) release tag; fall back to the
# last 25 commits on the first ever run.
LAST_TAG="$(gh release list --repo "$REPO" --limit 1 --json tagName --jq '.[0].tagName' 2>/dev/null || true)"
if [ -n "$LAST_TAG" ] && git rev-parse "$LAST_TAG" >/dev/null 2>&1; then
  RANGE="$LAST_TAG..HEAD"
else
  RANGE="HEAD~25..HEAD"
fi
COMMITS="$(git log --format='- %s' --no-merges "$RANGE" | grep -vE '^- (test|chore|ci|docs)(\(|:)' || true)"

BODY="$(cat <<EOF
<!-- Placeholder: rewrite the summary, add screenshots, then publish. -->

## Highlights

_One or two sentences on what this release means for users._

## Changes

${COMMITS:-'- (no commits found since the last release)'}

---
Deployed to https://www.proton-pulse.com as \`${SHA}\`.
EOF
)"

# Refresh the existing draft for this version if one exists; else create it.
if gh release view "$VERSION" --repo "$REPO" --json isDraft --jq .isDraft 2>/dev/null | grep -q true; then
  gh release edit "$VERSION" --repo "$REPO" --title "Proton Pulse Web $VERSION" --notes "$BODY"
  echo "[draft-release] refreshed draft $VERSION"
elif gh release view "$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  echo "[draft-release] $VERSION is already PUBLISHED -- bump package.json before the next release. Skipping."
else
  gh release create "$VERSION" --repo "$REPO" --draft --title "Proton Pulse Web $VERSION" --notes "$BODY" --target main
  echo "[draft-release] created draft $VERSION"
fi
echo "[draft-release] edit + publish at: https://github.com/$REPO/releases"

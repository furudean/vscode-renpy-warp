#!/usr/bin/env bash
set -euo pipefail

BUMP_TYPE="${1:-}"

if [[ -z "$BUMP_TYPE" ]]; then
  echo "usage: $0 <major|minor|patch>"
  exit 1
fi

if [[ "$BUMP_TYPE" != "major" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "patch" ]]; then
  echo "error: argument must be one of: major, minor, patch"
  exit 1
fi

# check for dirty git state
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: git working tree is dirty. commit or stash changes first"
  exit 1
fi

if ! command -v jq &> /dev/null; then
  echo "error: jq is not installed"
  exit 1
fi

if [[ ! -f "package.json" ]]; then
  echo "error: no package.json found in current directory"
  exit 1
fi

if [[ ! -f "CHANGELOG.md" ]]; then
  echo "error: no CHANGELOG.md found in current directory"
  exit 1
fi

# bump version via npm
npm version "$BUMP_TYPE" --no-git-tag-version > /dev/null

# read the new version
NEW_VERSION=$(jq -r '.version' package.json)
TODAY=$(date +"%Y-%m-%d")

# replace ## Unreleased in CHANGELOG.md
if ! grep -q "^## Unreleased" CHANGELOG.md; then
  echo "error: could not find '## Unreleased' in CHANGELOG.md"
  exit 1
fi

perl -i -pe "s/^## Unreleased/## ${NEW_VERSION} - ${TODAY}/" CHANGELOG.md

# commit
git add package.json CHANGELOG.md
git commit -m "chore: release v${NEW_VERSION}"

# create a git tag
git tag "v${NEW_VERSION}"

echo ""
echo "made commit for v${NEW_VERSION}"
echo ""
echo "to push commit and tag, run:"
echo "  git push && git push origin v${NEW_VERSION}"
echo ""
echo "to undo commit and remove the tag, run:"
echo "  git tag -d v${NEW_VERSION} && git reset HEAD~1"

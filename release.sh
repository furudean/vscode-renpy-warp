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

if ! grep -q "^## Unreleased" CHANGELOG.md; then
  echo "error: could not find '## Unreleased' in CHANGELOG.md"
  exit 1
fi


# bump version via npm
npm version "$BUMP_TYPE" --no-git-tag-version > /dev/null

# read the new version
NEW_VERSION=$(jq -r '.version' package.json)
TODAY=$(date +"%Y-%m-%d")

# extract changelog body
NOTES_FILE=$(mktemp)
awk '/^## Unreleased/{found=1; next} found && /^## /{exit} found' CHANGELOG.md > "$NOTES_FILE"

# update changelog with release version and date
perl -i -pe "s/^## Unreleased/## ${NEW_VERSION} - ${TODAY}/" CHANGELOG.md

# commit
git add package.json package-lock.json CHANGELOG.md
git commit -m "release v${NEW_VERSION}"

# create a git tag
git tag "v${NEW_VERSION}"
COMMIT_HASH=$(git rev-parse --short HEAD)

echo ""
echo "made commit for v${NEW_VERSION}"
echo ""
echo "to push commit, tag, and create github release, run:"
echo "  git push && git push origin v${NEW_VERSION} && gh release create v${NEW_VERSION} --notes-file \"${NOTES_FILE}\""
echo ""
echo "to undo commit and remove the tag, run:"
echo "  git tag -d v${NEW_VERSION} && git reset ${COMMIT_HASH}^"

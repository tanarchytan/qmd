#!/usr/bin/env bash
set -euo pipefail

# Lotl Release Script
#
# Renames the [Unreleased] section in CHANGELOG.md to the new version,
# bumps package.json, commits, and creates a tag. The actual publish
# happens via GitHub Actions when the tag is pushed.
#
# Usage: ./scripts/release.sh [patch|minor|major|<version>]
# Examples:
#   ./scripts/release.sh patch     # 0.9.0 -> 0.9.1
#   ./scripts/release.sh minor     # 0.9.0 -> 0.10.0
#   ./scripts/release.sh major     # 0.9.0 -> 1.0.0
#   ./scripts/release.sh 1.0.0     # explicit version

BUMP="${1:?Usage: release.sh [patch|minor|major|<version>]}"

# Ensure we're on main or dev, and working tree is clean.
# (Lotl's main is a single-commit orphan; day-to-day work happens on dev.
# Both branches are valid starting points for cutting a release.)
BRANCH=$(git branch --show-current)
case "$BRANCH" in
  main|dev) ;;
  *) echo "Error: must be on main or dev (currently on $BRANCH)" >&2; exit 1 ;;
esac

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working directory not clean" >&2
  git status --short
  exit 1
fi

# Verify package-lock.json is in sync with package.json
if ! npm ci --ignore-scripts --silent &>/dev/null; then
  echo "Error: package-lock.json is out of sync with package.json" >&2
  echo "Run 'npm install' and commit the updated lockfile." >&2
  exit 1
fi
echo "package-lock.json: in sync ✓"

# Read current version
CURRENT=$(jq -r .version package.json)
echo "Current version: $CURRENT"

# Calculate new version. Strips any pre-release suffix (-rc1, -beta.2, etc.)
# before arithmetic, so auto-bumping from 1.0.0-rc1 works sanely:
#   patch 1.0.0-rc1 → 1.0.1
#   minor 1.0.0-rc1 → 1.1.0
#   major 1.0.0-rc1 → 2.0.0
# Explicit `release.sh 1.0.0` skips the bump path entirely.
bump_version() {
  local current="$1" type="$2"
  local stripped="${current%%-*}"
  IFS='.' read -r major minor patch <<< "$stripped"
  case "$type" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
    *)     echo "$type" ;; # explicit version (e.g., "1.0.0", "1.0.0-rc2")
  esac
}

NEW=$(bump_version "$CURRENT" "$BUMP")
DATE=$(date +%Y-%m-%d)
echo "New version:     $NEW"
echo ""

# --- Validate CHANGELOG.md ---

if [[ ! -f CHANGELOG.md ]]; then
  echo "Error: CHANGELOG.md not found" >&2
  exit 1
fi

# The [Unreleased] section must have content
if ! grep -q "^## \[Unreleased\]" CHANGELOG.md; then
  echo "Error: no [Unreleased] section in CHANGELOG.md" >&2
  echo "" >&2
  echo "Add your changes under an [Unreleased] heading first:" >&2
  echo "" >&2
  echo "  ## [Unreleased]" >&2
  echo "" >&2
  echo "  ### Changes" >&2
  echo "  - Your change here" >&2
  exit 1
fi

# --- Preview release notes ---

echo "--- Release notes (will appear on GitHub) ---"
./scripts/extract-changelog.sh "$NEW"
echo "--- End ---"
echo ""

# --- Confirm ---

read -p "Release v$NEW? [y/N] " -n 1 -r
echo ""
[[ $REPLY =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }

# --- Rename [Unreleased] -> [X.Y.Z] - date, add fresh [Unreleased] ---

sed -i '' "s/^## \[Unreleased\].*/## [$NEW] - $DATE/" CHANGELOG.md

# Insert a new empty [Unreleased] section after the header
awk '
  /^## \['"$NEW"'\]/ && !done {
    print "## [Unreleased]\n"
    done = 1
  }
  { print }
' CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md

# --- Bump version and commit ---

jq --arg v "$NEW" '.version = $v' package.json > package.json.tmp && mv package.json.tmp package.json

git add package.json CHANGELOG.md
git commit -m "release: v$NEW"
git tag -a "v$NEW" -m "v$NEW"

echo ""
echo "Created commit and tag v$NEW"
echo ""
echo "Next: push to trigger the publish workflow"
echo ""
echo "  git push origin main --tags"

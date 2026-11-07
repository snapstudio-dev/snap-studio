#!/usr/bin/env bash
# Publishes a Snap Studio version: bumps the version in the sources, commits
# and pushes that change, then starts the GitHub release workflow and follows
# its run. Needs the GitHub CLI: brew install gh && gh auth login.
#
#   scripts/release.sh              patch: 0.1.4 → 0.1.5
#   scripts/release.sh --minor      minor: 0.1.4 → 0.2.0
#   scripts/release.sh --major      major: 0.1.4 → 1.0.0
#   scripts/release.sh --version 1.2.3   exact version
#   scripts/release.sh -y           without asking for confirmation
#   scripts/release.sh my-branch    from a branch other than main
#
# If the sources' version has not been published yet (first run, or previous
# build failed), it is reused as is, without a bump.
#
# CHANGELOG.md: the Unreleased section becomes this version's (date and
# compare links included) and goes in the version commit; the release
# workflow takes its notes from there (scripts/changelog.py).
set -euo pipefail

yes=false
level=patch
ref=main
exact=""
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) yes=true ;;
    --minor) level=minor ;;
    --major) level=major ;;
    --version)
      [ $# -ge 2 ] || { echo "--version expects a number (e.g. --version 1.2.3)" >&2; exit 1; }
      exact="$2"
      shift
      ;;
    --version=*) exact="${1#--version=}" ;;
    -*) echo "unknown option: $1" >&2; exit 1 ;;
    *) ref="$1" ;;
  esac
  shift
done
if [ -n "$exact" ]; then
  exact="${exact#v}"
  [[ "$exact" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "invalid version: \"$exact\" (expected: 1.2.3)" >&2; exit 1; }
fi
workflow="build.yml"
conf="src-tauri/tauri.conf.json"
cd "$(dirname "$0")/.."
source scripts/lib-run.sh

command -v gh >/dev/null || { echo "gh not found: brew install gh" >&2; exit 1; }

# The version commit starts from this copy: it must be clean, on the right
# branch and up to date with GitHub.
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Uncommitted changes: commit (or stash) them before a release." >&2
  exit 1
fi
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "$ref" ]; then
  echo "✗ You are on \"$branch\": switch to \"$ref\" (git switch $ref)." >&2
  exit 1
fi
git fetch -q origin "$ref"
if [ -n "$(git rev-list "HEAD..origin/$ref")" ]; then
  echo "✗ origin/$ref has commits you do not have: git pull first." >&2
  exit 1
fi

# The referenced slicing engine must be published: otherwise the published
# app could not download it.
engine="src-tauri/engine.json"
if [ -f "$engine" ]; then
  ev=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$engine" | head -1)
  for url in $(sed -n 's/^ *"url": "\(.*\)",$/\1/p' "$engine"); do
    if ! curl -sfIL -o /dev/null "$url"; then
      echo "✗ Engine $ev not found ($url): run scripts/engine.sh $ev first." >&2
      exit 1
    fi
  done
fi

current=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$conf" | head -1)
[ -n "$current" ] || { echo "version not found in $conf" >&2; exit 1; }
IFS=. read -r major minor patch <<<"$current"

latest=$(gh release view --json tagName -q .tagName 2>/dev/null || true)
published=false
gh release view "v$current" >/dev/null 2>&1 && published=true

if [ -n "$exact" ]; then
  if gh release view "v$exact" >/dev/null 2>&1; then
    echo "✗ v$exact is already published." >&2
    exit 1
  fi
  # Updates are only offered towards a newer version.
  if [ -n "$latest" ] && [ "$(printf '%s\n%s\n' "${latest#v}" "$exact" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" != "$exact" ]; then
    echo "✗ $exact is older than the latest release ($latest): installed apps would ignore it." >&2
    exit 1
  fi
  next="$exact"
  if [ "$exact" = "$current" ]; then bump=false; else bump=true; fi
elif ! $published && [ "$level" = patch ]; then
  next="$current"
  bump=false
else
  case "$level" in
    patch) next="$major.$minor.$((patch + 1))" ;;
    minor) next="$major.$((minor + 1)).0" ;;
    major) next="$((major + 1)).0.0" ;;
  esac
  bump=true
fi

# The changelog: this version's section, or what Unreleased will give it.
if python3 scripts/changelog.py notes "$next" >/dev/null 2>&1; then
  changelog="section $next already written"
elif python3 scripts/changelog.py notes Unreleased >/dev/null 2>&1; then
  changelog="Unreleased becomes $next"
else
  changelog="⚠ nothing under Unreleased: the release notes will list the commits"
fi

echo
echo "  Sources version          : $current$($published && echo " (published)" || echo " (not published yet)")"
echo "  Latest published release : ${latest:-none}"
echo "  Version to publish       : v$next"
echo "  Branch                   : $ref ($(git log -1 --format='%h %s'))"
echo "  CHANGELOG.md             : $changelog"
if $bump; then
  echo "  → a \"Version $next\" commit will be created and pushed to $ref"
fi
if [ -n "$(git rev-list "origin/$ref..HEAD")" ]; then
  echo "  → your unpushed commits will go with it"
fi
echo

if ! $yes; then
  read -r -p "Publish version $next? [y/N] " answer
  case "$answer" in
    o|O|oui|Oui|OUI|y|Y|yes) ;;
    *) echo "Cancelled."; exit 0 ;;
  esac
fi

# Unreleased becomes this version's section (nothing to do when it is
# already written, or when Unreleased is empty).
python3 scripts/changelog.py release "$next" || true
changelog_changed=false
git diff --quiet -- CHANGELOG.md || changelog_changed=true

if $bump; then
  # perl rather than sed -i, whose syntax differs between macOS and Linux.
  perl -0pi -e "s/^  \"version\": \"[^\"]*\",/  \"version\": \"$next\",/m" "$conf"
  perl -0pi -e "s/^version = \"[^\"]*\"/version = \"$next\"/m" src-tauri/Cargo.toml
  perl -0pi -e "s/(name = \"snap-studio\"\nversion = )\"[^\"]*\"/\$1\"$next\"/" src-tauri/Cargo.lock
  git add "$conf" src-tauri/Cargo.toml src-tauri/Cargo.lock CHANGELOG.md
  git commit -q -m "Version $next"
  echo "Commit \"Version $next\" created."
elif $changelog_changed; then
  git add CHANGELOG.md
  git commit -q -m "Changelog $next"
  echo "Commit \"Changelog $next\" created."
fi
git push -q origin "HEAD:$ref"

run_and_watch "$workflow" "$ref"
echo "Release: $(gh release view "v$next" --json url -q .url)"

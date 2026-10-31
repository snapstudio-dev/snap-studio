#!/usr/bin/env bash
# Starts Snap Studio in development (`cargo tauri dev`), with the usual
# slicing engine or another one — to try a Snapmaker Orca version before its
# engine is published (scripts/engine.sh).
#
#   scripts/dev.sh                        the usual engine (src-tauri/engine.json)
#   scripts/dev.sh --engine 2.4.1         official Snapmaker Orca 2.4.1
#   scripts/dev.sh --engine <path>        that engine (an .app, an executable, AppRun)
#   scripts/dev.sh --engine 2.4.1 -- …    the rest goes to `cargo tauri dev`
#
# A version is looked for in ~/snapstudio-dev-engines/orca-<version>/; on
# macOS, when missing, the official package is downloaded there once from
# Snapmaker's releases (about 270 MB). Elsewhere, give the engine's path.
# The engine is passed as SNAPSTUDIO_ENGINE (slice.rs): every slice and the
# profiles use it, though Settings › Engine still shows engine.json's version.
set -euo pipefail

engine=""
extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --engine)
      [ $# -ge 2 ] || { echo "✗ --engine needs a version or a path." >&2; exit 1; }
      engine="$2"
      shift 2
      ;;
    --) shift; extra=("$@"); break ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "✗ Unknown option: $1 (scripts/dev.sh --help)" >&2; exit 1 ;;
  esac
done

cd "$(dirname "$0")/.."
cargo tauri --version >/dev/null 2>&1 || { echo "✗ cargo tauri not found: cargo install tauri-cli" >&2; exit 1; }

# Downloads Snapmaker Orca <version>'s official macOS package into <dest>.
# Nothing is ever deleted recursively: the signature is checked on the
# mounted package before anything is copied, and the cleanup removes the
# one downloaded file and its two empty folders (rmdir refuses others).
fetch_macos() {
  local version="$1" dest="$2"
  command -v gh >/dev/null || { echo "✗ gh not found (brew install gh), or give the engine's path." >&2; exit 1; }
  dmg="Snapmaker_Orca_Mac_universal_V$version.dmg"
  tmp=$(mktemp -d)
  trap cleanup_fetch EXIT
  echo "Downloading Snapmaker Orca $version for macOS (once)…"
  gh release download "v$version" --repo Snapmaker/OrcaSlicer -p "$dmg" -D "$tmp" \
    || { echo "✗ No macOS package for Snapmaker Orca v$version in Snapmaker's releases." >&2; exit 1; }
  mkdir "$tmp/mnt"
  hdiutil attach "$tmp/$dmg" -nobrowse -readonly -mountpoint "$tmp/mnt" >/dev/null
  codesign --verify --deep --strict "$tmp/mnt/Snapmaker Orca.app" \
    || { echo "✗ The downloaded app's signature does not check out: nothing copied." >&2; exit 1; }
  mkdir -p "$dest"
  ditto "$tmp/mnt/Snapmaker Orca.app" "$dest/Snapmaker Orca.app"
  # Now: `exec` below would skip the EXIT trap.
  cleanup_fetch
  trap - EXIT
}

cleanup_fetch() {
  [ -n "${tmp:-}" ] || return 0
  hdiutil detach "$tmp/mnt" >/dev/null 2>&1 || true
  rm -f "$tmp/$dmg"
  rmdir "$tmp/mnt" "$tmp" 2>/dev/null || true
}

if [ -n "$engine" ]; then
  if [[ "$engine" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$ ]]; then
    version="${engine#v}"
    dir="$HOME/snapstudio-dev-engines/orca-$version"
    case "$(uname -s)" in
      Darwin)
        path="$dir/Snapmaker Orca.app"
        [ -d "$path" ] || fetch_macos "$version" "$dir"
        ;;
      *)
        path=$(find "$dir" -maxdepth 2 \( -name AppRun -o -name '*.AppImage' -o -name 'Snapmaker_Orca*' \) -print -quit 2>/dev/null || true)
        [ -n "$path" ] || { echo "✗ No engine in $dir: put Snapmaker Orca $version there, or give its path." >&2; exit 1; }
        ;;
    esac
  else
    path="$engine"
  fi
  [ -e "$path" ] || { echo "✗ No engine at $path" >&2; exit 1; }
  path=$(cd "$(dirname "$path")" && pwd)/$(basename "$path")
  export SNAPSTUDIO_ENGINE="$path"
  echo "Engine: $path"
  echo "(Settings › Engine still shows engine.json's version; slices use this one.)"
fi

cd src-tauri
exec cargo tauri dev "${extra[@]+"${extra[@]}"}"

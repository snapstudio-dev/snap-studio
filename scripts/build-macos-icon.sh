#!/bin/sh
# Compile the Icon Composer source (src-tauri/icons/macos/AppIcon.icon) into
# src-tauri/icons/macos/Assets.car, which macOS 26+ uses for the Dock and
# Finder (CFBundleIconName in Info.plist). Needs Xcode 26 or later; run by
# scripts/build-icons.py after the layer is rebuilt from the original art.
# Commit the resulting Assets.car.
set -eu
cd "$(dirname "$0")/../src-tauri/icons/macos"
out=$(mktemp -d)
xcrun actool AppIcon.icon --compile "$out" --output-format human-readable-text \
  --notices --warnings --errors --output-partial-info-plist "$out/partial.plist" \
  --app-icon AppIcon --include-all-app-icons --enable-on-demand-resources NO \
  --development-region en --target-device mac --minimum-deployment-target 11.0 \
  --platform macosx
cp "$out/Assets.car" Assets.car
rm -rf "$out"
echo "Updated $(pwd)/Assets.car"

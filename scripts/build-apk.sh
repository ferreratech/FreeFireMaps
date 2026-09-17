#!/usr/bin/env bash
# Build a sideloadable Android APK locally (no EAS, no Expo account).
#
#   npm run build:apk            -> dist-apk/freefiremaps-<version>-arm64.apk
#
# Needs the toolchain in ~/.android-env (JDK17 + Android SDK). `expo prebuild`
# regenerates native android/ from app.config.ts (gitignored; config is source
# of truth). Release build is signed with the debug keystore — fine for
# sideloading, wrong for the Play Store.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1090
source "$HOME/.android-env"

VERSION=$(node -p "require('./package.json').version")
OUT="dist-apk"
mkdir -p "$OUT"

echo "→ verify georeference transform + inverse round-trip"
node scripts/verify-transform.mjs

echo "→ verify persistence round-trip (pins/trace storage)"
node scripts/verify-storage.mjs

# GATE: the SVG overlay must be viewport-sized and outside the zoom transform
# (a page-sized overlay exceeds Android's single-bitmap limit and crashes).
echo "→ verify overlay bounds (bitmap-size gate)"
node scripts/verify-overlay-bounds.mjs
# GATE: pan/zoom + overlay geometry invariants (pinch focal fixed, overlay==transform)
node scripts/verify-geometry.mjs
# GATE: PDF rendering path (local PdfRenderer module wiring + sharp-tile math)
echo "→ verify renderer (tile math + module wiring)"
node scripts/verify-renderer.mjs

echo "→ prebuild (android/)"
npx expo prebuild --platform android --no-install --clean >/dev/null

# GATE: every native module the JS imports (plus the boot-critical Expo modules
# expo-router pulls in) must be in the generated autolinking output. This is the
# check that catches a "Cannot find native module 'X'" startup crash without a
# device. Runs after prebuild (needs android/ autolinking), before gradle.
echo "→ verify native-module linkage (build gate)"
node scripts/verify-native-modules.mjs

ABIS="${ABIS:-arm64-v8a}"
ARCH_FLAG=""
SUFFIX="-arm64"
if [[ "$ABIS" == "all" ]]; then SUFFIX=""; else ARCH_FLAG="-PreactNativeArchitectures=$ABIS"; fi

echo "→ gradle assembleRelease ($ABIS)"
( cd android && ./gradlew --no-daemon assembleRelease $ARCH_FLAG )

APK="android/app/build/outputs/apk/release/app-release.apk"
cp "$APK" "$OUT/freefiremaps-$VERSION$SUFFIX.apk"

# GATE: the APK must be self-contained — the JS bundle (Hermes bytecode) must be
# embedded so first launch works fully offline with no Metro/dev server. Uses
# Python's zipfile (always present) rather than `unzip` (not installed here).
echo "→ verify embedded JS bundle (self-contained gate)"
python3 - "$OUT/freefiremaps-$VERSION$SUFFIX.apk" <<'PY'
import sys, zipfile
apk = sys.argv[1]
z = zipfile.ZipFile(apk)
names = z.namelist()
entry = 'assets/index.android.bundle'
if entry not in names:
    print(f"✗ GATE FAILED: {entry} is missing from the APK — not self-contained.")
    sys.exit(1)
info = z.getinfo(entry)
if info.file_size < 100000:
    print(f"✗ GATE FAILED: {entry} is only {info.file_size} bytes — looks like a stub, not a real bundle.")
    sys.exit(1)
magic = z.read(entry)[:4]
kind = 'Hermes bytecode' if magic == bytes.fromhex('c61fbc03') else 'plain JS'
print(f"  ✓ {entry} embedded — {info.file_size} bytes ({kind})")
print("  ✓ APK is self-contained: JS bundle ships inside; no Metro/dev server needed.")
PY

# GATE: the native renderer class is really compiled into the APK's dex.
echo "→ verify renderer class is in the APK"
node scripts/verify-renderer.mjs --apk "$OUT/freefiremaps-$VERSION$SUFFIX.apk" | tail -3

ls -la "$OUT/freefiremaps-$VERSION$SUFFIX.apk"
echo "✓ $OUT/freefiremaps-$VERSION$SUFFIX.apk"

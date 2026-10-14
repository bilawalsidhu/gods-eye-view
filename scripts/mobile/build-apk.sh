#!/usr/bin/env bash
# Build the installable Android debug APK for God's Eye View.
#
# Usage: ./scripts/mobile/build-apk.sh
#
# Runs the web build, syncs it into the Capacitor shell, then assembles the
# debug APK with Gradle. Requires a JDK and the Android SDK
# (`ANDROID_HOME` or `ANDROID_SDK_ROOT` pointing at platform-37 plus
# build-tools). Output: android/app/build/outputs/apk/debug/app-debug.apk.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

npm run build
npx cap sync android

cd android
./gradlew assembleDebug

APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"
echo "APK: $APK"

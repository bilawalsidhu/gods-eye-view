#!/usr/bin/env bash
# Build the DroidEye debug APK on macOS.
#   ./droideye/build-apk.sh                                  -> app loads your Mac (Wi-Fi IP, port 4173)
#   ./droideye/build-apk.sh https://droideye.onrender.com    -> app loads the hosted server
# Output: DroidEye-debug.apk in the project root.
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${1:-}"
if [ -z "$URL" ]; then
  IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  [ -n "$IP" ] || { echo "No Wi-Fi IP found. Pass a server URL: ./droideye/build-apk.sh https://..."; exit 1; }
  URL="http://$IP:4173"
fi

# Use Android Studio's bundled Java and the default SDK location unless already set.
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
[ -x "$JAVA_HOME/bin/java" ] || { echo "Java not found at $JAVA_HOME. Set JAVA_HOME to a JDK 21."; exit 1; }
[ -d "$ANDROID_HOME" ] || { echo "Android SDK not found at $ANDROID_HOME. Set ANDROID_HOME."; exit 1; }
[ -f android/local.properties ] || echo "sdk.dir=$ANDROID_HOME" > android/local.properties

[ -d node_modules/@capacitor/android ] || npm ci

node droideye/set-server.mjs "$URL"
npx cap sync android
(cd android && ./gradlew assembleDebug)

cp android/app/build/outputs/apk/debug/app-debug.apk DroidEye-debug.apk
echo
echo "APK ready: $(pwd)/DroidEye-debug.apk  (loads $URL)"
echo "Install on a plugged-in phone: adb install -r DroidEye-debug.apk"

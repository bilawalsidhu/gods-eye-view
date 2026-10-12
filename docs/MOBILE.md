# Mobile (Android Capacitor shell)

Experimental: God's Eye View wrapped as an installable Android app via
Capacitor. App ID `ai.halfpixel.gev`, `capacitor.config.ts` at the repo root,
native shell under `android/`.

## Status

- SDK pins: `compileSdk` 37, `targetSdk` 37, `minSdk` 24
  (`android/variables.gradle`, consumed by `android/app/build.gradle`).
- APK assembly is currently BLOCKED: no stable `android-37` platform is
  published yet, so `./scripts/mobile/build-apk.sh` cannot finish on any
  runner. Keep the 37 pins; do NOT downgrade to ship an APK.
- The WebGL2 fallback probe (`src/mobile/webglSupport.js`) exists but is
  UNWIRED: nothing in the boot path calls it yet. Wiring it in is Plan 3
  work. On a device without WebGL2 the globe behavior is unchanged from the
  web build until then.

## Build and sideload

Prerequisites: JDK, and (once published) the Android SDK with platform-37
plus build-tools (`ANDROID_HOME` or `ANDROID_SDK_ROOT`).

```sh
./scripts/mobile/build-apk.sh
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

`build-apk.sh` runs `npm run build`, `npx cap sync android`, then
`./gradlew assembleDebug`. `adb install` reinstalls over the previous
debug build; uninstall first (`adb uninstall ai.halfpixel.gev`) if the
signing key changed.

## Smoke check and release pipeline

```sh
node scripts/mobile/smoke-check.mjs [--require-apk]
```

Without flags it asserts the static surface: `dist/index.html` exists, the
`android/` project exists, the 37/37/24 SDK pins, and the `INTERNET`
permission. With `--require-apk` (or automatically when an Android SDK is
detected) it additionally requires
`android/app/build/outputs/apk/debug/app-debug.apk` to exist.

Release pipeline: on an SDK-37-capable runner, CI builds with
`./scripts/mobile/build-apk.sh` and gates the release on
`node scripts/mobile/smoke-check.mjs --require-apk`, attaching the
resulting `app-debug.apk` to the GitHub Release for sideloading. Status:
not yet runnable — APK assembly is blocked because no stable `android-37`
platform is published, so no green `--require-apk` run exists yet; the
static checks above pass in the meantime. Documented Play path (not yet
executed):
graduate the debug APK to a signed release bundle, declare microphone and
location use in the store listing, and complete Play data-safety review
before any production track.

## Fold compliance

The manifest places no orientation or aspect locks: no `screenOrientation`,
no `maxAspectRatio`, no `resizeableActivity=false`. The launcher activity
declares
`configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation|density"`,
so unfold/refold resizes in place instead of destroying and recreating the
activity.

Verified statically on this box (no Android SDK/emulator here):

- `android/app/src/main/AndroidManifest.xml` contains none of
  `screenOrientation`, `maxAspectRatio`, `resizeableActivity`.
- `configChanges` covers `orientation`, `screenSize`,
  `smallestScreenSize`, `screenLayout`, and `density`.
- `MainActivity` (a plain `BridgeActivity`) sets no orientation.

Still requires a real Fold device or Pixel Fold emulator (API 37): cover
display portrait, inner display landscape, an unfold transition mid-session
with layers on, and confirmation that the camera (3D tiles + globe)
survives the resize without a black canvas or crash. None of that has been
observed yet — do not claim otherwise.

## Backend URL setup

The app talks to a God's Eye View server (same-origin by default). Point it
elsewhere in Provider Settings: the Capacitor branch adds a Backend URL row
(same row styling as the key rows) that persists an `https://host` base via
`src/mobile/keyStore.js` (`readApiBase`/`writeApiBase`, storage key
`GEV_API_BASE`). Only `https://host[:port]` values persist; anything else
clears the override and the app falls back to same-origin. The production
store is the Capacitor Preferences plugin, dynamically imported so the web
bundle never fetches it; outside Capacitor it falls back to a `localStorage`
mirror. Values are never logged. Boot reads the override first through
`src/mobile/runtimeConfig.js` (`storedApiBase`, `endpointSet`).

## Key model (BYOK)

Keys are bring-your-own and live with the user's own backend: enter them in
Provider Settings on the server the app points at. This plan adds no
encrypted on-device key storage — that is Plan 2. Until then, treat keys on
a shared or lost device as exposed and rotate them.

Google map tiles are metered and OFF by default: without a Google Maps API
key the photoreal/3D source stays unavailable with a key-guided notice
(pinned by `src/mobile/reviewGates.test.mjs`). Enabling it bills the key
holder per tile — on cell data an unfold or a long pan across the inner
display can pull many high-resolution tiles, so prefer Wi-Fi or keep the
metered source off when bandwidth matters.

## Permissions

| Permission | Manifest entry | Used for |
| --- | --- | --- |
| Internet | `android.permission.INTERNET` | Tile, feed, and backend requests |
| Microphone | `android.permission.RECORD_AUDIO` | Voice control (push-to-talk) |
| Location | `android.permission.ACCESS_FINE_LOCATION` | Location search and nearby layers |

Microphone and location hardware are `required="false"`, so the app
installs on devices without them; the corresponding features refuse with an
honest unavailable state instead of crashing. Deny either permission at
runtime and voice/location report the denial rather than hanging.

## Known gaps

- Plan 2 — on-device API replacement: direct-to-upstream adapters over
  Capacitor HTTP, encrypted key storage, and the OpenAI realtime token flow
  without a Node server. Until then the phone needs its home server.
- Plan 3 — mobile/foldable UI: responsive rails, touch-first cockpit,
  cover-vs-inner layouts, battery/data savers, and wiring the WebGL2
  fallback into the boot path.

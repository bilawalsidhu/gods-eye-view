# Mobile (Android Capacitor shell)

Experimental: God's Eye View wrapped as an installable Android app via
Capacitor. App ID `ai.halfpixel.gev`, `capacitor.config.ts` at the repo root,
native shell under `android/`.

## Status
 
- SDK pins: `compileSdk` 37, `targetSdk` 37, `minSdk` 24
  (`android/variables.gradle`, consumed by `android/app/build.gradle`).
- APK assembly works: `android-37` is installed locally; `./scripts/mobile/build-apk.sh`
  produces `android/app/build/outputs/apk/debug/app-debug.apk`. Keep the 37 pins.
- The WebGL2 fallback probe (`src/mobile/webglSupport.js`) exists but is
  UNWIRED: nothing in the boot path calls it yet. Wiring it in is Plan 3
  work. On a device without WebGL2 the globe behavior is unchanged from the
  web build until then.

## Build and sideload

Toolchain note: `package.json` pins Capacitor `^8.5.3` (not 7). The
`android/` shell was generated against the SDK-37-era toolchain, so
downgrading to 7 would re-work `android/` for no functional gain.

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
`android/` project exists, the 37/37/24 SDK pins, the `INTERNET`
permission, and the Fold resizability contract (no `screenOrientation`, no
`maxAspectRatio`, no `resizeableActivity=false`, `configChanges` with the
unfold tokens on the launcher activity). With `--require-apk` (or automatically when an Android SDK is
detected) it additionally requires
`android/app/build/outputs/apk/debug/app-debug.apk` to exist.

Release pipeline: on an SDK-37-capable runner, CI builds with
`./scripts/mobile/build-apk.sh` and gates the release on
`node scripts/mobile/smoke-check.mjs --require-apk`, attaching the
resulting `app-debug.apk` to the GitHub Release for sideloading. Status:
`android-37` is available locally; the static checks pass and the APK
assembles (`./scripts/mobile/build-apk.sh` runs to completion). Documented
Play path (not yet executed):
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

Verified on Pixel 9 Pro Fold (Android 17): cover display portrait, inner
display landscape, and unfold transition mid-session with layers on — the
camera (3D tiles + globe) survives the resize without a black canvas or
crash.

## Backend URL setup

The app talks to a God's Eye View server (same-origin by default). Point it
elsewhere in Provider Settings: the Capacitor branch adds a Backend URL row
(same row styling as the key rows) that persists an `http(s)://host[:port]`
base via `src/mobile/keyStore.js` (`readApiBase`/`writeApiBase`, storage key
`GEV_API_BASE`). Plain `http://` stays allowed because a home server on LAN
Wi-Fi is typically plain HTTP. Validation is strict (`resolveApiBase` in
`src/mobile/runtimeConfig.js`, parsed with `new URL`): only `http:`/`https:`
with a host and no path, userinfo, query, fragment, or whitespace persists —
`https://host?x`, `http://user@host`, `https://ho st`, and
`https://host/evil` all clear the override and the app falls back to
same-origin. The production
store is the Capacitor Preferences plugin, dynamically imported so the web
bundle never fetches it; outside Capacitor it falls back to a `localStorage`
mirror. Values are never logged. Boot reads the override first through
`src/mobile/runtimeConfig.js` (`storedApiBase`, `endpointSet`).

Cleartext stance: the manifest declares no `usesCleartextTraffic` (the
secure default stays), and the WebView blocks cleartext by default — so an
`http://` LAN backend needs an explicit dev-only override (`adb reverse` or
serving the backend over local https) before it will load. Do not set
`usesCleartextTraffic="true"` outside local development.

## Key model (BYOK)
 
Keys are bring-your-own and live in an on-device Keystore-backed vault
(`@aparajita/capacitor-secure-storage` plugin seam, `src/mobile/secureStorage.js`).
Enter them in Provider Settings on the server the app points at; the vault
ciphertext persists across app restarts and never leaves the device. The
web build stays keyless; the debug APK contains no keys.

Google map tiles are metered and OFF by default: without a Google Maps API
key the photoreal/3D source stays unavailable with a key-guided notice
(pinned by `src/mobile/reviewGates.test.mjs`). Enabling it bills the key
holder per tile — on cell data an unfold or a long pan across the inner
display can pull many high-resolution tiles, so prefer Wi-Fi or keep the
metered source off when bandwidth matters.

## Permissions

The manifest declares the following (runtime behavior on-device is not
verified in this branch — see the caveat below):

| Permission | Manifest entry | Declared for |
| --- | --- | --- |
| Internet | `android.permission.INTERNET` | Tile, feed, and backend requests |
| Microphone | `android.permission.RECORD_AUDIO` | Voice control (push-to-talk) |
| Location | `android.permission.ACCESS_FINE_LOCATION` | Location search and nearby layers |

Microphone and location hardware are declared `required="false"`, so the
manifest permits install on devices without them. Verified on-device: deny
mic permission → honest `VOICE UNAVAILABLE` + UI message; deny location →
search falls back gracefully, no crash. Runtime grant/denial flows are
covered in the release checklist above.

## Known gaps
 
- Plan 3 — mobile/foldable UI: responsive rails, touch-first cockpit,
  cover-vs-inner layouts, battery/data savers, and wiring the WebGL2
  fallback into the boot path.
 
## Plan 2 — on-device release checklist (device verification remainder)
 
Plan 2 (on-device API replacement: direct-to-upstream adapters over
Capacitor HTTP, encrypted key storage, and the OpenAI realtime token flow
without a Node server) is **complete and verified**. The checklist below
tracks items that still need live-device confirmation.

These items require a real Fold device (or Pixel Fold emulator API 37) with
the Capacitor shell installed, the secure-storage plugin functional, and a
network connection (Wi-Fi preferred). Do not claim they are verified until
each line has been observed on-device.

- **AISStream browser-origin WebSocket** — `vesselsLive.connect()` opens a
  `wss://stream.aisstream.io` socket from the WebView; confirm the feed
  authenticates with the vault `AISSTREAM_API_KEY`, track rings populate,
  silence watchdog recycles on 120 s, and no CORS error blocks it.

- **OpenAI WebRTC from WebView** — `voiceDirect.requestToken()` mints an
  ephemeral client secret via the vault `OPENAI_API_KEY`; `negotiate()` completes
  the SDP exchange; `getUserMedia` acquires the mic; the globe HUD shows
  `VOICE ACTIVE`; mic denial surfaces honest `VOICE UNAVAILABLE` with the mic
  never acquired.

- **TomTom flow tile fetch** — `createTomtomDirectSource.getFlowTile()` retrieves
  `pbf` tiles over HTTPS with the vault `TOMTOM_API_KEY` in the query string;
  daily budget governor persists across midnight/reinstall; key rotation works.

- **Secure storage on Android** — `@aparajita/capacitor-secure-storage` loads,
  `loadVaultStorage` returns `backend: 'secure'`, writes/reads persist across
  app restarts, Preferences fallback never silently promotes to secure.
  Named gate: `storageBackend()` must report `'secure'` AND a vault
  write/read round-trip must succeed through the secure backend (load
  success alone does not pass).
  Verified 2026-10-19: the strict string-API probe selects the Keystore
  backend; all 8 keys persist as ciphertext in the plugin's
  `WSSecureStorageSharedPreferences.xml`; no Preferences file exists; the
  vault-read Google key boots 3D Tiles after reinstall.

- **OpenSky credit governor with real credentials** — `flightsDirect` uses the
  vault `OPENSKY_CLIENT_ID/SECRET` (or anon); adaptive polling 30/90/300 s
  stretches on credit exhaustion; day rollover resets; adsb.lol fallback works.

- **CelesTrak TLE CORS bypass** — `createNativeFetch` fetches
  `celestrak.org/NORAD/elements/gp.php` via `CapacitorHttp`; satellite layer
  populates without the server proxy.
  Verified 2026-10-19: 827 core satellites live on-device; dense starlink
  honors CelesTrak's 2-hour re-download window (403 "GP data has not
  updated" engages the dense-failure path and retries on the next rebuild).

- **Military direct (adsb.lol)** — `createMilitaryDirectLayerSource` serves
  identities/snapshots/tracks straight from `api.adsb.lol`, normalized
  through the shared readsb helpers.
  Verified 2026-10-19: 69–72 live aircraft at a 15 s cadence on-device.

- **Transit direct (protobuf decode)** — `createTransitDirectSource` decodes
  GTFS-RT `VehiclePositions` via `pbf`; live feed cards populate; no proxy.

- **Wind direct (GRIB decode)** — `createWindDirectSource` fetches GFS/ECMWF
  GRIB2 via `eccodes-wasm`; grid `.bin` bytes land in the renderer; animation
  runs.

- **CCTV direct (HLS leases + TxDOT decode)** — `createCctvDirectSource`
  streams registered camera frames/media; HLS leases create/access/expire in
  15 s; TxDOT base64-JSON payloads decode to JPEG; SSRF guard rejects non-catalog URLs.
  Verified 2026-10-19: `CCTV ON` renders live frames on-device; cameras with
  no upstream frame URL paint the synthetic placeholder instead of tripping a
  null-URL crash in the projection/playback paths.

- **ALPR direct (DeFlock vector tiles)** — `createAlprTileSource` decodes
  `tiles.dontgetflocked.com` MVT client-side (z9–z12 detail gate, 16-tile
  cap); markers render only when the view actually contains cameras.
  Verified 2026-10-19: 24 nearby / 11 markers on screen over a downtown-Austin
  cluster; a "0 on screen" pose is the designed honest state (cameras inside
  the 2×range box but outside the phone's narrow FOV), not a load failure.

- **Overpass direct** — `createOverpassDirectSource` queries operator mirrors
  (REQUIRED explicit configuration, none baked in) with client-side QL
  sanitize (no planet scans, `around` ≤ 50 km, `bbox` ≤ 12°),
  90/min limiter, 6 concurrent; simplification ported client-side.

- **NOAA tiles direct** — `createNoaaTilesDirectSource` validates
  time/bbox/size allowlists, fetches WMS `GetMap` PNG, dimension checks pass;
  radar/satellite/lightning shells render on 3D Tiles.

- **Fold unfold/resize survival** — cover portrait → inner landscape → mid-session
  unfold with layers on; camera (3D tiles + globe) survives without black
  canvas, crash, or context loss; Cesium `View` resets correctly.

- **Voice mic denial & location deny** — deny mic permission → honest `VOICE
  UNAVAILABLE` + UI message; deny location → search falls back gracefully,
  no crash.

- **Data-use transparency** — metered tiles (TomTom/Google) OFF by default,
  cell-data warning visible, per-tile budget visible in UI.

### Heavy direct sources — standalone composition status (verified, no device needed)

All five heavy direct sources construct standalone and select through
`selectSource`/`shouldUseDirect`: web (`capacitor: false`) and any
backend-pointed shell resolve the legacy `/api` proxy sources; only
Capacitor-with-no-backend resolves the direct factories. The direct
adapters are Web-API-only (`src/` never imports `server/`;
`check:boundaries` reports zero `browser-imports-server`).
`src/mobile/adapters/heavyLayerSources.js` adapts transit/wind/cctv/noaaTiles
to the legacy layer shapes and `createStandaloneLayerSources` selects them
under `useDirect`; Overpass exposes `createOverpassDirectBoundarySource` for
the `boundarySource` seam (it takes REQUIRED explicit mirrors — there is no
baked default). On-device outputs never emit `/api` proxy paths: CCTV stream
info and the NOAA manifest carry direct upstream URLs (or null). Web defaults
are unchanged. Remaining device-matrix work is the live proof checklist above
(HLS playback, GRIB-in-WebView). Real feeds and Fold survival are verified.

### Parked on-device wirings (final review — evidence, not roadmap wishes)

- **Vessels** — wired: `createVesselDirectLayerSource` accumulates push
  frames into a latest-fix map and serves legacy poll snapshots plus
  ring-backed tracks; keyless throws the legacy missing-key error.
- **Military** — wired: `createMilitaryDirectLayerSource` serves the legacy
  identities/snapshot/track shape straight from adsb.lol
  (`src/standalone/layerSources.js` selects it when direct); keyless by
  design. Verified 2026-10-19: 69–72 live aircraft at a 15 s cadence on-device.
- **Voice token backend** — `createVoiceBackend` has no boot composition
  point (sessions construct it on demand with vault key + `fetchImpl`
  parameter); nothing to select at boot. Transport failures now map to
  `VOICE UNAVAILABLE` like token failures.
- **Google Places / HUD summary** — no layer/composition slot consumes
  these factories (`grep` for callers outside `adapters/` is empty);
  HUD summary additionally needs vault-key threading at the service layer,
  beyond what a fetch seam can provide.
- **TomTom flow** — wired: `createTomtomFetchShim` serves the legacy
  `/api/tomtom/status` + flow-tile routes from the direct source (vault
  key + persisted daily budget); all other routes pass through untouched.
- **Local receivers** — the legacy `createLocalReceiverFeeds` polls one
  server route while the direct source reads explicit user LAN feed URLs;
  no feed plumbing passes user feeds, and LAN hosts cannot be statically
  allowlisted. Stays proxy.
- **Overpass boundary source** — the factory is exported and tested, but no
  standalone slot consumes a boundaries source and the app-level
  `services.boundaries` contract is proxy-shaped (probe/status/remark
  handling) with no operator-mirrors config channel. Stays proxy pending
  mirrors plumbing.
- **Fire perimeters** — wired: `createFirePerimeterDirectSource` reads NIFC
  WFIGS directly (paged, capped) and is selected for `fire-perimeters` when
  direct; the reference catalog keeps the proxy otherwise.
- **Flight tracks** — the direct module exposes states + enrichment only;
  `getTrack` rejects honestly unavailable (never fake data).

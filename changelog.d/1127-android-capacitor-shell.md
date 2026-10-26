- Add an experimental Android shell via Capacitor (app ID `ai.halfpixel.gev`,
  `compileSdk`/`targetSdk` 37, `minSdk` 24). `scripts/mobile/build-apk.sh`
  builds the web bundle, syncs it into `android/` and assembles
  `app-debug.apk`; `scripts/mobile/smoke-check.mjs` asserts the static
  surface (bundled `dist/index.html`, SDK pins, `INTERNET` permission) and
  requires the APK with `--require-apk` on an SDK-37-capable runner.
  `android-37` is available locally and the APK assembles. The manifest sets
  no orientation or aspect locks and the launcher activity handles unfold
  resizes in place via `configChanges`. Provider Settings gains a Backend URL
  row persisted through `src/mobile/keyStore.js` (Preferences plugin on-device,
  `localStorage` fallback, `http(s)://host` only, never logged); boot resolves
  the override through `src/mobile/runtimeConfig.js`. Keys are bring-your-own
  and live in an on-device Keystore-backed vault
  (`@aparajita/capacitor-secure-storage` plugin seam,
  `src/mobile/secureStorage.js`); the vault ciphertext persists across app
  restarts and never leaves the device. The WebGL2 fallback probe
  (`src/mobile/webglSupport.js`) is tested but unwired until the mobile UI
  pass. See `docs/MOBILE.md` (Razwerkz, #1127).
- On-device heavy feed adapters: transit decodes GTFS-RT VehiclePositions via
  `pbf`, wind decodes GFS GRIB2 via `eccodes-wasm`, CCTV decodes TxDOT
  base64-JSON snapshots and serves HLS through in-memory 15 s leases,
  Overpass queries operator mirrors with client-side QL sanitize (mirrors are
  required configuration, no baked defaults), and NOAA tiles validate
  time/bbox/size allowlists against nowCOAST WMS. Thin layer-boundary shapes
  select the direct sources only inside the Capacitor shell with no backend
  configured; the web build keeps the same-origin proxies untouched
  (Razwerkz, #1127).
- Provider Settings destructive actions (vault row removal, server-key removal)
  confirm inline with a two-click arm/disarm control instead of the blocking
  `globalThis.confirm` dialog, so removal works the same on web and in the
  Capacitor shell (Razwerkz, #1127).

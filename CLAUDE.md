# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

God's Eye View is a browser-based real-time geospatial intelligence console with a photorealistic 3D globe. It visualizes live aircraft, ships, satellites, earthquakes, traffic, CCTV cameras, and radio stations — with voice control powered by the OpenAI Realtime API. Built with vanilla JavaScript, CesiumJS, and Vite.

## Build Commands

```bash
# Install dependencies
npm install

# Development server (requires GOOGLE_MAPS_API_KEY in .env)
npm run dev -- --host localhost --port 4173

# Production build
npm run build

# Lint (ESLint 9 flat config, zero warnings tolerated)
npm run lint

# Unit tests (headless, no browser required)
npm test

# Tracking regression tests
npm run test:track

# Map source tray QA
npm run qa:map-source-tray
```

**Node.js requirement**: 24.14.x or 26.x (enforced by `package.json`).

## Architecture

### Entry Point
`src/main.js` bootstraps the entire application:
1. Creates Cesium viewer with Google Photorealistic 3D Tiles
2. Initializes `MapStackController` for basemap switching (Google 3D / Bing / OSM)
3. Registers all data layers with `DataLayerManager`
4. Sets up `StyleManager` (HUD, panels, styles, share links)
5. Initializes voice commands via `initGevVoiceCommands()`
6. Initializes annotation whiteboard via `initAnnotations()`

### Data Layer System (`src/data/`)
Each live layer is a separate module. All layers implement a common registration pattern and are managed by `DataLayerManager`:

| Layer | File | Source |
|-------|------|--------|
| Flights | `flights.js` | OpenSky + adsb.lol |
| Military flights | `militaryFlights.js` | adsb.lol |
| Vessels | `aisLiveVessels.js` | AISStream (WebSocket) |
| Satellites | `satellites.js` | CelesTrak (SGP4 propagation) |
| Planets | `planets.js` | Computed ephemeris |
| Earthquakes | `earthquakes.js` | USGS |
| Traffic | `traffic.js` | TomTom tiles |
| Transit vehicles | `transitVehicles.js` | GTFS-RT (MBTA, OVapi, Metro Transit) |
| Synthetic traffic | `syntheticTraffic.js` | TomTom flow fallback (only where no GTFS-RT coverage) |
| CCTV | `cctv.js` | City APIs (Austin, Caltrans, TfL) |
| Radio | `radio.js` | Radio Browser |
| Bikeshare | `bikeshare.js` | GBFS feeds |
| Fire detection | `firmsHeatmap.js` | NASA FIRMS |
| Rocket launches | `rocketLaunches.js` | Launch Library 2 |
| Military installations | `militaryInstallations.js` | Overpass + Google Places (via proxy) |
| Military awareness | `militaryAwareness.js` | Cross-layer fusion (adsb.lol/AIS/Overpass) |

Bundled static data in `src/data/local_data/`: datacenters, dams, submarine cables, Natural Earth regions, neighborhoods.

### Voice System (`src/voice/`)
- `realtimeSession.js` — The 28 frozen voice-tool schemas + shared session config builder (used by both the dev proxy and the Pages Function)
- `gevRealtime.js` — OpenAI Realtime session management (WebRTC, state machine, UI)
- `gevActions.js` — Tool implementations (camera control, layer management, annotation)
- `voiceCost.js` — Model selection and cost tracking

### Annotation System (`src/annotations/`)
Voice whiteboard for drawing on the 3D world:
- `annotationResolver.js` — Geocodes place names to geometry (OpenStreetMap Overpass)
- `worldAnnotationRenderer.js` — Renders annotations on the globe surface
- `screenAnnotationRenderer.js` — Renders callouts/arrows in screen space
- `annotationEngine.js` — Orchestrates drawing, animation, persistence

### Scenes (`src/scenes/`)
`director.js` handles deterministic cinematic camera tours for social clip capture.

### Key Supporting Modules
- `ui.js` — Runtime UI, panels, HUD rendering, style system
- `hud.js` — Intelligence-style telemetry readout + AI scene summary
- `cameraVerbs.js` — Drone-operator camera commands (orbit, fly-to, route-follow)
- `mapStackController.js` — Basemap switching with Cesium ion / Google 3D / OSM
- `cockpitTracking.js` — Aircraft follow-camera with terrain holding
- `renderGovernor.js` — Idle render loop optimization (requestRenderMode)

### Detection Overlay (`src/data/detection.js`)
Renders styled screen-space bounding boxes (brackets + callout labels) over tracked objects.
Five-stop density profiles (OFF/SPARSE/BALANCED/DENSE). Uses a Canvas2D overlay on top of
Cesium with a shared world-overlay host/lane architecture. The arbiter-based label placement
runs on a 125ms throttle (`LABEL_SOLVE_INTERVAL_MS`). Debug with `?detectDebug=1`.

### Overlays (`src/overlays/`)
World-overlay host (`worldOverlay.js`) manages a z-ordered stack of canvas paint lanes.
Each lane registers a `painter` callback and optional `postRender`. Lanes include:
detection (brackets), callouts, labels, focus ring, scanlines. The host clears and composites
all lanes every frame the scene is in continuous render mode.

## Environment Variables

Copy `.env.example` to `.env`. Required:
- `GOOGLE_MAPS_API_KEY` — Google Maps 3D tiles (required for photoreal globe)

Optional: `OPENAI_API_KEY` (voice), `AISSTREAM_API_KEY`, `TOMTOM_API_KEY`, `NASA_FIRMS_API_KEY`, `OPENSKY_*`, `CESIUM_ION_TOKEN`, `LAUNCH_LIBRARY_2_TOKEN`

macOS: `scripts/dev-fresh.sh` pulls keys from Keychain.

## Testing

Unit tests use a headless harness (`scripts/run-unit-tests.mjs`), which runs the whole suite (parallel phase, then two serialized allocation probes). Test files are co-located with source (`*.test.mjs`). To run a single file, invoke node's runner directly:
```bash
node --test src/data/flights.test.mjs
```
Use plain filenames — `node --test` silently skips bracketed paths like `[[path]].test.mjs` (glob expands to nothing, exit 0, "tests 0"), so production Pages Function tests live next to their handlers under non-bracketed names (e.g. `functions/api/cctv/cctv.test.mjs`).

CI (`.github/workflows/ci.yml`) runs lint + the full suite (with `GEV_REQUIRE_ALLOCATION_GATE=1`) + build on every push/PR.

Accessibility: WCAG 2.1 A/AA is the gate (axe audit via `scripts/qa-a11y.mjs`, plus pinned census/contrast tests); the criterion-by-criterion AAA conformance ledger lives in `docs/ACCESSIBILITY.md` — axe has no `wcag21aaa`-tagged rules, so AAA claims rest on that ledger, not the audit tag.

Force AIS refresh for testing (layer modules live at `dataManager.layers.get(id).module` — there is no `_getLayer` helper):
```js
window.__godsEyeView?.dataManager?.layers?.get?.('ais-live-vessels')?.module?._loadLivePositionsForTest?.()
```

QA scripts under `scripts/qa-*.mjs` use Puppeteer for visual/behavioral testing and require a running dev server on port 4173.

## API Proxy

`vite.config.js` is a slim assembly; each dev-server proxy middleware lives in its own module under `vite/proxies/` (radio, celestrak, launches, tomtom, firms, terrain-heights, openzenith, adsbdb, overpass, opensky, adsblol, track-backfill, gbfs, cctv, ais-live, realtime, google-places, military-installations, regional, analytics, geocode — shared infrastructure in `_shared.js`). This keeps credentials server-side and adds caching/rate-limiting; unit tests import the per-endpoint modules directly (`src/data/*Proxy.test.mjs`).

**Dev/prod parity**: the keyless middlewares (celestrak, launches, adsbdb, opensky-track, adsblol mil/trace, cctv, openzenith, realtime token/debug-log, hud-summary, geocode, regional-brief) exist twice by design — as vite dev middlewares (`vite/proxies/*`, Node) and as Cloudflare Pages Functions (`functions/api/**`, workerd). Shared logic lives in worker-safe modules (`functions/_lib.js`, `functions/_upstream.js`, `functions/api/openzenith/_handler.js`, `src/data/cctvSources.js`, plus the per-endpoint policy modules `src/data/routePolicy.js`, `weatherEffectsPolicy.js`, `regionalBriefPolicy.js` (regional-brief — replaced the old always-empty Pages stub, so cockpit Regional News works on production deployments), `gbfsPolicy.js` and existing `overpassPolicy.js`/`terrainHeightsProxy.js`/`geocodePolicy.js`/`regionalBrief.js`) imported by BOTH runtimes; workerd has no `node:*`/`fs`/`Buffer`/`process`, so shared code sticks to web primitives (`Uint8Array`, `Request`/`Response`, `URLSearchParams`). Pages Function handlers are `.js` with JSDoc types — the three legacy `.ts` stubs were converted 2026-09-20 and `apiEndpoints.test.mjs` now rejects a `.ts` handler.

**Parity is enforced, not aspirational**: client code must compose `/api/...` URLs through the builder inventory in `src/config/apiEndpoints.js` (`import { api } from ...`) — no inline literals. `src/config/apiEndpoints.test.mjs` walks the dev plugins and the `functions/api/` tree and fails if any inventory route lacks a dev middleware or a Pages Function, if any mount/route is undeclared, or if any builder stops emitting its historical byte-exact URL. Never log the FIRMS upstream URL (it embeds the MAP_KEY).

## Global Exposed API

After init, `window.__godsEyeView` provides access to:
- `viewer` — Cesium viewer instance
- `styleManager` — UI/HUD/style controller
- `dataManager` — Layer manager
- `sceneDirector` — Cinematic scenes
- `annotations` — Whiteboard engine

## Performance Architecture

### Web Workers (`src/workers/`)

The app offloads heavy main-thread computation to Web Workers for parallelism:

**`aisVisibility.worker.js`** — Horizon occlusion for 12k+ AIS vessels.
Pure-JS WGS84 EllipsoidalOccluder (no Cesium dependency). Returns a `Uint8Array`
bitmask of visible vessel indices per request. Integrated via `getVisibilityWorker()`
/ `dispatchVisibilityWorker()` in `aisLiveVessels.js`.

**`detectionProjection.worker.js`** — Screen projection for detection overlay objects.
Handles: horizon occlusion, 4×4 view-projection transform, camera distance, AIR
reticle scaling. Returns projected `{sx, sy, halfW, halfH, visible}` per object.
Integrated into `_drawOverlay()` in `detection.js` — main thread falls back to
synchronous projection on first frame or when worker result isn't ready yet.

### Chunked Processing (`src/data/processChunked.js`)

`processChunked(items, chunkSize, handle, onComplete)` yields to the browser via
`requestIdleCallback` between chunks. Small arrays (≤1000 items) are processed
synchronously. Used by `aisLiveVessels.js` to normalize AIS rows without blocking
the main thread during bulk updates.

### Render Governor (`src/renderGovernor.js`)

Binary ref-counted render mode: callers call `holdContinuousRender()` / `releaseContinuousRender()`.
Keeps Cesium's `requestRenderMode` in continuous rendering when any consumer needs it.

### LabelArbiter (`src/data/labelArbiter.js`)

Spatial hash + ordered traversal for label placement. When density ≥ 90% of capacity,
switches from spatial search to ordered placement (fast-path). O(n) per solve, stable
across frames (incumbent preservation).

### Occluder Caching (`aisLiveVessels.js`)

`_cachedOccluder` is rebuilt only when camera position changes significantly. Skips
redundant horizon culling on stationary camera. Cache invalidated on AIS session reset.

## Rust / WASM (`rust/`)

Optional performance acceleration via WebAssembly:
- `rust/firms-renderer/` — FIRMS heat renderer (Gaussian splatting in WASM),
  WIRED into the cells LOD bands (`global`/`regional`): `src/data/firmsHeatmap.js`
  renders the legacy per-cell rectangle entities first (fallback + first
  paint), then `src/data/firmsHeatTexture.js` replaces them with ONE
  splat-texture ground rectangle via `render_heatmap(lons, lats, brights,
  width, height, bbox)` — N ground primitives → 1. Any load/render failure,
  or `?firmsWasm=0`, keeps the entity path. `getStats()` reports `renderer`
  ('entities' | 'wasm-texture'), `wasmRenderMs`, `textureSize`, `wasmError`.
- Build: `npm run build:wasm` (wasm-pack → `public/wasm/firms-renderer/`,
  gitignored; CI's build job regenerates it before `vite build`).
- Verified (2026-09-10, headless Chrome + dev server): real NASA data
  (37,437 detections), regional band 527 cells → 1 entity, splat pass
  14.8 ms regional / 42.6 ms global; numbers in `docs/PERFORMANCE.md`.
- Next WASM candidate (SGP4 batch propagation): MEASURED 2026-09-14 via the
  `satellitesDense` profiler scene — DOES NOT QUALIFY. Steady-state SGP4 is
  ~0.3 ms/frame (round-robin design keeps it off the hot path) and never
  appears in the CPU self-time top-10; the 191.9 ms full 10.7k-satellite pass
  is a path the design never takes per frame. Numbers in
  `docs/PERFORMANCE.md`. No WASM candidate is currently open.

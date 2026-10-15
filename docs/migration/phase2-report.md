# Phase 2 report: the globe engine and gev on Navara

Phase 2 put gev's application shell on an engine interface and added a
second engine behind it. `src/globe/` holds the contract, a Cesium engine and
a Navara engine (`@navaramap/three` 0.2.1). The app boots on Navara with
`?engine=navara`, with the map, camera, search, HUD and share links working
and the layers off. Cesium stays the default, and Cesium mode behaves as
before. Branch `migration/phase2-engine`, base `6193d50c` (the end of phase
1a).

**Choosing the engine:** `?engine=navara` (or `?engine=cesium`) in the URL;
otherwise the localStorage key `gev.engine` (`navara` or `cesium`), read by
`src/app/engineChoice.js`; otherwise Cesium. The storage key is a hidden
opt-in: nothing in the app writes it, so it is set only by hand (for example
`localStorage.setItem('gev.engine', 'navara')` in the console). An unknown
value or unreadable storage never selects Navara.

This is the exit criterion of the roadmap's phase 2. Layers keep running on
the Cesium viewer until phase 1c moves them onto the engine.

## History

| Commits | Content |
|---|---|
| `b43f0091`, `3a1ed636`, `11bee98f` | the contract (`src/globe/contract.js`), its engine-neutral suite and a fake engine on `src/geo` (Task 1) |
| `b1cd74eb`, `f645aae6` | the Cesium engine, `src/globe/cesium/` (Task 2) |
| `a2a5f344` | the app constructs the engine beside the viewer (Task 3) |
| `283c592f` … `8c5bba5f` | overlays, pick, services, credits and map sources use the engine; map sources become engine-neutral descriptions (Task 4) |
| `b1d02790`, `95aae465`, `487f74b7`, `8a760d21` | Navara pinned, the Navara engine, hardening, and the members Task 4 added (Tasks 6–7, cherry-picked) |
| `e0c67478` … `17a11e2a` | camera, navigation, orientation, share links, HUD and director flights on the engine; render holds on Navara (Task 5) |
| `9395fdc4` … `3f097ea1` | `?engine=navara` in the app, the build, the ground floor, attributions and the shell QA (Task 8) |
| Task 9 commits | shell QA across engines, the timing bench and this report |

Every commit passes `npm test` and `npm run check:boundaries`, with one
exception: between `95aae465` and `487f74b7` the Navara shape test fails,
because the members Task 4 added arrive only in `8a760d21`.

## What works on Navara

Checked headless by `scripts/qa-engine-shell.mjs` on the dev server and on
`vite preview` of a production build (see QA below):

- **Boot:** the app starts on Navara with no Cesium viewer
  (`window.__godsEyeView.viewer === null`) and shows the persistent notice
  "Experimental Navara engine / Layers, cockpit, director and voice are
  unavailable".
- **Map stacks:** Google Photorealistic 3D Tiles (with a Google key) and Esri
  imagery, and switching between them; OSM imagery and keyless terrain under
  Google tiles pass in the contract QA. ion World Terrain is wired but was
  never exercised live. Bing
  is unavailable on Navara, with a reason in the picker.
- **Camera:** boot flight, search ("Paris", "Tokyo"), city pills and POIs,
  north up, tilt, wheel zoom with a ground floor 30 m above the sampled
  surface, orbit, reset to the globe.
- **HUD:** coordinates, MGRS, altitude and the rest follow the camera.
- **Share links:** a hash written on either engine restores the same pose on
  either engine.
- **Attributions:** Navara's attribution card shows the Google line on
  screen.
- **Rendering on demand:** with the tiles loaded and the camera still, Navara
  renders no frames, as Cesium does.
- **Lazy loading:** Cesium mode requests no Navara code or assets.

## What is off on Navara

- **Layers:** the layer catalog is empty and the layer controls are inert
  stand-ins (`absentLayerControlServices()`). They stay on the viewer until
  1c.
- **Pick:** `picker.pick` and `drillPick` return nothing. Navara picks its
  meshes only on click gestures (`featureClick`); that maps to picks carried
  on input payloads, deferred to 1c together with the layers.
- **Google 3D tiles without a browser key:** on Navara they need a browser
  `googleApiKey`. A deployment that serves Google through the server token
  (`/api/google/tiles-token`, Cesium's route) has none in the browser, so
  Navara falls back to Esri imagery there until the S3 proxy (next steps).
- **Visual styles, bloom and sharpen:** no post-process stages, so the
  style buttons change nothing. The notice does not mention them.
- **Not constructed:** the cockpit, the director (so no data packs and no
  shot interactions), annotations and the draw tool, voice, the imagery box,
  scope mask, tracked-entity hold, embedded views, the first-run welcome
  (its choices turn on layers), CelestialRing, detection and the tracked
  readout.

## The contract

[`src/globe/contract.js`](../../src/globe/contract.js) defines
`GlobeEngine` in JSDoc, `createEngineEvent()` (the contract's own event
semantics), `assertGlobeEngine()` and `GLOBE_ENGINE_MEMBERS`. Positions are
`src/geo` values and angles are radians; pose angles follow Cesium's ranges.
The engine-neutral suite (`src/globe/testing/`) runs on the fake engine in
Node and on both real engines in `scripts/qa-globe-contract.mjs`.

The 58 required members:

| Capability | Members |
|---|---|
| — | `kind`, `destroy`, `isDestroyed` |
| `host` | `container`, `canvas`, `size` |
| `camera` | `pose`, `livePosition`, `height`, `setView`, `flyTo`, `flyToSphere`, `flightActive`, `lookAt`, `lookAtTransform`, `transform`, `release`, `cancelFlight`, `zoomIn`, `zoomOut`, `viewRectangle`, `pickEllipsoid`, `pickRay`, `changed`, `moveStart`, `moveEnd`, `commanded`, `percentageChanged` |
| `picker` | `pick`, `drillPick`, `pickPosition`, `pickPositionSupported`, `pickGlobe` |
| `projector` | `worldToWindow`, `viewProjection`, `horizonVisible` |
| `frames` | `preUpdate`, `preRender`, `postRender` |
| `render` | `request`, `setContinuous`, `isContinuous` |
| `surface` | `sampleHeight`, `supported`, `terrainHeight`, `terrainHeightSupported`, `clampToHeight`, `clampToHeightSupported`, `tilesLoaded` |
| `input` | `on`, `setCameraInputs` |
| `credits` | `addStatic` |
| `maps` | `setBaseImagery`, `setTerrain`, `setPhotorealTiles`, `releasePhotorealTiles`, `photorealActive`, `current` |

Against the plan's contract, the tasks added `livePosition`, `height`,
`flightActive`, `lookAtTransform`/`transform`, `zoomIn`/`zoomOut`,
`commanded`, `pickGlobe`, `viewProjection`, `horizonVisible`,
`terrainHeight`, `clampToHeight`, `releasePhotorealTiles`, `current`,
`isDestroyed`, `pose().aspectRatio`, input modifiers, `render.request(reason)`
and `flyTo` options `endTransform` and rectangle destinations. Each came with
suite checks. The suite also checks that `pickPosition` and `worldToWindow`
round-trip within 1.5 px (over New York, straight down and tilted) and that
`maps.setTerrain` resolves for keyless terrain and rejects an unknown kind,
on the fake and on both engines.

Three members have no shell caller in Navara mode yet and are kept for 1c:
`camera.flightActive` and `input.setCameraInputs` (the cockpit's camera
input lock) and `maps.current` (diagnostics).

`maps.*` take engine-neutral source descriptions from `maps/registry.js`
(`kind`, URL, keys); only the Cesium engine also gets prebuilt Cesium
providers.

## Deviations and known gaps

- **Pick on Navara deferred** (above). The ruling: picks arrive on the
  input payloads in 1c.
- **Visual styles off on Navara** (above).
- **Attribution card is closable.** Navara's card has a close button. Once
  it is closed, the data-provider lines are gone and only the ⓘ toggle and
  the Google Maps logo remain. Before Navara can be the default, gev needs an
  always-visible Google copyright line (mirrored into the HUD credit strip).
- **Worker-pool leak on a fast destroy.** Disposing a Navara view within about
  1.5 s of `init()` leaks about 11 workers: the pool's warm-up ignores
  `terminated`. Upstream ask; a possible mitigation is to defer dispose by
  about 2 s after init.
- **Frames after orbit while tiles stream.** After orbit stops on Navara,
  `render.isContinuous()` is false but Navara keeps rendering, up to 60 fps,
  while tiles stream in; it goes to 0 once the view settles. The shell QA
  records the rate (0 in the final runs; up to 90 frames in 1.5 s in
  Task 8's runs).
- **`cameraSensitivity` keeps two ledger keys.** It accepts an engine, a
  viewer or a camera, and a Cesium camera and `engine.camera` are separate
  keys. All layers have to switch together in 1c.
- **`cullPosition` stays a `Cesium.Cartesian3`,** because a test checks
  `instanceof`; it moves in 1c.
- **Director and data packs off on Navara.** The director is never
  constructed there, so neither startup nor a share link reaches the data-pack
  or interaction paths.
- **Layer paths still on the viewer:** `scenePick`, `groundSnap`,
  `meshFloorSampler` and the OSM and dynamic credits keep their viewer
  branches until 1c moves their callers.
- **Navara private internals,** all in
  [`src/globe/navara/internals.js`](../../src/globe/navara/internals.js),
  pinned to 0.2.1 by a test:
  - `ModelMesh.prototype._releaseGeometryArrays`, patched to keep tile
    positions and indices on the CPU for `surface.sampleHeight`;
  - `view._scenes.mrt`, the loaded 3D-tile roots;
  - `view._isIdle`, for `surface.tilesLoaded()`.
- **Upstream asks for Navara:**
  - an option to retain tile geometry for ray queries, or a
    `sampleHeight`/ray query over 3D tiles;
  - a public `isIdle`/`tilesLoaded` getter;
  - a fix for the worker-pool warm-up after `terminated`;
  - terrain or tile collision in the camera controller (gev adds its own
    floor, `src/globe/navara/groundFloor.js`);
  - a synchronous pick, or picks with ids for 3D tiles.
- **Other notes:**
  - Navara logs `THREE.WARNING: Multiple instances of Three.js being
    imported` (a warning, not an error).
  - ion World Terrain on Navara was never exercised live (no ion token in
    the test setup).
  - Navara hides the last raster layer instead of deleting it, to avoid a
    terrain bug when the layer count reaches 0.

## Bundle

| | `17a11e2a` (before Navara mode) | now |
|---|---|---|
| Main chunk (Cesium mode) | 2,844,121 B | 2,849,217 B (+5,096 B, +0.18 %) |
| Navara-mode app code (lazy) | — | 2,525 B |
| Navara engine chunk `navara-engine-*` (lazy) | — | 2,951,669 B |

The main chunk grew by about 5 KB for the mode branches only; no Navara or
three code is in it. `dist/` gains about 37 MB of Navara workers, wasm and
atmosphere assets, all loaded only on `?engine=navara`.

## Measurements

`scripts/qa-engine-bench.mjs`, headless Chrome with `--use-angle=metal
--disable-gpu-vsync --disable-frame-rate-limit`, 1280×800, on this Mac.
Each engine got one discarded warm-up run, then 3 runs, each in a fresh
browser context. Each cell is the median of that metric over the 3 runs
(per-metric medians, not the values of one median run).

- **Initial view:** navigation start to the startup pose (Austin, 600 m)
  with the camera still and the tiles loaded, both for 1.5 s; the time is
  when the later of the two began.
- **Flight:** the camera is set over Austin at 20 km looking down, the tiles
  load, then `flyTo` Paris at 20 km, 10 s, `cubicInOut`. Frame time is
  postRender to postRender over the flight.

| | Cesium dev | Navara dev | Cesium preview | Navara preview |
|---|---|---|---|---|
| Engine ready (ms) | 1,271 | 2,311 | 1,053 | 1,766 |
| Initial view (ms) | 8,322 | 12,816 | 8,109 | 12,411 |
| Flight frames per second | 57.6 | 201.1 | 55.4 | 206.2 |
| Frame time p50 (ms) | 21.0 | 3.9 | 21.4 | 3.7 |
| Frame time p95 (ms) | 23.6 | 10.1 | 24.3 | 10.0 |
| Longest frame (ms) | 38.9 | 267.3 | 30.6 | 360.2 |

Individual runs: initial view Cesium 8,316–8,522 (dev) and 8,009–8,409
(preview) ms; Navara 12,620–14,928 (dev) and 12,310–12,411 (preview) ms.
Navara's longest frame ranged 241–530 ms across all six runs.

Reading the numbers:

- **Headless numbers are indicative only:** no display, no vsync, one
  machine.
- **Startup:** Navara reaches the initial view 4.3 s (preview) to 4.5 s
  (dev) later than Cesium. Its engine is ready about 0.7–1 s later (the lazy
  chunk, wasm and workers); the rest is tile loading and refinement.
- **Flight:** the engines do different work. Cesium mode runs the default
  "normal" visual style's post-process stages, which Navara mode does not
  have. Cesium drew 55–59 frames per second while the browser ran 100–104
  animation frames per second, so Cesium drew roughly every other
  animation frame; the cause was not investigated. Navara drew one frame per
  animation frame, at about 200 per second.
- **Spikes:** Navara has single frames of 240–530 ms during the flight
  (Cesium's worst is 41 ms). They are likely tile-content uploads but were
  not profiled. Navara's 10 s flights also took 10.5–10.8 s of wall time
  against Cesium's 10.0 s.
- **Shell QA load times** (boot rest to tiles loaded): Cesium 1.3 s dev and
  1.0 s preview, Navara 4.1 s dev and 3.6 s preview.

## Screenshots

![Cesium and Navara at the same pose](phase2-side-by-side.jpg)

Both engines at `#lat=40.7060&lon=-74.0130&alt=900&heading=30&pitch=-25&roll=0`
(lower Manhattan), headless, once each engine reported its tiles loaded. The
framing is the same pixel for pixel: both cameras have a vertical field of
view of 39.683° at 1280×800 (60° across the wider side), and a
`pickPosition` → `worldToWindow` round trip lands within about 1 px on both
(the contract suite checks 1.5 px). The visible difference is Cesium mode's
default "normal" style, whose radial vignette darkens the corners on the
left; Navara (right) has no post-process stages. Navara also shows its
attribution card.

## QA

Final runs at the last commit, headless on free ports (never 4185):

| Check | Result |
|---|---|
| `npm test` | 6801 tests: 6800 pass, 0 fail, 1 skip (the Node 24 allocation budgets) |
| `npm run check:boundaries`, `npm run format:check` (1,412 files, every new phase 2 file included), `npm run build` | clean |
| `qa-globe-contract --engine=cesium` | 63/63 (56 contract, 7 engine) |
| `qa-globe-contract --engine=navara` | 66/66 (56 contract, 10 engine) |
| `qa-engine-shell`, dev server | Cesium 22/22, Navara 24/24, cross-engine 3/3 |
| `qa-engine-shell`, `vite preview` | Cesium 22/22, Navara 24/24, cross-engine 3/3 |

What `qa-engine-shell` measured, on dev (preview gave the same verdicts):

| Check | Cesium | Navara |
|---|---|---|
| Idle for 2 s after tiles load | 0 frames | 0 frames |
| Google line on screen | credit strip, Google Maps logo | attribution card, "Google" line inside the scrolled list |
| Search "Tokyo", HUD text parsed | 35°42'36.02"N 139°44'06.00"E, 8.5 km from the reference point | 35°42'36.00"N 139°44'06.00"E, 8.5 km |
| Wheel zoom floor over Paris (smallest clearance over the sampled surface on any frame) | 1 m (threshold ≥ −1 m) | 28.4 m dev, 29 m preview (threshold ≥ 25 m) |
| Share link reload on the same engine | Δ ≤ 1.4e-14° and 6e-9 m | Δ ≤ 7.1e-15° and 8e-9 m |
| Frames after orbit stops, over 1.5 s | 0 | 0 |
| Navara requests | 0 | 27 dev, 5 preview |
| Console errors | 0 | 0 |

Across engines:

- The Paris hash written on Cesium, opened on Navara, gives the pose that
  hash gave on Cesium, and the reverse: 0 m and 0° apart (tolerance 1 m and
  0.1°, heading and roll compared across the 0/360 seam). Both engines place
  the camera from the hash's rounded numbers, so they land identically.
- The side-by-side pose is also identical on both engines (0 m, 0°).

The "frames after orbit" gap above did not show in these runs (0 frames on
both servers); earlier runs recorded up to 90 frames in 1.5 s while tiles
streamed.

## Next steps

1. **Phase 1c: layers on the engine.** Move each layer family off the viewer
   onto the contract (picks on input payloads for Navara, render primitives
   through an engine-side layer host), then turn layers on in Navara mode.
2. **Google proxy (spike S3).** A same-origin `/api/google/tiles/*` proxy
   next to `/api/google/tiles-token`:
   - it rewrites `uri`/`url` in the tileset JSON, keeping `session`;
   - it authenticates upstream with `X-Goog-Api-Key` or a Bearer token from
     the existing token source (the spike tested only the header key);
   - it strips `key=` and fails closed with 502 if a key would still reach a
     response;
   - the CSP is unchanged (same origin), and it closes the browser-key gap
     above.

   Production also needs rate limits and per-user quotas, traffic
   accounting (about 1.8k upstream requests per 80 s city tour; 1,839 in the
   spike), a glb cache that honours Google's `Cache-Control`, streamed bodies
   and an origin check. Google's licence terms (attribution, caching only as
   the headers allow) stay with the app.
3. **Drape S1 in the product.** A drape post-effect with tiles, terrain and
   both modes, like Cesium's `ClassificationType`:
   - a height window of terrain −50 m to +600 m;
   - aircraft masked through G-buffer depth, which depends on the
     undocumented `raw.gbufferRenderTarget.depthTexture`, and gev's meshes
     must be `MeshDesc`;
   - about 0.8–0.9 ms p50 as its own `EffectPass` (an empty `EffectPass`
     alone costs about 0.8 ms) against 0.10 ms merged into tone mapping for
     a route and a block; the 256-segment stress case costs about 1 ms more
     even when merged;
   - real data needs a larger data texture and a grid for polygon edges
     (limits today: 256 segments, 8 polygons × 64 edges).

   Upstream asks (a drafted, unfiled issue): a native `clampToGround`
   drape for polylines and polygons (terrain, tiles or both), mergeable
   effects, and `effectIds` on tilesets without a batch table.
4. **Tile heights in `surface`.** Replace the retained-geometry patch with a
   public Navara height query over 3D tiles (the upstream ask above).
5. **An always-visible Google line** before Navara can be the default.
6. **A Dioxus UI, later,** once the shell no longer depends on Cesium.

# Slowdown audit, November 2026

A sweep of `main` (`c02ede3bb`, 13 November 2026) for bugs that freeze the page
or hold the frame rate down. This page lists what was found, why it happens and
how to fix it, and names the pull request that carries each fix.

[PERFORMANCE.md](PERFORMANCE.md) is the measured baseline of a healthy build;
this page is the list of things that fall outside it.

## How it was measured

- Keyless dev server, headless Chrome at 1440 x 900 on Apple silicon (Metal
  through ANGLE), default globe map.
- Per scenario: load, a spell at rest, scripted drags and wheel zooms, then a
  settle. Long tasks were counted with a `PerformanceObserver`, the hot function
  named from a CPU profile, and `globe.getHeight`, `scene.sampleHeight`,
  `scene.pick` and friends wrapped to count calls and time.
- A long task is one main-thread task over 50 ms. With no layers on, the
  baseline is two at load (longest about 240 ms) and none afterwards, with zero
  frames rendered while the camera is still.
- Four profiling sessions ran on one machine at the same time, so absolute
  timings carry some noise. Ratios against the baseline are what to read.

Nothing here was measured on Google Photorealistic 3D Tiles, on a discrete or
integrated PC GPU, or with keyed feeds (AISStream, FIRMS, TomTom). Those rows
are marked "read in code".

## Findings and fixes

Worst first. "Fix" names the pull request; a dash means none is open yet.

### Measured

| # | Where | What happens | Fix |
| ---: | --- | --- | --- |
| 1 | Bike Share, local data layers, Transit, Rail | 18 s freeze switching Bike Share on over New York (2,519 stations); 2.7 s on Data Centers; multi-second freezes with Transit while zooming | #1688, #1689 |
| 2 | Shipwrecks | 3 to 5 s freeze when the markers are built over loaded terrain; a share link with the layer on held the loading screen for 22.9 s in one run | — |
| 3 | Camera | Rendering stops until reload: at a whole-globe view looking straight down, pan a few times, then scroll one notch | — |
| 4 | Street Traffic | Zooming at 250 m over Manhattan: 25 long tasks in 24 s, longest 746 ms, 6.6 s in total | — |
| 5 | ALPR cameras | Up to a 1.9 s long task on load; eight off/on toggles cost 512 depth samples and 6.3 s | — |
| 6 | Wind | First zoom after load: up to 14 long tasks (longest 414 ms). Re-measured as one-off shader links, not a standing cost: see below | none proposed |
| 7 | Submarine cables | About 2 s of long tasks on load, heap briefly at 1 GB, about 0.5 s again on each re-enable | — |
| 8 | Live Flights at whole-globe view with detection labels | Fine on the test machine; at 4x CPU throttle, 8 fps with 143 long tasks in 15 s | — |
| 9 | Radio | 7 to 10 long tasks when the directory loads, longest 447 ms | — |
| 10 | Pointer pick | Not reproduced on a second look: see below | none needed |
| 11 | CCTV | A still-image camera holds continuous rendering at 60 frames a second although its picture changes about every 10 s | — |

### Read in code

| # | Where | What happens | Fix |
| ---: | --- | --- | --- |
| 12 | `/api/firms` | The whole fire set is filtered, serialised and sent uncompressed on every request; 15 to 55 MB estimated in a heavy season | — |
| 13 | AIS store | Both vessel maps are walked on every position message, and sorted whole once past the cap | — |
| 14 | Satellite clouds on the 3D Tiles map | A CPU pass over a 4096 x 2048 image, 90 to 180 ms measured on a synthetic canvas, twice in a row | — |
| 15 | NVG and FLIR styles | Over 100 texture reads per pixel on every frame | — |
| 16 | Wind server | Full 0.25 degree GRIB fields decoded on the event loop, 200 to 600 ms estimated per refresh | — |
| 17 | Imported geo files and other per-feature ground clamps | Measured afterwards: imported files do not freeze; see below | none needed |

## Cause and fix, per finding

### 1. Terrain height reads

`globe.getHeight` casts a ray against the mesh of the tile under the point, and
`scene.sampleHeight` renders a depth pass. Transit asked for every trail fix of
every vehicle several times per poll; Bike Share sampled every station in one
go. The fix keeps heights per point in one shared reader with a read budget
(`src/services/terrainSurface.js`) and spreads the depth samples across frames.

### 2. Shipwrecks

`rebuild()` in `src/layers/shipwrecks/index.js` adds 7,958 billboards with
`heightReference: CLAMP_TO_GROUND`. Each constructor runs
`Billboard._updateClamping`, which intersects a ray with the terrain mesh,
synchronously: 4.8 of the 4.9 s. The cost is only paid when terrain is loaded
at the time the markers are built, so a cold start with the layer in the URL
sometimes escapes it.

Fix: do not clamp. Wrecks are at sea and the markers already ignore the depth
test, so place them on the ellipsoid with `HeightReference.NONE`.

### 3. Camera: rendering stops after pan then zoom

Pure Cesium; no application code is involved. Above 1,000 km,
`ScreenSpaceCameraController` `handleZoom` rotates the camera about the cross
product of the picked point's normal and the screen centre's normal whenever
their dot product is between 0 and 1. With the pointer on the exact centre pixel
the two are the same vector, yet `n · n` often rounds to `0.9999999999999999`,
so the check passes with a zero axis. `Camera.rotate` then throws
`DeveloperError: normalized result is not a number` from
`Scene.initializeFrame`, outside the scene's own try/catch, so
`scene.renderError` never fires and Cesium stops its render loop for good. The
pans in the first reproduction only moved the camera to a pose where the
rounding goes that way.

Fix: make `camera.rotate` ignore a zero or non-finite axis, and recover from any
stopped loop by restoring the last drawn camera pose and restarting it a bounded
number of times before showing Cesium's error panel.

### 4. Street Traffic road loading

Three costs in one task after the detail tiles arrive, in
`src/layers/traffic/source.js`:

- `outsideDetailTiles` clips every coarse z12 road against every loaded detail
  tile (up to 16) for four regions.
- The composed set is then handed on with `replace: true`, so
  `ingestion.js` parses every road again although each tile was parsed as it
  streamed.
- `parseRoads` (`model.js`) asks `cachedGroundFloor` once per coordinate, and
  each call builds several string keys.

Fix: clip once per coarse tile against the detail tiles' union box and slice the
work across frames (or do it in the vector-tile worker); reuse the roads parsed
while streaming and parse only the clipped coarse remainder; look the floor up
once per floor cell within a parse.

This is separate from the one-viewport-tile-at-a-time loading recorded in
[KNOWN-ISSUES.md](KNOWN-ISSUES.md).

### 5. ALPR cameras

`refineAnchors` and `anchorFor` in `src/layers/alpr/overlay.js` call
`scene.sampleHeight` from the overlay's paint, four per paint. Each is a depth
render and a `readPixels`; the first one also compiles the pick shader. Results
are kept on the entity, so a rebuild or a re-enable samples everything again.

Fix: on a terrain globe read `globe.getHeight` through the shared terrain reader
instead of sampling; keep the answers in a map keyed by camera that outlives the
entities; move what sampling remains out of the paint into a queue of one per
frame.

### 6. Wind

The first reading blamed the layer's 916,476 vertices for slow depth reads
during zoom. Measuring again did not support that: depth reads cost the same
with and without Wind, hiding every wind primitive left pick time unchanged, and
the stalls appear on the first zoom only, as shader programs link (seven
programs, about 0.5 s, long tasks up to 166 ms). Later zooms had none.

The roughly 30 renders a second are the animation itself. It is already capped
at 30 Hz and stops when paused, hidden, out of view or under reduced motion;
lowering the rate would change how the layer looks. `disable()` releases the
baked geometry on purpose, at the price of one task of about 130 ms on
re-enable.

No fix is proposed. Warming the shader programs before the first zoom is the
one thing left to try.

### 7. Submarine cables

`src/layers/submarineCables/ingestion.js` loads both collections through
`Cesium.GeoJsonDataSource` with `clampToGround`. Switching the layer on is one
task of about 1.4 s, and 1.2 s of it is Cesium reading the terrain height for
the 1,917 ground-clamped landing markers, all created in the first frame,
including the ones behind the globe.

Fix, first step: start the landing markers hidden and let the existing horizon
sweep show the visible ones a few dozen per frame.

Follow-up: one batched `GroundPolylinePrimitive` and one
`PointPrimitiveCollection` in place of the entity data sources would also remove
the transient 1 GB heap and the visualiser tasks of 100 to 250 ms. It needs a
decision on how unclamped landing points are hidden behind the globe.

### 8. Live Flights at whole-globe view

Two costs that scale with the 7,500 aircraft of a full poll:

- The fleet pass (`src/layers/flights/rendering.js`, every 80 ms) dead-reckons
  each visible aircraft and asks `cachedGroundFloor` for it, including aircraft
  at cruise altitude that can never touch the floor. Each lookup formats numbers
  to strings several times and rewrites a cache entry: 40% of the busy time.
- The detection overlay (`src/data/detection.js` `_drawOverlay`) collects every
  detectable object and strokes every bracket on every frame.

Fix for the first: skip the floor path for a contact clearly above any terrain,
make the floor-cell key a number, and stop promoting the cache entry on every
read.

The second turned out smaller than it looked. The bracket strokes are already
one path per colour, and collecting the objects is about 3 ms of a 56 ms frame
at 4x throttle once the first fix is in. What costs is the per-object loop in
`_drawOverlay` (projection, occlusion, alpha, twelve path calls per bracket),
about 13 ms per frame at 4x. Removing it means keeping the bracket paths across
frames while the camera and every contributing layer are unchanged, which needs
a revision signal from each detectable layer: a design change, left as a
follow-up.

### 9. Radio

`stationTags()` in `src/layers/radio/categories.js` splits and normalises a
station's tags on every `hasTag` call, and `buildRadioCategories` runs that for
every station against every category, twice.

Fix: normalise once per station at ingest and count categories from that.

### 10. Pointer pick

Three sessions saw a single `scene.pick` of 207 to 342 ms during a gesture and
attributed it to `pickPointer` in `src/voice/pointerPick.js`. Timing every pick
across pointer rests, drags and wheel bursts did not bear that out: of 78 picks
with CCTV on over London all but two took 3 to 8 ms, and with five heavy layers
on, 81 picks took 5 to 30 ms apart from the first (135 ms). `pickPointer` picks
at most once per pointer rest.

The slow pick is the first pick after a layer appears, once per page load, most
likely the pick shader compiling, and its stack is CCTV's own hover pick
(`src/layers/cctv/hover.js`). No fix is proposed: removing the dwell pick would
only move the one-off cost to the next click.

### 11. CCTV still-image cameras

`src/layers/cctv/projection.js` holds continuous rendering for as long as any
projected camera is active and redraws the projection every frame.

Fix: hold only for video. For a still image, request one render when a new image
lands or while a focus fade runs.

### 12. `/api/firms`

`server/providers/firms.js` builds the payload and calls `JSON.stringify` per
request, with no kept body and no compression, and the client refetches every
ten minutes.

Fix: build the body and its gzip once per refresh and serve those bytes, as the
OpenSky provider does.

### 13. AIS store

`server/providers/vessels/ais-store.js` calls `pruneAisStreamCache()` for every
message; the static-data map is never pruned.

Fix: prune on a timer, evict in insertion order, and drop a vessel's static
entry with the vessel.

### 14. Satellite clouds on the 3D Tiles map

`src/layers/weather/infraredImage.js` runs `getImageData`, a per-pixel power
curve and `putImageData` over the whole canvas.

Fix: a 256-entry lookup table applied in place for the canvas path; for the
shell, do the transfer in its fragment shader.

### 15. NVG and FLIR styles

`src/styles/surveillance.js` loops 11 x 11 texture reads per pixel and
`src/styles/thermal.js` totals 106.

Fix: a separable or half-resolution blur, and noise ticked at about 15 Hz.

### 16. Wind server

`server/providers/wind/decode.js` decodes about a million doubles per message
synchronously, hourly, for six keys.

Fix: decode in a worker thread and keep the decoded U and V fields per cycle.

### 17. Per-feature ground clamps

`heightReference: CLAMP_TO_GROUND` per feature is also set in
`installations/rendering.js`, `alpr/presentation.js`, `ghostMaps/index.js`,
`earthquakes/index.js`, `airQuality/index.js`, `news/index.js` and
`osmPlaces/index.js`. Their counts were small in these runs (30 to 1,500) and
none froze.

Imported geo files were the one unbounded case, and measuring them cleared
them: 20,000 generated points (the import cap) finish in about 1.5 s with a
longest task near 0.5 s, because `settleGroundPins` in
`src/data/geoFileImport.js` already places pins with `HeightReference.NONE` and
resolves heights 256 at a time with a yield between batches. No fix is needed.

## Checked and fine

- Start-up of a production build: viewer ready in about 0.5 s, loading screen
  gone at 1.6 s, three long tasks totalling about 300 ms.
- Idle: no frames rendered with no layers on; every render hold was released
  when its layer went off.
- Leaks: all 41 layers toggled three times and ten of them eight times; no
  timer, scene listener, primitive or data source grew per cycle. The heap
  levelled off near 320 MB over 7.5 minutes of toggling eleven layers.
- At most one long task after load: Military, Satellites (including 11,903
  Starlink points), Earthquakes, News, Wildlife, GNSS, Drone Airspace, Military
  Installations, Fire Perimeters, rain radar, lightning, and satellite clouds on
  the globe map.
- Live Flights at city scale with the same 7,500 aircraft loaded: 60 fps, no
  long tasks.

## Not covered

- Google Photorealistic 3D Tiles: nothing was run there. Depth sampling is the
  only height source on that map, so findings 4, 5 and 17 may be worse.
- Live Vessels, FIRMS with data, TomTom traffic, Local ADS-B.
- Frame rate on anything but one Apple silicon machine.
- One all-layers run over Manhattan grew the heap from 346 to 638 MB in 60 s;
  whether that is retained was not established.
- One Satellites load showed a 5.2 s long task once and never again in four more
  loads.

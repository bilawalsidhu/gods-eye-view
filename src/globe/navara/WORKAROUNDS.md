# Navara dependency workarounds

`@navaramap/three` and its default plugin are pinned to **0.2.1**.
Locations below are repository paths; a unit test of our replacement is not
an upstream canary. `PASS` means the package bug is confirmed. `BUG GONE`
means the fixture controls passed and the bug is absent; only this outcome
names a removal target. `FIXTURE ERROR` means the check could not establish a
verdict, so keep the workaround. The script exits 0 only when every active
canary confirms its bug; either other outcome exits non-zero.

Run the browser canaries against a keyless Vite dev server on port 4300:

```sh
GOOGLE_MAPS_API_KEY= CESIUM_ION_TOKEN= OPENAI_API_KEY= FIRMS_MAP_KEY= MAPILLARY_CLIENT_TOKEN= TOMTOM_API_KEY= GEMINI_API_KEY= npx vite --port 4300 --strictPort
node scripts/qa-navara-canaries.mjs http://localhost:4300
```

Set `PUPPETEER_EXECUTABLE_PATH` to the installed Chrome executable if needed.
The script uses a bare real Navara view so adapter cleanup, redraw timers and
pick validation cannot hide the defects. All network requests outside the dev
origin are blocked; raster responses are local fixtures. A browser run confirmed
the batch-ID, deleted-vector-event and raster-idle bugs in 0.2.1. These are the
three active canaries; expected output is three `PASS` lines followed by
`3 bugs confirmed, 0 bugs gone, 0 fixture errors` (exit 0).

There is no initial-hide canary: its shared readiness timeout did not identify
whether `featureCreated` or a shown/hidden pixel control stalled. The installed
SDK supports the inline GeoJSON Feature, vector layer description and event,
but the event follows asynchronous geometry creation. The fixture hides the
layer immediately, before creation is observed. Code inspection cannot tell
which wait failed or why; a browser trace is needed before restoring the check.
There is no rapid-click canary: the timing-dependent stale pick was not
reproducible headless. Correct IDs from that run do not establish that the bug
is fixed. Neither excluded check is a signal to remove a workaround.

| Location | Package defect or missing API | Seen in | Detection | Remove or replace when fixed |
| --- | --- | --- | --- | --- |
| `src/globe/navara/internals.js:71` | `animation=false` still updates the tile tree on every RAF; no suspend/resume API. | 0.2.1 | No canary: needs an upstream update-loop counter, not just rendered-frame counts. | Replace `_startMainLoop` / `_renderer.setAnimationLoop` access with suspend/resume. |
| `src/globe/navara/internals.js:86` | `ModelMesh._releaseGeometryArrays` drops CPU positions and indices after upload, preventing tile ray queries. | 0.2.1 | No canary: needs a loaded synthetic 3D tile and an upload; surface unit tests exercise retained geometry only. | Remove the prototype patch when geometry retention or native ray/height queries are available. |
| `src/globe/navara/internals.js:120` | No public enumeration of loaded 3D tile roots. | 0.2.1 | No canary: API gap; startup guard checks `_scenes.mrt.children`. | Replace `tileRoots` private scene traversal with the public query. |
| `src/globe/navara/internals.js:131` | Idle is an event edge, with no public current-state getter. | 0.2.1 | No canary: API gap; startup guard checks boolean `_isIdle`. | Replace `isIdle` with a public idle/tiles-loaded getter. |
| `src/globe/navara/internals.js:165`, `src/globe/navara/look.js:276` | No independent atmosphere exposure; sky/cloud radiance needs scaling without brightening unlit content. Uniform vectors are shared and materials may be rebuilt. | 0.2.1 | No canary: appearance needs a controlled daylight pixel reference. Startup checks sky/stars `ref.raw.material.uniforms`, aerial `rawEffect.uniforms`, and clouds `rawEffect.cloudsPass.currentMaterial.uniforms`; reads also validate rebuilt materials. | Remove `forEachLuminanceUniform`, the scaler and shared-vector bookkeeping when independent exposure is supported. |
| `src/globe/navara/internals.js:209`, `src/globe/navara/cascadedLightCopy.js:49` | Transparent-pass copies clone cascaded shadow lights each frame. | 0.2.1 | `cascadedLightCopy.test.mjs`: “Navara 0.2.1's copy clones new lights every call (the leak)” uses the real CSM package. | Remove `patchCascadedLightCopy`, `keepCascadedLightIds`, and their startup call. |
| `src/globe/navara/internals.js:224`, `src/globe/navara/featureQueue.js:15` | Late changes for deleted vector layers remain queued and prevent idle. | 0.2.1 | `deleted-vector-events-retained` (browser, confirmed); startup checks `_eventManager.stacks.renderable_feature_changed` and `removeAt`. | Remove queue access, `dropOrphanFeatureChanges`, and its pre-update hook. |
| `src/globe/navara/internals.js:257` | No public ordered pass-name list for diagnostics. | 0.2.1 | No canary: API gap; startup checks `view.viewContext` queries and `renderPassOrchestrator.passMap.list`. A not-yet-created optional effect has no context. | Replace `pipelinePassNames` and the startup context probe with public diagnostics/descriptor queries. |
| `src/globe/navara/movers/batchIds.js:11` | Unregistering pickable wrappers does not recycle their global batch IDs. | 0.2.1 | `batch-ids-retained` (browser, confirmed) checks disjoint allocations after unregistering; this measures ID reuse, not WASM byte reclamation. | Remove `createBatchIdPool` and pool wiring in `movers/index.js`. |
| `src/globe/navara/ground/index.js:145` | The original native-vector path lost the first `show: false` while a new layer was being built. Current ground rendering uses its own pass, so the hide retry is already absent. | 0.2.1 (original path) | No canary: `initial-vector-hide-dropped` timed out before a verdict; the shared readiness error does not identify the failed wait. Requires browser diagnosis. | No current hide retry to delete. Do not remove the ground pass: it also implements draping and materials. |
| `src/globe/navara/maps.js:76` | Idle can be reported before a fetched raster tile arrives after a map switch; the map may keep a stale frame. | 0.2.1 | `idle-before-raster-arrives` (browser, confirmed) holds real raster requests across the idle event, then releases local PNG responses. | Remove the `SETTLE_MS` / `SETTLE_EVERY_MS` redraw timer from `changed`. |
| `src/globe/navara/maps.js` (`setPhotorealTiles`) | The default `model.height=1` displaces transformed 3D Tiles by −1 m in ECEF X on the synthetic ENU fixture; both rendered meshes and CPU queries inherit it. Set `model.height: 0` to preserve the tileset transform. | 0.2.1 | `scripts/qa-tiles-fixture.test.mjs` loads the real WASM package: default transform reproduces the measured flat-top +0.118 m / roof −0.676 m errors; the adapter restores all probes and 40 roof points within 1 µm against independent triangle rays. `qa-tiles-fixture --report` prints browser samples without asserting them. | Remove the explicit zero only when the package's default preserves authored tile positions; retain the authored-geometry regression test. |
| `src/globe/navara/maps.js:145` | Removing the final raster layer interrupts terrain loading at the current view. | 0.2.1 | No canary: needs terrain-loading continuity across final-layer removal; the raster idle fixture does not test terrain. | Remove the add-before-delete constraint and hidden base-raster retention under 3D tiles. |
| `src/globe/navara/maps.js:37`, `src/globe/navara/maps.js:209` | Quantized-mesh root URLs without the tile template can panic. | 0.2.1 | No canary: deliberately panicking WASM would invalidate the remaining view checks; no isolated terrain fixture here. | Use the upstream root-URL API instead of manually appending `{z}/{x}/{y}.terrain`. |
| `src/globe/navara/maps.js:65` | No ion imagery path. | 0.2.1 | No canary: explicit unsupported source; requires a real ion imagery endpoint. | Replace the ion-imagery rejection with native source support. |
| `src/globe/navara/maps.js:209` | No terrain-request authentication retry hook; an expired ion endpoint token cannot be refreshed after a tile 401. | 0.2.1 | No canary: no authenticated fixture or exposed request callback. This is an unresolved gap, not a working retry. | Add retry through the upstream hook; there is no compensating retry code to delete. |
| `src/globe/navara/maps.js:230` | Raster tile failures after source creation are not exposed with source/status information for map fallback. | 0.2.1 | No canary: no adapter fallback exists; successful layer construction is not proof of successful tiles. | Wire native errors into map fallback when the package exposes them; nothing currently compensates for this. |
| `src/globe/navara/index.js:52`, `src/globe/navara/viewOptions.js:19` | No `preserveDrawingBuffer` option; a default canvas also allocates antialiasing despite rendering through offscreen targets. | 0.2.1 | No canary: missing constructor options; `viewOptions.test.mjs` tests our chosen context attributes. | Replace pre-created WebGL2 context with equivalent native canvas/context options. |
| `src/globe/navara/index.js:48` | Default cache budget can retain excessive tile memory; a fixed total also includes screen-size render targets and coarsens HD views. | 0.2.1 | No canary: requires a navigation/resize memory soak. | Remove fixed-target tracking and `TILE_CACHE_ROOM` override if native budgeting preserves the desired tile allowance. |
| `src/globe/navara/index.js:289` | Disposing the view leaves shared postprocessing fullscreen geometry listeners holding renderer state. | 0.2.1 | No canary: requires renderer/heap retention measurements after repeated disposal. | Remove `Pass.fullscreenGeometry.dispose()` once upstream releases those listeners. |
| `src/globe/navara/frameDescriptor.js:4` | Auto-bound descriptor frame callbacks are not unregistered on deletion. | 0.2.1 | No canary: existing `frameDescriptor.test.mjs` uses a stub base class, not the real descriptor lifecycle. | Remove `withFrameUpdates` and use native descriptor updates. |
| `src/globe/navara/frameDescriptor.js:24` | Effect deletion removes the composer pass without disposing its GPU resources. | 0.2.1 | No canary: current tests cover the wrapper's disposal, not native resource ownership. | Remove `withPassDisposal` when native deletion disposes passes exactly once. |
| `src/globe/navara/postSamplingPass.js:8` | Every composer target is multisampled, including fullscreen effects that need one sample. | 0.2.1 | No canary: requires HD render-target/sample and pixel checks; unit tests use fake contexts. | Remove `GeometrySamplingPass` and its installation when native sampling separates geometry from effects. |
| `src/globe/navara/emptySceneRender.js:15` | Empty MRT/forward scenes still call render and trigger MSAA resolves. | 0.2.1 | No canary: requires instrumenting the real HD pipeline; unit tests cover the skip policy only. | Remove `skipEmptySceneRenders` when native passes skip safe empty renders. |
| `src/globe/navara/sceneDepth.js:60` | The transparent pass runs after effects without scene depth, drawing hidden meshes through terrain/tiles. | 0.2.1 | No canary: needs a controlled occluder/depth pixel scene. | Remove shader scene-depth injection when the native transparent target retains correct depth. |
| `src/globe/navara/meshes.js:71` | Transparent unlit colours still receive view exposure. | 0.2.1 | No canary: needs colour samples at multiple exposures; current mesh tests exercise adapter state. | Remove reciprocal exposure compensation when native display-space colours stay unchanged. |
| `src/globe/navara/groundFloor.js:59` | Camera zoom limits are geocentric distances, without terrain/3D-tile collision. | 0.2.1 | No canary: requires loaded relief plus actual wheel navigation. | Replace `createGroundFloor` and its engine wiring with native collision handling that preserves the contract. |
| `src/globe/navara/cameraModel.js:47` | Camera pitch clamps to ±89.99°, perturbing an exact authored pose when read back. | 0.2.1 | No canary: `cameraModel.test.mjs` simulates the clamp, not native round trips. | Remove pushed-pose tolerance once native pose readback is exact. |
| `src/globe/navara/cameraModel.js:51` | Flight easing has no sinusoidal-in-out preset. | 0.2.1 | No canary: requires sampling a native flight's time/position curve. | Replace the `quadInOut` approximation with the actual sine easing. |
| `src/globe/navara/input.js:193` | Camera controller options have a setter but no getter. | 0.2.1 | No canary: API gap; input unit tests verify retained/merged options. | Replace the local options mirror when options can be read and updated without losing prior settings. |
| `src/globe/navara/picking.js:53` | Quick clicks can receive the first gesture's GPU pick. | 0.2.1 | No canary: not reproducible headless. `rapid-click-first-pick` returned correct IDs for spaced and rapid clicks, which does not establish a fix for this timing-dependent bug. | Keep stale-answer CPU validation until rapid clicks reliably return the matching instance in the affected scenario. Preserve CPU paths needed for lines/drill picking. |
| `src/globe/navara/createNavaraEngine.js:255` | Depth reads immediately after a click can return the near plane. | 0.2.1 | No canary: requires a terrain/3D-tile depth scene and click timing; the two-quad pick fixture does not establish ground depth. | Replace the CPU ground ray with native depth picking when post-click depth is reliable. |
| `src/globe/navara/createNavaraEngine.js:169`, `src/globe/navara/ground/index.js:29` | Frame requests made during rendering are cleared at the end of the current frame. | 0.2.1 | No canary: current engine/ground unit tests emulate the flag reset. | Remove deferred re-request bookkeeping once native requests during a frame schedule the next one. |
| `src/globe/navara/viewOptions.js:175` | G-buffer normals for globe/3D tiles are zero, breaking atmosphere lighting. | 0.2.1 | No canary: needs actual G-buffer and lighting pixel checks; Google tiles are not used by these canaries. | Remove `useNormalBuffer: false` when native normals support the lighting path. |
| `src/globe/navara/viewOptions.js:191` | Cloud defaults override the low preset's shadow map size and cascade count. | 0.2.1 | No canary: requires inspecting the real cloud preset result; option tests only verify the override. | Remove explicit `shadowMapSize` / `shadowCascadeCount` once the low preset survives native defaults. |
| `src/globe/navara/viewOptions.js:93`, `src/globe/navara/look.js:172` | Cloud bases are ellipsoid-relative and do not clear local terrain. | 0.2.1 | No canary: needs sampled relief and cloud-base inspection at local scale. | Remove terrain-dependent cloud offsets if native cloud altitude can be terrain-relative. |
| `src/globe/navara/credits.js:13` | Content-based deduplication has no holder reference count. | 0.2.1 | No canary: current credit tests stub attribution; they do not test the plugin. | Remove local counts when native removal retains a credit until its last holder releases it. |
| `src/globe/navara/credits.js:28` | No separate persistent on-screen credit strip. | 0.2.1 | No canary: UI/API gap; opening the attribution card is only a partial substitute. | Replace forced `attribution.show()` with native on-screen credits. |
| `src/globe/navara/bloom.js:59` | Native selective bloom uses emissive/effect masks before the transparent pass; the contract needs whole-frame bloom after overlays. | 0.2.1 | No canary: capability gap; custom effect tests verify our implementation. | Replace the custom bloom descriptor with a native effect only if ordering and settings match. |

Private-member checks run through `navaraHooks(view)` before engine construction
and fail with the member path and pinned version. The current recursive source
scan found no private access in `ground/`, `imagery/`, `lines/`, `movers/`, or
other adapter subfolders. No private-access moves were necessary.

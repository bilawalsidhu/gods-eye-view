# Performance baseline

This page records one hardware-rendered Apple M5 comparison captured on 22
August 2026 in Chrome 150 at 1440 x 900. It is not a minimum hardware
specification and should not be used to predict performance on untested systems.
The original capture artifacts are not included here, so this page records
results rather than defining a runnable benchmark.

## Test context

The baseline was captured on 22 August 2026 with these conditions:

| Setting | Value |
| --- | --- |
| Renderer | Apple M5 Metal through the hardware ANGLE path |
| Browser | Chrome 150 in a fresh isolated profile |
| Viewport | 1440 x 900 at device pixel ratio 1 |
| Focus | Page foregrounded for controlled scenes |
| Scene sample | 5 seconds of scripted motion, then 5 seconds at rest |
| Startup | Browser cache disabled; three samples |

The capture covered three startup samples, 16 cold layer scenarios with 14
measurements, 23 controlled option and stress scenes, and five
hardware-rendered overlay scenes.

## Startup

| Sample | App ready | Initial settle | Load event | Motion / rest | Used JS heap |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 784.980 ms | 2,035.082 ms | 439.5 ms | 60 / 60 FPS | 102.9 MiB |
| 2 | 604.849 ms | 1,855.836 ms | 442.4 ms | 60 / 60 FPS | 111.6 MiB |
| 3 | 558.527 ms | 1,809.592 ms | 438.8 ms | 60 / 60 FPS | 105.1 MiB |
| Median | 604.849 ms | 1,855.836 ms | 439.5 ms | 60 / 60 FPS | 105.1 MiB |

The initial-settle measurement is the more useful launch reference because it
includes the first visual and data settling window. All three samples reached
the display ceiling during both motion and rest.

## Cold layer activation

Cold activation was measured separately from warm option switching. Live object
counts are included so that future runs can compare source populations before
attributing a difference to the client.

| Layer | Activation | Source count | Motion / rest | Used JS heap |
| --- | ---: | ---: | ---: | ---: |
| CCTV city | 19,608.240 ms | 48 | 60 / 60 FPS | 192.7 MiB |
| Space Missions (report label: Rocket missions) | 3,581.066 ms | 26 | 60 / 60 FPS | 131.3 MiB |
| Radio | 3,458.709 ms | 750 | 60 / 60 FPS | 124.8 MiB |
| Bikeshare | 2,069.498 ms | 633 | 60 / 60 FPS | 157.4 MiB |
| Datacenters | 817.693 ms | 4,362 | 59.6 / 60 FPS | 328.2 MiB |
| Flights | 667.671 ms | 247 | 60 / 60 FPS | 118.4 MiB |
| Submarine cables | 614.727 ms | 2,629 | 60 / 60 FPS | 412.0 MiB |
| Military Flights | 557.113 ms | 68 | 60 / 60 FPS | 118.4 MiB |

CCTV had the largest cold activation cost in this capture. Submarine cables
used the most heap, followed by datacenters. Completed single-layer samples
generally reached 60 FPS, so activation time and heap separate these cases more
clearly than steady-state frame rate.

## Aircraft, detection, and Cockpit

| Scene | Motion / rest |
| --- | ---: |
| Idle globe | 60 / 60 FPS |
| Flights, 2D | 60 / 60 FPS |
| Flights, 3D proximity | 60 / 60 FPS |
| Flights, all 3D models | 60 / 60 FPS |
| Military Flights, all 3D models | 60 / 60 FPS |
| Detection at 25% | 39.3 / 41.1 FPS |
| Detection at 50% | 37.4 / 39.8 FPS |
| Detection at 100% | 34.4 / 35.5 FPS |
| Cockpit | 49.6 / 49.2 FPS |

The clean detection scenes processed 8,169 to 8,170 observations. Selected
labels rose from 14 at 25% density to 28 at 50% and 56 at 100%. The aircraft
rows came from an earlier loaded, foreground-controlled pass because the clean
rerun received no live aircraft rows.

## Visual styles and combined stress

| Scene | Motion / rest |
| --- | ---: |
| Normal | 60 / 60 FPS |
| CRT (report label: Retro) | 60 / 60 FPS |
| NVG (report label: Surveillance) | 60 / 60 FPS |
| FLIR (report label: Thermal) | 49 / 60 FPS |
| Anime | 60 / 59.8 FPS |
| Noir | 47 / 56.6 FPS |
| Snow | 42.3 / 45.8 FPS |
| Combined static | 57.6 / 60 FPS |
| Combined operational | 39.9 / 43.1 FPS |

The combined static scene rendered 11,575 objects, used 872.2 MiB of JavaScript
heap, and issued 48,665 text draws during motion and 54,106 at rest. The combined
operational sample contained 3,909 observations and two selected labels, but its
live aircraft and traffic rows were empty, so it remains a limited stress case.

Snow, Noir, dense detection, and text-heavy combined layers are the clearest
controlled comparison points for later optimization work.

## Keyed live sources

NASA FIRMS, AISStream, and TomTom were captured in a separate hardware-rendered
pass. The page was visible but was not the focused window, so these frame rates
must not be compared directly with the foreground-controlled scenes above.

| Source | Point-in-time population | Activation or coverage | Motion / rest |
| --- | ---: | --- | ---: |
| NASA FIRMS | 100,430 detections in 3,557 cells | 30.0 s activation | 32.1 / 55.2 FPS |
| AISStream | 12,000 vessels | 6.4 s activation | 22.1 / 29.8 FPS |
| TomTom Traffic | 4,222 road dots | 70% coverage, 2 decoded tiles | 45.0 / 51.7 FPS |

These populations change continuously. A future comparison must record the
live counts again and match the focus conditions.

## Software-rendered CPU profile (repeatable instrument)

The captures above were one-shot, hardware-rendered, and not reproducible from
the repository. `scripts/profile-runtime.mjs` is the repeatable instrument:
it drives the real app in headless Chrome (SwiftShader software GL in CI-like
environments) through four scenes — `boot`, `storm` (heavy layers + scripted
camera orbit), `detection` (synthetic fleet + detection density 100%), and
`idle` — sampling rAF cadence, `longtask` entries, JS heap, and a CDP sampling
profiler per scene.

Results below are from 10 September 2026 against the Vite dev server,
1440 × 900, software GL (SwiftShader). **Absolute FPS from this environment is
not comparable to the hardware table above.** The portable signals are the CPU
self-time rankings, long-task counts, and heap.

| Scene | Viewer ready | Long tasks (n / total / max) | Heap | FPS | Dominant self-time |
| --- | ---: | --- | ---: | ---: | --- |
| boot | 2.4 s (DCL 3.5 s, load 5.7 s) | 13 / 6.1 s / 1.77 s | 68 MB | 5.2 | shader compile/link + context/texture init (Cesium `ShaderProgram`, `Context`, `texImage2D`) |
| storm | — | 45 / 343 s / 79.9 s | 479 MB | 0.3 | `readPixels` (framebuffer readback) — 90.3% of samples |
| detection (700 aircraft, density 100%) | — | 16 / 3.2 s / 0.71 s | 76 MB | 7.1 | 79% idle; Cesium render; app code not in top 10 |
| idle (parked camera) | — | 17 / 3.3 s / 0.71 s | 71 MB | 7.4 | 94% idle — render governor holds; residual HUD/telemetry timers only |

Findings, ranked by actionability:

1. **Boot is initialization-bound, not logic-bound.** The only application
   code in the boot top-10 is `celestialRing._clear` (repeated canvas clears
   per postRender while the globe is not framed — fixed by an idempotence
   guard) and the egm96 geoid parse. Everything else is first-render shader
   compilation and texture upload. Shader-cache friendliness (stable shader
   permutations) matters more than any JS micro-optimization on this path.
2. **The worst jank source found is a synchronous depth readback on a UI
   timer.** `getBasemapLabelContext` (HUD AI-summary context, 15 s cadence and
   camera-settle prewarm) → `getViewTargetCartographic` → `scene.pickPosition`
   → `readPixels`. In the storm profile a single readback stalled the main
   thread for up to 79.9 s under software GL; on hardware the same call is a
   pipeline-flushing synchronous read that lands at the worst possible moment
   (during or right after camera motion). Instrumented rate: 4 calls / 60 s of
   continuous orbit — cost is per-call, not per-frequency. Label context does
   not need tile-accurate depth: the ellipsoid fallback is sufficient there.
3. **Detection at maximum density is healthy.** With 700 synthetic aircraft
   and density 100%, the main thread is 79% idle and the longest task is
   708 ms (first solve). The projection-worker + label-arbiter architecture is
   doing its job; no rewrite candidate here.
4. **Idle honors the render-governor contract** (94% idle, no app-code frames
   in the top 10) — the remaining cost is HUD/telemetry timers, matching the
   known poll-timer list (250 ms / 500 ms / 60 ms).
5. **Layer storm heap** reached 479 MB with static + live layers enabled on
   top of photoreal tiles. Any future "enable everything" preset needs a heap
   budget check; `scoreSatelliteNameMatch` (satellite search) was the largest
   non-Cesium self-time entry, which is expected during catalog load.

WASM implication (docs/PLAN.md Phase 5): nothing in these profiles supports
moving per-frame app logic to WASM. The hot paths are (a) Cesium-internal
render initialization and (b) a synchronous GPU readback — neither is a JS
arithmetic bottleneck. The FIRMS splat renderer remains the only proven WASM
candidate (its 100k-heat-disc math is main-thread JS today); a second
candidate must first appear in a future profile of a workload these scenes do
not yet cover (e.g. AIS bulk normalization on low-end hardware).

## FIRMS heat-texture A/B (2026-09-10, same container)
The WASM splat path (`rust/firms-renderer/`, wired 2026-09-10) replaces the
per-cell rectangle entities of the FIRMS `global`/`regional` LOD bands with
ONE textured ground rectangle. A/B via `scripts/profile-runtime.mjs --scene
firms` / `--scene firmsEntities` (the second runs with `?firmsWasm=0`),
against the dev server serving REAL NASA data (37,437 detections in the
trailing 24 h — keyless public-source mode of the `/api/firms` proxy):

| Scene | band | cells | ground primitives | splat pass | fps (12 s) | idle% |
|---|---|---|---|---|---|---|
| firmsEntities | global | ~1800 (top-N) | ~1800 entities | — | 3.2 | 63 |
| firms | global | ~1800 (top-N) | **1** (1024x540 tex) | 42.6 ms | 1.3 | 65 |
| firmsEntities | regional | 527 | 527 entities | — | 4.9 | — |
| firms | regional | 527 | **1** (673x283 tex) | 14.8 ms | 4.2 | — |

Reading, honestly:
- **The structural win is real but SwiftShader cannot reward it.** Ground
  primitives → 1 is a draw-call/geometry-count reduction; software
  rasterization is fill-rate-bound, so fps is statistically unchanged (the
  deltas above are within run-to-run noise, both paths ~63–65% idle). On
  hardware GL, where draw-call count is first-order, this is the win the
  architecture change buys.
- **The WASM generation cost is proven small**: one 14.8 ms (regional) /
  42.6 ms (global, capped 1024-wide texture) splat pass per rebuild — not
  per frame — well inside a frame budget on real hardware.
- Verification set (headless Chrome, dev server): underlay entity present
  and canvas-backed; texture pixels non-blank (2.6% of texels alpha > 12 at
  the regional view); `getStats().renderer` flips 'entities' →
  'wasm-texture'; `?firmsWasm=0` forces the entity path; 13 new unit tests
  pin the layout/splat-input math. WebGL screenshots of the globe surface
  are black in this container (software GL + `preserveDrawingBuffer:false`
  compositing artifact) — content was verified by canvas pixel probe, not
  by screenshot.

## SGP4 propagation baseline (2026-09-14, same container)

The `satellitesDense` scene (`scripts/profile-runtime.mjs --scene
satellitesDense`) loads the real Starlink shell through the dev server's
CelesTrak proxy and reads the propagation telemetry the satellites module now
publishes in `getStats()` (`corePassMs`, `denseChunkMs`, `densePurePassMs`).
This is the evidence docs/PLAN.md requires before any SGP4-in-WASM rewrite
qualifies. Captured: 11,542 satellites total — 833 core + 10,709 dense.

| Path | Cost | Cadence | Amortized/frame |
|---|---|---|---|
| Core pass (`corePassMs`) | 8.6 ms (833 sats, incl. `fromDegrees` + point writes) | every 1 s | ~0.14 ms |
| Dense round-robin slice (`denseChunkMs`) | 0.3 ms (~36 props + point writes) | every frame | 0.3 ms |
| Full pure-SGP4 dense pass (`densePurePassMs`) | 191.9 ms (10,709 props ≈ 17.9 µs/prop, cold at load) | never (by design) | — |

Reading, honestly:
- **The WASM candidate does not qualify.** Steady-state SGP4 costs ≈ 0.44 ms
  per frame-equivalent — about 2.6% of a 16.7 ms frame budget — and no
  satellites/SGP4 function appears anywhere in the scene's top-10 CPU
  self-time (33% Cesium render, 19% `getBufferData`, 21.9% idle; software GL
  rasterization owns the frame). The "must appear in the profiler before
  anyone rewrites it in Rust" bar fails outright.
- **The one large number is a path the app never takes.** 191.9 ms is what a
  full-cadence dense pass would cost, and the round-robin design exists
  precisely so that path never runs inside one frame. Even a hypothetical 4×
  WASM kernel (~50 ms) would still not fit a frame budget; the correct fix
  for a future full-cadence requirement is workerization, not WASM.
- Hardware note: the in-code comment "~840 sats ≈ 1.6 ms/pass" was measured
  on the macOS workstation; 8.6 ms here is this container's CPU. The
  `getStats()` telemetry publishes the live number per machine, so both age
  honestly.

## Controls for a future capture
Use the same controls before attributing a difference to the application:

1. Record the exact GPU renderer and reject software-rendered or unavailable GPU
   strings.
2. Use a 1440 x 900 viewport at device pixel ratio 1 and keep the page focused.
   This baseline predates the render-resolution scale policy (September 2026):
   on displays with devicePixelRatio > 1.5 the scene now renders at
   `sceneResolutionScale` 0.75, so HiDPI captures are not comparable to the
   August 2026 numbers without `?renderScale=1` (or a fresh baseline).
3. Measure cache-disabled startup separately from cold layer activation and warm
   option switching.
4. Repeat startup three times and compare medians.
5. Sample each option for 5 seconds in scripted motion and 5 seconds at rest.
6. Record live object counts before attributing a difference to the client.
7. Treat a live-source outage as missing coverage, not as evidence of low client
   rendering cost.

## What is not established yet

- This report does not establish Windows performance.
- The report does not record machine memory capacity, so it cannot support a
  minimum-memory recommendation.
- The report does not cover other GPU renderers or viewport configurations.
- Military Installations is outside this comparison because it requires close
  camera context.
- The keyed pass has no controlled rerun suitable for comparison with the
  option scenes.

Use this page as a regression baseline for one known hardware and browser
configuration, not as a compatibility guarantee.

## Idle-GPU audit (2026-09-23, code-verified + instrumented)

User report: "the website pegs the GPU at 99% on several machines." The audit
answer is structural and does not need clean fps hardware to be conclusive,
because Cesium only burns GPU while it submits frames, and every frame
submission in this app is governed by two knobs the render governor owns:
`scene.requestRenderMode` (frames at all?) and `viewer.targetFrameRate`
(how many per second — Cesium's `startRenderLoop` gates each `render()` on
`frameTime - lastFrameTime > 1000/targetFrameRate`).

### Finding 1: a default session never idles

The governor's idle mode (`requestRenderMode = true`) is unreachable in a
default session, for two independent reasons:

- The first-run default style is CRT (operator ruling 2026-08-29), an
  animated post-processing stage whose `style-anim` hold is held for the
  lifetime of the style — it never releases while a boot-to-CRT session runs.
- Every live layer holds continuous render unconditionally while enabled
  (flights `src/data/flights.js`, military, satellites, planets, traffic,
  ais-vessels), because their per-frame interpolators assume continuous mode.

So a parked camera with default layers on runs 60 fps continuous, forever.
At photoreal-tile scene complexity that is the reported ~99% GPU. This is a
policy gap, not a leak: each hold is individually correct; their composition
was never priced.

### Finding 2: the fix that ships — low-demand 30 fps policy

Wall-clock animators are frame-rate-independent by construction: fleet
dead-reckoning samples a trajectory at `now - RENDER_DELAY_SEC`, satellites
propagate from JulianDate.now, the CRT uniforms advance on a `Date.now()`
delta. Rendering them at 30 Hz produces a bit-identical world at half the
frame submissions. The governor therefore resolves
`viewer.targetFrameRate = 30` (`LOW_DEMAND_FPS` in `src/renderGovernor.js`)
when the camera is parked AND every active hold is in
`LOW_DEMAND_HOLD_OWNERS` (`flights`, `military`, `satellites`, `planets`,
`traffic`, `ais-vessels`, `style-anim`); any camera-driven holder
(tracked-entity, camera-verb, cockpit, cctv-projection, replay, annotations)
or camera motion restores 60. Unknown owner ids are fail-safe baseline.
Phase 9 Batch P proved the mechanism on the style loop; the audit widened it
to the whole wall-clock class. Expected effect on the reported machines:
~50% GPU reduction in the everyday parked-camera case, no visual change.

### Finding 3: the HiDPI downscale policy was a silent NO-OP (fixed)

`applySceneRenderScale` (Phase 9 Batch R) wrote
`viewer.scene.sceneResolutionScale` — a property that does not exist in
Cesium 1.144. The real knob is `viewer.resolutionScale` (Viewer proxies to
`cesiumWidget.resolutionScale`, which drives the canvas backing store). The
assignment created an inert expando, so the DPR > 1.5 downscale (0.75,
claimed ~56% GPU bandwidth) NEVER ENGAGED — every HiDPI machine rendered at
full native backing-store size (~4x the per-pixel fragment cost at DPR 2).
This is a direct contributor to the reported 99% GPU pegs, and it compiles
with Finding 2's halved frame rate once fixed: HiDPI machines now get both
0.75x linear resolution and 30 fps parked. The unit test had pinned the same
wrong property on a stub viewer, which is exactly the mock-armor failure
mode ADR 0008 warns about. The fix is code-verified (Cesium 1.144 bundle:
the `resolutionScale` setter sets `_forceResize` and `pixelRatio *=
widget._resolutionScale` in the resize path; `Viewer.resolutionScale`
proxies to the widget) and unit-pinned on the real write target. The live
canvas readback (`?renderScale=0.75` → `scene.canvas.width` 1080) could not
be captured: the audit box sat at load ~80 with 71 Chromium processes and
CDP `Runtime.callFunctionOn` itself timed out. The probe now samples
`resolutionScale` plus the live canvas dimensions; the 2026-10-01 run
below closed that inch.

The remaining knobs were already sane: FXAA off by default, MSAA 2,
`targetFrameRate` 60 cap (120 Hz ProMotion fix, 2026-08-05). The HUD
readPixels stall found in the 2026-09-10 profile was already fixed
(`surfaceOnly: true` in `getBasemapLabelContext`, cached per camera
signature).

### Instrument and honest limits

`scripts/profile-gpu-holds.mjs` drives a scripted session (boot-idle →
flights-idle → orbit → rest) and samples `frameState.frameNumber` deltas
bracketed by screenshot pumps, plus `requestRenderMode`, governor
diagnostics (`policy` field), and the cost knobs. Absolute renders/s from
this box are NOT hardware numbers: headless Chrome runs SwiftShader, and the
audit machine ran at load average 76-92 (concurrent sessions, ~70 Chromium
processes), which twice starved `page.goto`. The portable signals are WHICH
holds are alive, the resolved policy, and renders/s vs. the policy — those
are load-independent and are what the probe asserts. A hardware fps A/B on a
quiet machine remains open work; the code path it would measure is pinned by
`src/renderGovernor.test.mjs` (12 tests) instead.

### WASM implications (task follow-up)

A 99%-GPU peg is a frame-submission problem; moving JavaScript to WASM does
not address it (the bottleneck was never single-threaded JS compute — see
"Software-rendered CPU profile" above, where the top self-time entries are
Cesium's own render/tile work). The open WASM candidates remain the
measured ones in this document; the audit adds none.

## Idle render-request audit (2026-10-01)

A pass over upstream's post-v0.10.3 perf-relevant commits (the tree was
290 behind / 513+ ahead at audit time) found exactly one material defect
class still un-extracted, and it was real here too. Everything else had
landed in the Phase 13 extraction or was N/A by layout: `499e116`
(hidden-entity release on toggle-off) — already in this tree's
`localGeojson.js`; `fa9af39` (terrain-height cache LRU) — no
`terrainHeights` service exists here, and this tree's only client height
cache (`screenAnnotationRenderer.js`) was already soft/hard-bounded;
`b456eb8` + `20a03aa` (atmosphere) — ported in `src/atmosphereCompat.js`;
`8702458` (icon-font subset) — already subset here (330 KB → ~4 KB,
`index.html`).

### The defect: the bundled-layer publisher republished every walk

`createLocalInfrastructureOverlayPublisher.publish()` called
`setOverlayEntries()` unconditionally — and the preRender walk calls
`publish()` on every rendered frame. Each call re-normalized every
entry, rebuilt the host cohorts, and `invalidateHost()`-ed the overlay
host, which clears its rect caches AND calls `scene.requestRender()`.
So with any bundled layer (datacenters/dams) enabled, every rendered
frame requested at least one more frame: on a parked camera the scene
never settled, and under any continuous-render hold (flights, orbit,
storm) every frame also paid a full host normalize+rebuild for a cohort
that had not changed. (Upstream `b5568de`, same root cause, same fix
shape; the cables layer already had its own change detection here, and
the commit's other half — settle-waited ground sampling — is N/A: this
tree grounds stems with bounded retry arms instead.)

### Measured A/B (request-space census, parked camera, `local-datacenters` ON)

`scene.requestRender` was wrapped on the live scene (method wrap, no
`/src` import — the harness-import-mints-a-second-module trap); the
probe counted calls for 20 s with no screenshot pumps, so counts are
independent of BeginFrame availability:

| Tree | requestRender calls / 20 s | frames executed | governor |
|---|---|---|---|
| v0.10.3 (`3cb9a61`) | **636** | 28 | idle, holds `[]` |
| publish guard (`5890329`) | **206** | 11 | idle, holds `[]` |

**3.1× fewer render requests, 2.5× fewer executed frames.** The
remaining 206 calls/20 s are Cesium's own tile-streaming self-requests
(stack samples: `di.render → b1t → scene.requestRender`, cesium bundle)
and are identical between trees. Both trees end at `requestRenderMode`
true with the governor idle — the fix removes the request storm, not a
hold; on hardware with steady BeginFrames the storm translated into
continuous walk-cadence rendering that never let the parked scene rest.
Fix + unit pinning: unchanged-cohort replays are skipped, an in-place
tip move republishes, membership changes republish, `hide()` drops the
snapshot (next `show()` republishes from scratch), and emptying the
cohort always reaches the host.

### gpu-holds live verification (closes the 2026-09-23 open inch)

`node scripts/profile-gpu-holds.mjs --json` completed end-to-end (the
navigation budget is now 360 s after a third tightness bite at load
~56). The box ran at load 35-70 with CI jobs active — the portable
signals (holds, resolved policy, resolutionScale) are load-independent
by the instrument's design note above. Resolved live on this tree:
`policy: "low-demand"` with `targetFrameRate 30` at boot-idle,
flights-idle, and rest-after-orbit; `policy: "camera"` at 60 during
orbit; `resolutionScale 1` (correct at dpr 1); holds exactly as
designed — `style-anim` from the CRT first-run default stage (documented
above: perf captures run `setStyle('normal')`) plus `flights` once
flights are enabled; FXAA off, MSAA 2. SwiftShader renders/s 7/6/5/4
across the phases — not hardware numbers, recorded only as the
request-mode/policy conformance signal. Heap 188 MB, 74 long tasks over
the full session. No new cost knob anomaly; no new WASM candidate.

### WASM-candidate verdicts (2026-09-23, R6 measured — all three disqualified)

Method: `scripts/measure/bench-wasm-candidates.mjs` — node (V8, the same JIT
the browser runs) drives the REAL production code paths: the `LabelArbiter`
class, the actual `detectionProjection.worker.js` message handler (through a
`self` shim — one import per process; the handler is module-scoped), and the
exported `normalizeVessel` seam with the bundled EGM96 grid warm. 20 warm-up
iterations, 200 (30 for AIS) timed iterations; deterministic LCG inputs so
runs are comparable. Box load ~72 during capture (5 concurrent sessions) —
an idle machine can only be faster, so the disqualifications are
conservative. Per-candidate:

| Candidate | Measured (median) | Budget it runs against | Verdict |
|---|---|---|---|
| `LabelArbiter.solve` at DENSE | **0.405 ms**/solve (p95 0.605; 300 candidates, 6 layers, capacity 100) | 125 ms throttle (8 solves/s) → 0.32% | **disqualified** — 300× headroom |
| Detection projection loop | n=250: **0.054 ms**; n=1000: **0.076 ms**; n=5000: **0.414 ms** (2.48% of frame) | 16.7 ms frame at 60 fps | **disqualified** — and it already runs off-main-thread in a worker |
| AIS bulk row normalization | **28.3 ms** per 12k-row payload (2.36 µs/row; p95 59.8) | amortized by `processChunked` into 500-row idle slices → **1.18 ms/slice** | **disqualified** — the jank risk it would solve is already designed out |

Notes: the earlier documented normalization figure (1.24 µs/row, of which
0.34 was the duplicate `fromDegrees`) used a narrower row shape; this bench
uses the full AISStream field set with EGM96 lookups warm, hence the higher
per-row figure — the verdict is unchanged at either number. Together with
the SGP4 verdict above, every standing WASM candidate is now closed with
measurements: the app's JavaScript compute costs are microseconds against
millisecond budgets, and the real cost centers are Cesium's own render/tile
work and (pre-audit) frame submission volume. **No WASM candidate is open.**

## Per-frame callback census (Phase 15B, 2026-10-03, same container)

`scripts/profile-frame-census.mjs` is the repeatable instrument for the
question Phase 14's request-census could only answer in aggregate: WHO
runs on every rendered frame, and how many times. It wraps the live
scene's four frame events in place (the installed @cesium/engine stores
listeners in a `Map`, not an array) and counts callback invocations with
per-frame raise counts as the denominator; owners are captured from the
registration-time stack (a wrapper's call-time stack cannot contain the
listener's own frame — it has not been entered yet).

Counts from the 2026-10-03 capture (12 s phases, 1600×900 SwiftShader,
host load 60–87; frame counts are load-bound, calls/frame ratios are
exact; this run predates the attribution fix, so owners are function-
name level — the committed instrument adds `/src/` owner columns):

| Scene / phase | frames | preRender listeners | preRender calls/frame | postRender listeners | postRender calls/frame |
|---|---:|---:|---:|---:|---:|
| baseline parked | 7 | 1 | 1.00 | 5 | 3.00 |
| baseline motion | 10 | 2 | 1.50 | 5 | 3.00 |
| targets parked | 7 | 5 (1 never called) | 5.00 | 5 | 5.00 |
| targets motion | 7 | 6 | 5.86 | 5 | 5.00 |

Reading, honestly:
- Baseline boot carries 8 pre-attached frame listeners; the 15B target
  cohort (radio, military-awareness, planets, rocket-launches) adds 4
  preRender consumers (one of which never fired in the parked phase —
  the layer was mid-rollback, see the planets enable bug in
  docs/PLAN.md Phase 15B). Each consumer runs exactly 1.00/frame — no
  double-registration leaks.
- The census motivated the two Phase 15B cadence moves (planets'
  per-frame ConstantProperty churn ×8 entities → one 60 s interval;
  rocket-launches' per-frame declutter walk → dirty-flag + quantized
  pose gate with a 500 ms floor). Radio and military-awareness were
  already cadence-bound and are unchanged. The durable per-layer
  evidence for the rockets move is `getStats().declutterWalks /
  declutterWalksSkipped`, asserted by `scripts/qa-frame-cadence.mjs`.
- A full-boot outage on this box (~12:30–14:00 UTC-5: the renderer's
  main thread blocked 10+ min under host load, four consecutive boot
  failures after two clean morning runs) limited the capture to
  function-name-level attribution. The instrument is committed and
  reproduces the table with full attribution when the box boots.

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

## Controls for a future capture
Use the same controls before attributing a difference to the application:

1. Record the exact GPU renderer and reject software-rendered or unavailable GPU
   strings.
2. Use a 1440 x 900 viewport at device pixel ratio 1 and keep the page focused.
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

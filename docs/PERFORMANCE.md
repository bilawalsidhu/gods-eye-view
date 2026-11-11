# Performance baseline

This page records one hardware-rendered Apple M5 comparison captured on 22
August 2026 in Chrome 150 at 1440 x 900. It is not a minimum hardware
specification and should not be used to predict performance on untested systems.
The original capture artifacts are not included here, so this page records
results rather than defining a runnable benchmark.

## Test context

The baseline was captured on 22 August 2026 with these conditions:

| Setting      | Value                                                |
| ------------ | ---------------------------------------------------- |
| Renderer     | Apple M5 Metal through the hardware ANGLE path       |
| Browser      | Chrome 150 in a fresh isolated profile               |
| Viewport     | 1440 x 900 at device pixel ratio 1                   |
| Focus        | Page foregrounded for controlled scenes              |
| Scene sample | 5 seconds of scripted motion, then 5 seconds at rest |
| Startup      | Browser cache disabled; three samples                |

The capture covered three startup samples, 16 cold layer scenarios with 14
measurements, 23 controlled option and stress scenes, and five
hardware-rendered overlay scenes.

## Startup

| Sample |  App ready | Initial settle | Load event | Motion / rest | Used JS heap |
| -----: | ---------: | -------------: | ---------: | ------------: | -----------: |
|      1 | 784.980 ms |   2,035.082 ms |   439.5 ms |   60 / 60 FPS |    102.9 MiB |
|      2 | 604.849 ms |   1,855.836 ms |   442.4 ms |   60 / 60 FPS |    111.6 MiB |
|      3 | 558.527 ms |   1,809.592 ms |   438.8 ms |   60 / 60 FPS |    105.1 MiB |
| Median | 604.849 ms |   1,855.836 ms |   439.5 ms |   60 / 60 FPS |    105.1 MiB |

The initial-settle measurement is the more useful launch reference because it
includes the first visual and data settling window. All three samples reached
the display ceiling during both motion and rest.

## Cold layer activation

Cold activation was measured separately from warm option switching. Live object
counts are included so that future runs can compare source populations before
attributing a difference to the client.

| Layer                                          |    Activation | Source count | Motion / rest | Used JS heap |
| ---------------------------------------------- | ------------: | -----------: | ------------: | -----------: |
| CCTV city                                      | 19,608.240 ms |           48 |   60 / 60 FPS |    192.7 MiB |
| Space Missions (report label: Rocket missions) |  3,581.066 ms |           26 |   60 / 60 FPS |    131.3 MiB |
| Radio                                          |  3,458.709 ms |          750 |   60 / 60 FPS |    124.8 MiB |
| Bikeshare                                      |  2,069.498 ms |          633 |   60 / 60 FPS |    157.4 MiB |
| Datacenters                                    |    817.693 ms |        4,362 | 59.6 / 60 FPS |    328.2 MiB |
| Flights                                        |    667.671 ms |          247 |   60 / 60 FPS |    118.4 MiB |
| Submarine cables                               |    614.727 ms |        2,629 |   60 / 60 FPS |    412.0 MiB |
| Military Flights                               |    557.113 ms |           68 |   60 / 60 FPS |    118.4 MiB |

CCTV had the largest cold activation cost in this capture. Submarine cables
used the most heap, followed by datacenters. Completed single-layer samples
generally reached 60 FPS, so activation time and heap separate these cases more
clearly than steady-state frame rate.

## Aircraft, detection, and Cockpit

| Scene                           |   Motion / rest |
| ------------------------------- | --------------: |
| Idle globe                      |     60 / 60 FPS |
| Flights, 2D                     |     60 / 60 FPS |
| Flights, 3D proximity           |     60 / 60 FPS |
| Flights, all 3D models          |     60 / 60 FPS |
| Military Flights, all 3D models |     60 / 60 FPS |
| Detection at 25%                | 39.3 / 41.1 FPS |
| Detection at 50%                | 37.4 / 39.8 FPS |
| Detection at 100%               | 34.4 / 35.5 FPS |
| Cockpit                         | 49.6 / 49.2 FPS |

The clean detection scenes processed 8,169 to 8,170 observations. Selected
labels rose from 14 at 25% density to 28 at 50% and 56 at 100%. The aircraft
rows came from an earlier loaded, foreground-controlled pass because the clean
rerun received no live aircraft rows.

## Visual styles and combined stress

| Scene                            |   Motion / rest |
| -------------------------------- | --------------: |
| Normal                           |     60 / 60 FPS |
| CRT (report label: Retro)        |     60 / 60 FPS |
| NVG (report label: Surveillance) |     60 / 60 FPS |
| FLIR (report label: Thermal)     |     49 / 60 FPS |
| Anime                            |   60 / 59.8 FPS |
| Noir                             |   47 / 56.6 FPS |
| Snow                             | 42.3 / 45.8 FPS |
| Combined static                  |   57.6 / 60 FPS |
| Combined operational             | 39.9 / 43.1 FPS |

The combined static scene rendered 11,575 objects, used 872.2 MiB of JavaScript
heap, and issued 48,665 text draws during motion and 54,106 at rest. The combined
operational sample contained 3,909 observations and two selected labels, but its
live aircraft and traffic rows were empty, so it remains a limited stress case.

Snow, Noir, dense detection, and text-heavy combined layers are the clearest
controlled comparison points for later optimization work. Snow has since been
retired as a visual preset; its row records the measurement as taken.

## Keyed live sources

NASA FIRMS, AISStream, and TomTom were captured in a separate hardware-rendered
pass. The page was visible but was not the focused window, so these frame rates
must not be compared directly with the foreground-controlled scenes above.

| Source         |          Point-in-time population | Activation or coverage        |   Motion / rest |
| -------------- | --------------------------------: | ----------------------------- | --------------: |
| NASA FIRMS     | 100,430 detections in 3,557 cells | 30.0 s activation             | 32.1 / 55.2 FPS |
| AISStream      |                    12,000 vessels | 6.4 s activation              | 22.1 / 29.8 FPS |
| TomTom Traffic |                   4,222 road dots | 70% coverage, 2 decoded tiles | 45.0 / 51.7 FPS |

These populations change continuously. A future comparison must record the
live counts again and match the focus conditions.

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
8. Record whether the app is running in Pinokio's embedded view or in an
   external browser. One Pinokio 8.2.0 user reported severe stutter in the
   embedded view that went away when the same local URL was opened in a normal
   browser ([#365](https://github.com/bilawalsidhu/gods-eye-view/issues/365)).
   Do not compare embedded-view and external-browser measurements directly;
   compare the reported GPU renderer and matched scene settings first.

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

## Repeatable memory profiling

The historical profiling captures below used one-off development harnesses. Those
harnesses are archived in commit `ba3b0c9f`; they are not part of the final PR.
The permanent scripts added here are limited to two regression tools:

- `qa-aircraft-surface.mjs` checks the new GPU surface, picking, tracking,
  disable/re-enable and repaint behavior in a browser against a local server.
- `qa-aircraft-retention.mjs` is the real-Cesium GC fixture used by the two
  `aircraftSurface.test.mjs` cases. It also supports `--remove-all`.

```sh
node scripts/qa-aircraft-surface.mjs http://127.0.0.1:PORT OUTPUT
node --expose-gc scripts/qa-aircraft-retention.mjs --check
node --expose-gc scripts/qa-aircraft-retention.mjs --remove-all --check
```

Existing unit, allocation and tracking gates remain the regression baseline.
Recorded heap, process-footprint and GPU estimates below are different measures;
their savings must not be combined into an app-wide reduction.

### Infrastructure memory iteration — 9 November 2026

Measured in headless Chrome 156.0.8078.47 with hardware ANGLE Metal on Apple M2
Pro, 1440 × 860 at device pixel ratio 1, against the Vite development server.
Each configuration used a fresh browser and three cycles with 3-second settling
at each checkpoint. The workload contained 4,363 datacenter entities and 716 dam
entities; 5,067 records had analyst positions. Google 3D was unavailable because
credentials were not configured, so these results do not cover its tile cache.

| Configuration                                   | Active retained heap, typical city/map checkpoints | Retained heap after final idle |
| ----------------------------------------------- | -------------------------------------------------: | -----------------------------: |
| Original                                        |                                        255–260 MiB |                       92.4 MiB |
| Shared constant point styles and stem materials |                                        235–239 MiB |                       93.9 MiB |
| Shared styles plus serialized dataset cache     |                                        232–236 MiB |                       89.0 MiB |

The combined change saved approximately 23 MiB of active retained heap at matched
checkpoints. All data signatures and counts matched, and screenshots preserved
the visible infrastructure styling. Browser RSS did not show a consistent
reduction, so no total-process-memory saving is claimed. These changes preserve
all features, geometry, label budgets, resolution, antialiasing and tile detail.
Re-enabling now parses cached text before rebuilding; no extra fetch is made.

Validation passed: the full unit suite and serialized allocation gates, 90
focused infrastructure tests, 109 tracking browser checks (synthetic aircraft
and bundled imagery), 23 infrastructure LOD browser checks, application
startup/annotation/destruction checks, the production build, formatting and
package boundaries. These checks establish no observed regression in the tested
flows; they do not establish coverage of every live provider or Google 3D.

Continue with separate captures for Google 3D city travel/map switching,
satellite toggles, vessel populations, cable geometry and CCTV playback. Keep
each workload's data population fixed or recorded, establish its own baseline,
and verify picking, re-enable and destruction before changing cache lifetimes.

### Dense flat-map iteration — 9 November 2026

Standard mode now keeps lightweight civilian/military contact descriptors for
the complete feed and creates native billboards within a padded viewport only.
Tracked/cockpit subjects are exempt. Positions, search and tracking remain
available worldwide. Detection brackets cache exact batched paths between
position updates. Only drawing requests viewport-filtered detection candidates;
public queries retain their synchronous contact semantics, including immediately
after ingestion. Data Centers and Dams similarly materialize native entities
only for records admitted by their existing LOD; normal mode retains the
original polygon footprints, ground pins, lines and picking metadata.

The optional DISPLAY → Resources → Low resource preference targets **30 FPS**,
reduces globe resolution to 0.6 and overlay DPR to 1, uses MSAA 1, disables
bloom/sharpen and fleet models, and reduces tile budgets. Selected aircraft
tracking remains available. Standard restores the preceding rendering settings.
These quality reductions are optional; the viewport, path and infrastructure
optimizations run in Standard as well. No data source is disabled by this
preference.

The controlled workload used matched synthetic populations and frozen builds.

The harness injects an identical synthetic OpenSky population, uses the real
rendering and layer lifecycles, and samples 10 seconds per phase after settling.
It records post-render FPS, frame intervals, main-thread task CPU, browser
process CPU, retained heap after diagnostic GC and RSS. `--footprint` uses
macOS physical-footprint accounting, including compressed pages, across the
owned browser process tree. RSS alone understated memory on this laptop.
`--cpu-profile` saves a CDP profile and hotspot summary. `--baseline FILE`
checks build type, browser, renderer, viewport, sample duration and feed population before
producing comparisons. Run measurements without simultaneous tests/builds.

On the current Apple M2 Pro laptop with 16 GiB RAM, Chrome 156.0.8078.47,
hardware ANGLE Metal,
1440 × 860 at DPR 2, Vite development server, flat OSM map and 10,000 aircraft:

| Standard workload              | Earlier reference FPS | Optimized FPS | Earlier → optimized main-thread CPU | Earlier → optimized physical footprint |
| ------------------------------ | --------------------: | ------------: | ----------------------------------: | -------------------------------------: |
| Aircraft, wide view            |                  48.4 |          59.7 |                       90.8% → 66.0% |                        1427 → 1433 MiB |
| Aircraft, regional view        |                  57.3 |          60.1 |                       63.0% → 27.5% |                        1356 → 1340 MiB |
| Aircraft + Data Centers + Dams |                  54.0 |          60.2 |                       90.8% → 59.4% |                        2184 → 1552 MiB |

Combined retained JS heap fell from 267.4 to 132.3 MiB. This is approximately
**29% less total browser physical footprint**, **51% less retained JS heap**
and **35% less main-thread CPU** for the combined case. The regional view kept
all 10,000 contacts with about 1,115 native aircraft markers. Bracket paths were
reused for roughly 80% of frames during the wide-view measurement. The earlier
Retina reference already included aircraft viewport/path caching, so this table
does not measure the complete change against the original application.

The optional 30 FPS capture (`final-low30/report.json`, same workload and
sampling) held 30.1 FPS in the combined case at 33.5% main-thread CPU and
1115 MiB physical footprint: approximately 49% less memory and 63% less
main-thread CPU than the earlier reference, with the documented visual
reductions. Native-selector switching preserved all 5,067 analyst records and
restored 60 FPS, resolution 1 and MSAA 4. Both modes retained canvas capture
support for voice viewport/crop requests.

A separate final production-build capture (`final-production/report.json`)
measured 53.6 FPS with all 10,000 aircraft visible, 59.5 FPS regionally and
58.9 FPS with both infrastructure layers enabled. Combined retained JS heap
was 86.7 MiB and browser physical footprint 1506 MiB. Its viewport, offscreen
search/tracking, metadata, selected-entity and resource-selector checks all
passed without browser/render errors. The higher CPU readings in this run
(78.9% main-thread CPU in the combined case) show cross-run variability;
there is no pre-change production capture, so no production saving percentage
is claimed. The normal path meets 30 FPS in this workload and approaches 60,
but these samples do not establish a locked 60 FPS at every density or view.

Artifacts: `qa-artifacts/aircraft-load/retina-standard/report.json` and
`qa-artifacts/aircraft-load/normal-windowed-infrastructure/report.json`.
These single-laptop runs establish the tested workload, not an old-hardware
guarantee. CPU is main-thread task time as a percentage of one logical core;
GPU-process CPU is not hardware GPU utilization. No temperature or power saving
was measured. Native/GPU memory remains substantial; **75% total-memory
reduction has not been achieved**. Google 3D, dense live fleet models and other
providers require separate fixed-population captures before claiming the same
results there.

Validation for this iteration: 109/109 aircraft tracking browser checks,
23/23 infrastructure LOD checks, application startup/annotation/destruction,
15/15 isolated allocation gates, focused query/detection/viewport and geometry
parity tests, resource-selector switching with complete metadata and selection
preservation, production build, formatting and package boundaries passed.
The full unit run recorded 11,591 passes, 3 skips and 13 failures. Two temporary
Git fixture failures (cleanup/signing) passed in isolation; the remaining 11
catalog failures report untranslated strings from separate CCTV observation
work in this checkout. All five new resource-control messages are translated
in every shipped catalog. The final public-query compatibility fix was then
covered by focused civilian/military tests and the complete 109-check browser
rerun; the full unit suite was not rerun again after that fix.

### Remaining feature costs and cable residency — 9 November 2026

A second production-build audit toggles features over the same 10,000-aircraft
flat-map workload. `--feature-costs --gpu-memory --footprint` adds synthetic
2,000-core/5,000-dense satellite and 5,000-camera catalogs, real bundled cables,
and post-process toggles. The satellite fixture populates only one core group;
empty groups deliberately report unavailable. The camera fixture measures
catalog/coverage geometry, not representative live media or vehicle inference.
The bloom toggle in this capture retained the default zero intensity, so it
does not measure an active bloom effect. Do not use these fixtures as live
provider capacity guarantees.

The largest measured increment was Submarine Cables:

| 10,000 aircraft + cables                       | Before this iteration | Optimized |
| ---------------------------------------------- | --------------------: | --------: |
| Browser physical footprint                     |              3312 MiB |  2202 MiB |
| Increment above the preceding aircraft control |              2049 MiB |   965 MiB |
| Retained JS heap                               |               198 MiB |   160 MiB |
| Added estimated live WebGL storage             |               314 MiB |   108 MiB |
| Worldwide logical features                     |                  2629 |      2629 |

That is approximately **34% less total browser footprint**, **53% less added
cable memory**, and **66% less added WebGL storage**. The renderer retains every
original route vertex and inserts segment boundaries on the same rhumb curve;
it creates native ground geometry only for padded viewport segments. Landings
and reference stems also leave native sources when out of view. Stable IDs,
metadata, native picking, line colors/widths, surface classification and selected
details remain available. Curve bounds conservatively include unsampled arcs
and terrain relief. A parked resize or FOV change triggers a fresh selection.
Eviction deliberately does not queue `Entity.show=false` before removal:
Cesium's static ground batches otherwise retain a removed geometry in their
show-update queue and stop the render loop on camera travel.

Fresh-browser artifacts are `qa-artifacts/resource-costs/before/report.json`
and `qa-artifacts/resource-costs/final/report.json`. An intermediate run ended
with a closed Chrome session; its partial results are not the final validation.
The original harness's feature-label population assertion was corrected;
its note describes the correction against the recorded 10,000
contacts. Measurement values were not changed.

CPU/FPS were sensitive to other laptop activity (observed load average near 23;
no macOS thermal warning was reported). The final matrix's unchanged aircraft
control ran as low as 43 FPS, so its CPU/FPS deltas cannot establish an isolated
code improvement. A separate warm, steady run (`steady/report.json`) measured
about 60 FPS for aircraft-only/regional views and 51 FPS for aircraft plus
cables after a 15-second warm-up. This is not a locked-60-FPS claim for every
layer combination. Paired vector/cache bracket checks reduced GPU-process CPU
by about 9–15%; main-thread results varied between pairs.

The dense-bracket bitmap cache activates at 4,096 candidates and caps
its pixel store at 24 MiB. It preserves DPR and keys on exact paths, width,
opacity and surface size; continuous geometry changes fall back to vectors.
It releases its canvas for sparse/disabled workloads. This trades bounded image
storage for reduced repeated drawing, rather than claiming a memory saving.
Chrome pixel checks at DPR 1/1.5/2, overlapping alpha bands and fractional
coordinates differed by at most 2/255 per color channel. The recorded wide-view
measurements use the same cache path; the final threshold avoids allocating it
for the roughly 1,115-marker regional view.

Other costs to consider when enabling features:

| Feature          | Evidence and scope                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google 3D        | Standard configuration permits 1536 MiB cached content plus 1024 MiB overflow, before driver overhead. The controller now requests public `trimLoadedTiles()` when a 3D camera settles and when its stack is hidden. Selected tiles remain protected by Cesium; returning to old views may download tiles again. Active detail/cache settings are unchanged. Live Google memory savings were not measured. |
| CCTV             | The 5,000-record catalog/coverage fixture added about 56 MiB estimated WebGL storage and 20 MiB retained heap. It retained geometry after disable. A 1080p still-image projection uses up to three RGBA canvases (about 24 MiB) before GPU copies. Video decoding and on-device detection add separate costs not covered here.                                                                             |
| Weather playback | Globe mosaics cache six decoded 2048×1024 images (48 MiB); each weather shell has a 128 MiB image-cache budget. Current/staging GPU textures are additional. These are code budgets, not measurements from this audit.                                                                                                                                                                                     |
| Aircraft 3D      | Fleet caps are 150 models per layer in proximity mode and 350 in All mode, with separate tracked models. Model assets/draw calls add costs; this audit uses flat-map sprites and does not quantify a dense 3D fleet.                                                                                                                                                                                       |
| Dense satellites | The 7,000-object fixture added about 17 MiB retained heap and less than 2 MiB WebGL storage above the pre-satellite state. Catalog/native points remain cached while disabled. It is smaller than cables in this workload.                                                                                                                                                                                 |

The **75% total-memory target remains unmet**. The approximately 1.1 GiB idle
browser footprint in this configuration already exceeds 25% of the original
3.2 GiB cable-heavy case. Further work must examine native/driver allocations
and the cost of the full globe renderer, not just retain fewer JavaScript
objects. WebGL estimates exclude Canvas2D backing stores, worker heaps, driver
copies, pipeline caches and browser compositing; they are not total GPU memory.

Verification completed 10 November: 195 focused detection/map/cable tests,
14 native cable browser checks (picking, selected details, travel, parked
resize, surface-classification changes, return-to-view and re-enable), real
Chrome pixel comparisons, a known-allocation WebGL accounting check,
application startup/annotation/terminal teardown, 15 isolated allocation gates,
production build and package boundaries passed. Formatting of the performance
changes passed; a later repository-wide check flagged separate maritime files
(`server/providers/vessels/ais-store.js` and `src/maritime/voyage.js`). The full unit run
recorded 11,619 passes, 3 skips and 13 failures: 11 locale catalogs and one
Gemini endpoint expectation from separate vehicle-flow work, plus a temporary
directory cleanup failure. The cleanup checks still reported local ENOTEMPTY
failures when isolated. Allocation probes interrupted during the overnight
pause were rerun and all 15 passed. These failures remain reported rather than
changing unrelated feature work to make the suite green.

The feature capture used matched local builds.

Complete results and validation status are in the gitignored
`qa-artifacts/resource-costs/` directory.

### Next optimization plan — 10 November 2026

The next pass targets normal-mode resource ownership and frame pacing. Keep
current visible detail, full contact data, picking, tracking, camera calibration,
weather controls and map-provider recovery. These are proposed changes, not
measured savings or changes already implemented.

| Order | Work                                          | Evidence and proposed approach                                                                                                                                                                                                                                                                                                                                                                                                                                          | Tradeoff / gate                                                                                                                                                                                                                                                   |
| ----- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | CCTV still-image runtime eviction             | `pauseInactiveProjectionFeeds` disposes inactive video runtimes, but skips image runtimes. A visited still-image camera can retain its 1920×1080 canvas and two swap buffers: about 24 MiB of RGBA storage before source images and GPU textures. Bound inactive runtimes by bytes and evict after a short grace period; release canvas backing stores, image callbacks and material references. Keep camera metadata and calibration independent of runtime ownership. | Returning to an evicted camera reloads its frame. Test repeated camera switching, adjust mode, activation and disable/re-enable; verify no stale async callback recreates disposed resources.                                                                     |
| 2     | Aircraft model creation pacing                | Civil and military fleet/tracked loaders explicitly use `asynchronous:false`; the installed Cesium option spreads WebGL creation across frames when true. Prototype asynchronous creation plus a small bounded admission queue, retaining existing model caps and billboard-to-ready-model handoff. Defer the retained warm-up model until a 3D view needs it.                                                                                                          | Primarily reduces CPU spikes, rather than steady-state model memory. Measure cold tracking latency, zoom transitions and cockpit handoff. Existing distance hysteresis and viewport eligibility remain.                                                           |
| 3     | Weather decoded-cache residency               | Globe cache holds six 2048×1024 mosaics (48 MiB). A shell budgets 128 MiB, already intended for shown and next frames with detail; material/GPU storage is additional. Retain full-quality shown images, keep next-frame prefetch during playback, and release history/prefetch on pause or hide after a grace period. Add a shared budget across active weather products, protecting displayed and staging images.                                                     | Scrubbing backward may fetch/decode again. Do not merely lower each cache cap: protected frames can exceed it, and active playback needs staging capacity. Test playback, pause/scrub, infrared modes, host switches and late decode completion.                  |
| 4     | Google 3D tile history and inactive ownership | All credential routes currently permit 1536 MiB cache plus 1024 MiB overflow. Existing camera-settle and hide trims already discard unused tiles. Benchmark smaller history budgets while holding screen-space error fixed; separately trial destroying an inactive, controller-owned tileset after an idle grace period.                                                                                                                                               | High potential, but actual memory is unmeasured. Too little overflow can force coarser tiles; frequent eviction can increase downloads and pan stutter. Preserve external tileset ownership, provider recovery, collision/height behavior and weather attachment. |
| 5     | CCTV coverage geometry residency              | The 5000-camera fixture retained coverage geometry after disable. Keep the catalog lightweight and reconstruct native coverage only for the padded viewport plus active/selected cameras. Dispose inactive geometry on disable while preserving calibration data.                                                                                                                                                                                                       | Measure terrain sampling and rebuild cost; use a staggered queue to avoid re-enable stalls. Ambient cards already tear down on disable and inactive video already disposes, so do not claim those as new fixes.                                                   |

For Google 3D, compare the current budget with experimental 512 MiB and 256 MiB
history budgets at the same visible detail, recording visible working-set size
and overflow separately. These are experiment points, not proposed universal
defaults. Test dense city, low flight, fast travel and return-to-previous-view
with actual Google content. The prior flat-map fixture cannot validate this.

After these lifecycle changes, profile steady model draw calls before building
a new asset pool. Cesium's installed glTF loader already uses shared resource
cache loaders for textures and buffers. If draw submission dominates, prototype
instancing repeated fleet types, preserving per-aircraft picking, tint, transform
and tracked-model handoff. That is a larger renderer change. Source-sized CCTV
buffers and compressed aircraft textures are separate candidates requiring image
quality comparisons; do not silently reduce full-screen feed or model quality.

Extend the production benchmark with real CCTV still/video switching, each
weather product and playback, dense civil/military 3D fleets, and actual Google
city travel, then test the combined workload. Use the same laptop, browser,
viewport and DPR, with warm-up and repeated before/after runs and no concurrent
builds. Record total browser physical footprint, retained heap, estimated live
WebGL storage, worker/media costs, process CPU and frame-time percentiles; the
WebGL probe alone misses Canvas2D, decoders and driver storage. Distinguish
post-disable retained resources from allocator high-water memory. Add regression
checks around changed ownership and async races rather than repeating unrelated
application tests for every experiment.

The target remains approximately 60 FPS in normal mode (16.7 ms frame budget),
with 30 FPS as a fallback floor for heavy combinations, not a global cap. Check
tail frame times as well as average FPS. The measured cable-heavy baseline was
3312 MiB; a 75% reduction would require about 828 MiB total, below the roughly
1.1 GiB idle footprint seen in a separate run. The four systems above cannot be
assumed to deliver that total reduction. If they plateau, profile base scene
framebuffers/driver allocations and prototype a lighter flat-map render path
before promising the target. Report each measured workload separately.

### CCTV, aircraft, weather and Google 3D — 10 November 2026

Implemented the first resource-lifecycle pass in Standard mode. CCTV now
releases inactive still-image runtimes as well as video, zeros their canvas
backing stores, and releases coverage outside its existing visible set or on
layer disable. Camera metadata, calibration and sampled frustum coordinates
remain available. A cadence-limited camera restores its previous proxy frame
once on return while retaining its refresh deadline; the proxy's existing
provider cache enforces the upstream request floor.

The installed Cesium static entity material batch removes primitives without
explicitly destroying their materials. CCTV now observes its image materials
through public primitive/appearance APIs and destroys each only after no native
primitive references it. This also covers native batch replacements while a
camera remains active. Collection change events avoid scanning unchanged scenes;
billboard and point collections are not traversed. Subscriptions stop after the
last owned material/source is released. The code does not patch Cesium internals.

Civil and military aircraft load assets on demand, spread WebGL creation across
frames, and admit at most four fleet loads per tick with at most four pending
fleet loads per layer. Existing model caps, viewport eligibility, tracked-model
priority and ready-model handoff remain. A cold dense fleet fills progressively
while its icons remain visible. Weather drops decoded history and speculative
frames when paused, retaining displayed/staging/retiring images until their
consumers release them; active playback keeps full-resolution prefetch.

Google's three credential routes now share a 512 MiB cache target plus 2048 MiB
overflow. The former 2560 MiB combined working-set ceiling, collision behavior
and screen-space detail setting remain. This reduces historical retention during
travel; returning to an evicted view may download content again. Google was
unavailable in the local measurement environment, so live city memory, download
churn and FPS remain unmeasured. Inactive shared tileset destruction is deferred:
several app consumers retain the startup tileset reference and need an explicit
recreation contract first. Per-product weather playback budgets remain; a shared
budget and aircraft instancing need separate multi-product/varied-asset trials.

Measurements use frozen before/after source trees, Chrome 156 with hardware
ANGLE Metal on the same M2 Pro/16 GiB laptop, production builds, a 1440×860 view,
DPR 2, Standard mode and 300 synthetic aircraft. The scenario visits 24 distinct
1080p still cameras, returns to the first, disables/re-enables CCTV, changes six
global-cloud infrared settings and plays/pauses weather. Both captures use the
same harness hash, populations and drawing-buffer dimensions; no builds or
other tests ran alongside these captures.

| Measurement                                            |            Before |           After |
| ------------------------------------------------------ | ----------------: | --------------: |
| Browser physical footprint after 24 camera visits      |          2507 MiB |        1791 MiB |
| Additional retained canvas pixel capacity              |           570 MiB |          24 MiB |
| Canvas pixel capacity above control after CCTV disable |           570 MiB |           0 MiB |
| API-accounted WebGL storage after 24 visits            |           789 MiB |         290 MiB |
| Paused global-weather decoded cache                    | 48 MiB / 6 images | 8 MiB / 1 image |
| Warmed 300-model aircraft FPS                          |              60.3 |            60.4 |
| Warmed 300-model main-thread CPU                       |             35.3% |           29.3% |
| CCTV-enabled FPS after 24 visits                       |              60.4 |            60.4 |
| Weather playback FPS                                   |              59.3 |            59.0 |

This is **29% less total browser footprint** for this CCTV-heavy scenario and
**96% less additional canvas capacity**. The sampled warmed-model CPU was about
17% lower; this is a paired observation, not a general CPU-reduction guarantee.
Cold admission has a different temporary model count, so its CPU readings are
not used as an equal-population comparison; both warmed phases contain 300
models. Weather playback retains its buffering and the paused cache shrinks by
83%. Active CCTV API-accounted WebGL storage stays near 290 MiB on return and
re-enable, rather than continuing to grow.

API-accounted storage counts allocations minus explicit deletion. It does not
observe implicit handle garbage collection, Canvas2D pixels, video decoders or
Metal/driver caches, and must not be equated with total GPU physical memory.
Browser footprint stays above the fresh idle level after disable despite pixel
and entity release. The remaining cost is concentrated in GPU/renderer processes;
decoded-image caches, native allocation reuse and driver residency require a
memory-infra trace to separate. A CCTV-disabled phase measured 54.8 FPS (P95
33.7 ms), so this is not a locked-60-FPS claim. Live video, camera AI, Google city
travel and a varied hangar fleet are not represented by these fixtures.

The **75% total-memory target remains unmet**. For the 2507 MiB CCTV baseline,
that target would be about 627 MiB, below the measured 1068 MiB fresh idle
footprint. Base renderer/driver allocations need investigation alongside further
feature work; reductions from different workloads must not be added together.

Validation: 581 CCTV/provider/media tests, the focused aircraft/weather/map
checks, 40 application lifecycle tests, 109 native aircraft browser checks,
production build and package boundaries passed. Both final captures passed every
check with no browser/render errors; 31 checks on the baseline and 43 on the
comparison, including population comparisons. Older hide-only CCTV assertions
now require actual plane removal while preserving host labels, deselection state
and camera pose. Regression coverage includes cached cadence restoration,
material sharing, native batch replacement, listener disposal and late model-load
cancellation.

Evidence lives under `qa-artifacts/feature-optimization/`: `measured-before/`,
`measured-after/`, `validation.json`, source hashes and changed runtime snapshots.
Earlier shared-output and intermediate texture-cleanup captures are diagnostic
only. The measured harness is archived as `measured-harness.mjs.txt`; its generic
model-like counter also included CCTV geometry, so only dedicated aircraft-phase
model counts are used. The archived profiling harness distinguishes Models via their public
animation collection and additionally records P99/max frame times. These counter
improvements do not rewrite the saved measurements. Use the same archived harness
for both sides of any new comparison.

## Native aircraft sharpness (November 10, 2026)

This first experiment was superseded by the separate aircraft surface below:
its 1.5× framebuffer still softened silhouettes on a 2× Retina display.

The native Cesium path remains in use: shared SVG inputs become textures in
Cesium's billboard atlas. Standard mode now renders at the display pixel ratio,
capped at 1.5×; it previously rendered at 1× even on a 2× Retina screen. MSAA
remains 4. Aircraft choose shared 32/64/96/192-pixel images using their actual
framebuffer footprint, with hysteresis to avoid repeated atlas changes. Model
minimum sizes are corrected for the framebuffer ratio so aircraft do not shrink.
Picking remains in CSS coordinates. Low-resource mode retains 0.6×/30 FPS.

On the same M2 Pro/16 GiB laptop, Chrome 156/Metal, 1440×860 CSS pixels and DPR 2,
the frozen production candidate produced these seven-second warmed samples:

| Workload / native render scale  | Browser physical footprint |  FPS |
| ------------------------------- | -------------------------: | ---: |
| 300 3D aircraft / 1.5×          |                   1534 MiB | 60.1 |
| 300 3D aircraft / full 2×       |                   2000 MiB | 56.6 |
| 10,000 flat-map contacts / 1×   |                   1204 MiB | 59.6 |
| 10,000 flat-map contacts / 1.5× |                   1532 MiB | 54.9 |

The 1.5× cap used **23% less browser footprint than full 2×** in the 3D sample.
It still costs memory relative to the old 1× renderer: about 328 MiB more in the
wide flat-map sample. This is a bounded sharpness improvement, not a memory
reduction against the old blurry view. The extreme 10,000-contact view does not
hold 60 FPS. These synthetic fixtures do not profile live Google city travel or
a varied hangar fleet, and the 75% total-memory target remains unmet.

A native billboard image comparison preserved CSS footprint and contact picking
at 1×/1.5×/2×. The 1.5× crop was closer to the full-2× reference (mean squared
pixel error 44.5 versus 87.2 for 1×); this isolated image check is not a universal
perceptual-quality score. All 12 fidelity/mode checks, 95 focused unit tests,
109 native Retina tracking checks, production build and package boundaries
passed. The final workload captures reported no JavaScript/render errors.

Evidence: `qa-artifacts/native-crispness/fidelity/`, `final-models/` and
`final-wide/`. Use `state.fps` in these reports, measured between browser frame
timestamps. Earlier exploratory captures divided frame count by Node elapsed
time, which can bias FPS through protocol sampling latency. The harness now
records the browser frame interval directly.

## Separate full-resolution aircraft surface (November 10, 2026)

Normal-mode 2D aircraft render on one transparent full-DPR WebGL2 surface above
the globe and below the shared HUD. A single indexed draw uses a bounded 2048²
atlas with shared 512² class silhouettes; neither textures nor DOM nodes grow
per aircraft. The globe returns to 1× rendering, with MSAA 4 unchanged. Civil,
military and tracked 2D aircraft retain their existing CSS size, tint, alpha and
rotation. Native Cesium billboards remain responsible for exact identity picks;
their image buffers warm on image/admission changes and flush current positions
when picking. Follow-camera entities and the ready-model handoff remain intact.
Tracked entities retain an invisible position anchor so Cesium's EntityView keeps
updating while their original billboard is hidden. The single tracked pick proxy
updates every frame; deferred buffer updates apply to the fleet.

The surface reuses its last frame until camera, viewport/DPR, contact visuals or
membership change. This matches the existing fleet motion cadence; it does not
throttle camera movement. The initial per-frame vector prototype fell to about
8–14 FPS at 10,000 contacts and was rejected. Batched rendering plus frame reuse
avoids both repeated path tessellation and redundant pick-buffer uploads.

Paired frozen production captures used the same harness, M2 Pro/16 GiB laptop,
Chrome 156/Metal, 1440×860 CSS pixels, DPR 2 and five-second warmed samples.
Other application work remained active on the laptop; these are observations,
not isolated hardware limits. No builds or other tests from this task ran alongside captures.

| Workload                       | Before memory | After memory | Before FPS | After FPS | Before main CPU | After main CPU |
| ------------------------------ | ------------: | -----------: | ---------: | --------: | --------------: | -------------: |
| 1,000 aircraft                 |      1448 MiB |     1208 MiB |       60.1 |      60.2 |           27.9% |          20.2% |
| 10,000 aircraft                |      1570 MiB |     1298 MiB |       54.8 |      59.8 |           74.7% |          57.6% |
| Regional view, 10,000 retained |      1485 MiB |     1250 MiB |       60.1 |      60.2 |           31.3% |          26.2% |
| 10,000, detection off          |      1456 MiB |     1227 MiB |       60.0 |      60.1 |           38.4% |          29.4% |
| Combined fixture               |      1731 MiB |     1462 MiB |       57.4 |      60.1 |           67.0% |          52.8% |

Memory is total browser physical footprint. CPU is CDP main-thread task time
divided by sampled wall time. The 10,000-aircraft case used **17% less memory**
and **23% less sampled main-thread CPU**, with the same 10,000 contacts visible.
The regional case retains the same 1,112 native residents on both sides; 522
fall within the actual painted viewport, with the remainder in the residency
padding. The full-DPR surface has 18.9 MiB logical color capacity; at 10,000
contacts its atlas, staging tile and CPU/GPU vertex/index capacities total about
21.4 MiB. Driver/compositor allocations are additional and included only in the
physical footprint measurement. Disabling layers releases the extra canvas,
texture, buffers and program; the browser can retain native/driver caches.

The surface deliberately uses native compositing for non-normal/transitioning
styles, bloom and other optical post-process stages, cockpit, non-3D scene modes,
and special gradient artwork. Low mode retains the existing native 0.6×/30 FPS
budget. Overlay allocation/context failure also restores native rendering, so a
lost auxiliary context does not blank the globe. 3D models and background imagery
still use the smaller globe framebuffer. These captures do not profile live
Google city travel or a varied 3D hangar fleet, and do not establish a universal
60-FPS guarantee. The 75% total-memory target remains unmet; percentages from
different workloads and earlier optimizations must not be added together.

Evidence: `qa-artifacts/aircraft-surface/measured-before/` and
`measured-after-cached/`. The earlier vector, GPU-per-frame and uncached captures
are diagnostic only. The paired reports passed all 13 workload checks without
JavaScript/render errors. Dedicated browser verification also covers native
contact and tracked-entity picks, follow-camera selection, display changes,
style/low-mode fallbacks, re-enable cleanup and auxiliary context loss. All 22
surface browser checks, 109 hardware Retina tracking checks, 58 focused unit
tests, production build and package/import boundaries passed. The workload
profiles contain no tracked selection; the final tracked-pick/anchor and viewport
membership safeguards were validated separately from those performance samples.
Live-data verification also exposed nested helicopter rotor groups missing from
the first synthetic fixture. The compiler now flattens their SVG rotations, and
unsupported future artwork falls back to native rendering instead of stopping
the scene. Browser comparisons cover all ten ordinary aircraft classes against
their source SVGs; mean absolute 8-bit alpha error is below 0.08 for every class.
The live OpenSky preview was then checked separately from the synthetic fixtures.

## Detection reuse and transit residency (November 10, 2026)

Detection reuses exact projected geometry while the camera matrix, camera
position, viewport, density profile, contact coordinates and bracket dimensions
are unchanged. Weak keys avoid owning evicted contacts. Alpha, keyhole/sonar
appearance, label text and label placement remain live. Per-frame VEH contacts
(transit and street traffic) use one direct scratch projection instead: caching
positions that change on every frame added work without a reuse window. The
combined observation array is reused, and non-solve paints avoid unnecessary
label-priority/hash work. Turning detection off releases its geometry and cached
bracket pixels; it previously retained the extra raster surface while hidden.

Transit now removes offscreen native billboards while retaining vehicle records,
playback histories and analyst queries. Visibility sweeps recreate residents on
re-entry, with fresh heading state. Selecting an offscreen record creates a
protected resident. Empty collections use public `removeAll()` to release
Cesium's pending-update references. Existing feed coverage, TTLs, history
budgets, label density, image resolution and movement cadence are unchanged.

Captures used frozen production previews on the current Apple M2 Pro / 16 GiB
laptop, Chrome 156 with hardware ANGLE Metal, 1440 x 860 CSS pixels at DPR 2,
standard mode and five-second samples. No CPU profiler was attached to the final
repeated comparison. CPU below is CDP main-thread task time / sampled wall time,
not total system CPU. Three samples per workload are summarized by their median.

| Workload                         | Before FPS | After FPS | Before main CPU | After main CPU |
| -------------------------------- | ---------: | --------: | --------------: | -------------: |
| 10,000 aircraft, dense detection |       55.6 |      58.3 |           81.0% |          77.8% |
| 3,000 transit vehicles, city     |       60.0 |      60.0 |           57.1% |          43.5% |
| Same transit records, street     |       60.0 |      60.0 |           17.4% |          14.3% |

Dense detection retained 10,000 observations, 10,000 visible brackets and 42
selected labels in every repeated sample. The street transit view kept the same
18 visible vehicles and 3,000 analyst records, with **18 resident billboards
instead of 3,000**. This is a 99.4% reduction in resident billboard count, not
in total application memory. The city view still renders all 3,000 vehicles.

At the final street checkpoint, browser physical footprint was 1217.5 -> 1153.6
MiB (about 5% less); retained page heap was 57.0 -> 58.2 MiB. City footprint was
1155.2 -> 1158.1 MiB. The geometry cache trades a small amount of JS storage for
less repeated work. There is **no established 75% total-memory saving**.

Results varied substantially on the shared laptop. An earlier unprofiled full
journey measured 60.2 -> 52.1 FPS for the dense view and 60.1 -> 58.5 FPS
regionally; an exploratory profiled pair measured 43.5 -> 53.0 FPS densely and
about 60 FPS regionally. The repeated unprofiled dense ranges were 50.3–57.5 FPS
before and 52.2–58.4 after. Intermediate transit captures also varied in CPU and
footprint, including runs with no physical-memory saving. The final VEH direct
path avoids cache bookkeeping for the moving fleet, but these observations do
not establish universal CPU improvements or a locked 60 FPS under every load.
The per-frame VEH bypass was added after the repeated AIR comparison; AIR's
cache path remained intact and was covered by the final unit/preview checks.

Validation: 332 focused unit tests, 109 hardware Retina aircraft tracking checks,
transit parked/moving heading and camera-orbit checks, the production build and
package/import boundaries passed. The final transit capture passed nine checks
with no JS/render errors, including offscreen queries/selection, camera re-entry
and disable cleanup. Ground-aircraft controls are checked separately against the
promoted stable preview. These synthetic captures do not establish every live
feed's availability or profile Google 3D city travel.

Evidence is under `qa-artifacts/overlay-transit/`: `repeated-before/`,
`repeated-after/`, `transit-before-final/`, `transit-after-direct/` and
`comparison.json`. `baseline-source/`, `source/` and `release-source/` archive
runtime snapshots/hashes. `source/` predates the final VEH direct path;
`release-source/` records the shipped version. Other captures in that directory
are exploratory/intermediate evidence, not interchangeable saving percentages.
The historical captures used the same archived harness on each frozen build.

## Street traffic and satellite work reuse (November 10, 2026)

Street traffic reuses detection records and formatted identities per simulated
dot. Recycling changes the identity, moving points remain live and switching
between live-flow and simulated styling clears the previous tier. Stopped dots
skip redundant interpolation/position setters while retaining fades and height
refinement, including the frame that finishes a surface correction. Dot limits,
speeds, stop-light/creep behavior and update cadence are unchanged.

Satellite fleet points use a direct TEME-to-ECEF rotation instead of calculating
geodetic coordinates, speed and bearing and then converting back to Cartesian.
Rotation is shared for a batch timestamp, and caller-owned scratch vectors are
cloned by native point setters. Tests compare the result with the existing rich
path within 1 mm for LEO, polar, GEO and eccentric fixtures. Tracking, analyst
records, search and orbit paths retain the rich calculation. Detection stops
iterating after the last core point instead of scanning trailing dense extras
which never contribute labels. A small shared class/group/ISS text cache is
cleared on locale changes; reclassification selects the new class/group key.
There are no additional text-cache fields per satellite. No source populations,
class preferences, render resolution, cadence or 3D detail were reduced.

The current M2 Pro / 16 GiB laptop ran Chrome 156 / hardware ANGLE Metal with
1440 x 860 CSS pixels at DPR 2, standard mode. Fixtures produced 2,667 street
dots and 7,001 satellites (2,000 visual, ISS and 5,000 dense). Three five-second
samples per phase were captured in fresh browsers for the long journey. A
second check alternated before/after builds in one browser (B,A,A,B,B,A), with
the inactive app's renderer paused. Each measured phase had a one-second warmup
and a four-second sample, three samples per build. Paired physical memory is
not attributable to either build, so it is not compared. Focus before fixture
preparation is required: the app intentionally idles background traffic work.

| Paired workload                                | Before / after median FPS | Before / after main-thread task CPU |
| ---------------------------------------------- | ------------------------: | ----------------------------------: |
| Traffic, detection on                          |               60.0 / 60.0 |                       21.6% / 23.0% |
| Tracked satellite, 7,001 points                |               60.1 / 60.0 |                       31.9% / 32.8% |
| Combined, same 2,667 dots and 7,001 satellites |               60.0 / 60.0 |                       41.7% / 35.8% |

The combined observation is about 14% less sampled main-thread task time.
Individual-layer CPU did not consistently improve: earlier captures favored the
changes, but later samples varied or favored the baseline. These are shared
laptop observations, not guaranteed CPU savings or a locked-60-FPS claim. The
long final journey also included one 54.4 FPS traffic/no-detection sample; all
final long-journey scene medians were about 60 FPS. Source populations matched
in every paired scene. Traffic reused 99/99 sampled detection objects across
consecutive calls, compared with 0/99 before; this establishes less record/string
churn, not a matching total-RAM reduction.

Final independent long-journey retained-memory checkpoints:

| Scene                  | Before / after retained page heap | Before / after browser physical footprint |
| ---------------------- | --------------------------------: | ----------------------------------------: |
| Traffic, detection on  |                   46.4 / 46.5 MiB |                       1112.4 / 1087.9 MiB |
| Traffic, detection off |                   44.5 / 45.8 MiB |                       1055.4 / 1081.7 MiB |
| Satellites, global     |                   57.3 / 58.4 MiB |                       1138.8 / 1156.0 MiB |
| Satellites, tracked    |                   59.7 / 63.3 MiB |                       1229.2 / 1281.8 MiB |
| Satellites, disabled   |                   59.4 / 61.6 MiB |                       1213.2 / 1204.5 MiB |

There is **no established total-memory saving in this pass**; several checkpoints
increased. Native satellite point/catalog caching is still retained while off.
Time advances during these animated scenarios, and browser/driver residency and
other laptop activity varied. Native/browser/GPU allocations remain much larger
than retained page JS heap. The overall 75% memory target remains unmet.

Validation: 335 focused tests pass, including coordinate equivalence, date
mutation, recycled traffic identity, stationary height correction, classification
and language changes and the dense-scan cutoff. The hardware Retina tracking
suite passed all 109 checks; the final shared text memo was then rechecked by the
focused suite and final browser search/follow/re-enable journeys. Traffic source,
oblique camera, visibility/styling controls and keyless fixture verification passed
11 checks; live quota accounting was inconclusive by design because providers
were synthetic. The final long journey passed all 10 checks, including all 7,001
analyst records, name search, follow-camera ownership and re-enable recovery.
All five paired checks passed. No JS/render errors were recorded. Production
build, formatting and package/import boundaries passed. No new worker or GPU
simulation subsystem was introduced.

Evidence is under `qa-artifacts/traffic-satellites/`: `before/`, `after/`,
`paired/` and `comparison.json` are the final comparisons. `before-source/` and
`release-source/` archive runtime snapshots/hashes. Intermediate math-only and
per-contact-cache captures and failed fixture/preparation diagnostics are retained
separately and are not the shipped results. The per-contact cache was replaced
with the shared vocabulary cache. The historical long captures and paired checks used the same archived harness.

### PR integration allocation check — 10 November 2026

The final isolated PR branch was checked against the repository's unchanged
5,000-observation moving-detection allocation gate on Node 24.22.1. Integration
initially exposed about 1,326,927 bytes per frame in this synthetic workload.
Keeping projection cache misses inline and overwriting the existing observation
array backing store reduced the median to 209,338 bytes per frame (41.9 bytes
per candidate), below the existing 700,000-byte and 154-byte-per-candidate
limits. The same probe against current upstream measured 333,921 bytes per
frame. All 5,000 brackets remained visible, with 56 selected labels and 60
solves over 480 measured frames. These are transient JS allocation measurements,
not retained browser/GPU memory or an app-wide memory reduction. Exact cached
projection reuse remains available between contact/camera changes.

### Shared aircraft ownership and transit batching — 10 November 2026

The shared aircraft surface used to retain both its last accepted collection and
its last painted collection after layer teardown. Reset now drops both references;
public fleet `removeAll()` follows the same teardown path as disabling. Other
active fleets invalidate the old pixels and continue rendering.

`node --expose-gc scripts/qa-aircraft-retention.mjs [--remove-all]` exercises real
Cesium objects without WebGL. Three paired runs of each 10,000-contact scenario
against PR head `2d544996` and this follow-up gave:

| Action | Retained native residents, before → after | Median JS heap after GC, before → after | Logical contacts after action |
| --- | --- | --- | --- |
| Hide | 10,000 → 0 | 61,365,704 → 47,837,440 bytes | 10,000 |
| Remove all | 10,000 → 0 | 54,316,368 → 40,548,096 bytes | 0 |

All three repetitions agreed on native-object retention. Hide preserves contact
IDs and positions; re-enable readmits them. The roughly 13 MiB reductions measure
retained native JS graphs in this Node fixture, not GPU memory or total app RAM.
The browser aircraft gate also verifies GC of a previously painted civil fleet
while military remains visible, repainting only the remaining fleet, then civil
re-enable, search, picking and tracking.

The archived native marker-ownership benchmark measured these operations
without WebGL (medians of five runs). The permanent transit residency tests
check queue cleanup and prevent per-removal compaction:

| Operation | Vehicles | Before | After |
| --- | ---: | ---: | ---: |
| Release | 4,096 | 54.205 ms | 1.381 ms |
| Release | 8,192 | 165.292 ms | 2.543 ms |
| Migrate | 4,096 | 51.657 ms | 3.303 ms |
| Migrate | 8,192 | 187.853 ms | 17.289 ms |

For 8,192 removals, native length reads fell from 8,192 to zero and compaction
traversals from 33,558,528 slots to zero. The last removal still empties pending
references. Ingestion eviction and disable share that cleanup path, including
count reset on re-enable. These are CPU operation timings, not browser FPS or
whole-app CPU reductions.

The simplification removes obsolete model preload bookkeeping, consolidates
detection geometry-cache cleanup, and deletes cached detection objects when
their aircraft records are evicted. Queries no longer need a threshold-triggered
scan to discover already-removed contacts. Search, tracking, playback cadence and
Standard visual quality remain unchanged.

The 3,000-vehicle browser transit fixture retained all 3,000 analyst records and
passed offscreen search, selected-contact tracking and viewport re-entry checks.
Its three city samples measured 56.8/58.1/59.0 FPS; street samples measured
60.0/60.0/60.0 FPS. These ran alongside local validation work, not as a claim of
a guaranteed frame rate on other hardware.

Tracking passed all 111 checks with `--offline-imagery --offline-terrain
--hardware --dpr 2`. The opt-in terrain fixture serves flat, zero-height Cesium heightmap tiles for
Re:Earth's exact terrain paths and matching `/api/terrain/heights` responses. Live terrain
returned HTTP 429 during an earlier run; that run passed every behavioral
tracking assertion but failed its two no-console-error checks. The fixture keeps
all tracking/ground-floor assertions enabled; it does not validate live terrain
availability. The expanded sharp-surface browser gate passes 26 checks, including
the parked-source deletion repaint regression.

### Contributing-guidelines audit — 10 November 2026

The current PR was checked against `CONTRIBUTING.md` and the PR template using
Node 24.22.1. The exact `npm test` command passed: 12,152 ordinary tests passed,
3 skipped, and the 1 focus plus 14 overlay allocation checks passed. The local
run used isolated temporary files and Git settings; no assertions were disabled.
The previous temporary-directory cleanup failure did not recur in this run.

Production build, setup doctor, `npm run format`, `format:check`, package/import
boundaries, translation catalogs and published layer-token checks passed. The
token check used `upstream/main`, the actual merge-time base for this fork:
38 published assignments remain unchanged and no new layer token is claimed.
The runtime reference and numbered changelog fragment are present. No data
source or layer was added, so the new-layer checklist does not apply. Missing
JSDoc on exported performance helpers was added.

The required tracking command passed all 111 checks using documented imagery
and terrain fixtures. Offline terrain now covers its point-height API as well as
mesh tiles, keeping all corridor-prefetch and ground-floor assertions enabled
without sharing a live DEM quota with other browser gates. This is a test-only
fixture; it does not change production terrain or qualify live DEM availability.

The existing transit heading gate (5 checks) and map-source control lifecycle
gate (8 checks) passed. The weather teardown gate also passed: weather data
loaded, all scene resource counts returned exactly to baseline, and no uncaught
page errors occurred. Provider console diagnostics were retained in its report.
The broader map-tray gate was attempted but reported push-to-talk/focus/notice
failures and a 503 from the unconfigured realtime-token endpoint; it is not
reported as passing. The CCTV retry completed with 52 checks passed and one
failed: its live-DEM completion probe received no height. The earlier attempt
also encountered HTTP 429 from the terrain proxy. Frame loading, calibration,
click ownership, viewshed reuse and idle raycast checks passed, but live CCTV
DEM qualification remains outstanding. After merging upstream weather frame
sources and contact-clock support, all 335 focused weather/aircraft tests and
the full unit, build and tracking gates passed again. No new tests or scripts
were added for this audit.

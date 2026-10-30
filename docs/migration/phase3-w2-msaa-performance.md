# Navara render-cost investigation — 2026-10-30

The optimization reduces median uncapped Navara work p95 from **18.1 to 14.6 ms (19.3%)** against the original pipeline rerun on the same build. Cesium measures **4.2 ms**, so Navara remains **3.476×** slower on this metric. The required 1.10 gate still **FAILS**. At normal pacing both engines deliver **600 frames/10 s**, with no measured frames above 33.4 ms.

The previous report's 15.7 ms Navara / 4.2 ms Cesium result was a different session. Against that historical number the reduction is only **7.0%**, from 3.738× to 3.476×. Do not substitute the fresh 18.1 ms control for the historical result or describe the 19.3% as a controlled cross-day improvement. All three fresh optimized samples are faster than all three fresh original-pipeline samples, but the run order and desktop-load variation limit causal precision.

Runtime commit: `c5a6ba1e133ec8c1e4a3bfcb55655b14b7fc37bb`. Dioxus, app defaults, SDK files and upstream branches are unchanged. All work and commits are local.

## What was expensive

- Navara 0.2.1 creates both HDR composer buffers with 4× MSAA, depth and stencil. Full-screen effects repeatedly resolve these buffers even though their input is already a raster image. This is additional work beyond antialiasing geometry.
- The default cinematic look has more post-processing than Cesium's current normal mode. In this camera pose clouds are disabled, but atmosphere, lens flare, tone mapping and SMAA remain. Lens flare alone submits 22 draws including its mip chain. The two standard looks are not an equal-effects renderer microbenchmark.
- Installation outlines remain expensive inside Navara's MRT stencil path. With post-buffer MSAA removed diagnostically, the empty scene was 3.6 ms and the installation-only scene 7.2 ms. The combined fixture has one batched outline mesh, but it still requires three stencil draws and their MRT resolves. This attribution is diagnostic, not an accepted before/after benchmark.
- CPU timings within individual passes moved when the pipeline changed: the browser can wait for GPU command completion in a later pass. The reported preRender→postRender duration measures **CPU/submission/backpressure**, not isolated JavaScript time or a GPU timer. The original 3.7× figure was not a 3.7× normal-view FPS loss.

## Delivered change

`GeometrySamplingPass` makes the two composer buffers single-sampled while retaining the original sample count for MRT geometry, forward opaque/transparent meshes and the final point/sprite/line overlay. A reusable multisampled target preserves forward geometry coverage. Its background copy and the transparent geometry share one `render()`/resolve; empty passes avoid copies. Depth, HDR precision and post-effect order are preserved.

The adapter uses public `ViewContext`, pass, render-target and renderer APIs. It restores borrowed passes/buffer settings during teardown, follows resized targets and MRT attachment replacement, and does not patch the SDK or reduce the canvas resolution. The version is pinned to Navara 0.2.1; its pipeline assumptions must be checked again on an SDK upgrade.

Rejected experiments are retained in the evidence:

- Single-pass CCTV ribbons: 154→78 overlay draws, but no useful frame-time improvement; not shipped.
- Skipping stencil/depth resolves: no useful improvement; not shipped.
- A stencil-only shader variant: slower; not shipped.
- Removing MSAA from all post/forward buffers: faster, but would also reduce forward/overlay edge coverage; not shipped. The delivered version keeps four geometry samples.
- One combined diagnostic encountered 16 free-terrain HTTP 429 errors and is excluded. Subsequent checks reuse the existing OSM/free-terrain test cache. No Google/Cesium credentials or paid tiles were used.

Per-pass GPU timer-query values were non-additive on this headless Metal path; they are not used as measured GPU milliseconds.

## Repeated measurements

Same M2 Pro/12-core host and Chrome 152 headless Metal; 1280×800, DPR 1; keyless OSM/terrain; fixed application clock and the unchanged combined W2 fixture. Each series discards one context, then measures three contexts per engine, with 3 s warmup and 10 s capture per scene. All GPU jobs are sequential, with no concurrent builds or runtime edits. The baseline series precedes the optimized series; Cesium/Navara contexts alternate within optimized series. The later paced series uses normal browser pacing.

All captures use the same QA manifest SHA256 `b09675751d2086df83f6badb9f6ea9c70d748fb69266d4afcf2ad43f5f4e1135`, committed runtime, empty tracked diff and driver. `--baseline-sampling` disables only the new sampling effect before startup and asserts that its override ran. The provider fixtures, look, camera, resolution, counts and motion assertions remain unchanged. All final browser-error arrays are empty. Tile caching changes startup/network conditions, so these runs make no cold-start claim.

| Scene | Original Navara work p95 samples, ms | Optimized Navara samples, ms | Median original → optimized | Reduction | Cesium median | Optimized N/C |
|---|---|---|---:|---:|---:|---:|
| Empty | 7.2, 7.6, 9.0 | 5.6, 6.2, 6.4 | 7.6 → 6.2 ms | 18.4% | 3.9 ms | 1.590 FAIL |
| Combined | 15.5, 18.3, 18.1 | 14.3, 14.7, 14.6 | 18.1 → 14.6 ms | 19.3% | 4.2 ms | 3.476 FAIL |

| Paced scene | Frame interval p95 C / N | Frames per 10 s, every measured run | Frames >33.4 ms C / N | Gate |
|---|---:|---:|---:|---|
| Empty | 18.2 / 18.9 ms | 600 / 600 | 0 / 0 | PASS |
| Combined | 18.1 / 18.7 ms | 600 / 600 | 0 / 0 | PASS |

Uncapped combined frame-interval p95 is 7.1 ms Cesium / 16.9 ms Navara, versus 20.5 ms for the original Navara pipeline. Retained combined JS heap after GC in the paced series is 91.4 MiB Cesium / 53.2 MiB Navara; this excludes GPU memory. No GPU-memory or energy saving is claimed.

The unchanged combined workload asserts 500 worldwide earthquakes (five local), 6000 fires, 20 installations, 200 bike stations, 750 radio stations, 325 ALPR cameras, 25 CCTV cameras, 800 moving/shown transit vehicles and two imagery dates in every sample.

## Review and validation

- Same-page original/optimized pixel oracle: **0 changed RGB pixels** in the fixed 500×460 scene region (230,000 pixels). It verifies post buffers at 0 samples and MRT/forward buffers at 4. Removing contours changes 5,584 pixels and fails the oracle. This is a region-specific proof, not a universal whole-frame equivalence claim.
- Real terrain/opaque-box/depth checks: **8/8**. Sprite colour/alpha oracle: **27/27**. CCTV preview: **31/31**, including actual viewshed pixels, moving-video pixels, paused negative control, repeated toggles and zero idle frames over 22 s.
- Military glyph/model comparison: **20/20** with original thresholds. Model footprint 10,102 vs 10,129 pixels; model size, highlights and luminance remain in tolerance. Navara engine contract: **76/76**, including lifecycle/resource cleanup and return to idle.
- Four new unit regressions cover target/sample ownership, replacement MRT targets, hidden/empty geometry, ping-pong inputs, resize and restoration without per-frame reallocation.
- Full Node 24 suite: **7,345 pass, one Windows-only skip**, plus **15 allocation probes**. Import/package boundaries, scoped formatting, production build, panel build, QA build and main-chunk composition pass. The first boundary check found the two new files missing from the ownership inventory; registering them fixed it. No existing code was reformatted. Main-chunk byte acceptance remains unavailable without its pre-existing baseline.
- The final uncapped driver exits **1** because the original 1.10 performance gate fails; its captures complete and contain no runtime errors. The paced driver exits **0**. These outcomes are retained rather than converting the uncapped failure to a pass.

This task delivers a measured optimization, **not W2 acceptance**. The other previously recorded FIRMS, shell and broader common-surface/dense-matrix gaps remain open; no thresholds were relaxed. Paid photoreal geometry was deliberately not exercised. The next substantial performance opportunity is reducing the SDK's stencil/MRT resolve cost and reviewing the default effect chain while preserving its appearance.

## Reproduce and inspect

From the migration worktree, with the keyless QA preview on 4207:

```sh
rtk proxy env GOOGLE_MAPS_API_KEY= CESIUM_ION_TOKEN= /Users/h/.local/share/mise/installs/node/24.14.0/bin/node scripts/qa-w2-comparison.mjs --base-url=http://127.0.0.1:4207 --out=/private/tmp/gev-msaa-baseline.json --preview --look=cinematic --scenarios=empty,combined --engines=navara --baseline-sampling
rtk proxy env GOOGLE_MAPS_API_KEY= CESIUM_ION_TOKEN= /Users/h/.local/share/mise/installs/node/24.14.0/bin/node scripts/qa-w2-comparison.mjs --base-url=http://127.0.0.1:4207 --out=/private/tmp/gev-msaa-uncapped.json --preview --look=cinematic --scenarios=empty,combined
rtk proxy env GOOGLE_MAPS_API_KEY= CESIUM_ION_TOKEN= /Users/h/.local/share/mise/installs/node/24.14.0/bin/node scripts/qa-w2-comparison.mjs --base-url=http://127.0.0.1:4207 --out=/private/tmp/gev-msaa-paced.json --preview --look=cinematic --scenarios=empty,combined --mode=paced
```

- [Original-pipeline control](phase3-w2-msaa-baseline.json), SHA256 `946779ea8332945510329107c9581b385bdca05d686cea2c1d8859a60b563949`.
- [Optimized uncapped comparison](phase3-w2-msaa-uncapped.json), SHA256 `e7a800c7e3816f65af27d002fcf18b9105067cfaaaf355fd93e3d604b0374b90`.
- [Optimized paced comparison](phase3-w2-msaa-paced.json), SHA256 `eb705dc588ffc3098a20510cc92cf56a84f38fdf1e4aba7bc0b3a50c33d8b0a7`.
- [Gate, pixel, model, contract and diagnostic evidence](phase3-w2-msaa-evidence.json). Original local screenshots/logs remain under `/private/tmp/gev-w2-opt-final/`.

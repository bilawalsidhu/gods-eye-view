# Navara empty-scene resolve optimization — 2026-10-30

The next redundant operation is an MSAA resolve caused by rendering an empty MRT scene. Suppressing it reduces combined median work p95 from **8.8 to 8.6 ms (2.3%)** against the original-render control. Fresh Cesium measures **3.6 ms**: the same-series ratio changes **2.444→2.389×**. Empty-scene work changes **5.0→3.9 ms (22.0%)**. The 1.10 combined budget still fails; this does not complete W2 acceptance.

Runtime `e8d7ec6ad7ea5317f2315dfe8926ff7598cdc4b9`. Dioxus, SDK files, app defaults and prior optimizations remain unchanged. All browser work was headless, with empty Google/Cesium keys and paid-map interception before navigation. No subagents, pushes or publication.

**The clear win is the base map. The combined-scene change is small and close to the observed run-to-run variation; it is not a substantial closure of the full-load gap.** Combined uncapped frame-interval p95 changes 11.1→10.5 ms (Cesium 6.2 ms).

## Investigation and implementation

Short diagnostics found baseline empty/combined costs of 4.9/9.4 ms. Disabling lens flare gave 4.4/9.3 ms, so its 22 draws did not explain the combined bottleneck in this experiment; lens flare stays intact. A prototype suppressing empty scene renders gave 4.1/8.8 ms. These single-context diagnostics identify candidates and are not the accepted measurements below. Per-pass CPU times include backpressure and are not isolated GPU timings.

Navara invokes Three's public `render()` on MRT/forward scenes even when they contain only lights. Three still resolves the current multisampled target. The new helper temporarily wraps `renderer.render` during the MRT pass and skips only its known MRT/opaque scenes when they have no visible drawables, no background, no custom render callbacks, no automatic clear, no pending shadow work and no unresolved explicit clear. Other scenes and real geometry retain their original calls. All effects, resolution, shaders, stencil draws and 4× geometry MSAA remain intact.

Review found an important exception before committing: the SDK may explicitly clear depth before rendering an empty scene, particularly when underground hiding is disabled. The helper now tracks `renderer.clear()` by target; the first render after a clear must run. `clearDepth`/`clearStencil` delegate to this public method. Both borrowed methods restore in `finally`, with no persistent renderer override or extra GPU resources.

The regression failed before the fix (the required resolve was skipped) and passes afterward. Initial browser QA incorrectly expected fewer calls even in the new clear-preservation case. The final assertion requires the same calls in that case; exact pixel tolerance was never relaxed.

## Quality and gates

- **24/24** pixel/call checks. Six original/optimized cases have **zero changed RGB pixels** in the 850×460 canvas region: catalog+CCTV, overlapping fills/holes/outlines in three poses, empty terrain, and the explicit depth-clear branch. The latter produces the same plain sky in both original and optimized SDK paths in this fixture; it verifies resolve preservation and output equality, not visible-terrain quality. Repeated original frames are also exact; removing geometry/filling holes fails the negative controls. This is regional equivalence for these fixtures, not a universal image guarantee.
- Catalog: **40→39 render submissions**, unchanged **247 GPU draws**. Custom poses: **41→40, 42→41, 42→41** submissions, unchanged **70/121/89** draws. Empty scene **36→35**, unchanged74 draws. Depth-clear case correctly retains **38→38** submissions and76 draws.
- Real terrain/opaque-object/depth checks **8/8**; installation checks **Navara7/7, Cesium12/12**; MSAA preservation **4/4**; Navara lifecycle/engine contracts **76/76**. No unexpected browser errors in final checks.
- Full Node24 suite: **7,354 passed**, one Windows-only skip, **15 allocation probes passed**. Five new tests cover draw order/receivers, visibility updates, safety conditions, nested/exception restoration and per-target clears. Boundaries, scoped formatting, production/panel/QA builds and main-chunk composition pass. The pre-existing main byte baseline remains unavailable.
- Only new/modified fragments were formatted. A whole-file formatter invocation was rejected by automatic review; the safe alternative inspected its proposed diff and applied formatting only to added/changed fragments. Nothing remains blocked.

## Repeated measurements

M2 Pro/12-core host, Chrome152 headless Metal,1280×800 DPR1, cinematic look, fixed clock, cached free OSM/terrain and unchanged W2 populations. One discarded context per variant, then three measured contexts;3s warmup/10s capture per scene. Uncapped order is Cesium then the two Navara variants, reversing the Navara order in measured run1. Paced runs alternate Cesium and optimized Navara. Own GPU jobs were sequential with no concurrent builds/runtime edits.

The same-build control installs no-op scene callbacks, invoking the conservative original-render path while retaining previous MSAA/stencil optimizations. The helper/clear tracking exists in both variants, so this isolates resolve suppression; it is not a comparison of independently built old/new binaries. All captures record the committed runtime, empty tracked diff, identical driver/fixtures and QA manifest `387b49aa410105572b06d85c14297037e9cbf99a0e55caf05c514274b7c404a3`. All populations and 800 moving/shown transit vehicles are asserted; final error arrays are empty.

| Scene | Original-render samples, ms | Optimized samples, ms | Median control → optimized | Reduction | Cesium median, ms | Optimized N/C |
|---|---|---|---:|---:|---:|---:|
| empty | 5.1, 5.0, 5.0 | 3.9, 3.9, 4.0 | 5.0 → 3.9 | 22.0% | 3.4 | 1.147 FAIL |
| combined | 8.8, 8.9, 8.8 | 8.4, 8.6, 8.7 | 8.8 → 8.6 | 2.3% | 3.6 | 2.389 FAIL |

| Paced scene | Interval p95 C/N, ms | Distinct frames/10s C/N | Frames >33.4ms C/N | Gate |
|---|---:|---|---:|---|
| empty | 18.9 / 19.4 | [600] / [600, 601] | 0 / 0 | PASS |
| combined | 18.8 / 19.0 | [600] / [600, 601] | 0 / 0 | PASS |

Work p95 is preRender→postRender **CPU/submission/backpressure**, not a GPU timer or normal-view FPS loss. Existing engine effect chains differ. The previous session's Navara9.1ms/Cesium4.0ms and2.275× ratio are historical; use the fresh control above for attribution. Desktop/run-order variability limits precision, particularly for the smaller combined gain. No GPU memory/energy or cold-start saving is claimed.

The uncapped driver exits1 for the retained performance budget; captures complete without runtime errors. Paced exits0. Earlier W2 FIRMS/shell/common-surface gaps remain open, and paid photoreal geometry was not exercised. Dioxus remains deferred.

## Evidence and reproduction

- [Uncapped control/optimized/Cesium data](phase3-w2-empty-renders-uncapped.json), SHA256 `bf00d07786a3696f97566130f7410b24294f443c90e8a4868c11e87db66fc662`.
- [Paced data](phase3-w2-empty-renders-paced.json), SHA256 `93f6b483af88dbe3178bb3f3a4a1b650629c51450076a11362ff2fb9dff349a9`.
- [Gates, exact-pixel checks, diagnostics and review fix](phase3-w2-empty-renders-evidence.json). Full PNGs/logs remain `/private/tmp/gev-empty-final2-*`; CPU logs are `/private/tmp/gev-empty-fixed-*`.

From the migration worktree with the keyless QA preview on4207, using Node24:

```sh
rtk proxy env GOOGLE_MAPS_API_KEY= CESIUM_ION_TOKEN= node scripts/qa-installation-stencil.mjs --base-url=http://127.0.0.1:4207 --out=/private/tmp/empty-pixels.json --empty-renders
rtk proxy env GOOGLE_MAPS_API_KEY= CESIUM_ION_TOKEN= node scripts/qa-w2-comparison.mjs --base-url=http://127.0.0.1:4207 --out=/private/tmp/empty-uncapped.json --preview --look=cinematic --scenarios=empty,combined --empty-render-pairs
rtk proxy env GOOGLE_MAPS_API_KEY= CESIUM_ION_TOKEN= node scripts/qa-w2-comparison.mjs --base-url=http://127.0.0.1:4207 --out=/private/tmp/empty-paced.json --preview --look=cinematic --scenarios=empty,combined --mode=paced
```

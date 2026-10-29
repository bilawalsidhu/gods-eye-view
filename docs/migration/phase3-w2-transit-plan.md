# W2 transit: native baseline, Navara port and comparison

Scope: finish the W2 transit layer without changing GTFS-RT ingestion, playback timing, camera defaults or source policy. Dioxus and W3/W4 are deferred. Work sequentially in `migration/phase3-layers`; no subagents, push or publication. Every build and browser launch has empty Google/Cesium credentials, and browser interception blocks paid map endpoints. Only owned ports4193/4207/4208; headless Metal, one GPU job at a time.

## 1. Pin a useful native reference

- Keep the existing native `qa-transit` heading, recovery, movement, style, selection, trail, context and disable assertions. Remove its unsafe implicit4173 target: require an explicit permitted URL, and install the shared paid-map block in every page before navigation. A live feed that supplies no moving vehicles is unavailable evidence, never a passing deterministic scenario.
- Capture deterministic vehicles through the actual snapshot/history source contract, with bus/tram/subway/rail/ferry/unknown modes, fixed identities, timestamps and bounded positions. Include stopped and stale vehicles, a disappearing selected vehicle, out-of-order reports, bearing changes and a failed request followed by recovery. Pin one fixture epoch for both engines, not the browser's run time.
- Record source hashes and screenshots at regional, city,600m nadir and oblique poses. Require five positive marker controls, exact pick/card IDs, actual motion and heading, selected trail pixels and unchanged history. Measure800/3000-vehicle populations separately from a small correctness fixture. Retain native reference evidence before renderer extraction.

## 2. Extract only engine operations

- Inject a renderer factory from application composition. Shared lifecycle keeps generation/cancellation, polling, visibility scheduling, moving/height-dirty sets, source health, card policy and style events. The renderer owns the two marker banks, their resources, camera events/sensitivity, pre/post-render subscriptions, input handler, credits and native scene queries.
- Replace direct `Cesium.Color` construction with the existing portable colour helper; preserve palette values and icon raster generation. Preserve the existing mutable marker fields required by shared playback, but do not fabricate a Cesium viewer for Navara.
- Move view rectangle, cartographic pose, perspective course projection and current-frustum/horizon tests behind the renderer. Preserve a5m admission sphere and the existing bounds fallback when a frustum is unavailable. Keep visibility sweeps off the per-frame path and retain the rotation refresh throttle.
- Route surface sampling through the current application ground/mesh services. The terrain globe reads the loaded surface synchronously; photoreal misses remain unknown. Do not turn an absent floor into a clearance claim. Keep the current25m prepared corridor,640-vertex history bound and shared sampling budgets.
- Inject the selected-trail renderer through this same owner. Its native implementation and alpha-age curve remain the reference. The moving head must update a clip fraction without rebuilding its vertex buffers every frame. Keep static history separate from the moving head and retain the selected history/request generation guards.
- Keep QA instrumentation meaningful: use engine frame events and measure actual layer CPU, geometry uploads and live population. Do not report an unavailable Navara upload probe as zero. Existing native tests that inspect native collections remain native tests; add portable renderer contract tests rather than deleting them.

## 3. Implement the Navara renderer

- Reuse `engine.movers` for stationary and moving sprite banks, the existing icon rasters and rendering order. Preserve icon size, selected outline, colour, heading, horizon and no-depth-test semantics. Batch mutations before drawing, retain dirty ranges, and commit only when something changed. Reuse the existing vessel/aircraft bank approach where it fits; do not scan/reallocate the stationary fleet on every frame.
- Picks must identify an actual visible owned instance. Retain pointer-tool ownership and the existing sensor-coordinate mapping. Selection, Escape, context actions and a selected vehicle moving between banks must preserve identity and card position.
- Use the existing line/ground rendering capabilities for the selected trail. Prove surface coverage and the partial head against the native reference; plain lifted segments are not a substitute for native draping. Keep colour/alpha ageing and hidden-surface behavior explicit.
- Teardown releases banks, trail geometry/materials, events, camera sensitivity, input, credits and render holds; late image/history/floor completions cannot recreate them.

## 4. Review and verify

- Review source isolation and the real frame path. Regression tests cover position copying, stable marker identity on bank migration, equal-value no-op updates, partial-construction rollback, stale async completions, cancellation, source failure/recovery and selection removal. Reuse the existing playback/math tests without duplicating them.
- Headless native/Navara dev and instrumented preview must exercise actual rendered marker/trail pixels, physical picks, oblique heading, zoom/visibility transitions, ground refinement, selected readout, ten toggles, destroyed resources and recovery after a hidden/offscreen interval. Stopped/static fleets must settle to zero frames; moving fleets must continue only while playback/height work requires them.
- Run focused tests during edits, then full unit/allocation, boundaries, changed-code formatting, production/panel/QA builds and main composition on the completed change. Reuse valid frozen-build evidence; rerun a failing scenario only after a diagnosis or relevant fix.
- Save paired evidence and exact remaining limitations in the W2 report, then make a local implementation commit. Continue directly to recent imagery and whole-W2 comparison; a transit checkpoint does not close W2.

## 5. Whole-W2 performance handoff

Use identical fixture payloads, visible populations, camera poses, canvas/DPR, style and keyless map sources. Separate warmed frame work (CPU submission), paced frame intervals, long frames, startup, idle and retained resources. One discarded warm context followed by three measured contexts per engine; freeze sources/builds and run serially. Preserve the existing1.10work-ratio and Cesium+2long-frame/10s gates where applicable. Report per-layer and combined results, including FIRMS/ALPR unresolved regressions. These measurements say nothing about paid Google3D loading performance.

## Native extraction checkpoint — 2026-10-29

The shared transit package has no Cesium dependency; application and standalone construction inject the native resource owner. Source, playback, height budgets and the native trail implementation remain unchanged. Registration/insertion failure cleanup is covered. Existing QA now requires an explicit permitted URL, always launches headless and blocks paid map requests before navigation.

Validation:169 focused tests pass, package boundaries pass, scoped formatting passes1649 files. Native keyless dev heading checks pass5/5. Selected marker and trail recovery passes in621.6ms with7/8 stable positive trail controls (before extraction676.7ms,7/8; these are correctness runs, not a performance comparison). Raw logs:/private/tmp/gev-transit-extraction-regression.log,/private/tmp/gev-transit-extraction-boundaries.log,/private/tmp/gev-transit-extracted-heading.log,/private/tmp/gev-transit-extracted-recovery.log. Full gates, rebuilt preview, deterministic source acceptance, Navara rendering and performance comparison remain pending.

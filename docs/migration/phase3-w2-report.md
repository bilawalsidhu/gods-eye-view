# Phase 3 W2 — execution report

Status: W2 in progress. Earthquakes are accepted on both engines; FIRMS and the remaining seven layers are pending. The initial checkpoint established the native oracle and fixed a shared overlay lifecycle defect. The execution sequence and later migration phases are in [the detailed plan](phase3-w2-plan.md).

## Reviewed changes

Removing a source entry previously removed its projection record but retained its collision arbiter identity. A later layout invalidation could then schedule frames for a label that no longer existed. Clear, individual remove and replace-empty now release that identity. Three regressions first failed on the old implementation (two unexpected render requests each), then passed. A fourth test proves another source in the same collision domain still paints. Existing live-source fade and collision policies are unchanged.

The new W2 driver feeds seventeen deterministic USGS-shaped features through the real parser, yielding fifteen valid earthquakes. Four camera poses require five visible fixed controls each, a fixed geometry epoch and actual nonempty globe pixels with all HUD/labels hidden. Ten enable/disable cycles retain owned resource counts; disabling leaves no analyst rows. The comparator rejects failed captures, late runtime errors, missing page observation, missing/nonfinite controls and changed capture/pose epochs. Eight CLI regressions exercise those rejection paths.

## Checkpoint evidence

Native dev and instrumented production preview each pass 18/18 checks with fifteen analyst rows, four nonempty disc rasters, ten toggles, no observed browser errors and zero rendered frames in the two-second disabled sample. Detection is explicitly switched OFF for that isolated idle sample; its starting mode was DENSE. This is a measurement precondition, not evidence that the unrelated Detection painter is idle in DENSE mode.

Both engine contracts pass (Cesium 73/73, Navara 80/80). Ordinary dev and production-preview shell checks pass on both engines (23/23 and 25/25), plus four cross-engine checks each, including share-link camera restoration. Only the exact known setup-status 404 is classified as expected on preview; no JavaScript/HTTP5xx errors are waived.

Production, panel and QA builds, main composition, package/import boundaries, scoped format and the required allocation suite pass. The final ordinary unit count is recorded in the compact evidence after the last comparator regressions. Raw capture artifacts and sanitized logs remain local under qa-artifacts/w2 and /tmp; hashes, populations and per-pose raster counts are in [the compact evidence](phase3-w2-evidence.json).

## Failed attempts and limits

The initial capture encountered a Vite outdated-optimize-dependency 504 after an accidental duplicate dev-start attempt invalidated its cache; the failed result is retained. Subsequent clean captures passed 17/18 but failed strict idle, including after the independent arbiter fix. Runtime traces identified active Detection painting; isolating it via its public OFF mode closed the sample. These failures are retained, not relabelled as passing runs.

The bootstrap checks established native ground discs only. W2-1b below records Navara acceptance; eight other layers and whole-wave acceptance are still pending.

## W2-1a — earthquake native renderer extraction

Accepted: the layer now owns plain geo/Rgba presentation and refresh/cancellation, with an injected render factory. The native renderer owns the original CustomDataSource, unchanged static ground ellipses and raw analyst snapshots. Standalone application defaults and the public data facade keep their native behavior. Destruction uses the renderer's original owner even if a caller supplies another viewer; repeated destruction is safe. The portable earthquake package has no external engine dependency, and import-direction checks now require all native drawing to stay in render/cesium.js.

Three new semantic regressions cover exact coordinates/radii/depth palette/alpha/identity and truncation, last-good geometry after a failed refresh, and correct destruction ownership. Together with existing source/lifecycle tests, full ordinary tests pass 7186/7187 (one Windows-only skip), all fifteen allocation checks pass, boundaries/scoped format and production/panel/QA builds pass. Main composition excludes Three/Navara from the native entry; there is no phase3 byte-budget baseline, so this does not claim a size-budget gate.

Dev and QA-preview each pass 18/18 earthquake checks. Both compare equal to the pinned native baseline for all fifteen records, fixed epochs and projected controls. All eight native dev PNGs (four poses, on/off) are byte-identical to the pre-extraction baseline. Review resolved the renderer-owned destruction case and kept every existing no-callback/no-continuous-hold source assertion, extending its scan to the extracted renderer. Only newly added blocks were restyled after scoped format found two differences; old formatting was preserved.

The configured outline fields remain in native entities. Cesium's installed GeometryUpdater explicitly disables outlines when onTerrain is true; Navara must match that actual image, not invent visible rings. W2-1b below implements classification on the real Navara terrain/3D-tile surface, with foreground mesh exclusion and horizon checks.


## W2-1b — Navara earthquakes

Accepted for this layer. A lazy public SDK post-effect classifies the actual visible terrain/Google-tiles depth. A separate public surface-depth mask excludes custom forward meshes. It preserves native 48-vertex footprints, source order, three depth colors and encoded-sRGB alpha, with camera-relative float64 preparation. No SDK modifications or new private hooks are used. Native ground outlines remain absent.

Initial GPU checks exposed real mismatches: hardware linear alpha produced brighter discs than native display-space blending, and a -12km volume floor excluded orbital terrain measured near -26km. Explicit display-space composition and the native conservative -100km floor resolve those cases. The screen-cell index retains every overlapping candidate; a 513-overlap regression proves it has no cell cap.

Static camera data is cached, with invalidation on camera, projection or viewport changes. Its regression first observed 102 texture versions where only 2 were needed. Large discs now binary-search the radial boundary edge and check its neighbors; small/subpixel discs retain all 48 supporting planes. Native geometry oracles cover 25 world/magnitude cases including poles, date line and M10. Switching fast/full/fast in the same actual GPU scene yields exactly zero changed channels in all four poses. An actual source-fed antipodal M10 is present in the analyst records and adds zero visible pixels.

Dev and QA-preview pass 25/25 native and 26/26 Navara checks: 15 analyst records, fixed epochs, five visible controls per pose, source failure/recovery, a cancelled late empty response, share restoration in both engine directions and ten toggle cycles. Enabled and disabled isolated samples each draw zero frames in two seconds. All three observed pages per capture have no runtime errors. Native's eight baseline on/off PNGs remain byte-identical. Earthquakes retain their existing noninteractive behavior; no selection/follow controls are invented.

Five actual photoreal surface probes are painted, including a real roof. A real opaque 200m custom cube masks the effect: its 32x32 interior has max RGB delta 0, with contrast 139 proving geometry is present. Removing only the mask through QA interception produces delta 81 and a genuine failed verdict. Normal production output has no QA-probe markers; injection exists only in the instrumented QA build or dev request interception.

Performance uses 500 parser-fed events, 1280x800/DPR1, minimal look, a discarded warmup and three fresh measured contexts per engine, three-second warmups and ten-second samples:

| Scene | Native work p95 ms | Navara work p95 ms | Work ratio | Paced interval ratio |
|---|---:|---:|---:|---:|
| Global |6.0|0.8|0.133|0.979|
| City |8.8|8.5|0.966|0.990|
| Orbit |7.0|5.5|0.786|1.037|

Both complete series pass the existing 1.1 ratios; paced long-frame counts above 33.4ms are zero for both engines. Earlier city failures (full 13.7 vs 8.7 ms and cache-only 13.2 ms) remain archived. These are observed engine pre/post-render work intervals, not GPU timer-query times. Default-look and combined-layer performance remain wave-closure tasks.

Review found that Navara attribution still listed only shell providers after W1. Canonical credits for available W1 feeds and USGS are now included. A failing unit regression proved the missing credits, and the actual Navara UI contains the USGS credit. Unsupported future layers remain excluded.

Final product checks: 7195/7196 ordinary tests pass with one Windows-only skip, 15/15 allocation checks, boundaries, 1575-file scoped formatting, production/panel/QA builds and main composition. Engine contracts pass 73/73 and 80/80. Dev and ordinary production shell pass on both engines, including cross-engine share checks. After diagnostic-only additions, 109 focused contract/fake-engine tests and boundaries/scoped format pass again. No production source changed after the frozen build/performance series.

Limits: the Transamerica centre probe reads 195.91m native versus 212.05m Navara; painted surfaces establish draping, not two-metre roof-height parity. Some before/after Navara background pixels differ; the same-context fast/full shader comparison isolates the optimization and is exact. Earlier bare Navara runs intermittently failed S5 idle and a line click; repeats pass, failure logs/diagnostics are retained, and no cause or picking fix is claimed. Main composition has no phase3 byte-budget baseline, so no size-budget gate is claimed. FIRMS proceeds under [its detailed plan](phase3-w2-firms-plan.md); W2/W3/W4/UI/Rust/Cesium-removal work remains open.

Reviewed lossy comparison images (193KB total; raw PNGs remain the pixel oracle):

![Terrain comparison](images/phase3-w2-earthquakes-terrain.webp)

![Photoreal roofs](images/phase3-w2-earthquakes-tiles.webp)


## W2-2a — FIRMS native renderer extraction

Accepted on Cesium; the FIRMS Navara renderer is next. The portable layer retains source normalization, viewport/LOD policy, aggregation, DEM anchors, cards, analyst/context records and stable selection. The injected native renderer owns rectangles, translucent billboards, projection, horizon/picking/input and the original scene's disposal. Native collection teardown now unregisters its sprite identity. The portable fire-layer package has no external engine dependency; the import-direction guard enforces the new ownership.

The deterministic proxy fixture contains 371 valid detections and two invalid coordinate records, VIIRS/MODIS confidence, UTC acquisition clocks, a separate source receipt clock, three regions and pole/date-line cases. Five poses cover global/regional heat cells and local/close/terrain glows. The explicit DEM fixture is anchor test data, not live elevation accuracy evidence.

The initial 34/35 capture failed enabled idle. Traces showed Detection OFF and no render holds, with requests from chrome resize observers. DOM evidence identified the HUD summary typewriter widening its corner. That is legitimate UI animation; application observers were preserved. QA now supplies a fixed provenance-aware summary and waits for actual frame/text quiescence before the unchanged strict zero-frame sample. All failed captures remain retained.

Independently, the existing FIRMS settle timeout survived disable/destroy and duplicated requests after repeated moveEnd events. Three regressions failed on that code, while the active-layer final-frame control passed. The timer is now owned, cancelled on watcher removal and coalesced. All four tests pass. New geometry/color/sprite-policy, date-line/pole rectangle arithmetic and original-owner disposal checks bring the ordinary suite to 7203 tests: 7202 pass and one Windows-only test skips; all 15 allocation checks pass.

Native dev and QA-preview each pass 36/36: real parser and receipt clocks, five visible controls per pose, actual nonempty ground/sprite pixels, real pointer selection, one UI-owned focus transfer, canvas-painted selected card with one accessible action, source-order-independent selection, source failure/keyless/stale/recovery/cancellation, ten toggles and zero frames in both enabled/disabled two-second samples. Dev and preview both match the native baseline semantically, including exact rectangle geometry/colors/metadata. All ten on/off PNGs per build are byte-identical to the baseline. Close glows and regional cells were visually reviewed.

The strict comparator accepts the real baseline and rejects 19 independently corrupted captures, including missing observers, late errors, empty data/rasters, wrong clocks/controls/geometry and broken selection/idle. These sensitivity probes are separate from the Node unit count. Legacy FIRMS runs on explicitly selected headless Metal and passes 9/9 with no unexpected browser errors. Two exact intentional keyless-source 503 messages are classified, with all other errors retained.

Boundaries, scoped format (1582 files), production/panel/QA builds and main composition pass. The first full suite exposed an old camera-handoff source guard tied to a literal native event enum; the updated guard checks the injected event and actual native LEFT_CLICK owner, preserving sibling-pick/card ordering and the no-layer-camera-flight rule. Both engine contracts and dev/ordinary-preview shell regressions pass; native earthquakes retain 25/25 checks. No byte-budget baseline or live FIRMS provider acceptance is claimed. Next: actual Navara cells/glows, alpha/ground/pick/focus/share/lifecycle/performance proof and review under the detailed FIRMS plan.

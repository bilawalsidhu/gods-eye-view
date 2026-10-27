# W2-2 FIRMS — implementation and acceptance plan

Status: planned; earthquake W2-1b final GPU/performance acceptance is still running. FIRMS runtime has not changed. The parent W2 and migration plan remains authoritative; all work is sequential, local, without subagents, push or publication.

## Pin the native contract

1. Use the actual `/api/firms` envelope: fires, fetchedAt and stale. Fixed acquisition UTC timestamps differ from source receipt time. Fixture covers VIIRS categorical and MODIS numeric confidence, FRP/brightness/day-night, invalid string coordinates, poles/date line and multiple regions. Preserve the existing adapter rather than normalizing twice in QA.
2. Capture global heatmap (2-degree grid, 1800-cell cap), regional heatmap (1-degree, 3600), local detections (2500) and close detections (3000), plus terrain and horizon cases. Heat/FRP sorting, viewport clipping before the cap, 10% LOD hysteresis and padded bounds are behavior to preserve. Require nonempty ground/sprite pixels and five visible fixed controls, then retain native on/off images before extracting anything.
3. Exercise real pointer selection, ambient/selected cards, strongest-fire and analyst queries, stable detection identity after reversed source order, eviction, UI-owned world focus, both source error states (no key versus network failure), stale receipt time, successful recovery and a delayed response after disable/re-enable. Existing follow absence is N/A; do not add a synthetic follow feature.
4. Capture the native translucent glow blend against its off image. Opaque W1 palette tests do not establish alpha parity. Any shared overlay color change requires a failing real-image comparison first and W1 regressions afterward.

## Native extraction, separate commit

1. Keep source adaptation, aggregation, LOD selection, cards/context and refresh generation rules in the portable layer. Move CustomDataSource, rectangle entities, BillboardCollection, screen-space input/picking and native viewport adapters to layer-owned render/cesium modules. Inject the renderer through the existing application factory and keep the public native default facade.
2. Replace shared Cartesian/math/color imports with existing geo/Rgba helpers. Use a small local rectangle helper for width/height/center/clone; reuse engine.camera.viewRectangle on Navara. Preserve native computeViewRectangle behavior through its adapter; no guessed full-world fallback.
3. Keep selected object identity independent of regenerated pick indices. Preserve cached DEM floor quality and separate negative-geoid cull anchors. Close-only warmup remains sequential, bounded by 200, and rebuilds only when a floor actually arrives.
4. Before fixing the existing unowned moveEnd settle timeout, add a regression that observes a late render request after disable/destroy. Cancel/coalesce only the owned timer and prove active settling still requests its final frame. Do not call this fixed based on source inspection alone.
5. Native renderer tests cover original owner disposal, repeated destroy, retained last-good geometry and asynchronous completions. Native source/geometry/selection snapshots must match; deterministic on/off images should remain byte-identical. Classify any terrain/clock difference with actual evidence.

## Navara implementation, separate commit

1. Wire the actual supported factory only after implementation. Add FIRMS credit using canonical data-credit HTML. Shared/native import boundaries remain enforced; no Cesium object enters Navara graph.
2. Heatmap cells must classify the real terrain and 3D tiles, exclude foreground custom meshes and preserve encoded-space alpha/source order. Rectangles follow latitude parallels: prove the footprint against native RectangleGeometry rather than assume four flat ENU edges are equivalent. Extract a minimal shared ground helper from earthquake rendering only when this second real consumer needs it.
3. Detection sprites use existing engine.movers and actual engine input/selectionDispatcher, with original sprite image, anchor, size, order and horizon policy. No invisible pick-only substitute or duplicate visual overlay. Confirm alpha against the measured native raster before changing shared compositing.
4. Preserve query/card/selection/focus/share behavior, stale/error/key-required status and cancellation. Ten toggle cycles, destroy, late callbacks and static enabled/disabled samples must leave no owned listeners, timers, instances or continuous render holds. Require zero frames in each two-second isolated idle sample with Detection OFF.

## Review and gates

At each native/Navara checkpoint: focused FIRMS, anchors, cards, source and interaction tests; full Node24 JS/allocation checks; boundaries/import guards; scoped formatting; production/panel/QA builds and main composition. Restart only verified own dev server after a full test run. Headless Metal browser jobs run sequentially on own unreserved ports with frozen application source and strict main/share page observers.

Run native and Navara dev/QA-preview captures, ordinary production shell, both engine contracts, actual source failure/cancel/pick/focus/share journeys and the relevant existing legacy QA. Ground acceptance includes positive/negative foreground-mesh controls. Compare feature populations, UTC epochs, source receipt clocks, projection <=2px, opaque glyph RGB <=3, real alpha and footprint, including horizon/poles/date line.

For heavy heatmap/detection populations, use equal fixture/camera/canvas, discard warmup, then three fresh contexts per engine. Preserve uncapped work p95 <=1.1 native, paced interval p95 <=1.1 native and long-frame count <=native+2 per ten seconds. Keep failed attempts, source/driver/build hashes and actual limits. No green result from empty data, unavailable layer or relaxed tolerances.

Review the final diff, fix findings, update compact wave evidence and report, then stage explicit files and commit locally with the Codex co-author trailer. Proceed to military installations only after FIRMS acceptance; all subsequent W2/W3/W4/UI/Rust/Cesium-removal work remains authorized.

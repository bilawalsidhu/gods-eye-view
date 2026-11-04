# W2-3 — military installations renderer migration plan

## Current sequencing note

FIRMS correctness, functional, pixel, ground, and legacy preview checks pass. Its full-resolution cache still misses the uncapped close work-ratio gate (latest accepted full series 1.136; limit 1.10), so FIRMS is not accepted and W2 cannot close. FIRMS is locally checkpointed at `9e64185a`. The close-budget investigation has tried the full-resolution cache, lower target resolutions, bounded composites, transfer polynomials, and a fullscreen triangle without a passing uncapped result. Continue the next independent W2 layer while keeping that exact gate open; do not weaken it or report FIRMS/W2 accepted. Re-run FIRMS and combined W2 performance at closure.

This is a planning update to avoid freezing all remaining W2 work on one unresolved renderer budget. Layer acceptance remains explicit per layer, and W2 exit still requires every layer plus the unchanged combined gates.

## Native baseline

- Trace existing source adapters and ownership: bounded Overpass elements with retrieval provenance, explicit Google military-base search candidates, bundled named wide-view points, capability-unavailable tile fallback, and delayed name enrichment. Preserve canonical IDs, aliases, genuine source/status/coverage fields, cancellation, and unavailable/retry behavior.
- Use deterministic fixtures through the real parsers. Include polygons with holes and multiple islands, outline segments, point-only named sites, named and unnamed records, duplicate aliases, invalid geometry, saturated and empty results, delayed names, failed/cancelled requests, and a selected site beyond the render cap.
- Capture the native renderer at global/wide, regional, close, terrain/photoreal, horizon, date-line, and tile/terrain transition poses. Freeze source and geometry clocks. Save real on/off images, source geometry, renderer counts, and five visible projected controls per pose.
- Preserve the actual population contract: `MAX_RENDERED` 700 plus a selected item beyond the cap, bounded named-point and 24-label cohorts, selected/normal 9px/13px entity points and 7px named markers, existing category palette and black outlines.
- Exercise real pointer selection, selected-card canvas ink and accessible action, exact ellipsoidal `getNearby` distance, Contacts' 20km subject-window refresh boundary, focus/navigation on item 701+, repeated selected/empty/sibling clicks, search candidate classification, source reorder, and tool-owned pointer behavior.

## Native extraction

- Inject a renderer factory into the existing installation composition. Keep source, ingestion, sorting, coverage, record identity, context/card policy, and serialization portable.
- Move `CustomDataSource`, entities, `PointPrimitiveCollection`, ground polygon/line geometry, projection, horizon checks, picking/input, and original-owner disposal into `render/cesium*.js`.
- Replace Cesium math/color/geodesic imports in portable modules with the existing geo/color equivalents; prove exact-distance cases at high latitude and across the date line.
- Preserve context identity through the smallest displayed-record interface. Do not create a fake viewer/entity collection to make Navara fit the Cesium API.
- Add meaningful failing regressions for `destroy(viewer)` ownership, repeated init/destroy, cancellation, late tile/name/floor callbacks, and selected-item survival before changing lifecycle behavior.
- Keep native geometry stable on unchanged refreshes and verify byte-identical native captures where deterministic. Review the extraction, run focused/full JS and allocation tests, boundaries, scoped format, production/panel/QA builds, main chunk, and native baseline comparison; commit locally.

## Navara renderer

- Render the bounded point cohorts with the existing engine mover atlas and real `selectionDispatcher` events. Preserve point sizes, outlines, palette/order, horizon visibility, pick ownership, and the shared card overlay.
- Inject real viewport, camera, focus, and geodesic ports. Use canonical OpenStreetMap/OpenMapTiles and explicit Places attribution, with source-derived visibility.
- Ground-clamped selected polygon fills and ordinary outlines are existing product behavior. Inspect public Navara SDK surface capabilities before choosing a path. Verify holes/multi-rings, surface classification, actual paint on terrain and 3D tiles, and exclusion by opaque foreground geometry with positive and negative controls.
- Reuse public packed-depth ground helpers only when the installation renderer proves the same need. Keep candidate ranges uncapped and pixel intersections correct at acute edges. Compare true native clamping, named-marker floor, and Navara surface behavior; DEM estimates alone do not establish surface clamping. Record measured height quality and solve gaps before acceptance.
- Run source/query/selection/card/Contacts/focus/search/share in both directions and ordinary-production shell tests. Strictly observe every main/share page; retain exact `/api/setup/status` 404 allowance only for instrumented previews.
- Pixel/geometry gates stay at the existing tolerances, with positive nonempty raster controls. Performance uses equal fixtures at the 700-record cap plus selected extra and named cohorts, discarded warm-up plus three contexts per engine, uncapped work ratio <=1.10, paced interval ratio <=1.10, and long frames <= Native + 2 per 10 seconds. Do not change population or gate after measurement.

## Review and exit

- Review the renderer, shared APIs, terrain/tiles path, and lifecycle diffs. Fix findings before acceptance.
- Run FIRMS/earthquake/W1 regression suites alongside installation checks; run full unit/allocation, boundaries, scoped formatting, production/panel/QA builds, main composition, preview, and legacy checks.
- Retain failed attempts and hashes for source, QA driver, and build. Update the phase3 W2 report and evidence. Explicitly stage and commit locally. Installations acceptance does not close W2; continue bikeshare, radio, ALPR, CCTV, transit, recent imagery, then rerun the complete W2 matrix including FIRMS' open uncapped close gate.

## 2026-10-28 implementation checkpoint — native preview and full gates passed

- The adapter split and Navara installation renderer are implemented in the active worktree. Focused tests pass 51/51. The instrumented production-style preview passes all 12 Cesium checks and all 7 Navara checks: startup, ground readiness, OSM imagery/attribution, real outline pixels, pointer selection and selected-fill pixels, canonical identity, Places attribution, and zero unexpected browser errors. Cesium outline/fill changed 1,468/2,157 pixels; Navara changed 3,419/1,416.
- The isolated Cesium fixture now uses the package's `approximateTerrainHeights.json` and local single-image imagery. The preview waits for selected ground primitives and a rendered frame before taking the selection capture. Cesium's optimized Vite dev worker path did not return geometry-worker replies; the built preview's workers completed and both ground-pixel checks passed. Use the built preview as the native acceptance evidence.
- Review fixed two real defects: Cesium polyline graphics now receive a `ColorMaterialProperty` instead of an engine-neutral color as a material, and selected markers without `namedArea` now pass a boolean to Cesium's `PointPrimitive.show`. Regression tests cover both.
- Boundaries, 1,603-file scoped formatting, production build, panel build, QA-preview build, and the main-chunk composition check pass. The main-chunk script reports that no baseline is configured, so it did not check a size budget. Full `npm test` passes 7,239, skips one, and has zero failures.
- Final built-preview rerun passes Cesium 12/12 and Navara 7/7 with the same raster counts. The test guard now reads the extracted Cesium renderer file instead of the deleted facade path. No code defect was found in the tracked-readout contract: installations intentionally do not publish a tracked card on selection.
- Next: locally commit the reviewed installation checkpoint. FIRMS' uncapped close budget remains open separately at 1.136 versus 1.10; this installation checkpoint does not close W2. Continue the detailed W2 sequence with bikeshare, radio, ALPR, CCTV, transit, recent imagery, and only then the full wave gates.

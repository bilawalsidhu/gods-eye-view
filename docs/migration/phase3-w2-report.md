# Phase 3 W2 — execution report

Status: in progress. This checkpoint establishes the native earthquake oracle and fixes a shared overlay lifecycle defect; none of the nine W2 layers is accepted on Navara yet. The execution sequence and later migration phases are in [the detailed plan](phase3-w2-plan.md).

## Reviewed changes

Removing a source entry previously removed its projection record but retained its collision arbiter identity. A later layout invalidation could then schedule frames for a label that no longer existed. Clear, individual remove and replace-empty now release that identity. Three regressions first failed on the old implementation (two unexpected render requests each), then passed. A fourth test proves another source in the same collision domain still paints. Existing live-source fade and collision policies are unchanged.

The new W2 driver feeds seventeen deterministic USGS-shaped features through the real parser, yielding fifteen valid earthquakes. Four camera poses require five visible fixed controls each, a fixed geometry epoch and actual nonempty globe pixels with all HUD/labels hidden. Ten enable/disable cycles retain owned resource counts; disabling leaves no analyst rows. The comparator rejects failed captures, late runtime errors, missing page observation, missing/nonfinite controls and changed capture/pose epochs. Eight CLI regressions exercise those rejection paths.

## Checkpoint evidence

Native dev and instrumented production preview each pass 18/18 checks with fifteen analyst rows, four nonempty disc rasters, ten toggles, no observed browser errors and zero rendered frames in the two-second disabled sample. Detection is explicitly switched OFF for that isolated idle sample; its starting mode was DENSE. This is a measurement precondition, not evidence that the unrelated Detection painter is idle in DENSE mode.

Both engine contracts pass (Cesium 73/73, Navara 80/80). Ordinary dev and production-preview shell checks pass on both engines (23/23 and 25/25), plus four cross-engine checks each, including share-link camera restoration. Only the exact known setup-status 404 is classified as expected on preview; no JavaScript/HTTP5xx errors are waived.

Production, panel and QA builds, main composition, package/import boundaries, scoped format and the required allocation suite pass. The final ordinary unit count is recorded in the compact evidence after the last comparator regressions. Raw capture artifacts and sanitized logs remain local under qa-artifacts/w2 and /tmp; hashes, populations and per-pose raster counts are in [the compact evidence](phase3-w2-evidence.json).

## Failed attempts and limits

The initial capture encountered a Vite outdated-optimize-dependency 504 after an accidental duplicate dev-start attempt invalidated its cache; the failed result is retained. Subsequent clean captures passed 17/18 but failed strict idle, including after the independent arbiter fix. Runtime traces identified active Detection painting; isolating it via its public OFF mode closed the sample. These failures are retained, not relabelled as passing runs.

Current raster checks establish actual native ground discs, not Navara ground classification or full W2 acceptance. Navara earthquake rendering, terrain/3D-tile classification, source failure/cancellation, cross-engine layer state and the remaining eight layers still require implementation and acceptance. No W2 performance conclusion is claimed at this checkpoint.

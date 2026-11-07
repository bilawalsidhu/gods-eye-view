import * as geo from '../geo/index.js';
import { acceptedSurfaceHeight } from '../globe/surfaceDetail.js';

/** Answers from tiles larger than this are too coarse to latch (m).
 *  Measured on Navara: from 800 m the answering tiles were 112-314 m and
 *  within 2 m of Cesium; from 15 km, cold,
 *  3.5-4 km tiles were off by -16.2 to +6.2 m; while streaming a 27.9 km tile
 *  read 143.2 m at Austin where the ground is 122.5 m. A 1.8 km tile at
 *  Austin (the hidden tile under a 600 m camera looking ahead) read the
 *  ground right, but 1 km keeps every measured coarse error out; such a miss
 *  only leaves the DEM prior in place. Cesium does not size its answers, so
 *  its gates are the camera height and tilesLoaded below. */
export const MAX_FLOOR_TILE_SIZE_M = 1000;
import { approxDistanceKm } from '../data/approxDistance.js';

/** Construct an instance-owned meshFloorSampler service with explicit dependencies. */
export function createMeshFloorSampler({
  groundFloor,
  signal,
  eventTarget = null,
}) {
  const {
    coarseFloorCoord,
    cachedMeshFloor,
    reportValidatedMeshFloorCell,
    setMeshFloorPreferred,
    meshFloorPreferred,
    cachedGroundFloor,
  } = groundFloor;
  signal?.throwIfAborted();
  // src/data/meshFloorSampler.js — rendered-surface (mesh) floor sampling
  // (field-test round 4, 2026-07-06).
  //
  // The visible world in the google-3d regime is the PHOTOGRAMMETRIC MESH,
  // which sits above the Re:Earth bare-earth DEM (measured ~17 m at the Austin
  // airport apron) — so DEM-floored sprites/trails still buried themselves in
  // the mesh while 3D models (which groundSnap against the mesh) looked right.
  // This module samples the mesh height ONE-SHOT per coarse cell and reports it
  // to groundFloor.js, whose cachedGroundFloor() then answers mesh-first.
  //
  // Rationing (the CCTV loading-jitter lesson): scene.sampleHeight forces
  // tile-load prioritization at the probe point, so sampling is (a) gated to
  // cells NEAR the viewer — where tiles are streamed and where an error is
  // visible at all, (b) capped per call, (c) one-shot per cell for the session,
  // (d) skipped entirely outside the google-3d regime. A returned-undefined
  // probe (tiles not streamed yet) is NOT latched — it retries on a later call.
  //
  // Sample acceptance is sanity-gated against the DEM prior when warm (a
  // vertical probe can hit a rooftop or another aircraft instead of pavement):
  // the mesh legitimately sits ABOVE bare earth, so the window is asymmetric.

  /** @constant {number} Max scene samples per call (one call per layer poll). */
  const MAX_SAMPLES_PER_CALL = 40;
  /** @constant {number} Only cells within this range of the viewer subpoint are
   *  sampled. Round-5 hardening: tightened 40 → 15 km — beyond the streamed
   *  fine-LOD area a probe returns COARSE-tile heights (not undefined), and the
   *  one-shot latch made those permanent (owner round 5: grounded planes stuck
   *  at a uniform wrong height). */
  const MAX_SAMPLE_DIST_KM = 15;
  /** @constant {number} No sampling when the camera is above this height — the
   *  streamed LOD under a high camera is coarse everywhere, so every probe
   *  would latch junk. */
  const MAX_CAMERA_HEIGHT_M = 25_000;
  const _scratchEngineProbe = geo.cartographic.create();

  // Regime tracking: mesh cells only apply while the photoreal (google-3d)
  // stack renders. main.js re-dispatches MapStackController.onChange as this
  // CustomEvent; the boot default is photoreal, matching groundFloor's initial
  // preference. Module-scope listener: the module only loads in the browser
  // bundle, and the subscription is idempotent for the app's lifetime.

  /**
   * Equirectangular distance (km) — same approximation the flights clamp uses.
   */
  function _approxKm(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * 111.32;
    const dLon =
      (lon2 - lon1) * 111.32 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
    return Math.hypot(dLat, dLon);
  }

  /**
   * Samples the rendered mesh height for the coarse cells containing `points`,
   * one-shot per cell, budget-capped, viewer-proximity-gated. Call ONCE per
   * layer poll (never per contact, never per frame). Synchronous — Cesium's
   * sampleHeight is a CPU-side query against loaded tiles.
   *
   * @param {object|undefined} engine - The globe engine (engine.surface,
   *   camera.height, maps.photorealActive); without one, nothing.
   * @param {Array<{lat: number, lon: number}>} points - Contact/waypoint coords.
   * @param {object} [options]
   * @param {Array<object>} [options.excludeObjects] - What the probe passes
   *   through: the layer's engine mover sets, or (Cesium layers) its own
   *   Billboard and Model instances.
   * @param {number} [options.viewerLat] @param {number} [options.viewerLon]
   *   Viewer subpoint (computed once by the caller's poll).
   */
  function sampleMeshFloorCells(
    engine,
    points,
    { excludeObjects = [], viewerLat, viewerLon } = {},
  ) {
    if (!meshFloorPreferred()) return;
    if (!engine || engine.isDestroyed?.() || !engine.surface.supported) return;
    if (!Array.isArray(points) || !points.length) return;
    // Round-5 hardening (the CCTV projectionTilesReady lesson, ported late):
    // while tiles are MID-STREAM a probe returns coarse-LOD heights — real
    // numbers, wildly wrong — and the one-shot latch made them permanent.
    // Only sample when the visible Google tileset reports tilesLoaded AND the
    // camera is low enough that the streamed LOD near it is fine-grained.
    const camH = engine.camera.height();
    if (!Number.isFinite(camH) || camH > MAX_CAMERA_HEIGHT_M) return;
    if (!(engine.maps.photorealActive() && engine.surface.tilesLoaded()))
      return;
    let sampled = 0;
    const attempted = new Set();
    for (const p of points) {
      if (sampled >= MAX_SAMPLES_PER_CALL) break;
      if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) continue;
      const cell = coarseFloorCoord(p.lat, p.lon);
      const key = `${cell.lat},${cell.lon}`;
      if (attempted.has(key)) continue;
      attempted.add(key);
      if (cachedMeshFloor(cell.lat, cell.lon) != null) continue; // one-shot latch
      if (
        Number.isFinite(viewerLat) &&
        Number.isFinite(viewerLon) &&
        approxDistanceKm(viewerLat, viewerLon, cell.lat, cell.lon) >
          MAX_SAMPLE_DIST_KM
      ) {
        continue; // too far: tiles not streamed there, probe would be a guaranteed miss
      }
      let height;
      try {
        const carto = geo.cartographic.fromDegrees(
          cell.lon,
          cell.lat,
          0,
          _scratchEngineProbe,
        );
        // A coarse tile's answer, or only terrain, is a miss (no latch).
        height = acceptedSurfaceHeight(
          engine.surface.sampleHeightDetailed(carto, {
            exclude: excludeObjects,
          }),
          { maxTileSizeM: MAX_FLOOR_TILE_SIZE_M },
        );
        sampled += 1;
      } catch {
        continue; // scene mid-teardown — try again next poll
      }
      if (!Number.isFinite(height)) continue; // tiles not loaded yet — no negative latch
      // Round 5: a REAL Re:Earth prior is REQUIRED before any sample latches.
      //  - A geoid-fallback prior (cached while the proxy was failing) is a
      //    sea-level poison that rejected legitimate samples at elevated
      //    fields (AUS: mesh 138 m vs poisoned −27 m prior → dropped forever).
      //  - No prior at all means no way to tell a real surface from a
      //    coarse-LOD/rooftop/aircraft mis-hit — the old sanity-only branch
      //    latched a 37 m "surface" at Austin permanently. The DEM lands
      //    within a poll (the same warm batch that queued this cell), so
      //    waiting costs one poll, not correctness.
      // 2026-08-21: a "provisional" tier that KEPT the reading when no prior
      // existed was built here and then removed, because it was measured failing.
      // Run twice against the real GPU at the same Austin apron with the proxy
      // down, it recorded 122.1 m once and 20.6 m the next time — the second is a
      // coarse-LOD read of ground that is really ~122 m, and it left the contact
      // ~100 m under the mesh. The DEM requirement above is not a formality.
      //
      // Before reaching for the obvious gate: `tilesLoaded` / `allTilesLoaded` is
      // NOT a resolution signal. It reports that the streaming queue has drained
      // for the CURRENT camera's screen-space-error target, and a distant or high
      // camera is entirely satisfied by coarse tiles — which is exactly the state
      // that reported "loaded" during the measurement above. Gating harder on it
      // buys nothing. A correct gate has to ask about the specific tile covering
      // the sample point: walk the tileset tree to the tile containing the
      // coordinate and require its `geometricError` to be below a threshold tied
      // to the accuracy the caller needs, before trusting the sample. That is
      // feasible and deliberately deferred — see the P2 in
      // the project roadmap, which bundles it with the fly_route probe so
      // one post-launch pass settles rendered-mesh sampling everywhere.
      reportValidatedMeshFloorCell(cell.lat, cell.lon, height);
    }
  }

  // re-export for callers that want one import site

  const onStack = (event) => {
    const id = event?.detail?.activeId;
    if (id) setMeshFloorPreferred(id === 'photoreal');
  };
  eventTarget?.addEventListener('gev:map-stack-changed', onStack);
  signal?.addEventListener(
    'abort',
    () => eventTarget?.removeEventListener('gev:map-stack-changed', onStack),
    { once: true },
  );
  return {
    sampleMeshFloorCells,
    cachedGroundFloor,
    /** Whether the globe engine has its tiles loaded (street level's mesh
     *  sampler gate). */
    visibleTilesetLoaded: (engine) => engine?.surface.tilesLoaded() ?? false,
  };
}

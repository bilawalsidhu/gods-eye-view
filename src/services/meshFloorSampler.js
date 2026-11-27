import { approxDistanceKm } from '../data/approxDistance.js';
import { heightsOf } from '../queries/heights.js';
import { findCamera, findGlobe } from '../render/rendererOf.js';

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
    meshFloorPriorReady,
    setMeshFloorPreferred,
    meshFloorPreferred,
    cachedGroundFloor,
  } = groundFloor;
  signal?.throwIfAborted();
  // The visible photogrammetric mesh can sit above the Re:Earth bare-earth DEM in the
  // google-3d regime.
  // This module samples the mesh height at the callers' points, a few probes
  // per coarse cell, and reports them to groundFloor.js, which keeps each
  // reading that passes its gate at its own point; cachedGroundFloor() then
  // answers mesh-first, from the reading nearest the asked point.
  //
  // Rationing: scene.sampleHeight forces
  // tile-load prioritization at the probe point, so sampling is (a) gated to
  // cells NEAR the viewer — where tiles are streamed and where an error is
  // visible at all, (b) capped per call, (c) at most MAX_PROBES_PER_CELL
  // readings per cell for the session, each at a point apart from the others,
  // (d) skipped entirely outside the google-3d regime. A returned-undefined
  // probe (tiles not streamed yet) is NOT latched — it retries on a later call.
  //
  // Sample acceptance is sanity-gated against the DEM prior when warm (a
  // vertical probe can hit a rooftop or another aircraft instead of pavement):
  // the mesh legitimately sits ABOVE bare earth, so the window is asymmetric.

  /** @constant {number} Max scene samples per call (one call per layer poll). */
  const MAX_SAMPLES_PER_CALL = 40;
  /** @constant {number} Only cells within this range of the viewer subpoint are
   *  sampled. Beyond the streamed fine-LOD area a probe returns coarse-tile heights. */
  const MAX_SAMPLE_DIST_KM = 15;
  /** @constant {number} No sampling when the camera is above this height — the
   *  streamed LOD under a high camera is coarse everywhere, so every probe
   *  would latch junk. */
  const MAX_CAMERA_HEIGHT_M = 25_000;
  /** @constant {number} Readings per cell: a cell is probed at most this
   *  many times, each at a point apart from the others, and groundFloor keeps
   *  each reading at its point (a read answers from the nearest one). */
  const MAX_PROBES_PER_CELL = 8;
  /** @constant {number} How far apart (degrees, about 17 m) a new probe must
   *  be from the cell's earlier ones to be worth taking. */
  const PROBE_APART_DEG = 0.00015;
  /** @type {Map<string, Array<{lat: number, lon: number}>>} Points probed
   *  per cell that returned a reading. */
  const _probedPoints = new Map();
  /** Scratch for probe coordinates (degrees). */
  const _scratchProbe = { lon: 0, lat: 0 };

  /**
   * True when the globe is hidden (the google-3d regime draws the mesh
   * alone) and the drawn 3D tiles have loaded what is in view; false with
   * the globe shown or no tiles drawn. Asked of the globe port once per poll.
   * The globe check matters on its own: the regime flag can still say
   * photoreal while a switch to a globe stack is loading, or after a silent
   * one, and a probe of the globe there would latch terrain as mesh.
   * @param {object} viewer
   * @returns {boolean}
   */
  function _surfaceSettled(viewer) {
    try {
      const globe = findGlobe(viewer);
      return (
        globe?.isGlobeVisible?.() === false &&
        globe.isSettled('surface') === true
      );
    } catch {
      /* mid-teardown */
    }
    return false;
  }

  /**
   * Samples the rendered mesh height for the coarse cells containing `points`,
   * a few probes per cell, budget-capped, viewer-proximity-gated. Call ONCE per
   * layer poll (never per contact, never per frame). Synchronous — the renderer's
   * sampleHeight is a CPU-side query against loaded tiles.
   *
   * @param {object|undefined} viewer - The viewer whose renderer draws the
   *   mesh (skipped when absent/torn down). The probe asks its query port
   *   (`heightsOf`), which sees through every draw set not drawn as ground.
   * @param {Array<{lat: number, lon: number}>} points - Contact/waypoint coords.
   * @param {object} [options]
   * @param {string[]} [options.sets] - The caller's own draw set ids, seen
   *   through as well.
   * @param {number} [options.viewerLat] @param {number} [options.viewerLon]
   *   Viewer subpoint (computed once by the caller's poll).
   */
  function sampleMeshFloorCells(
    viewer,
    points,
    { sets, viewerLat, viewerLon } = {},
  ) {
    if (!meshFloorPreferred()) return;
    if (!viewer || viewer.isDestroyed?.()) return;
    const heights = heightsOf(viewer);
    const exclude = Array.isArray(sets) ? sets : undefined;
    // Without depth-texture support every probe throws: nothing to latch.
    if (!heights?.supported().surface) return;
    if (!Array.isArray(points) || !points.length) return;
    // While tiles are mid-stream a probe can return coarse heights. Sample only when
    // tiles have settled and the camera is low enough to stream fine detail.
    let camH;
    try {
      camH = findCamera(viewer)?.pose().height;
    } catch {
      return; // mid-teardown
    }
    if (!Number.isFinite(camH) || camH > MAX_CAMERA_HEIGHT_M) return;
    if (!_surfaceSettled(viewer)) return;
    let sampled = 0;
    const attempted = new Set();
    for (const p of points) {
      if (sampled >= MAX_SAMPLES_PER_CALL) break;
      if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) continue;
      const cell = coarseFloorCoord(p.lat, p.lon);
      const key = `${cell.lat},${cell.lon}`;
      if (attempted.has(key)) continue;
      // A cell with a reading is probed again only at a point well apart
      // from the ones already probed, a few times at most, so the cell's
      // readings follow where its vehicles actually are.
      const probes = _probedPoints.get(key);
      if (
        cachedMeshFloor(cell.lat, cell.lon) != null &&
        (probes?.length >= MAX_PROBES_PER_CELL ||
          probes?.some(
            (q) =>
              Math.abs(q.lat - p.lat) < PROBE_APART_DEG &&
              Math.abs(q.lon - p.lon) < PROBE_APART_DEG,
          ))
      )
        continue;
      attempted.add(key);
      if (
        Number.isFinite(viewerLat) &&
        Number.isFinite(viewerLon) &&
        approxDistanceKm(viewerLat, viewerLon, cell.lat, cell.lon) >
          MAX_SAMPLE_DIST_KM
      ) {
        continue; // too far: tiles not streamed there, probe would be a guaranteed miss
      }
      // Probe where the caller's point is, not at the cell's centre: a
      // centre that falls on a roof would lift everything in the cell.
      _scratchProbe.lon = p.lon;
      _scratchProbe.lat = p.lat;
      const height = heights.now(_scratchProbe, { exclude });
      // A miss counts against the budget whatever its cause: past the support
      // gate a probe only throws mid-teardown, when every later cell would too.
      sampled += 1;
      if (height === null) continue; // tiles not loaded yet — no negative latch
      // Latch only against a real Re:Earth prior. A geoid fallback can reject valid
      // samples at elevated fields. Without a prior, a coarse tile, rooftop or aircraft
      // hit cannot be distinguished from the surface. Waiting for the DEM costs one poll.
      // `tilesLoaded` can be satisfied by coarse tiles under a high camera. A resolution
      // gate would need per-tile `geometricError`.
      const accepted = reportValidatedMeshFloorCell(p.lat, p.lon, height);
      // A spot counts as probed once the gate has judged it against a real
      // prior: accepted, or refused with the cell's DEM warm. A spot refused
      // only because the DEM was still cold is tried again later. Each spot is
      // recorded once, so a cell retried while it has no reading does not fill
      // its probe allowance with the same spot.
      if (!accepted && !meshFloorPriorReady(cell.lat, cell.lon)) continue;
      if (!probes) _probedPoints.set(key, [{ lat: p.lat, lon: p.lon }]);
      else if (
        probes.length < MAX_PROBES_PER_CELL &&
        !probes.some(
          (q) =>
            Math.abs(q.lat - p.lat) < PROBE_APART_DEG &&
            Math.abs(q.lon - p.lon) < PROBE_APART_DEG,
        )
      )
        probes.push({ lat: p.lat, lon: p.lon });
    }
  }

  // Mesh cells apply only while the photoreal (google-3d) stack renders. The scene
  // rebroadcasts stack changes as `gev:map-stack-changed` on `eventTarget`.
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
  return { sampleMeshFloorCells, cachedGroundFloor };
}

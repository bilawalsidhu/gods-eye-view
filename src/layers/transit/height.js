import * as Cesium from 'cesium';
import {
  FLOOR_REREAD_ATTEMPTS,
  FLOOR_REREAD_MS,
  FLOOR_WARM_PER_POLL,
  TRANSIT_POLL_MS,
  HEIGHT_SAMPLE_MAX_ALTITUDE_M,
  withinViewBounds,
} from './policy.js';

/** Surface preparation off the render path, shared by markers and history. */
export function createHeight({ state, services, parts }) {
  const { governorRequestRender } = services.render;
  const {
    cachedGroundFloor,
    neighborFloorM,
    warmGroundFloor,
    coarseFloorCoord,
    GROUND_FLOOR_LIFT_M,
  } = services.ground;
  // The application's rendered-mesh sampler. Optional so a layer built on a
  // bare floor stub still runs; the application always supplies it.
  const sampleMeshFloorCells = services.mesh?.sampleMeshFloorCells || null;

  /** The camera's subpoint in degrees, for the sampler's proximity gate. */
  function viewerSubpoint() {
    const carto = state._viewer?.camera?.positionCartographic;
    if (!carto) return { viewerLat: undefined, viewerLon: undefined };
    return {
      viewerLat: (carto.latitude * 180) / Math.PI,
      viewerLon: (carto.longitude * 180) / Math.PI,
    };
  }

  function cameraAltitude() {
    const carto = state._viewer?.camera?.positionCartographic;
    return carto && Number.isFinite(carto.height) ? carto.height : Infinity;
  }

  /**
   * Whether ground matters at this camera. Above the gate a few metres of
   * terrain are invisible, so the fleet renders on the ellipsoid and nothing
   * is warmed — a national view must not queue a country's worth of cells.
   * @returns {boolean}
   */
  function nearGround() {
    return cameraAltitude() <= HEIGHT_SAMPLE_MAX_ALTITUDE_M;
  }

  /**
   * The floor under a vehicle, and the best fallback if its own cell is cold.
   * @param {number} lat
   * @param {number} lon
   * @returns {{cell: string, height: number|null, prior: number|null}}
   */
  const terrainPoint = new Cesium.Cartographic();
  function requestHeight(lat, lon, entry = null) {
    const coarse = coarseFloorCoord(lat, lon);
    const cell = `${coarse.lat},${coarse.lon}`;
    const fixtureFloor =
      entry?.qaFloorM ?? state._qaFixtureFloors?.get(entry?.key);
    if (Number.isFinite(fixtureFloor))
      return { cell, height: fixtureFloor, prior: null };
    // On a terrain globe, use the loaded surface under the marker. This is
    // synchronous cache work and does not launch a terrain request.
    const globe = state._viewer?.scene?.globe;
    if (globe?.show === true) {
      Cesium.Cartographic.fromDegrees(lon, lat, 0, terrainPoint);
      const rendered = globe.getHeight?.(terrainPoint);
      const flat =
        state._viewer?.terrainProvider instanceof
        Cesium.EllipsoidTerrainProvider;
      if (Number.isFinite(rendered) || flat)
        return {
          cell,
          height: (flat ? 0 : rendered) + GROUND_FLOOR_LIFT_M,
          prior: null,
        };
    }
    const floor = cachedGroundFloor(lat, lon);
    if (Number.isFinite(floor)) {
      return { cell, height: floor + GROUND_FLOOR_LIFT_M, prior: null };
    }
    if (!nearGround()) {
      // Far enough away that the ellipsoid is indistinguishable from the
      // street: draw, do not wait, do not warm.
      return { cell, height: null, prior: 0 };
    }
    const neighbour = neighborFloorM(coarse);
    return {
      cell,
      height: null,
      // A neighbouring floor is a coarse prior, never a clearance guarantee.
      prior: Number.isFinite(neighbour)
        ? neighbour + GROUND_FLOOR_LIFT_M
        : null,
    };
  }

  /** A vehicle no longer rendered needs nothing released: cells are shared. */
  function releaseVehicle() {}

  let cellCursors = new WeakMap();
  let budgetAt = -Infinity;
  let demUsed = new Set(),
    meshUsed = 0;
  function rereadFloors() {
    state._floorTimer = null;
    if (!state._enabled) return;
    const onGround = nearGround(),
      candidates = [];
    const entries = [...state._vehicles.values()].filter(
      (entry) =>
        entry.key === state._selectedKey ||
        state._visible.has(entry) ||
        withinViewBounds(state._viewBounds, entry.segment?.from || entry.to),
    );
    entries.sort(
      (a, b) =>
        Number(b.key === state._selectedKey) -
        Number(a.key === state._selectedKey),
    );
    for (const entry of entries) {
      const cells = new Map();
      const collect = (point, answer) => {
        if (!onGround) return;
        if (!cells.has(answer.cell))
          cells.set(answer.cell, {
            lat: point.lat,
            lon: point.lon,
            cell: answer.cell,
            warm: answer.height !== null,
          });
      };
      parts.trails.prepareEntry(entry, collect);
      const newest = entry.fixes.at(-1);
      const answer = requestHeight(newest.lat, newest.lon, entry);
      entry.heightCell = answer.cell;
      if (answer.height !== null) {
        entry.heightM = answer.height;
        entry.heightResolved = true;
        if (entry.heightPending) {
          entry.heightPending = false;
          state._visibilityDirty = true;
        }
      }
      candidates.push({
        entry,
        cells: [...cells.values()],
        cursor: 0,
        start: cellCursors.get(entry) || 0,
      });
    }
    const selectedCells =
      candidates[0]?.entry.key === state._selectedKey
        ? candidates[0].cells.slice(0, 12)
        : [];
    const ordered = [...selectedCells],
      seen = new Set(selectedCells.map((cell) => cell.cell));
    const start = candidates.length
      ? state._floorCursor % candidates.length
      : 0;
    let remaining = true;
    while (remaining) {
      remaining = false;
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[(start + i) % candidates.length];
        if (candidate.cursor >= candidate.cells.length) continue;
        const index =
          (candidate.start + candidate.cursor++) % candidate.cells.length;
        const cell = candidate.cells[index];
        remaining = true;
        if (!seen.has(cell.cell)) {
          seen.add(cell.cell);
          ordered.push({
            ...cell,
            entry: candidate.entry,
            next: (index + 1) % candidate.cells.length,
          });
        }
      }
    }
    state._floorCursor += FLOOR_WARM_PER_POLL;
    const dem = [],
      mesh = [];
    for (const cell of ordered) {
      let admitted = false;
      if (
        !cell.warm &&
        (demUsed.has(cell.cell) || demUsed.size < FLOOR_WARM_PER_POLL)
      ) {
        demUsed.add(cell.cell);
        dem.push(cell);
        admitted = true;
      }
      if (cell.warm && meshUsed + mesh.length < 40) {
        mesh.push(cell);
        admitted = true;
      }
      if (admitted && cell.entry) cellCursors.set(cell.entry, cell.next);
    }
    meshUsed += mesh.length;
    const markers = entries.map((entry) => entry.marker).filter(Boolean);
    for (let i = 0; i < dem.length; i += 8)
      warmGroundFloor(dem.slice(i, i + 8));
    for (let i = 0; i < mesh.length; i += 8)
      sampleMeshFloorCells?.(state._viewer?.scene, mesh.slice(i, i + 8), {
        excludeObjects: markers,
        ...viewerSubpoint(),
      });
    // Cached completions can be adopted now; asynchronous completions are
    // adopted by the next bounded reread.
    for (const entry of entries) parts.trails.prepareEntry(entry);
    parts.rendering.requestVisibility();
    governorRequestRender('transit-floor');
    if (state._floorAttempts++ < FLOOR_REREAD_ATTEMPTS)
      state._floorTimer = setTimeout(rereadFloors, FLOOR_REREAD_MS);
  }

  /** Start a fresh re-read cycle. Called once per poll, never per frame. */
  function anchorFloors() {
    if (state._floorTimer) {
      clearTimeout(state._floorTimer);
      state._floorTimer = null;
    }
    state._floorAttempts = 0;
    const now = performance.now();
    if (now - budgetAt >= TRANSIT_POLL_MS) {
      demUsed = new Set();
      meshUsed = 0;
      budgetAt = now;
    }
    rereadFloors();
  }

  function clear() {
    budgetAt = -Infinity;
    cellCursors = new WeakMap();
    demUsed.clear();
    meshUsed = 0;
    if (state._floorTimer) {
      clearTimeout(state._floorTimer);
      state._floorTimer = null;
    }
    state._floorAttempts = 0;
    state._heightDirty.clear();
  }

  return {
    nearGround,
    requestHeight,
    releaseVehicle,
    anchorFloors,
    rereadFloors,
    clear,
  };
}

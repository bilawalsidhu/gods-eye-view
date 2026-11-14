import * as Cesium from 'cesium';
import {
  FLOOR_REREAD_ATTEMPTS,
  FLOOR_REREAD_MS,
  FLOOR_WARM_PER_POLL,
  TRANSIT_POLL_MS,
  HEIGHT_SAMPLE_MAX_ALTITUDE_M,
  withinViewBounds,
} from './policy.js';
import {
  TERRAIN_NEED,
  createTerrainSurface,
} from '../../services/terrainSurface.js';

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

  // Loaded-terrain heights come from the application's shared reader, which
  // keeps them per point and rations the reads (services/terrainSurface.js).
  // A layer built without one keeps its own.
  const sharedSurface = services.ground.terrainSurface;
  const terrainSurface = sharedSurface || createTerrainSurface();

  /**
   * The floor under a vehicle, and the best fallback if its own cell is cold.
   * @param {number} lat
   * @param {number} lon
   * @param {?object} [entry] The vehicle, for a fixture floor.
   * @param {number} [need] How much the answer matters; see TERRAIN_NEED.
   * @returns {{cell: string, height: number|null, prior: number|null}}
   */
  function requestHeight(lat, lon, entry = null, need = TERRAIN_NEED.PATH) {
    const coarse = coarseFloorCoord(lat, lon);
    const cell = `${coarse.lat},${coarse.lon}`;
    const fixtureFloor =
      entry?.qaFloorM ?? state._qaFixtureFloors?.get(entry?.key);
    if (Number.isFinite(fixtureFloor))
      return { cell, height: fixtureFloor, prior: null };
    // On a terrain globe, use the loaded surface under the marker. This reads
    // tiles already loaded and does not launch a terrain request.
    const globe = state._viewer?.scene?.globe;
    if (globe?.show === true) {
      if (
        state._viewer?.terrainProvider instanceof
        Cesium.EllipsoidTerrainProvider
      ) {
        // Nothing is asked of the terrain while the globe is flat: show the
        // reader the flat provider, so the heights kept from the terrain
        // before it do not come back with the terrain after it.
        terrainSurface.observe(state._viewer);
        return { cell, height: GROUND_FLOOR_LIFT_M, prior: null };
      }
      const rendered = terrainSurface.height(state._viewer, lat, lon, need);
      if (Number.isFinite(rendered))
        return { cell, height: rendered + GROUND_FLOOR_LIFT_M, prior: null };
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
    const waitingBefore = terrainSurface.waitingCount();
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
    // Every vehicle's own position before any trail: the first trails of a
    // pass must not spend the budget the last markers are waiting on.
    for (const entry of entries) {
      const newest = entry.fixes.at(-1);
      if (newest)
        requestHeight(newest.lat, newest.lon, entry, TERRAIN_NEED.MARKER);
    }
    for (const entry of entries) {
      const cells = new Map();
      const collect = (point, answer) => {
        if (!onGround) return;
        // A cell keeps the last point offered in it: the path is walked
        // oldest first, so that is where the vehicle is now or about to be,
        // and the mesh sampler reads the surface there.
        const held = cells.get(answer.cell);
        if (held) {
          held.lat = point.lat;
          held.lon = point.lon;
        } else
          cells.set(answer.cell, {
            lat: point.lat,
            lon: point.lon,
            cell: answer.cell,
            warm: answer.height !== null,
          });
      };
      parts.trails.prepareEntry(entry, collect);
      const newest = entry.fixes.at(-1);
      const answer = requestHeight(
        newest.lat,
        newest.lon,
        entry,
        TERRAIN_NEED.MARKER,
      );
      entry.heightCell = answer.cell;
      // The selected vehicle's path also offers its history, newest segment
      // first; the vehicle's own cell is read where its newest fix is.
      const own = cells.get(answer.cell);
      if (own) {
        own.lat = newest.lat;
        own.lon = newest.lon;
      }
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
    // A pass that ran out of terrain budget before reaching every point
    // comes back for the rest. Each pass reads its budget, and points stop
    // falling due once the terrain settles, so this ends.
    const waiting = terrainSurface.waitingCount() - waitingBefore;
    if (state._floorAttempts++ < FLOOR_REREAD_ATTEMPTS || waiting > 0)
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
    // The shared reader's heights belong to every layer still showing.
    if (!sharedSurface) terrainSurface.clear();
  }

  return {
    nearGround,
    requestHeight,
    releaseVehicle,
    anchorFloors,
    rereadFloors,
    clear,
    /** Terrain read counters since the layer was created, for checks. */
    terrainStats: () => terrainSurface.stats(),
  };
}

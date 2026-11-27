import {
  FLOOR_REREAD_ATTEMPTS,
  FLOOR_REREAD_MAX_ATTEMPTS,
  FLOOR_REREAD_MS,
  FLOOR_WARM_PER_POLL,
  TRANSIT_POLL_MS,
  HEIGHT_SAMPLE_MAX_ALTITUDE_M,
  TERRAIN_HEIGHT_CACHE_MAX,
  TERRAIN_HEIGHT_FRESH_MS,
  TERRAIN_NEED,
  TERRAIN_READ_BUDGET_MS,
  TERRAIN_READ_WINDOW_MS,
  TERRAIN_REFRESH_BUDGET_MS,
  TERRAIN_SETTLE_MS,
  withinViewBounds,
} from './policy.js';
import { heightsOf } from '../../queries/heights.js';
import { readFix } from '../../data/contactPlayback.js';

const POSE_KEYS = ['lon', 'lat', 'height', 'heading', 'pitch', 'roll'];

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

  /**
   * Whether ground matters at this camera. Above the gate a few metres of
   * terrain are invisible, so the fleet renders on the ellipsoid and nothing
   * is warmed — a national view must not queue a country's worth of cells.
   * @returns {boolean}
   */
  function nearGround() {
    return parts.rendering.cameraHeightM() <= HEIGHT_SAMPLE_MAX_ALTITUDE_M;
  }

  const terrainPoint = { lon: 0, lat: 0 };
  const AGAINST_TERRAIN = Object.freeze({ against: 'terrain' });
  /** Point key → `{ h, at }`: the height read there and when. */
  const terrainHeights = new Map();
  /** Floor cell → the last height read anywhere in that cell. */
  const terrainCells = new Map();
  let terrainWindowAt = -Infinity;
  let terrainReadMs = 0;
  let terrainMarkerMs = 0;
  let terrainRefreshMs = 0;
  // Per need (history, path): the oldest read among the points this window
  // left for later; the next window re-reads only points read within the
  // reuse time of it.
  const terrainDeferredAt = [Infinity, Infinity];
  const terrainRefreshUpTo = [Infinity, Infinity];
  /** Drawn points a pass left unread or due a re-read; see rereadFloors. */
  let terrainWaiting = 0;
  let passing = false;
  /** Whether the last terrainHeight call left its point for a later window. */
  let terrainDeferred = false;
  /** When the camera last moved or the globe was last loading tiles. */
  let terrainChangedAt = -Infinity;
  const cameraSeen = {};
  /** The globe's `surfaceVersion` the kept heights were read from. */
  let terrainSurfaceRead = null;

  /** A number unique to a point on a 1e-5° grid. */
  function gridKey(lat, lon) {
    return (
      (Math.round(lat * 1e5) + 9e6) * 36000001 + Math.round(lon * 1e5) + 18e6
    );
  }

  function dropOldestQuarter(map) {
    let drop = TERRAIN_HEIGHT_CACHE_MAX >> 2;
    for (const old of map.keys()) {
      map.delete(old);
      if (--drop <= 0) break;
    }
  }

  function clearTerrainHeights() {
    terrainHeights.clear();
    terrainCells.clear();
    terrainWindowAt = -Infinity;
    terrainDeferredAt.fill(Infinity);
    for (const key of POSE_KEYS) cameraSeen[key] = NaN;
  }

  /** A drawn point waits for a read: a pass comes back for it. */
  function wait(need) {
    if (need === TERRAIN_NEED.HISTORY) return;
    terrainWaiting++;
    if (
      !passing &&
      !state._floorTimer &&
      state._floorAttempts <= FLOOR_REREAD_MAX_ATTEMPTS
    )
      state._floorTimer = setTimeout(rereadFloors, FLOOR_REREAD_MS);
  }

  /**
   * The loaded terrain's height at a point, or undefined when it is not
   * known yet; reuse and budgets are in policy.js. Requests come in the same
   * order every pass, so a window re-reads only points read within the reuse
   * time of the longest-waiting one: otherwise the first few would be re-read
   * forever and the rest never.
   */
  function terrainHeight(lat, lon, cell, need) {
    terrainDeferred = false;
    const now = performance.now();
    if (now - terrainWindowAt >= TERRAIN_READ_WINDOW_MS) {
      for (let i = 0; i < terrainDeferredAt.length; i++) {
        terrainRefreshUpTo[i] = terrainDeferredAt[i] + TERRAIN_HEIGHT_FRESH_MS;
        terrainDeferredAt[i] = Infinity;
      }
      terrainWindowAt = now;
      terrainReadMs = terrainMarkerMs = terrainRefreshMs = 0;
      const camera = parts.rendering.cameraPose();
      if (
        !parts.rendering.terrainSettled() ||
        POSE_KEYS.some((key) => camera?.[key] !== cameraSeen[key])
      ) {
        terrainChangedAt = now;
        for (const key of POSE_KEYS) cameraSeen[key] = camera?.[key];
      }
    }
    const key = gridKey(lat, lon);
    const held = terrainHeights.get(key);
    if (
      held &&
      (now - held.at < TERRAIN_HEIGHT_FRESH_MS ||
        held.at >= terrainChangedAt + TERRAIN_SETTLE_MS)
    )
      return held.h;
    const marker = need === TERRAIN_NEED.MARKER;
    const share = need === TERRAIN_NEED.HISTORY ? 0.25 : 1;
    const trailSpent =
      terrainReadMs - Math.max(0, terrainMarkerMs - TERRAIN_READ_BUDGET_MS / 2);
    const affordable = marker
      ? !held || terrainReadMs < TERRAIN_READ_BUDGET_MS
      : trailSpent < TERRAIN_READ_BUDGET_MS * share &&
        (!held ||
          (terrainRefreshMs < TERRAIN_REFRESH_BUDGET_MS * share &&
            held.at <= terrainRefreshUpTo[need]));
    if (!affordable) {
      wait(need);
      if (held) {
        if (!marker && held.at < terrainDeferredAt[need])
          terrainDeferredAt[need] = held.at;
        return held.h;
      }
      const borrowed = terrainCells.get(cell);
      if (borrowed !== undefined) return borrowed;
      terrainDeferred = true;
      return undefined;
    }
    terrainPoint.lon = lon;
    terrainPoint.lat = lat;
    const rendered = heightsOf(state._viewer).now(
      terrainPoint,
      AGAINST_TERRAIN,
    );
    const spent = performance.now() - now;
    terrainReadMs += spent;
    if (marker) terrainMarkerMs += spent;
    if (held) terrainRefreshMs += spent;
    // A tile that left the globe keeps the height it gave.
    if (rendered === null) return held?.h;
    if (held) {
      held.h = rendered;
      held.at = now;
    } else {
      if (terrainHeights.size >= TERRAIN_HEIGHT_CACHE_MAX)
        dropOldestQuarter(terrainHeights);
      terrainHeights.set(key, { h: rendered, at: now });
    }
    if (terrainCells.size >= TERRAIN_HEIGHT_CACHE_MAX)
      dropOldestQuarter(terrainCells);
    terrainCells.set(cell, rendered);
    return rendered;
  }

  /**
   * The floor under a vehicle, and the best fallback if its own cell is cold.
   * @param {number} lat
   * @param {number} lon
   * @param {?object} [entry] The vehicle, for a fixture floor.
   * @param {number} [need] How much the answer matters; see TERRAIN_NEED.
   * @returns {{cell: string, height: number|null, prior: number|null, deferred?: true}}
   */
  function requestHeight(lat, lon, entry = null, need = TERRAIN_NEED.PATH) {
    const coarse = coarseFloorCoord(lat, lon);
    const cell = `${coarse.lat},${coarse.lon}`;
    const fixtureFloor =
      entry?.qaFloorM ?? state._qaFixtureFloors?.get(entry?.key);
    if (Number.isFinite(fixtureFloor))
      return { cell, height: fixtureFloor, prior: null };
    let deferred = false;
    // On a terrain globe, use the loaded surface under the marker. This reads
    // tiles already loaded and does not launch a terrain request.
    const globe = parts.rendering.globeSurface();
    // A height belongs to the surface it was read from; the version moves
    // with the terrain provider, the globe shown or hidden, and the 3D tilesets
    // shown. Read on every request, hidden or flat included, so no change
    // between two reads is missed.
    const surface = parts.rendering.surfaceVersion();
    if (surface !== terrainSurfaceRead) {
      clearTerrainHeights();
      terrainSurfaceRead = surface;
    }
    if (globe !== 'none') {
      if (globe === 'flat')
        return { cell, height: GROUND_FLOOR_LIFT_M, prior: null };
      const rendered = terrainHeight(lat, lon, cell, need);
      if (Number.isFinite(rendered))
        return { cell, height: rendered + GROUND_FLOOR_LIFT_M, prior: null };
      deferred = terrainDeferred;
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
    const answer = {
      cell,
      height: null,
      // A neighbouring floor is a coarse prior, never a clearance guarantee.
      prior: Number.isFinite(neighbour)
        ? neighbour + GROUND_FLOOR_LIFT_M
        : null,
    };
    // Left for a later window, not missed: nothing to warm.
    if (deferred) answer.deferred = true;
    return answer;
  }

  /** A vehicle no longer rendered needs nothing released: cells are shared. */
  function releaseVehicle() {}

  const newestFix = {};
  let cellCursors = new WeakMap();
  let budgetAt = -Infinity;
  let demUsed = new Set(),
    meshUsed = 0;
  function rereadFloors() {
    state._floorTimer = null;
    if (!state._enabled) return;
    passing = true;
    terrainWaiting = 0;
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
    const markers = entries.map((entry) => {
      const fix = entry.track?.count
        ? readFix(entry.track, entry.track.count - 1, newestFix)
        : null;
      return (
        fix && {
          lat: fix.lat,
          lon: fix.lon,
          answer: requestHeight(fix.lat, fix.lon, entry, TERRAIN_NEED.MARKER),
        }
      );
    });
    for (const [i, entry] of entries.entries()) {
      const newest = markers[i];
      if (!newest) continue;
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
        } else if (!answer.deferred)
          cells.set(answer.cell, {
            lat: point.lat,
            lon: point.lon,
            cell: answer.cell,
            warm: answer.height !== null,
          });
      };
      parts.trails.prepareEntry(entry, collect);
      const { answer } = newest;
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
    for (let i = 0; i < dem.length; i += 8)
      warmGroundFloor(dem.slice(i, i + 8));
    parts.rendering.sampleMeshFloors(mesh);
    // Cached completions can be adopted now; asynchronous completions are
    // adopted by the next bounded reread.
    for (const entry of entries) parts.trails.prepareEntry(entry);
    parts.rendering.requestVisibility();
    governorRequestRender('transit-floor');
    passing = false;
    // A pass that left a drawn point waiting for a terrain read comes back
    // for it, up to FLOOR_REREAD_MAX_ATTEMPTS: a camera that never stops
    // keeps points falling due.
    const attempt = state._floorAttempts++;
    if (
      attempt < FLOOR_REREAD_ATTEMPTS ||
      (terrainWaiting > 0 && attempt < FLOOR_REREAD_MAX_ATTEMPTS)
    )
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
    clearTerrainHeights();
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

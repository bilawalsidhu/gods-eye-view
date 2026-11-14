import * as Cesium from 'cesium';

/**
 * The height of the terrain globe's loaded surface at a point, kept per point
 * and read within a time budget.
 *
 * `globe.getHeight` casts a ray against the mesh of the tile drawn under the
 * point: geometry work, not a table lookup, and dearer the finer the tile. A
 * layer that asks for every vehicle, trail fix or site on every pass asks the
 * same few thousand points over and over, so the answers are kept and the
 * reads are rationed. One instance serves every layer of an application, so
 * the layers share one budget instead of each spending its own.
 */

/**
 * While the camera moves or tiles load, a kept height is reused this long
 * before the point is read again.
 */
export const TERRAIN_HEIGHT_FRESH_MS = 2_000;
/**
 * A height read once the camera has been still and the globe's tiles loaded
 * for this long is kept until either changes: the globe draws a point from
 * another tile only after one of them does.
 */
export const TERRAIN_SETTLE_MS = 5_000;
/** Read budgets are counted over windows of this length. */
export const TERRAIN_READ_WINDOW_MS = 200;
/**
 * Milliseconds of terrain reads in one window. Past it a point never read
 * takes the last height read in its ~111 m floor cell, or waits for a later
 * request; a MARKER point is read regardless.
 */
export const TERRAIN_READ_BUDGET_MS = 16;
/**
 * The share of that budget re-reads of kept points may use, the longest-kept
 * first, leaving the rest for points never read.
 */
export const TERRAIN_REFRESH_BUDGET_MS = 12;
/**
 * How much a height matters to what is drawn, lowest first. BACKGROUND is a
 * point nobody is looking at (the undrawn trail history of a vehicle) and may
 * use a quarter of each budget; PATH is drawn geometry; MARKER is a thing's
 * own position, read even when the window's budget is spent, since a marker
 * without a height is not drawn.
 */
export const TERRAIN_NEED = Object.freeze({
  BACKGROUND: 0,
  PATH: 1,
  MARKER: 2,
});
/** Points kept; the oldest quarter is dropped past it. */
export const TERRAIN_HEIGHT_CACHE_MAX = 60_000;

/** A number unique to a point on a `scale`-per-degree grid. */
function gridKey(lat, lon, scale) {
  return (
    (Math.round(lat * scale) + 90 * scale) * (360 * scale + 1) +
    Math.round(lon * scale) +
    180 * scale
  );
}

/**
 * @returns {{
 *   height: (viewer: object, lat: number, lon: number, need?: number) => number|undefined,
 *   observe: (viewer: object) => void,
 *   waitingCount: () => number,
 *   stats: () => {reads: number, reused: number, deferred: number, borrowed: number, held: number},
 *   clear: () => void,
 * }}
 */
export function createTerrainSurface() {
  const point = new Cesium.Cartographic();
  /** Point key → `{ h, at }`: the height read there and when. */
  const heights = new Map();
  /** Floor-cell key → the last height read anywhere in that cell. */
  const cells = new Map();
  /** The globe and terrain provider the kept heights were read from. */
  let globeRead = null;
  let providerRead = null;
  let windowAt = -Infinity;
  let readMs = 0;
  let refreshMs = 0;
  // Per need (background, path): the oldest read among the points this window
  // left for later, and the bound the next window re-reads up to.
  const deferredAt = [Infinity, Infinity];
  const refreshUpTo = [Infinity, Infinity];
  let waiting = 0;
  /** When the camera last moved or the globe was last loading tiles. */
  let changedAt = -Infinity;
  let cameraLon = NaN,
    cameraLat = NaN,
    cameraHeight = NaN;
  const counters = { reads: 0, reused: 0, deferred: 0, borrowed: 0 };

  function clear() {
    heights.clear();
    cells.clear();
    globeRead = providerRead = null;
    windowAt = -Infinity;
    readMs = refreshMs = 0;
    deferredAt.fill(Infinity);
    refreshUpTo.fill(Infinity);
    changedAt = -Infinity;
    cameraLon = cameraLat = cameraHeight = NaN;
  }

  /**
   * The globe redraws a point from another tile only after the camera moves
   * or a tile arrives: note when either was last seen.
   */
  function noteChange(viewer, globe, now) {
    const camera = viewer.camera?.positionCartographic;
    if (
      globe.tilesLoaded === false ||
      camera?.longitude !== cameraLon ||
      camera?.latitude !== cameraLat ||
      camera?.height !== cameraHeight
    ) {
      changedAt = now;
      cameraLon = camera?.longitude;
      cameraLat = camera?.latitude;
      cameraHeight = camera?.height;
    }
  }

  /** The viewer's terrain globe, the one whose heights are held, or null. */
  function terrainGlobe(viewer) {
    const globe = viewer?.scene?.globe;
    if (globe?.show !== true || typeof globe.getHeight !== 'function')
      return null;
    // A height belongs to the terrain it was read from: another globe or
    // another terrain provider is another surface, however settled the camera.
    const provider = viewer.terrainProvider;
    if (globe !== globeRead || provider !== providerRead) {
      clear();
      globeRead = globe;
      providerRead = provider;
    }
    return globe;
  }

  /**
   * Look at the camera and the globe's tile loading without asking for a
   * height. The surface only sees a change when it is asked something, so a
   * caller that asks nothing while tiles load (it waits for them) calls this
   * on its own walk; otherwise the load would pass unseen and the heights
   * kept from before it would never be read again.
   * @param {object} viewer
   */
  function observe(viewer) {
    const globe = terrainGlobe(viewer);
    if (globe) noteChange(viewer, globe, performance.now());
  }

  /**
   * The loaded terrain's height at a point, in metres above the ellipsoid, or
   * undefined when it is not known yet or the viewer has no terrain globe
   * showing. A point read within the reuse time answers from memory, and so
   * does one read after the camera and the globe's tiles had settled: the
   * surface under it cannot have changed since. Past the window's budget a
   * kept point keeps its last height and a new point borrows its floor
   * cell's. Requests tend to come in the same order every pass, so re-reads
   * go to the longest-kept points first: otherwise the first few would be
   * re-read forever and the rest never.
   * @param {object} viewer The Cesium viewer whose globe is read.
   * @param {number} lat Degrees.
   * @param {number} lon Degrees.
   * @param {number} [need] How much the answer matters; see TERRAIN_NEED.
   */
  function height(viewer, lat, lon, need = TERRAIN_NEED.PATH) {
    const globe = terrainGlobe(viewer);
    if (!globe) return undefined;
    const now = performance.now();
    if (now - windowAt >= TERRAIN_READ_WINDOW_MS) {
      for (let i = 0; i < deferredAt.length; i++) {
        refreshUpTo[i] = deferredAt[i];
        deferredAt[i] = Infinity;
      }
      windowAt = now;
      readMs = refreshMs = 0;
      noteChange(viewer, globe, now);
    }
    const key = gridKey(lat, lon, 1e5);
    const held = heights.get(key);
    if (
      held &&
      (now - held.at < TERRAIN_HEIGHT_FRESH_MS ||
        held.at >= changedAt + TERRAIN_SETTLE_MS)
    ) {
      counters.reused++;
      return held.h;
    }
    const cellKey = gridKey(lat, lon, 1e3);
    const marker = need === TERRAIN_NEED.MARKER;
    // Background may use a quarter of each budget; drawn geometry the rest.
    const share = need === TERRAIN_NEED.BACKGROUND ? 0.25 : 1;
    const affordable =
      marker && !held
        ? true
        : readMs < TERRAIN_READ_BUDGET_MS * (marker ? 1 : share) &&
          (!held ||
            marker ||
            (refreshMs < TERRAIN_REFRESH_BUDGET_MS * share &&
              held.at <= refreshUpTo[need]));
    if (!affordable) {
      counters.deferred++;
      if (held) {
        if (!marker && held.at < deferredAt[need]) deferredAt[need] = held.at;
        waiting++;
        return held.h;
      }
      const borrowed = cells.get(cellKey);
      if (borrowed !== undefined) {
        counters.borrowed++;
        return borrowed;
      }
      waiting++;
      return undefined;
    }
    Cesium.Cartographic.fromDegrees(lon, lat, 0, point);
    const rendered = globe.getHeight(point);
    const spent = performance.now() - now;
    readMs += spent;
    if (held) refreshMs += spent;
    counters.reads++;
    // A tile that left the globe keeps the height it gave.
    if (!Number.isFinite(rendered)) return held?.h;
    if (held) {
      held.h = rendered;
      held.at = now;
    } else {
      if (heights.size >= TERRAIN_HEIGHT_CACHE_MAX) {
        let drop = TERRAIN_HEIGHT_CACHE_MAX >> 2;
        for (const old of heights.keys()) {
          heights.delete(old);
          if (--drop <= 0) break;
        }
        cells.clear();
      }
      heights.set(key, { h: rendered, at: now });
    }
    cells.set(cellKey, rendered);
    return rendered;
  }

  return {
    height,
    observe,
    /**
     * Requests so far that were left unread or due a re-read. A caller that
     * reads it before and after its own pass learns whether to come back.
     */
    waitingCount: () => waiting,
    /** Read counters since creation, for checks. */
    stats: () => ({ ...counters, held: heights.size }),
    clear,
  };
}

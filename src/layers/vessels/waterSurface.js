import {
  INLAND_WATER_AGREE_M,
  INLAND_WATER_LOWEST_M,
  INLAND_WATER_MIN_ELEVATION_M,
  WATER_SURFACE_CELLS_PER_BATCH,
  WATER_SURFACE_MAX_CELLS_PER_MINUTE,
} from './policy.js';

/** Wall time and timers, replaceable in tests. */
const DEFAULT_CLOCK = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
});

/** The window the per-minute cell budget is counted over. */
const MINUTE_MS = 60_000;

/** Pitch of the terrain cells, in degrees: the shared coarse floor grid. */
const CELL_DEG = 0.001;
/** Cell indices per degree. */
const PER_DEG = 1 / CELL_DEG;
/** Cell indices around the globe in longitude. */
const LON_CELLS = 360 * PER_DEG;

/** Most cells kept in the level cache before it starts again. */
const LEVEL_CACHE_MAX = 50_000;

/** A cell whose level cannot be told yet (its terrain is not all fetched). */
const UNKNOWN = Symbol('unknown');

/** Whose points are fetched first: the selected vessel's trail, then the view. */
const BACKLOG_ORDER = ['trail', 'view'];

/** The eight cells around a cell, as index offsets. */
const NEIGHBOURS = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

/** Fewest neighbours known before a level is told without the rest. */
const MIN_NEIGHBOURS_KNOWN = 4;

/**
 * The level of inland water at a vessel, from the terrain cells around it,
 * or null where the vessel is on the sea (drawn on the geoid, as before).
 *
 * Each reading is one cell's terrain: its ellipsoidal height and its height
 * above sea level as the terrain service gives it (`elevation`). The terrain
 * flattens water, so a lake or river reads the same in several cells, while
 * quays, banks and stray cells do not. The level is therefore the lowest
 * elevation another cell confirms within `agreeM`: below it are only lone
 * cells (a lock chamber, a hole, the far bank's foot).
 * - At least `minElevationM` above sea level, it is inland water: lakes,
 *   rivers, locked docks.
 * - Where the vessel's own cell is at least that far below sea level and
 *   three cells agree on a level no lower than `lowestM` (the Dead Sea), it
 *   is water below sea level: the Caspian, the Dead Sea. A terrain source
 *   that gave sea-floor depths would have to fail these to sink sea vessels.
 * - Otherwise it is the sea, where the geoid is exact and the terrain near
 *   coasts only adds noise.
 *
 * @param {{ellipsoid: number, elevation: number}} own - The vessel's cell.
 * @param {Array<{ellipsoid: number, elevation: number}>} neighbours - The
 *   cells around it that are known.
 * @param {{minElevationM?: number, agreeM?: number, lowestM?: number}} [options]
 * @returns {number|null} Ellipsoidal level of the water (m), or null for the
 *   sea.
 */
export function inlandWaterLevelM(
  own,
  neighbours,
  {
    minElevationM = INLAND_WATER_MIN_ELEVATION_M,
    agreeM = INLAND_WATER_AGREE_M,
    lowestM = INLAND_WATER_LOWEST_M,
  } = {},
) {
  if (!Number.isFinite(own?.elevation) || !Number.isFinite(own?.ellipsoid))
    return null;
  if (Math.abs(own.elevation) < minElevationM) return null;
  const cells = [own, ...(neighbours ?? [])]
    .filter(
      (c) => Number.isFinite(c?.elevation) && Number.isFinite(c?.ellipsoid),
    )
    .sort((a, b) => a.elevation - b.elevation);
  for (let i = 0; i < cells.length; i += 1) {
    const floor = cells[i].elevation;
    let agreeing = 0;
    for (
      let j = i;
      j < cells.length && cells[j].elevation - floor <= agreeM;
      j += 1
    )
      agreeing += 1;
    if (agreeing < 2) continue;
    if (floor >= minElevationM && own.elevation >= minElevationM)
      return cells[i].ellipsoid;
    if (
      own.elevation <= -minElevationM &&
      floor <= -minElevationM &&
      floor >= lowestM &&
      agreeing >= 3
    )
      return cells[i].ellipsoid;
    return null;
  }
  return null;
}

/**
 * Water levels under vessels from the shared terrain cache, and the batches
 * that fill it.
 *
 * Reads are synchronous cache lookups (vessels are drawn with them, several
 * times a second). A cell's own terrain is fetched first; the eight around it
 * only when it is not at sea level (and its list asks for them), since at sea
 * they cannot change the answer. Batches run one at a time, the trail's cells
 * first. Each list has a budget of cells; asking for a list again replaces
 * what is left of it, its queued cells included, and dropping it stops it.
 * After each batch `onWarm` gets the keys of the cells whose level may have
 * changed.
 *
 * @param {object} options
 * @param {object|null} options.ground - Terrain cache:
 *   `cachedRealEllipsoidalGround`, `cachedRealOrthometricGround` (optional)
 *   and `resolveEllipsoidalGround`. Without it no level is ever known.
 * @param {(lat: number, lon: number) => number|null} options.geoidAt - Geoid
 *   undulation, or null while the grid loads: the height above sea level of
 *   a cell whose service sent none is its ellipsoidal height less this.
 * @param {(cells: Set<number>) => void} [options.onWarm]
 * @param {number} [options.cellsPerBatch]
 * @param {number} [options.cellsPerMinute] - Cells all batches may fetch in
 *   any minute; a batch waits for the budget when it is spent.
 * @param {{now: () => number, setTimeout: Function, clearTimeout: Function}}
 *   [options.clock]
 */
export function createWaterSurface({
  ground,
  geoidAt,
  onWarm = () => {},
  cellsPerBatch = WATER_SURFACE_CELLS_PER_BATCH,
  cellsPerMinute = WATER_SURFACE_MAX_CELLS_PER_MINUTE,
  clock = DEFAULT_CLOCK,
}) {
  /** Cells sent in the last minute: `{at, cells}` per batch, oldest first. */
  const sent = [];
  /** A batch waiting for the minute's budget to free up. */
  let waiting = null;
  /** Level by cell key: a number (inland), null (the sea) or UNKNOWN. */
  const levels = new Map();
  /** Cells for the next batch, by key: `{iLat, iLon, list, around}`. */
  const pending = new Map();
  /** Cells being fetched, by key, each with the batch fetching it. */
  const inFlight = new Map();
  /** Points still to ask for, by list, each with how far it has got. */
  const backlogs = new Map();
  /** Cells each list may still queue (its points' and their neighbours'). */
  const budgets = new Map();
  /** The current ask of each list: a batch of an earlier ask queues nothing
   *  more for it. */
  const asks = new Map();
  let askCount = 0;
  /** When each cell the service did not answer was last asked for: it is
   *  not asked again (or charged) within the minute. */
  const failed = new Map();
  let running = null;
  let generation = 0;
  // Until a batch has landed nothing is known: reads cost nothing.
  let anyFetched = false;

  // One key per meridian: +180° is −180°.
  const wrapLon = (iLon) =>
    iLon >= LON_CELLS / 2
      ? iLon - LON_CELLS
      : iLon < -LON_CELLS / 2
        ? iLon + LON_CELLS
        : iLon;
  const keyOf = (iLat, iLon) =>
    (iLat + 90 * PER_DEG) * 1e6 + (iLon + LON_CELLS);

  /** One cell's terrain, or null while it is not fetched. */
  function reading(iLat, iLon) {
    const lat = iLat / PER_DEG;
    const lon = iLon / PER_DEG;
    const ellipsoid = ground.cachedRealEllipsoidalGround(lat, lon);
    if (ellipsoid == null) return null;
    let elevation = ground.cachedRealOrthometricGround?.(lat, lon) ?? null;
    if (elevation == null) {
      const n = geoidAt(lat, lon);
      if (!Number.isFinite(n)) return null;
      elevation = ellipsoid - n;
    }
    return { ellipsoid, elevation };
  }

  /** The level of a cell, or undefined while its terrain is not all known. */
  function tell(iLat, iLon) {
    const own = reading(iLat, iLon);
    if (!own) return undefined;
    if (Math.abs(own.elevation) < INLAND_WATER_MIN_ELEVATION_M) return null;
    const neighbours = [];
    for (const [dLat, dLon] of NEIGHBOURS) {
      const r = reading(iLat + dLat, wrapLon(iLon + dLon));
      if (r) neighbours.push(r);
    }
    if (neighbours.length < MIN_NEIGHBOURS_KNOWN) return undefined;
    return inlandWaterLevelM(own, neighbours);
  }

  /**
   * The water at `lat`/`lon`: its ellipsoidal level (m) when it is inland
   * water, null when it is the sea, undefined while it cannot be told yet.
   * @param {number} lat
   * @param {number} lon
   * @returns {number|null|undefined}
   */
  function levelAt(lat, lon) {
    if (!anyFetched || !Number.isFinite(lat) || !Number.isFinite(lon))
      return undefined;
    const iLat = Math.round(lat * PER_DEG);
    const iLon = wrapLon(Math.round(lon * PER_DEG));
    const key = keyOf(iLat, iLon);
    const cached = levels.get(key);
    if (cached === UNKNOWN) return undefined;
    if (cached !== undefined) return cached;
    const level = tell(iLat, iLon);
    if (levels.size >= LEVEL_CACHE_MAX) {
      // Unknown cells (vessels drawn far from any fetched water) go first;
      // known levels only if the cache is full of them.
      for (const [k, v] of levels) if (v === UNKNOWN) levels.delete(k);
      if (levels.size >= LEVEL_CACHE_MAX) levels.clear();
    }
    levels.set(key, level === undefined ? UNKNOWN : level);
    return level;
  }

  /**
   * The water at `lat`/`lon` from its own cell alone, for points whose
   * neighbours are not asked for (a trail's samples): the cell's height when
   * it is off sea level, null near sea level, undefined while not fetched.
   * Unconfirmed by other cells, so a bank reads as water here.
   * @param {number} lat
   * @param {number} lon
   * @returns {number|null|undefined}
   */
  function ownLevelAt(lat, lon) {
    if (!ground || !Number.isFinite(lat) || !Number.isFinite(lon))
      return undefined;
    const own = reading(
      Math.round(lat * PER_DEG),
      wrapLon(Math.round(lon * PER_DEG)),
    );
    if (!own) return undefined;
    return Math.abs(own.elevation) < INLAND_WATER_MIN_ELEVATION_M
      ? null
      : own.ellipsoid;
  }

  /**
   * The key of the cell `lat`/`lon` is in, as `onWarm` names cells.
   * @param {number} lat
   * @param {number} lon
   * @returns {number|null}
   */
  function cellKeyAt(lat, lon) {
    if (!ground || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return keyOf(Math.round(lat * PER_DEG), wrapLon(Math.round(lon * PER_DEG)));
  }

  /**
   * Ask for the terrain under `points`, nearest first, batch by batch until
   * the list is done or its budget spent. Asking for the same `list` again
   * replaces what is left of it. Never throws; the answers land in the
   * shared cache.
   * @param {Array<{lat: number, lon: number}>} points
   * @param {{list?: 'view'|'trail', around?: boolean, maxCells?: number}}
   *   [options] - `around: false` asks for the points' own cells only (a
   *   trail's samples, which the vessel's own level stands in around);
   *   `maxCells` caps the cells this ask may queue.
   */
  function warm(
    points,
    { list = 'view', around = true, maxCells = Infinity } = {},
  ) {
    if (!ground || !Array.isArray(points)) return;
    drop(list);
    backlogs.set(list, { points, next: 0, around });
    budgets.set(list, maxCells);
    asks.set(list, ++askCount);
    fill();
    if (!running) runBatch();
  }

  /**
   * Stop asking for a list: what is left of it and its queued cells are
   * dropped (a batch already running finishes).
   * @param {'view'|'trail'} list
   */
  function drop(list) {
    backlogs.delete(list);
    budgets.delete(list);
    asks.delete(list);
    for (const [key, c] of pending) if (c.list === list) pending.delete(key);
  }

  /** Queue one cell for `list` unless it is known, on its way, or the
   *  list's budget is spent. */
  function enqueue(iLat, iLon, list, around, ask) {
    const key = keyOf(iLat, iLon);
    if (pending.has(key) || inFlight.has(key)) return;
    if (
      ground.cachedRealEllipsoidalGround(iLat / PER_DEG, iLon / PER_DEG) != null
    ) {
      // Fetched since it was read (another layer shares the cache): read
      // it again, and its neighbours if it is not at sea level.
      if (levels.get(key) === UNKNOWN) levels.delete(key);
      if (around) enqueueAround(iLat, iLon, list, ask);
      return;
    }
    const failedAt = failed.get(key);
    if (failedAt !== undefined && clock.now() - failedAt < MINUTE_MS) return;
    const budget = budgets.get(list) ?? 0;
    if (budget <= 0) return;
    budgets.set(list, budget - 1);
    pending.set(key, { iLat, iLon, list, around, ask });
  }

  /** Queue the cells around a fetched cell when it is not at sea level, for
   *  the ask that queued it, while that is still its list's ask. */
  function enqueueAround(iLat, iLon, list, ask) {
    if (asks.get(list) !== ask) return;
    const own = reading(iLat, iLon);
    if (!own || Math.abs(own.elevation) < INLAND_WATER_MIN_ELEVATION_M) return;
    for (const [dLat, dLon] of NEIGHBOURS)
      enqueue(iLat + dLat, wrapLon(iLon + dLon), list, false, ask);
  }

  /** How many cells of `list` wait for a batch. */
  function queued(list) {
    let n = 0;
    for (const c of pending.values()) if (c.list === list) n += 1;
    return n;
  }

  /** Move the backlogs' cells into the next batch, the trail's first. */
  function fill() {
    for (const list of BACKLOG_ORDER) {
      const backlog = backlogs.get(list);
      if (!backlog) continue;
      const { points } = backlog;
      const ask = asks.get(list);
      // Each list keeps up to a batch waiting, so the view's cells (and
      // their neighbours) never crowd out the trail's.
      let queuedNow = queued(list);
      while (
        queuedNow < cellsPerBatch &&
        backlog.next < points.length &&
        budgets.get(list) > 0
      ) {
        const p = points[backlog.next++];
        if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) continue;
        const before = pending.size;
        enqueue(
          Math.round(p.lat * PER_DEG),
          wrapLon(Math.round(p.lon * PER_DEG)),
          list,
          backlog.around,
          ask,
        );
        queuedNow += pending.size - before;
      }
      if (backlog.next >= points.length || !(budgets.get(list) > 0))
        backlogs.delete(list);
    }
  }

  /**
   * The cells of the next batch: the trail's first, then the view's, no
   * more than a batch or what the minute's budget has left. Waits for the
   * budget when it is spent.
   */
  function nextBatch() {
    const t = clock.now();
    while (sent.length && t - sent[0].at >= MINUTE_MS) sent.shift();
    let used = 0;
    for (const s of sent) used += s.cells;
    const room = Math.min(cellsPerBatch, cellsPerMinute - used);
    // No budget at all: nothing is ever fetched.
    if (room <= 0 && !sent.length) return null;
    if (room <= 0) {
      waiting = clock.setTimeout(
        () => {
          waiting = null;
          if (!running) runBatch();
        },
        MINUTE_MS - (t - sent[0].at) + 1,
      );
      return null;
    }
    const batch = [];
    for (const list of BACKLOG_ORDER)
      for (const entry of pending) {
        if (batch.length >= room) break;
        if (entry[1].list === list) batch.push(entry);
      }
    sent.push({ at: t, cells: batch.length });
    return batch;
  }

  function runBatch() {
    if (!pending.size || waiting) return;
    const batch = nextBatch();
    if (!batch?.length) return;
    const abort = new AbortController();
    for (const [key] of batch) {
      pending.delete(key);
      inFlight.set(key, abort);
    }
    const ran = generation;
    running = abort;
    const cells = batch.map(([, c]) => ({
      lat: c.iLat / PER_DEG,
      lon: c.iLon / PER_DEG,
    }));
    Promise.resolve()
      .then(() =>
        ground.resolveEllipsoidalGround(cells, { signal: abort.signal }),
      )
      .catch(() => {
        /* best-effort: unfetched cells keep their vessels where they are */
      })
      .then(() => {
        if (running === abort) running = null;
        // Only this batch's own entries: a later batch may fetch a key again.
        for (const [key] of batch)
          if (inFlight.get(key) === abort) inFlight.delete(key);
        // Cancelled meanwhile: what landed stays in the shared cache, and
        // nothing is moved for a layer that is off.
        if (ran !== generation) return;
        anyFetched = true;
        // A fetched cell changes its own level and its neighbours'; one off
        // sea level needs the cells around it next.
        const changed = new Set();
        const at = clock.now();
        for (const [key, c] of batch) {
          // Not answered (the service failed or left it out): rests a minute.
          if (
            ground.cachedRealEllipsoidalGround(
              c.iLat / PER_DEG,
              c.iLon / PER_DEG,
            ) == null
          ) {
            failed.set(key, at);
            continue;
          }
          failed.delete(key);
          changed.add(key);
          for (const [dLat, dLon] of NEIGHBOURS)
            changed.add(keyOf(c.iLat + dLat, wrapLon(c.iLon + dLon)));
          if (c.around) enqueueAround(c.iLat, c.iLon, c.list, c.ask);
        }
        for (const key of changed) levels.delete(key);
        try {
          onWarm(changed);
        } catch (error) {
          console.warn('[vessels] water level refresh failed', error);
        }
        fill();
        runBatch();
      });
  }

  /** Stop fetching: queued points and cells are dropped, a running batch
   *  is aborted and its answer moves nothing. Known levels stay. */
  function cancel() {
    generation += 1;
    backlogs.clear();
    budgets.clear();
    asks.clear();
    pending.clear();
    inFlight.clear();
    running?.abort();
    running = null;
    if (waiting) clock.clearTimeout(waiting);
    waiting = null;
  }

  /** Read every cell not known before again (the geoid it needed has
   *  loaded since). */
  function forgetUnknown() {
    for (const [key, value] of levels)
      if (value === UNKNOWN) levels.delete(key);
  }

  return {
    forgetUnknown,
    levelAt,
    ownLevelAt,
    cellKeyAt,
    warm,
    drop,
    cancel,
    available: Boolean(ground),
  };
}

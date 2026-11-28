/** Construct an instance-owned groundFloor service with explicit dependencies. */
export function createGroundFloor({ terrain, signal }) {
  const { cachedRealEllipsoidalGround, resolveEllipsoidalGround } = terrain;
  signal?.throwIfAborted();
  // The coarse floor keeps entity render heights above the local ellipsoidal surface.
  // Moving aircraft and long trails share a 3-decimal (~111 m) grid over terrainHeights.
  // Within a cell the error is bounded by local relief, sufficient for a visual floor.
  // Reads use the synchronous cache. warmGroundFloor batches misses through
  // resolveEllipsoidalGround (single-flight, fire-and-forget).

  /** @constant {number} Metres added above the resolved floor so a clamped
   *  billboard/waypoint sits ON the surface instead of z-fighting it. */
  const GROUND_FLOOR_LIFT_M = 1.5;
  /** Accepted rendered-mesh window around a real ellipsoidal DEM prior. */
  const MESH_FLOOR_BELOW_PRIOR_M = 15;
  const MESH_FLOOR_ABOVE_PRIOR_M = 80;

  /**
   * Snaps a coordinate to the coarse (3-decimal, ~111 m) floor grid.
   * @param {number} lat
   * @param {number} lon
   * @returns {{lat: number, lon: number}} Grid-cell coordinate.
   */
  function coarseFloorCoord(lat, lon) {
    return { lat: Number(lat.toFixed(3)), lon: Number(lon.toFixed(3)) };
  }

  /**
   * Pure floor clamp.
   *  - finite alt + finite ground → max(alt, ground + lift)
   *  - finite alt + unknown ground → alt (no data, no clamp)
   *  - null alt   + finite ground → ground + lift (the 'ground'-waypoint case:
   *    the point IS on the surface; put it there)
   *  - null alt   + unknown ground → null (caller applies its own fallback)
   * @param {number|null|undefined} altM - Proposed ellipsoidal render height.
   * @param {number|null|undefined} groundM - Local ellipsoidal ground, if known.
   * @param {number} [liftM] - Clearance above the floor.
   * @returns {number|null}
   */
  function floorAltitudeM(altM, groundM, liftM = GROUND_FLOOR_LIFT_M) {
    const hasAlt = Number.isFinite(altM);
    const hasGround = Number.isFinite(groundM);
    if (hasAlt && hasGround) return Math.max(altM, groundM + liftM);
    if (hasAlt) return altM;
    if (hasGround) return groundM + liftM;
    return null;
  }

  /**
   * Floor decision at the point of DISPLAY.
   *
   * `floorAltitudeM` above answers "what height should this FIX render at" and
   * runs once per poll. But what the user sees is the DEAD-RECKONED position:
   * a Cartesian interpolation between two fixes for the whole segment, and a
   * velocity extrapolation of the newest fix while a contact coasts through its
   * stale-feed grace. Both drift the rendered point horizontally away from the
   * fix whose cell supplied the height, so a contact drifting over a sloped apron can
   * render under the surface it is over.
   *
   * This is the same "never below the visible surface" rule applied at the
   * displayed coordinate instead of the fix coordinate. It returns `null` rather
   * than the unchanged height whenever nothing should move, so the per-frame
   * caller can skip rebuilding a Cartesian entirely — the common case by far.
   *
   * @param {number|null|undefined} displayHeightM - Ellipsoidal height the
   *   dead-reckoned display position currently carries.
   * @param {number|null|undefined} floorM - Ellipsoidal floor at the DISPLAYED
   *   coordinate (`cachedGroundFloor`), or null when that cell is not warm.
   * @param {number} [liftM] - Clearance above the floor.
   * @returns {number|null} The height to render at, or null for "leave it alone".
   */
  function displayFloorHeightM(
    displayHeightM,
    floorM,
    liftM = GROUND_FLOOR_LIFT_M,
  ) {
    if (!Number.isFinite(displayHeightM) || !Number.isFinite(floorM))
      return null;
    const lifted = floorM + liftM;
    return displayHeightM < lifted ? lifted : null;
  }

  /** @constant {number} Pitch of the coarse floor grid in degrees — the spacing
   *  `coarseFloorCoord` rounds to, and therefore the step between adjacent cells. */
  const FLOOR_CELL_DEG = 0.001;

  /** @constant {number} Resolved neighbours required before one may be borrowed.
   *  A single reading cannot be checked against anything: a hangar roof and an
   *  apron are both "a warm cell 111 m away", and there is no way to tell them
   *  apart from one number. Two readings at least agree or disagree. */
  const NEIGHBOR_FLOOR_MIN_SAMPLES = 2;

  /**
   * A floor for `cell` borrowed from the eight cells ADJACENT to it.
   *
   * Used only as a stand-in while `cell` itself is unresolved.
   *
   * Leans to the LOWEST resolved neighbour, and refuses to answer at all from
   * fewer than NEIGHBOR_FLOOR_MIN_SAMPLES of them.
   *
   * A low reading is inert because `displayFloorHeightM` only raises. A high reading can
   * place a contact on a neighbouring roof. On a slope the lowest neighbour under-reads
   * by up to one cell of grade, so the contact gets less lift until its own cell warms.
   *
   * @param {{lat: number, lon: number}|null|undefined} cell - Coarse cell.
   * @returns {number|null} Ellipsoidal floor, or null when too few neighbours are
   *   warm to borrow from.
   */
  function neighborFloorM(cell) {
    if (!Number.isFinite(cell?.lat) || !Number.isFinite(cell?.lon)) return null;
    let lowest = null;
    let resolved = 0;
    for (let dLat = -1; dLat <= 1; dLat += 1) {
      for (let dLon = -1; dLon <= 1; dLon += 1) {
        if (dLat === 0 && dLon === 0) continue;
        const h = cachedGroundFloor(
          cell.lat + dLat * FLOOR_CELL_DEG,
          cell.lon + dLon * FLOOR_CELL_DEG,
        );
        if (h == null) continue;
        resolved += 1;
        if (lowest == null || h < lowest) lowest = h;
      }
    }
    return resolved >= NEIGHBOR_FLOOR_MIN_SAMPLES ? lowest : null;
  }

  /** @constant {number} Cap on cells one corridor may contribute — a fast rollout
   *  or a spliced fix must not turn one contact into an unbounded warm batch.
   *  Sized for the worst realistic ground segment: a 27 m/s rollout coasts ~810 m
   *  (≈7 cells) in one poll interval, leaving headroom plus the endpoint slot. */
  const CORRIDOR_MAX_CELLS = 12;
  /** @constant {number} Step along a corridor leg when collecting cells (~14 m,
   *  an eighth of a cell). Half-cell steps were only cell-complete on LONG legs:
   *  a short leg rounds to a single step, so the walk degenerates to testing the
   *  leg's endpoints and a cell clipped between them is skipped. At this step any
   *  cell the path occupies for ~14 m of ground or more contains a sample — the
   *  guarantee this walk actually makes. The loop still exits the moment the cell
   *  budget fills, so a finer step costs iterations only on short corridors. */
  const CORRIDOR_WALK_STEP_DEG = 0.000125;
  /** @constant {number} Degrees added around a cell before a contact is allowed
   *  to adopt the next one (~22 m). A dead-reckoned position that jitters across
   *  a 0.001° edge would otherwise alternate floors at fleet-tick rate and pop
   *  the sprite between two heights. */
  const CELL_HYSTERESIS_DEG = 0.0002;

  /**
   * The floor cell a contact should read, with boundary hysteresis.
   *
   * Cells are 0.001° squares, so a display position sitting on an edge (parked
   * GPS jitter, the tracked reconciliation's decaying correction) flips between
   * two cells frame to frame — and their floors can differ by the local grade or,
   * next to a building, several metres. The contact keeps its previous cell until
   * it is CELL_HYSTERESIS_DEG clear of that cell's bounds, which costs two
   * comparisons and no allocation on the sticky path.
   *
   * @param {number} lat @param {number} lon - Displayed coordinate.
   * @param {{lat: number, lon: number}|null|undefined} previousCell - The cell
   *   this contact read last tick, if any.
   * @returns {{lat: number, lon: number}} The cell to read.
   */
  function stickyFloorCell(lat, lon, previousCell) {
    if (previousCell) {
      // The short way round, so a contact on the 180° seam keeps its cell.
      let dLon = lon - previousCell.lon;
      dLon -= 360 * Math.round(dLon / 360);
      if (
        Math.abs(lat - previousCell.lat) <= 0.0005 + CELL_HYSTERESIS_DEG &&
        Math.abs(dLon) <= 0.0005 + CELL_HYSTERESIS_DEG
      ) {
        return previousCell;
      }
    }
    return coarseFloorCoord(lat, lon);
  }

  /**
   * The coarse cells a contact's DISPLAY is about to walk through.
   *
   * The dead-reckoned display runs one render delay behind and advances toward
   * the newest fix, so the segment [display → newest fix] is exactly the ground
   * it will render over during the next poll or two. Warming only the cell it is
   * standing on warms the cell it is LEAVING: at 10 m/s a contact crosses a
   * ~111 m cell every ~11 s while the warm batch runs once per 30 s poll, so it
   * stays permanently ahead of its own floor data and the display clamp has
   * nothing to read (KAUS: sprites 2–4 m under the mesh with a cold cell for the
   * whole observation).
   *
   * Walks in half-cell steps so no cell between the ends is skipped. The step
   * COUNT follows the segment length (never a fixed cap — a capped count over a
   * long segment samples sparsely and leaves holes in the middle of ground the
   * contact does cross). Length is bounded instead, and honestly: the walk emits
   * a GAP-FREE PREFIX from `from`, and the destination cell always takes the last
   * slot. A corridor longer than CORRIDOR_MAX_CELLS is therefore truncated —
   * contiguous near ground plus the far endpoint — rather than thinned; the
   * ground in between is picked up on a later poll as the display advances into
   * it. Loop work stays bounded because the walk exits as soon as the cell budget
   * fills, whatever the segment length.
   *
   * Takes the display PATH as a polyline, not two endpoints: while the contact
   * is extrapolating, that path is an arc (the dead-reckon integrates a
   * constant-rate turn), and walking a straight chord between its ends would
   * warm ground the contact never crosses while its actual arc stayed cold.
   *
   * @param {Array<{lat: number, lon: number}>} points - Display path, current
   *   position first, destination last.
   * @returns {Array<{lat: number, lon: number}>} Deduped coarse cells, start
   *   first, destination last.
   */
  function corridorFloorCells(points) {
    if (!Array.isArray(points) || !points.length) return [];
    const first = points[0];
    if (!Number.isFinite(first?.lat) || !Number.isFinite(first?.lon)) return [];
    const start = coarseFloorCoord(first.lat, first.lon);
    const out = [start];
    const seen = new Set([`${start.lat},${start.lon}`]);
    let destination = null;
    for (let i = points.length - 1; i >= 1; i--) {
      if (Number.isFinite(points[i]?.lat) && Number.isFinite(points[i]?.lon)) {
        destination = coarseFloorCoord(points[i].lat, points[i].lon);
        break;
      }
    }
    if (!destination) return out;
    const destKey = `${destination.lat},${destination.lon}`;
    // One slot is reserved for the destination, appended after the prefix.
    const prefixLimit = CORRIDOR_MAX_CELLS - 1;
    walk: for (let s = 0; s < points.length - 1; s++) {
      const a = points[s];
      const b = points[s + 1];
      if (![a?.lat, a?.lon, b?.lat, b?.lon].every(Number.isFinite)) continue;
      // The short way round, so a segment across 180° walks across it.
      let dLon = b.lon - a.lon;
      dLon -= 360 * Math.round(dLon / 360);
      const steps = Math.ceil(
        Math.max(Math.abs(b.lat - a.lat), Math.abs(dLon)) /
          CORRIDOR_WALK_STEP_DEG,
      );
      for (let i = 1; i <= steps; i++) {
        if (out.length >= prefixLimit) break walk;
        const t = i / steps;
        let lon = a.lon + dLon * t;
        if (lon > 180) lon -= 360;
        else if (lon < -180) lon += 360;
        const cell = coarseFloorCoord(a.lat + (b.lat - a.lat) * t, lon);
        const key = `${cell.lat},${cell.lon}`;
        if (seen.has(key) || key === destKey) continue;
        seen.add(key);
        out.push(cell);
      }
    }
    if (!seen.has(destKey)) out.push(destination);
    return out;
  }

  /**
   * Shares one poll's corridor-cell budget across the contacts that need it.
   *
   * Three rules:
   *  1. Cells already collected are FREE — a parked contact, whose corridor is
   *     its own fix cell, never competes for budget at all.
   *  2. Candidates are ordered by how many of their cells are genuinely cold,
   *     then by speed (whoever leaves their floor behind soonest).
   *  3. Allocation runs in widening rounds — one cell each, then `fairShare`
   *     each, then the remainder — so no contact is left with NOTHING while
   *     another takes seconds. The nearest cell is the one a contact needs first
   *     anyway; the far end of its corridor can wait a poll.
   *
   * Equal-ranked runs rotate by `epoch` so ties cycle round-robin within a rank. Only
   * cold cells consume budget (`isWarm`). Warm cells are still emitted so the mesh
   * sampler sees them after their DEM prior lands. Every candidate is served within
   * `ceil(candidates / budget)` polls once warms land.
   *
   * @param {Array<{cells: Array<{lat: number, lon: number}>, cold: number, speedMps: number}>} candidates
   * @param {Set<string>} seen - Keys ("lat,lon") already collected; MUTATED with
   *   everything this call allocates, so the caller's dedupe stays consistent.
   * @param {number} budget - Max cold cells to charge for.
   * @param {number} fairShare - Per-candidate cap for the middle round.
   * @param {number} [epoch] - Poll counter; rotates equal-ranked runs.
   * @param {(cell: {lat: number, lon: number}) => boolean} [isWarm] - Whether a
   *   cell already has a floor (defaults to the shared cache).
   * @returns {Array<{lat: number, lon: number}>} Cells to add, allocation order.
   */
  function allocateCorridorCells(
    candidates,
    seen,
    budget,
    fairShare,
    epoch = 0,
    isWarm = (cell) => cachedGroundFloor(cell.lat, cell.lon) != null,
  ) {
    const out = [];
    if (!Array.isArray(candidates) || !candidates.length || !(budget > 0))
      return out;
    const ranked = [...candidates].sort(
      (a, b) => b.cold - a.cold || b.speedMps - a.speedMps,
    );
    if (Number.isFinite(epoch) && epoch !== 0) {
      for (let i = 0; i < ranked.length;) {
        let j = i + 1;
        while (
          j < ranked.length &&
          ranked[j].cold === ranked[i].cold &&
          ranked[j].speedMps === ranked[i].speedMps
        )
          j += 1;
        const runLength = j - i;
        if (runLength > 1) {
          const shift = ((epoch % runLength) + runLength) % runLength;
          const run = ranked.slice(i, j);
          for (let m = 0; m < runLength; m += 1)
            ranked[i + m] = run[(m + shift) % runLength];
        }
        i = j;
      }
    }
    // Cursor per candidate, carried ACROSS rounds: a later round resumes where
    // the previous one stopped instead of re-walking cells already handled.
    const cursor = new Array(ranked.length).fill(0);
    let left = budget;
    const round = (limit) => {
      for (let i = 0; i < ranked.length; i++) {
        const cells = ranked[i].cells || [];
        while (cursor[i] < cells.length && cursor[i] < limit) {
          const cell = cells[cursor[i]];
          const key = `${cell.lat},${cell.lon}`;
          if (seen.has(key)) {
            cursor[i] += 1;
            continue;
          } // already in this batch
          if (isWarm(cell)) {
            // Free: it has a floor already. Still emitted, so the mesh sampler
            // gets another look now that its DEM prior exists.
            cursor[i] += 1;
            seen.add(key);
            out.push(cell);
            continue;
          }
          if (left <= 0) return;
          cursor[i] += 1;
          seen.add(key);
          out.push(cell);
          left -= 1;
        }
      }
    };
    round(1); // nobody goes home empty-handed
    round(fairShare); // then a fair slice each
    round(CORRIDOR_MAX_CELLS); // then the remainder, neediest first
    return out;
  }

  // --- Mesh-floor cells ---
  // The visible photogrammetric mesh can sit above the bare-earth DEM. Use the nearest
  // validated mesh reading in the cell to keep contacts above the visible surface.
  // Slightly above is fine. The DEM provides the instant prior, fallback and sanity gate.
  /** @type {Map<string, Array<{lat: number, lon: number, h: number}>>}
   *  coarse cell key -> rendered-surface readings (m, ellipsoidal), each kept
   *  at the point it was probed. A read answers from the reading nearest the
   *  asked point, so a viaduct and the street beside it in one cell keep their
   *  own heights. */
  const _meshCells = new Map();
  /** @constant {number} Readings closer than this (degrees, about 5 m) are
   *  one spot: the lower one is kept there. */
  const MESH_READING_SAME_SPOT_DEG = 0.00005;
  /** @constant {number} Readings kept per cell. The sampler probes a cell at
   *  most eight times, but ground snaps report at each aircraft's position;
   *  past this many, a reading away from the others is not kept, so a busy
   *  apron cell stays a short list to scan. */
  const MESH_READINGS_PER_CELL = 16;
  /** @type {boolean} Whether mesh cells apply — true only in the google-3d
   *  regime (photoreal stack). On globe stacks the rendered surface IS the
   *  terrain provider (Re:Earth on keyless), so the DEM is already correct
   *  there and mesh heights would float. Kept current by meshFloorSampler's
   *  'gev:map-stack-changed' listener. Photoreal is the boot default. */
  let _meshPreferred = true;

  /** @param {boolean} preferred - google-3d regime active. */
  function setMeshFloorPreferred(preferred) {
    _meshPreferred = !!preferred;
  }

  /** @returns {boolean} Whether mesh-floor cells currently apply. */
  function meshFloorPreferred() {
    return _meshPreferred;
  }

  /**
   * Records a sampled rendered-surface height for the cell containing the
   * coordinate, unchecked, when the cell has no reading yet. The sampler goes
   * through `reportValidatedMeshFloorCell`, which keeps a reading per point.
   * @param {number} lat @param {number} lon @param {number} heightM
   */
  function reportMeshFloorCell(lat, lon, heightM) {
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !Number.isFinite(heightM)
    )
      return;
    const c = coarseFloorCoord(lat, lon);
    const key = `${c.lat},${c.lon}`;
    if (!_meshCells.has(key)) _meshCells.set(key, [{ lat, lon, h: heightM }]);
  }

  /** Return whether a rendered-mesh sample is plausible against a real DEM prior. */
  function meshFloorSampleWithinPrior(heightM, priorM) {
    return (
      Number.isFinite(heightM) &&
      Number.isFinite(priorM) &&
      heightM >= priorM - MESH_FLOOR_BELOW_PRIOR_M &&
      heightM <= priorM + MESH_FLOOR_ABOVE_PRIOR_M
    );
  }

  /**
   * Validate and record a rendered-mesh floor through the single shared gate.
   * Callers must not bypass this with raw `reportMeshFloorCell`: a coarse-LOD
   * or aircraft hit would otherwise poison every floor consumer in the cell.
   * The reading is kept at the point it was taken; a second reading at the
   * same spot (within about 5 m) keeps the lower of the two. A cell keeps at
   * most MESH_READINGS_PER_CELL readings.
   * @returns {boolean} Whether the sample passed and was reported.
   */
  function reportValidatedMeshFloorCell(lat, lon, heightM) {
    if (![lat, lon, heightM].every(Number.isFinite)) return false;
    const cell = coarseFloorCoord(lat, lon);
    const prior = cachedRealEllipsoidalGround(cell.lat, cell.lon);
    if (!meshFloorSampleWithinPrior(heightM, prior)) return false;
    const key = `${cell.lat},${cell.lon}`;
    const readings = _meshCells.get(key);
    if (!readings) {
      _meshCells.set(key, [{ lat, lon, h: heightM }]);
      return true;
    }
    const same = readings.find(
      (r) =>
        Math.abs(r.lat - lat) < MESH_READING_SAME_SPOT_DEG &&
        Math.abs(r.lon - lon) < MESH_READING_SAME_SPOT_DEG,
    );
    if (same) {
      if (heightM < same.h) same.h = heightM;
    } else if (readings.length < MESH_READINGS_PER_CELL) {
      readings.push({ lat, lon, h: heightM });
    }
    return true;
  }

  /**
   * Whether the cell holding the point has the real DEM prior that
   * `reportValidatedMeshFloorCell` judges a reading against.
   * @param {number} lat @param {number} lon
   * @returns {boolean}
   */
  function meshFloorPriorReady(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    const c = coarseFloorCoord(lat, lon);
    return cachedRealEllipsoidalGround(c.lat, c.lon) != null;
  }

  /**
   * Synchronous mesh-cell read — the cell's reading nearest the point, or
   * null when the cell is unsampled OR the google-3d regime is inactive (globe
   * stacks must floor on the DEM).
   * @param {number} lat @param {number} lon
   * @returns {number|null}
   */
  function cachedMeshFloor(lat, lon) {
    if (!_meshPreferred) return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const c = coarseFloorCoord(lat, lon);
    const readings = _meshCells.get(`${c.lat},${c.lon}`);
    if (!readings) return null;
    if (readings.length === 1) return readings[0].h;
    const k = Math.cos((lat * Math.PI) / 180) ** 2;
    let best = readings[0],
      bestD = Infinity;
    for (const r of readings) {
      const d = (r.lat - lat) ** 2 + k * (r.lon - lon) ** 2;
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best.h;
  }

  /** Test hook: clears mesh cells (never called at runtime — cells are valid all session). */
  function _clearMeshFloorCellsForTest() {
    _meshCells.clear();
  }

  /**
   * Synchronous coarse-cell ground read (warm cache only — never a fetch).
   * Prefers the RENDERED-surface mesh cell (google-3d regime) and falls back
   * to the Re:Earth DEM cell — the single choke point every ground-adjacent
   * consumer (fleet clamp, grounded surface chain, trail floors) reads, so
   * they all agree on one surface.
   * @param {number} lat
   * @param {number} lon
   * @returns {number|null} Ellipsoidal floor of the cell, or null if not warm.
   */
  function cachedGroundFloor(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const mesh = cachedMeshFloor(lat, lon);
    if (mesh != null) return mesh;
    const c = coarseFloorCoord(lat, lon);
    return cachedRealEllipsoidalGround(c.lat, c.lon);
  }

  /**
   * Awaitable variant for one-shot consumers (trail backfills): dedupes the
   * points to unique coarse cells and resolves them, so `cachedGroundFloor`
   * reads immediately after are warm. The underlying resolver chunks (≤200/req)
   * and falls back per-point, so any trace length is safe. Never throws.
   * @param {Array<{lat: number, lon: number}>} points
   * @returns {Promise<void>}
   */
  /** @constant {number} Max ms a one-shot consumer (trail backfill) waits for
   *  the floor resolve before painting. An unbounded wait would hold trail
   *  paints on cold lookups.
   *  The resolve keeps running past the deadline and lands in the cache for
   *  the next paint/select. */
  const FLOOR_RESOLVE_DEADLINE_MS = 1200;

  /**
   * Bounded-latency variant of resolveGroundFloorCells: waits at most
   * FLOOR_RESOLVE_DEADLINE_MS, then returns so the caller can paint with the
   * cells that ARE warm. The underlying resolve continues in the background
   * and fills the cache for later reads. Never throws.
   * @param {Array<{lat: number, lon: number}>} points
   * @returns {Promise<void>}
   */
  function resolveGroundFloorCellsBounded(points) {
    return Promise.race([
      resolveGroundFloorCells(points),
      new Promise((resolve) => setTimeout(resolve, FLOOR_RESOLVE_DEADLINE_MS)),
    ]);
  }

  async function resolveGroundFloorCells(
    points,
    { signal: consumerSignal } = {},
  ) {
    if (!Array.isArray(points) || !points.length) return;
    const cells = new Map();
    for (const p of points) {
      if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) continue;
      const c = coarseFloorCoord(p.lat, p.lon);
      const key = `${c.lat},${c.lon}`;
      if (cells.has(key)) continue;
      if (cachedRealEllipsoidalGround(c.lat, c.lon) != null) continue;
      cells.set(key, c);
    }
    if (!cells.size) return;
    try {
      await resolveEllipsoidalGround([...cells.values()], {
        signal: consumerSignal,
      });
    } catch {
      /* best-effort — unresolved cells simply don't clamp */
    }
  }

  /** @type {boolean} Single-flight guard for the warm batch. */
  let _floorBatchInFlight = false;
  /** @type {Map<string, {lat: number, lon: number}>} Cells requested while a
   *  batch was in flight are flushed as the next batch when it completes,
   *  so contending calls queue instead of being dropped. */
  const _pendingFloorCells = new Map();

  /** Kicks the resolver for a cell map, chaining any cells queued meanwhile. */
  function _resolveFloorCells(cells) {
    _floorBatchInFlight = true;
    resolveEllipsoidalGround([...cells.values()])
      .catch(() => {
        /* best-effort — unclamped this tick, floor lands later */
      })
      .finally(() => {
        _floorBatchInFlight = false;
        if (!signal?.aborted && _pendingFloorCells.size) {
          const next = new Map(_pendingFloorCells);
          _pendingFloorCells.clear();
          _resolveFloorCells(next);
        }
      });
  }

  /**
   * Fire-and-forget batch warm of the coarse floor cells for the given points.
   * Dedupes to unique cells, skips already-warm ones, and never blocks or
   * throws into the caller. Contending calls QUEUE (never drop): their cells
   * ride the next batch as soon as the in-flight one completes. Results are
   * picked up by later `cachedGroundFloor` reads.
   * @param {Array<{lat: number, lon: number}>} points
   */
  function warmGroundFloor(points) {
    if (signal?.aborted) return;
    if (!Array.isArray(points) || !points.length) return;
    const cells = new Map();
    for (const p of points) {
      if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) continue;
      const c = coarseFloorCoord(p.lat, p.lon);
      const key = `${c.lat},${c.lon}`;
      if (cells.has(key) || _pendingFloorCells.has(key)) continue;
      if (cachedRealEllipsoidalGround(c.lat, c.lon) != null) continue; // already warm
      cells.set(key, c);
    }
    if (!cells.size) return;
    if (_floorBatchInFlight) {
      for (const [key, c] of cells) _pendingFloorCells.set(key, c);
      return;
    }
    _resolveFloorCells(cells);
  }

  signal?.addEventListener(
    'abort',
    () => {
      _meshCells.clear();
      _pendingFloorCells.clear();
    },
    { once: true },
  );
  return {
    GROUND_FLOOR_LIFT_M,
    MESH_FLOOR_BELOW_PRIOR_M,
    MESH_FLOOR_ABOVE_PRIOR_M,
    coarseFloorCoord,
    floorAltitudeM,
    displayFloorHeightM,
    FLOOR_CELL_DEG,
    NEIGHBOR_FLOOR_MIN_SAMPLES,
    neighborFloorM,
    CORRIDOR_MAX_CELLS,
    CORRIDOR_WALK_STEP_DEG,
    CELL_HYSTERESIS_DEG,
    stickyFloorCell,
    corridorFloorCells,
    allocateCorridorCells,
    setMeshFloorPreferred,
    meshFloorPreferred,
    reportMeshFloorCell,
    meshFloorSampleWithinPrior,
    reportValidatedMeshFloorCell,
    meshFloorPriorReady,
    cachedMeshFloor,
    _clearMeshFloorCellsForTest,
    cachedGroundFloor,
    FLOOR_RESOLVE_DEADLINE_MS,
    resolveGroundFloorCellsBounded,
    resolveGroundFloorCells,
    warmGroundFloor,
  };
}

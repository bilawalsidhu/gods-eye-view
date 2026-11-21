import {
  fromDegrees,
  fromDegreesInto,
  toLonLatH,
} from '../../geo/ellipsoid.js';
import { distance } from '../../geo/vector.js';
import { heightsOf } from '../../queries/heights.js';
import { findCamera, findFrame, findGlobe } from '../../render/rendererOf.js';
import { vesselViewArea } from './cameraArea.js';
import {
  TRAIL_HEIGHT_M,
  TRAIL_COLOR,
  TRAIL_HEAD_MAX_M,
  TRAIL_MAX_POINTS,
  TRAIL_MIN_MOVE_M,
  VESSEL_LIFT_M,
  WATER_SURFACE_AHEAD_MAX_M,
  WATER_SURFACE_AHEAD_S,
  WATER_SURFACE_MAX_CAMERA_HEIGHT_M,
  WATER_SURFACE_MAX_CELLS_PER_POLL,
  WATER_SURFACE_MAX_RADIUS_KM,
  WATER_SURFACE_MAX_VESSELS,
  WATER_SURFACE_MIN_RADIUS_KM,
  WATER_SURFACE_RADIUS_PER_HEIGHT,
  WATER_SURFACE_STAND_IN_M,
  WATER_SURFACE_TRAIL_CELLS,
  followsClock,
} from './policy.js';
import { createWaterSurface } from './waterSurface.js';
import { KNOT_MPS } from '../../data/units.js';

/**
 * Each entry's value, or for an undefined one the nearest defined one's (by
 * index; the earlier one on a tie); undefined where none is defined.
 * @template T
 * @param {Array<T|undefined>} values
 * @returns {Array<T|undefined>}
 */
export function nearestKnown(values) {
  const out = values.slice();
  const gap = values.map(() => Infinity);
  let last = -1;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] !== undefined) last = i;
    else if (last >= 0) {
      out[i] = values[last];
      gap[i] = i - last;
    }
  }
  last = -1;
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] !== undefined) last = i;
    else if (last >= 0 && last - i < gap[i]) out[i] = values[last];
  }
  return out;
}

/**
 * At most `count` of `items`, spread evenly from the first to the last.
 * @template T
 * @param {T[]} items
 * @param {number} count
 * @returns {T[]}
 */
export function spread(items, count) {
  if (items.length <= count) return items;
  if (count <= 1) return items.slice(0, Math.max(0, count));
  const out = [];
  for (let i = 0; i < count; i += 1)
    out.push(items[Math.round((i * (items.length - 1)) / (count - 1))]);
  return out;
}

/** A vessel record's own fix time, epoch ms (NaN when it gives none). */
function recordFixMs(record) {
  const epoch = record?.lastPositionEpoch;
  if (Number.isFinite(epoch)) return epoch * 1000;
  return Number.isFinite(record?.receivedAtMs) ? record.receivedAtMs : NaN;
}

export function createTracking({
  vesselState,
  services,
  parts: components,
  layer,
  options,
}) {
  const { state } = vesselState;
  const { geoidHeight } = services.geoid;
  const { createTrail } = services.trails;
  const { governorRequestRender } = services.render;

  /**
   * Geoid undulation N at (lat, lon), or null until the grid has loaded.
   * @param {number} lat
   * @param {number} lon
   * @returns {number|null}
   */

  function currentGeoidN(lat, lon) {
    return vesselState._geoidReady ? geoidHeight(lat, lon) : null;
  }

  // Lakes and rivers are drawn at their own level, not at sea level: the
  // terrain's level under each vessel (services.ground, when the application
  // supplies it) wherever it is clearly not the sea.
  const water = createWaterSurface({
    ground: services.ground ?? null,
    geoidAt: currentGeoidN,
    onWarm: (cells) => {
      // Batches cancelled with the layer never land here; one that lands
      // while the layer is off moves nothing.
      if (state.feed && !state.feed.enabled) return;
      refloorVesselRecords(cells);
      reliftTrail(cells);
    },
  });

  /** Each vessel's inland level as last read, and where: it stands in while
   *  the vessel is drawn over cells not fetched yet (between polls it moves
   *  on along its track), within WATER_SURFACE_STAND_IN_M of there. */
  const lastLevels = new WeakMap();

  /** The level last read for the vessel, if it was read near (lat, lon). */
  function standInLevel(record, lat, lon) {
    const last = record ? lastLevels.get(record) : undefined;
    if (!last) return undefined;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const metres = Math.hypot(
      (lat - last.lat) * 111_320,
      (lon - last.lon) * 111_320 * cosLat,
    );
    return metres <= WATER_SURFACE_STAND_IN_M ? last.level : undefined;
  }

  // Whether the shown globe is the bare ellipsoid: its terrain did not load
  // (the terrain service is down, or the install has none), so it draws the
  // sea and every lake at height 0, and vessels are drawn there too. Asked of
  // the height service once per surface (as transit asks), never per vessel.
  let flatGlobe = false;
  let flatAskedFor = null;
  let unwatchGlobe = null;
  let watchedViewer = null;

  function checkFlatGlobe() {
    const viewer = watchedViewer ?? state.viewer;
    const globe = viewer ? findGlobe(viewer) : null;
    if (!globe || globe.isGlobeVisible?.() !== true) {
      // Hidden (the photoreal stack draws its own sea and lakes) or none.
      flatAskedFor = null;
      setFlatGlobe(false);
      return;
    }
    const version = globe.surfaceVersion?.() ?? 0;
    if (version === flatAskedFor) return;
    flatAskedFor = version;
    const pose = findCamera(viewer)?.pose();
    const point = {
      lat: Number.isFinite(pose?.lat) ? pose.lat : 0,
      lon: Number.isFinite(pose?.lon) ? pose.lon : 0,
    };
    const heights = heightsOf(viewer);
    Promise.all([
      heights.batch([point], { against: 'terrain' }),
      heights.batch([point], { against: 'terrain', ellipsoidMisses: true }),
    ]).then(
      ([[answered], [terrain]]) => {
        if (flatAskedFor !== version) return;
        // Answered, but only by the ellipsoid: no terrain is drawn.
        setFlatGlobe(answered !== null && terrain === null);
      },
      () => {
        // Asked again at the next check.
        if (flatAskedFor === version) flatAskedFor = null;
      },
    );
  }

  function setFlatGlobe(flat) {
    if (flat === flatGlobe) return;
    flatGlobe = flat;
    refloorVesselRecords();
    reliftTrail(null);
    // Terrain is back: the water under the vessels in view, now.
    if (!flat) warmWaterSurface({ checkGlobe: false });
  }

  /**
   * Follow what the viewer's globe draws (checked again as it loads and
   * when its surface changes) while the layer is on.
   * @param {object} viewer
   */
  function watchSurface(viewer) {
    unwatchSurface();
    watchedViewer = viewer ?? null;
    const off = viewer
      ? findGlobe(viewer)?.on?.('progress', checkFlatGlobe)
      : null;
    unwatchGlobe = typeof off === 'function' ? off : null;
    checkFlatGlobe();
  }

  /** Stop following the globe and stop fetching water levels (the layer is
   *  off). Levels already known stay for when it is on again. */
  function unwatchSurface() {
    unwatchGlobe?.();
    unwatchGlobe = null;
    watchedViewer = null;
    flatAskedFor = null;
    // Asked again of the next globe the layer is on over.
    flatGlobe = false;
    water.cancel();
  }

  /**
   * Ellipsoidal height (m) of the water surface at (lat, lon): 0 on a flat
   * globe; an inland water level where the terrain shows one; else the sea
   * (the geoid), or null while the geoid grid loads. With `record`, where
   * the terrain there is not fetched yet, the level last read for that
   * vessel stands in, so a vessel drawn along its track between polls stays
   * on its lake or river.
   * @param {number} lat
   * @param {number} lon
   * @param {Object|null} [record] - The vessel drawn there.
   * @param {boolean} [remember] - Keep the level read as its stand-in.
   * @returns {number|null}
   */
  function currentWaterSurfaceM(lat, lon, record = null, remember = true) {
    if (flatGlobe) return 0;
    const level = water.levelAt(lat, lon);
    if (typeof level === 'number') {
      if (record && remember) {
        // Kept in place: this runs for every vessel drawn, several times a
        // second.
        const last = lastLevels.get(record);
        if (last) {
          last.level = level;
          last.lat = lat;
          last.lon = lon;
        } else lastLevels.set(record, { level, lat, lon });
      }
      return level;
    }
    if (level === null) {
      if (record && remember) lastLevels.delete(record);
      return currentGeoidN(lat, lon);
    }
    return standInLevel(record, lat, lon) ?? currentGeoidN(lat, lon);
  }

  /**
   * The water surface at (lat, lon) for `record` as currentWaterSurfaceM
   * gives it, without moving the level kept for it (a reader that is not
   * drawing it, such as the bridge).
   * @param {number} lat
   * @param {number} lon
   * @param {Object|null} record
   * @returns {number|null}
   */
  function peekWaterSurfaceM(lat, lon, record) {
    return currentWaterSurfaceM(lat, lon, record, false);
  }

  /**
   * Build a slightly lifted trail vertex for a vessel record — raised
   * TRAIL_HEIGHT_M above the water surface (same datum as the anchor) to
   * avoid z-fighting.
   * @param {Object} record - Vessel record with lat/lon.
   * @returns {{x: number, y: number, z: number}|null} Lifted ECEF position, or null without a fix.
   */

  function vesselTrailPosition(record) {
    if (!Number.isFinite(record?.lat) || !Number.isFinite(record?.lon))
      return null;
    const heightM = components.queries.vesselDatumHeightM(
      currentWaterSurfaceM(record.lat, record.lon, record),
      TRAIL_HEIGHT_M,
    );
    return fromDegrees(record.lon, record.lat, heightM);
  }

  /** Where a moving vessel will be about WATER_SURFACE_AHEAD_S after its
   *  fix, on its course; null for one not under way. */
  function aheadOf(record) {
    const speedKn = record.speed;
    const courseDeg = record.course;
    if (!(speedKn > 0.5) || !Number.isFinite(courseDeg)) return null;
    const metres = Math.min(
      speedKn * KNOT_MPS * WATER_SURFACE_AHEAD_S,
      WATER_SURFACE_AHEAD_MAX_M,
    );
    const course = (courseDeg * Math.PI) / 180;
    const cosLat = Math.max(0.01, Math.cos((record.lat * Math.PI) / 180));
    return {
      lat: record.lat + (metres * Math.cos(course)) / 111_320,
      lon: record.lon + (metres * Math.sin(course)) / (111_320 * cosLat),
    };
  }

  /**
   * Ask the terrain for the water level under the vessels in view, nearest
   * the middle of the view first (at most WATER_SURFACE_MAX_VESSELS, within
   * a radius that grows with the camera's height), while the camera is low
   * enough to see it: where each is reported, where it is drawn, and where it
   * is heading. Called after each poll; the vessels move onto it as it
   * arrives.
   * @param {{checkGlobe?: boolean}} [options]
   */
  function warmWaterSurface({ checkGlobe = true } = {}) {
    if (!state.viewer) return;
    if (checkGlobe) checkFlatGlobe();
    // A flat globe draws every water at 0: no terrain to ask for.
    if (!water.available || flatGlobe) return;
    const height = findCamera(state.viewer)?.pose()?.height;
    if (!(height <= WATER_SURFACE_MAX_CAMERA_HEIGHT_M)) {
      water.drop('view');
      return;
    }
    const area = vesselViewArea(state.viewer);
    if (!area) return;
    const radiusKm = Math.min(
      WATER_SURFACE_MAX_RADIUS_KM,
      Math.max(
        area.radiusKm,
        WATER_SURFACE_MIN_RADIUS_KM,
        (height / 1000) * WATER_SURFACE_RADIUS_PER_HEIGHT,
      ),
    );
    const cosLat = Math.cos((area.lat * Math.PI) / 180);
    const near = [];
    for (const record of state.records.all) {
      if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon))
        continue;
      let dLon = record.lon - area.lon;
      dLon -= 360 * Math.round(dLon / 360);
      const km = Math.hypot(
        (record.lat - area.lat) * 111.32,
        dLon * 111.32 * cosLat,
      );
      if (km <= radiusKm) near.push({ km, record });
    }
    near.sort((a, b) => a.km - b.km);
    const points = [];
    for (const { record } of near.slice(0, WATER_SURFACE_MAX_VESSELS)) {
      points.push(record);
      const visual = components.rendering.getVisual(record);
      if (
        Number.isFinite(visual?.drawnLat) &&
        Number.isFinite(visual?.drawnLon)
      )
        points.push({ lat: visual.drawnLat, lon: visual.drawnLon });
      const ahead = aheadOf(record);
      if (ahead) points.push(ahead);
    }
    water.warm(points, { maxCells: WATER_SURFACE_MAX_CELLS_PER_POLL });
  }

  /**
   * Datum re-lift: re-derive records' positions in place so chevrons, labels
   * and models snap to the water surface as soon as it is known, rather than
   * at the next refresh (up to REFRESH_MS out). Every record when the geoid
   * grid warms mid-session (the first refresh can land before
   * ensureGeoidReady() resolves, anchors at N = 0; a selected-vessel trail
   * cannot exist that early, as selection needs a rendered pick) or the
   * globe's surface changes; only the records drawn in `cells` when terrain
   * cells arrive.
   * @param {Set<number>|null} [cells] - Cell keys (`water.cellKeyAt`) whose
   *   level changed; null for every record.
   */

  function refloorVesselRecords(cells = null) {
    if (!cells) water.forgetUnknown();
    if (!state.records.all.length) return;
    let moved = 0;
    for (const record of state.records.all) {
      const visual = components.rendering.getVisual(record);
      if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon))
        continue;
      if (cells) {
        const drawn = visual.position ? toLonLatH(visual.position) : null;
        const key = water.cellKeyAt(
          drawn ? drawn.lat : record.lat,
          drawn ? drawn.lon : record.lon,
        );
        if (!cells.has(key)) continue;
      }
      moved += 1;
      visual.position = components.rendering.anchorPosition(record);
      // A ship model stands on the waterline: written in place, since its
      // model item holds it.
      const at = visual.waterline ? toLonLatH(visual.position) : null;
      if (at)
        fromDegreesInto(
          at.lon,
          at.lat,
          at.height - VESSEL_LIFT_M,
          visual.waterline,
        );
      components.rendering.syncRecordIcon(record);
      // A moving vessel is drawn again where it is on the next pass.
      visual.drawnLat = NaN;
      visual.drawnLon = NaN;
      visual.followedAtMs = undefined;
      visual.drawnAtMs = Number.NaN;
    }
    if (cells && !moved) return;
    components.rendering.forgetClockStep();
    // The rows moved with no poll behind them: draw the frame that shows it.
    governorRequestRender('ais-vessels-refloor');
  }

  /**
   * Heights (m) for trail vertices at `points`: each on its water where its
   * cell is known (its own cell alone will do), else on the water of the
   * nearest vertex along the trail that is known (a track runs from one
   * water to the next), else on the selected vessel's last level.
   * @param {Array<{lat: number, lon: number}|null>} points
   * @returns {number[]}
   */
  function trailHeightsM(points) {
    const lift = (surfaceM) =>
      components.queries.vesselDatumHeightM(surfaceM, TRAIL_HEIGHT_M);
    if (flatGlobe) return points.map(() => lift(0));
    const known = points.map((pt) => {
      if (!pt) return undefined;
      const level = water.levelAt(pt.lat, pt.lon);
      return level !== undefined ? level : water.ownLevelAt(pt.lat, pt.lon);
    });
    const filled = nearestKnown(known);
    const record = state.selectedRecord;
    const standIn = record ? lastLevels.get(record)?.level : undefined;
    return points.map((pt, i) => {
      if (!pt) return NaN;
      const level = filled[i];
      if (typeof level === 'number') return lift(level);
      if (level === null) return lift(currentGeoidN(pt.lat, pt.lon));
      return lift(standIn ?? currentGeoidN(pt.lat, pt.lon));
    });
  }

  /**
   * Lift the trail's vertices in `cells` onto the water surface now known
   * there (each vertex keeps its place, only its height changes).
   * @param {Set<number>|null} cells - Cell keys whose level changed; null
   *   for every vertex (the globe's surface changed).
   */
  function reliftTrail(cells) {
    if (!state.trail || !state.trailPositions.length) return;
    const positions = state.trailPositions;
    const points = positions.map((position) => toLonLatH(position));
    if (
      cells &&
      !points.some((pt) => pt && cells.has(water.cellKeyAt(pt.lat, pt.lon)))
    )
      return;
    const heights = trailHeightsM(points);
    let lifted = false;
    for (let i = 0; i < positions.length; i += 1) {
      const pt = points[i];
      if (!pt || Math.abs(heights[i] - pt.height) < 0.01) continue;
      lifted = true;
      positions[i] = fromDegrees(pt.lon, pt.lat, heights[i]);
    }
    if (!lifted) return;
    drawTrailBody();
    governorRequestRender('ais-vessels-refloor');
  }

  /**
   * Start (or restart) the selected vessel's trail: seed with the current
   * position, render, then fire-and-forget the server ring-buffer backfill.
   * @param {Object} record - Freshly selected vessel record.
   */

  function startSelectedVesselTrail(record) {
    state.trailAbort?.abort();
    state.trailAbort = new AbortController();
    state.trailBackfillToken += 1;
    state.trailId = record.id;
    state.trailPositions = [];
    state.trailTimes = [];
    const current = vesselTrailPosition(record);
    if (current) {
      state.trailPositions.push(current);
      state.trailTimes.push(recordFixMs(record));
    }
    if (!state.trail && state.viewer) {
      state.trail = createTrail(state.viewer, {
        color: TRAIL_COLOR,
        width: 2.5,
      });
    }
    if (!state.trailHeadOff && state.viewer)
      state.trailHeadOff =
        findFrame(state.viewer)?.on('preRender', drawSelectedVesselTrail) ??
        null;
    drawTrailBody();
    backfillVesselTrail(record.id, state.trailBackfillToken, record.reference);
  }

  /**
   * The world clock moved to another time: the trail keeps what it holds,
   * drawn up to the new time, until the vessel's track at that time
   * replaces it. Clearing it would blank the trail at every step of the clock.
   * @param {Object} record - The selected vessel at the new time.
   */
  function retimeSelectedVesselTrail(record) {
    if (state.trailId !== record.id || !state.trail) {
      startSelectedVesselTrail(record);
      return;
    }
    state.trailAbort?.abort();
    state.trailAbort = new AbortController();
    state.trailBackfillToken += 1;
    drawSelectedVesselTrail();
    backfillVesselTrail(record.id, state.trailBackfillToken, record.reference, {
      replace: true,
    });
  }

  /** The world time the selected vessel is drawn at; Infinity live, where
   *  every fix is behind it. */
  function drawnTimeMs() {
    return followsClock(vesselState) ? vesselState.worldNow() : Infinity;
  }

  /** How many trail vertices are at or before `atMs` (undated ones always). */
  function bodyCountAt(atMs) {
    let count = state.trailTimes.length;
    while (count > 0 && state.trailTimes[count - 1] > atMs) count -= 1;
    return count;
  }

  /** Draw the trail's body: its fixes up to the time the vessel is drawn at.
   *  A fix ahead of the vessel would draw the trail in front of it. */
  function drawTrailBody() {
    if (!state.trail) return;
    state.trailBodyCount = bodyCountAt(drawnTimeMs());
    state.trail.setPositions(
      state.trailPositions.slice(0, state.trailBodyCount),
    );
  }

  /** The head: the body's last vertex to where the vessel is drawn, or none
   *  (no vessel drawn, or one too far from the body to be on its path). */
  function trailHeadPositions() {
    const record = state.selectedRecord;
    if (!record || record.id !== state.trailId || state.trailBodyCount < 1)
      return null;
    // Where its icon is drawn now (the renderer's, while it moves the icons).
    const at = components.rendering.drawnPositionNow(record);
    const last = state.trailPositions[state.trailBodyCount - 1];
    if (!at || !last) return null;
    const metres = distance(last, at);
    if (metres < 1 || metres > TRAIL_HEAD_MAX_M) return null;
    return [last, { x: at.x, y: at.y, z: at.z }];
  }

  /**
   * Each frame before it draws: the body moved on when the drawn time has
   * passed a fix, then the head to where the vessel is drawn now.
   */
  function drawSelectedVesselTrail() {
    if (!state.trail || !state.trailId) return;
    if (bodyCountAt(drawnTimeMs()) !== state.trailBodyCount) drawTrailBody();
    state.trail.setHead?.(trailHeadPositions());
  }

  /**
   * Fire-and-forget backfill from the server-side per-vessel ring buffer
   * (PRD F3 — "recent path" since server boot, not voyage history). Older
   * samples are spliced AHEAD of the live accumulation, capped at
   * TRAIL_MAX_POINTS (newest kept). Any failure (404/timeout/malformed)
   * silently keeps the live-only trail.
   * @param {string} id - Key of the selected vessel.
   * @param {number} token - Backfill token captured at request time.
   * @returns {Promise<void>}
   */

  async function backfillVesselTrail(
    id,
    token,
    reference = id,
    { replace = false } = {},
  ) {
    const owner = state.trailAbort;
    // Following the world clock, the track ends at the world's time.
    const atMs = followsClock(vesselState) ? vesselState.worldNow() : undefined;
    const signal = owner
      ? AbortSignal.any([owner.signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000);
    let samples = null;
    try {
      const track = await vesselState._source.getTrack?.(
        reference,
        atMs === undefined ? { signal } : { signal, atMs },
      );
      samples = track?.records ?? null;
    } catch {
      return; // silent — keep the live-accumulated trail
    }
    if (
      signal.aborted ||
      owner !== state.trailAbort ||
      !samples ||
      token !== state.trailBackfillToken
    )
      return;
    if (state.trailId !== id) return;

    const older = [];
    const olderTimes = [];
    const sampled = [];
    for (const sample of samples) {
      const lat = Number(sample?.latitude);
      const lon = Number(sample?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      // Following the clock, an undated sample may be later than the time.
      if (
        atMs !== undefined &&
        !(Number.isFinite(sample?.observedAtMs) && sample.observedAtMs <= atMs)
      )
        continue;
      sampled.push({ lat, lon });
      olderTimes.push(
        Number.isFinite(sample?.observedAtMs) ? sample.observedAtMs : NaN,
      );
    }
    // Same datum as the live vertices, so the spliced trail is
    // height-continuous; a sample whose water is not known yet takes the
    // nearest known one's along the trail.
    const heights = trailHeightsM(sampled);
    sampled.forEach(({ lat, lon }, i) =>
      older.push(fromDegrees(lon, lat, heights[i])),
    );
    if (replace) {
      // The track at the new time, then the vessel's own fix at it.
      const record = state.selectedRecord;
      const current = record?.id === id ? vesselTrailPosition(record) : null;
      state.trailPositions = current ? [...older, current] : older;
      state.trailTimes = current
        ? [...olderTimes, recordFixMs(record)]
        : olderTimes;
    } else {
      if (!older.length) return;
      state.trailPositions = older.concat(state.trailPositions);
      state.trailTimes = olderTimes.concat(state.trailTimes);
    }
    if (state.trailPositions.length > TRAIL_MAX_POINTS) {
      const drop = state.trailPositions.length - TRAIL_MAX_POINTS;
      state.trailPositions = state.trailPositions.slice(drop);
      state.trailTimes = state.trailTimes.slice(drop);
    }
    drawTrailBody();
    // Its samples' own water levels, spread along the whole trail, newest
    // first; the trail is lifted onto them as they arrive (reliftTrail).
    water.warm(spread(sampled.reverse(), WATER_SURFACE_TRAIL_CELLS), {
      list: 'trail',
      around: false,
      maxCells: WATER_SURFACE_TRAIL_CELLS,
    });
  }

  /**
   * Append the selected vessel's refreshed position to its trail when it has
   * moved more than TRAIL_MIN_MOVE_M from the last trail vertex.
   * @param {Object} record - Selected vessel record after an in-place update.
   */

  function appendSelectedVesselTrailFix(record) {
    if (!state.trail) return;
    const next = vesselTrailPosition(record);
    if (!next) return;
    const last = state.trailPositions[state.trailPositions.length - 1];
    if (last && distance(last, next) <= TRAIL_MIN_MOVE_M) return;
    state.trailPositions.push(next);
    state.trailTimes.push(recordFixMs(record));
    if (state.trailPositions.length > TRAIL_MAX_POINTS) {
      state.trailPositions.shift();
      state.trailTimes.shift();
    }
    drawTrailBody();
  }

  /**
   * Clear the rendered trail and accumulation; invalidate pending backfills.
   */

  function clearSelectedVesselTrail() {
    // Its samples' water is no longer wanted.
    water.drop('trail');
    state.trailAbort?.abort();
    state.trailAbort = null;
    state.trailBackfillToken += 1;
    state.trailId = null;
    state.trailPositions = [];
    state.trailTimes = [];
    state.trailBodyCount = -1;
    state.trailHeadOff?.();
    state.trailHeadOff = null;
    if (state.trail) state.trail.clear();
  }

  /**
   * Destroy the trail primitive entirely (layer disable/teardown).
   */

  function destroySelectedVesselTrail() {
    clearSelectedVesselTrail();
    if (state.trail) {
      state.trail.destroy();
      state.trail = null;
    }
  }
  return {
    currentGeoidN,
    currentWaterSurfaceM,
    peekWaterSurfaceM,
    watchSurface,
    unwatchSurface,
    warmWaterSurface,
    vesselTrailPosition,
    refloorVesselRecords,
    startSelectedVesselTrail,
    retimeSelectedVesselTrail,
    drawSelectedVesselTrail,
    backfillVesselTrail,
    appendSelectedVesselTrailFix,
    clearSelectedVesselTrail,
    destroySelectedVesselTrail,
  };
}

import { pointAtS, projectOnPath } from '../../data/railPaths.js';

/**
 * Binding a train to its railway line and moving it along that line.
 *
 * A train is bound to one shape of its feed's path pack: the shape its trip
 * names, else the route's shape its report lies on. Every later report is
 * projected onto that shape near the arc the train was last seen at, so a
 * report can never snap to the far side of a loop or to a parallel branch.
 * A report that lands well off the line means the binding was wrong (a
 * diversion, a short-turn shape, a mismatched trip): the train is moved to
 * another of its route's shapes if one fits, else it is unbound and drawn
 * with straight-line motion again.
 *
 * Between two reports the marker moves by arc length: both reports are
 * projected onto the shape once per playback segment, and each frame only
 * interpolates the arc and looks up the point.
 *
 * Pure: no Cesium, no DOM.
 */

/** A report farther than this from the bound line unbinds the train (m). */
export const PATH_OFF_TRACK_M = 150;
/** Fastest train the search window allows for (m/s, about 250 km/h). */
const PATH_MAX_SPEED_MPS = 70;
/** Window slack for report jitter and clock error (m). */
const PATH_WINDOW_SLACK_M = 300;
/** Widest hinted search; beyond it the whole shape is searched (m). */
const PATH_WINDOW_MAX_M = 50_000;
/**
 * Among route shapes that fit a report about equally well, the longest wins:
 * overlapping shapes are usually a full run and its short turns, and a short
 * turn would unbind a train that runs past its end.
 */
const PATH_TIE_M = 10;

/**
 * Half-width of the arc window a train can have moved in `dtMs`, or NaN when
 * the gap is unknown or too long for a window to be meaningful.
 * @param {number} dtMs
 * @returns {number}
 */
export function pathWindowM(dtMs) {
  if (!Number.isFinite(dtMs)) return NaN;
  const window =
    PATH_WINDOW_SLACK_M + (PATH_MAX_SPEED_MPS * Math.abs(dtMs)) / 1000;
  return window > PATH_WINDOW_MAX_M ? NaN : window;
}

/** Arc moved between two reports before it says which way a train runs (m). */
const DIRECTION_MIN_M = 1;

/** +1 or -1 for an arc step longer than DIRECTION_MIN_M, else `known`. */
function directionOf(step, known) {
  return Number.isFinite(step) && Math.abs(step) > DIRECTION_MIN_M
    ? Math.sign(step)
    : known;
}

function createBinding(shapeIndex, path, via, s, fix) {
  return {
    shapeIndex,
    path,
    via,
    /**
     * Which way the drawn train runs along the shape: +1 along it, -1
     * against it, 0 until two reports or a playback segment tell. Kept until
     * a rebind. Once playback has placed the train, only playback changes
     * it: the newest reports run ahead of the drawn train, so a reversal
     * they show turns it when playback reaches it.
     */
    direction: 0,
    /** The direction the last placed playback segment ran, 0 before one. */
    drawDirection: 0,
    /** Arc and time of the newest report. */
    fixS: s,
    fixT: fix.t,
    fixLat: fix.lat,
    fixLon: fix.lon,
    /** Arc and time last drawn. */
    drawS: s,
    drawT: fix.t,
    /** Projections of the current playback segment's two reports. */
    segment: {
      fromSeq: -1,
      toSeq: -1,
      fromLat: NaN,
      fromLon: NaN,
      toLat: NaN,
      toLon: NaN,
      sFrom: NaN,
      sTo: NaN,
      ok: false,
    },
  };
}

/** The route shape a report fits best, preferring the longest near-tie. */
function bestRouteShape(pack, routeId, fix, accept) {
  const candidates = [];
  for (const index of pack.shapesForRoute(routeId)) {
    const path = pack.pathAt(index);
    const hit = projectOnPath(path, fix.lat, fix.lon);
    if (!hit || hit.offsetM > PATH_OFF_TRACK_M) continue;
    if (!accept(index, path)) continue;
    candidates.push({ index, path, s: hit.s, offsetM: hit.offsetM });
  }
  if (!candidates.length) return null;
  const nearest = Math.min(...candidates.map((c) => c.offsetM));
  let best = null;
  for (const candidate of candidates) {
    if (candidate.offsetM > nearest + PATH_TIE_M) continue;
    if (!best || candidate.path.length > best.path.length) best = candidate;
  }
  return best;
}

/**
 * Bind a train to a shape from its feed's pack.
 *
 * The trip's own shape when the trip is in the pack and the report lies on it;
 * otherwise the route shape the report lies nearest (within PATH_OFF_TRACK_M),
 * which for a single-shape route is that shape.
 *
 * @param {object} pack From createRailPathPack.
 * @param {{tripId?: string, routeId?: string}} ids
 * @param {{t: number, lat: number, lon: number}} fix The newest report.
 * @returns {object|null} A binding, or null to keep straight-line motion.
 */
export function bindTrainPath(pack, { tripId, routeId } = {}, fix) {
  if (!pack || !fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon))
    return null;
  const trip = pack.shapeForTrip(tripId);
  if (trip !== null) {
    const path = pack.pathAt(trip);
    const hit = projectOnPath(path, fix.lat, fix.lon);
    if (hit && hit.offsetM <= PATH_OFF_TRACK_M)
      return createBinding(trip, path, 'trip', hit.s, fix);
  }
  const best = bestRouteShape(pack, routeId, fix, (index) => index !== trip);
  return best
    ? createBinding(best.index, best.path, 'route', best.s, fix)
    : null;
}

/**
 * Follow a new report on the bound shape.
 * @param {object} binding
 * @param {{t: number, lat: number, lon: number}} fix
 * @returns {boolean} False when the report lies off the line: the binding is wrong.
 */
export function followFix(binding, fix) {
  if (!binding || !fix) return false;
  const hit = projectOnPath(
    binding.path,
    fix.lat,
    fix.lon,
    binding.fixS,
    pathWindowM(fix.t - binding.fixT),
  );
  if (!hit || hit.offsetM > PATH_OFF_TRACK_M) return false;
  if (!binding.drawDirection)
    binding.direction = directionOf(hit.s - binding.fixS, binding.direction);
  binding.fixS = hit.s;
  binding.fixT = fix.t;
  binding.fixLat = fix.lat;
  binding.fixLon = fix.lon;
  return true;
}

/**
 * After a report fell off the bound shape: another shape of the route that
 * holds both the previous report and this one, or null for straight lines.
 * @param {object} pack
 * @param {{routeId?: string}} ids
 * @param {object} binding The binding that no longer fits.
 * @param {{t: number, lat: number, lon: number}} fix
 * @returns {object|null}
 */
export function rebindTrainPath(pack, { routeId } = {}, binding, fix) {
  if (!pack || !binding || !fix) return null;
  const best = bestRouteShape(pack, routeId, fix, (index, path) => {
    if (index === binding.shapeIndex) return false;
    const previous = projectOnPath(path, binding.fixLat, binding.fixLon);
    return !!previous && previous.offsetM <= PATH_OFF_TRACK_M;
  });
  return best
    ? createBinding(best.index, best.path, 'route', best.s, fix)
    : null;
}

/** Project one playback report, near the last drawn arc when that is useful. */
function projectReport(binding, fix, hintS, hintT) {
  const path = binding.path;
  const window = pathWindowM(fix.t - hintT);
  let hit = Number.isFinite(hintS)
    ? projectOnPath(path, fix.lat, fix.lon, hintS, window)
    : null;
  if (!hit || hit.offsetM > PATH_OFF_TRACK_M)
    hit = projectOnPath(path, fix.lat, fix.lon);
  return hit && hit.offsetM <= PATH_OFF_TRACK_M ? hit.s : NaN;
}

/**
 * Where a bound train is drawn this frame.
 *
 * The playback segment's two reports are projected once per segment (the
 * from-report reuses the previous segment's to-report when they are the same
 * report); every frame interpolates the arc by the playback fraction and
 * looks up that point.
 *
 * @param {object} binding
 * @param {{fromSeq: number, toSeq: number, fraction: number}} sample Playback sample.
 * @param {{from: {seq:number, t:number, lat:number, lon:number},
 *   to: {seq:number, t:number, lat:number, lon:number}}} segment The sample's two reports.
 * @param {{lat?: number, lon?: number, bearingDeg?: number}} out
 * @returns {boolean} False when the train should stay on its straight-line point.
 */
export function placeOnPath(binding, sample, segment, out) {
  if (!binding || !sample || !segment || !(sample.fromSeq >= 0)) return false;
  const { from, to } = segment;
  if (from.seq !== sample.fromSeq || to.seq !== sample.toSeq) return false;
  const cache = binding.segment;
  if (
    cache.fromSeq !== sample.fromSeq ||
    cache.toSeq !== sample.toSeq ||
    cache.fromLat !== from.lat ||
    cache.fromLon !== from.lon ||
    cache.toLat !== to.lat ||
    cache.toLon !== to.lon
  ) {
    const chained =
      cache.ok &&
      cache.toSeq === sample.fromSeq &&
      cache.toLat === from.lat &&
      cache.toLon === from.lon;
    const sFrom = chained
      ? cache.sTo
      : projectReport(binding, from, binding.drawS, binding.drawT);
    const sTo =
      sample.toSeq === sample.fromSeq
        ? sFrom
        : Number.isFinite(sFrom)
          ? projectReport(binding, to, sFrom, from.t)
          : NaN;
    cache.fromSeq = sample.fromSeq;
    cache.toSeq = sample.toSeq;
    cache.fromLat = from.lat;
    cache.fromLon = from.lon;
    cache.toLat = to.lat;
    cache.toLon = to.lon;
    cache.sFrom = sFrom;
    cache.sTo = sTo;
    cache.ok = Number.isFinite(sFrom) && Number.isFinite(sTo);
    if (cache.ok) {
      binding.drawDirection = directionOf(
        sTo - sFrom,
        binding.drawDirection || binding.direction || 0,
      );
      binding.direction = binding.drawDirection;
    }
  }
  if (!cache.ok) return false;
  const f = Number.isFinite(sample.fraction)
    ? Math.max(0, Math.min(1, sample.fraction))
    : 1;
  const s = cache.sFrom + (cache.sTo - cache.sFrom) * f;
  if (!pointAtS(binding.path, s, out)) return false;
  binding.drawS = s;
  binding.drawT = from.t + (to.t - from.t) * f;
  return true;
}

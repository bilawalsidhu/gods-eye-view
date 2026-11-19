import {
  dayNumberOf,
  formatClock,
  isTimeZone,
  parseServiceDate,
  serviceDayOriginMs,
} from './railTimeZones.js';

/**
 * @module railSchedule
 * @description Timetable tier of the Rail layer: which trains run now
 * according to the operator's static GTFS, where along their line the
 * timetable puts them (only to match a live train to its run, never drawn),
 * and the stop list a train card shows.
 *
 * Schedule packs come from scripts/build-rail-paths.mjs (`<feedId>.schedule.json`).
 * Service calendars are resolved to concrete dates at build time, so this
 * module never evaluates a calendar. Stop times are seconds after the service
 * day's GTFS origin (noon minus 12 h, agency time zone) and may exceed 24 h.
 *
 * Realtime delays follow GTFS-RT TripUpdate semantics:
 *
 *   delays = { [tripId]: { delaySec?, startDate?, relationship?, stops?: [{
 *     stopId? | stopSequence?, relationship?,
 *     arrival?: { time?, delay? }, departure?: { time?, delay? } }] } }
 *
 * (the trip records of src/data/railTripUpdates.js, keyed by trip id). A
 * trip `relationship` of 'CANCELED' or 'DELETED' drops the run from
 * activeTrips; a stop `relationship` of 'SKIPPED' (or `skipped: true`) is
 * passed without a stop, and one of 'NO_DATA' has no prediction: that stop
 * and the stops after it keep their timetable times until the next update.
 *
 * `time` is POSIX seconds (milliseconds are accepted too), `delay` seconds.
 * A stop update's delay carries on to later stops until the next update;
 * stops before the first update use the trip's `delaySec` (else the
 * timetable). `startDate` ('YYYYMMDD' or 'YYYY-MM-DD') pins the entry to one
 * run of a trip that runs on several days.
 *
 * Clock strings are 24-hour 'HH:MM' in each STATION's own time zone.
 *
 * Pure: no Cesium, no DOM, no I/O.
 */

/** Schedule-pack format this module reads. */
export const RAIL_SCHEDULE_PACK_VERSION = 1;

/** Earliest a delayed or early train is looked for around its timetable (ms). */
const EARLY_SLACK_MS = 60 * 60_000;
const LATE_SLACK_MS = 12 * 60 * 60_000;
const MINUS = '−';
/** TripUpdate relationships under which a scheduled run does not run. */
const CANCELED = new Set(['CANCELED', 'DELETED']);

/**
 * A relative time chip as the Launches layer writes its countdown: `T−4`
 * for an event four minutes ahead, `T+3` for one three minutes past. Minutes
 * round up toward the event (Math.ceil, as the Launches countdown rounds its
 * seconds), so `T−1` shows until the moment itself and `T+0` for the first
 * minute after. An hour or more reads `T−1:05`.
 * @param {number} deltaMs Event time minus now.
 * @returns {string}
 */
export function formatRelative(deltaMs) {
  if (!Number.isFinite(deltaMs)) return '';
  const minutes = Math.ceil(deltaMs / 60_000);
  const sign = deltaMs > 0 ? MINUS : '+';
  const total = Math.abs(minutes);
  const text =
    total >= 60
      ? `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
      : String(total);
  return `T${sign}${text}`;
}

const isIndex = (value, length) =>
  Number.isInteger(value) && value >= 0 && value < length;

/** Largest delay a live report may state, either way (s): a day. */
const LIVE_DELAY_MAX_S = 86_400;

/**
 * The delay a live train's own report states (`delaySec`: Irish Rail's
 * public message, SIRI VM's `Delay`), for a feed that publishes no trip
 * updates; null when it states none, or more than a day either way (a unit
 * error, not a late train).
 * @param {{delaySec?: unknown}|null|undefined} record
 * @returns {number|null} Seconds, positive when late.
 */
export function liveDelaySec(record) {
  const value = record?.delaySec;
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= LIVE_DELAY_MAX_S
    ? value
    : null;
}

/**
 * Validate and index a decoded schedule pack.
 * @param {object} raw The JSON body of `<feedId>.schedule.json`.
 * @returns {object} A schedule for the functions below.
 */
export function createSchedule(raw) {
  if (
    !raw ||
    raw.version !== RAIL_SCHEDULE_PACK_VERSION ||
    typeof raw.feedId !== 'string' ||
    !Array.isArray(raw.stops) ||
    !Array.isArray(raw.patterns) ||
    !Array.isArray(raw.profiles) ||
    !raw.trips ||
    typeof raw.trips !== 'object' ||
    !raw.services ||
    typeof raw.services !== 'object'
  )
    throw new TypeError('Malformed rail schedule pack');
  const timezone = isTimeZone(raw.timezone) ? raw.timezone : 'UTC';
  const stops = raw.stops.map((stop, index) => ({
    index,
    id: String(stop?.id ?? ''),
    name: String(stop?.name ?? ''),
    lat: Number(stop?.lat),
    lon: Number(stop?.lon),
    parent: isIndex(stop?.parent, raw.stops.length) ? stop.parent : null,
    platform: stop?.platform ? String(stop.platform) : null,
    ownZone: isTimeZone(stop?.tz) ? stop.tz : null,
  }));
  for (const stop of stops) {
    const parent = stop.parent === null ? null : stops[stop.parent];
    stop.timezone = stop.ownZone ?? parent?.ownZone ?? timezone;
    delete stop.ownZone;
    Object.freeze(stop);
  }
  const stopIndexById = new Map(stops.map((stop) => [stop.id, stop.index]));
  const patterns = raw.patterns.map((pattern, index) => {
    const list = Array.isArray(pattern?.stops) ? pattern.stops : [];
    const n = list.length;
    if (n < 2 || !list.every((value) => isIndex(value, stops.length)))
      throw new TypeError(`Malformed rail schedule pattern ${index}`);
    const dist =
      Array.isArray(pattern.dist) && pattern.dist.length === n
        ? pattern.dist.map(Number)
        : new Array(n).fill(0);
    const seq =
      Array.isArray(pattern.seq) && pattern.seq.length === n
        ? pattern.seq.map(Number)
        : list.map((_, k) => k + 1);
    return Object.freeze({
      index,
      shape: Number.isInteger(pattern.shape) ? pattern.shape : null,
      stops: Object.freeze(list.slice()),
      seq: Object.freeze(seq),
      dist: Object.freeze(dist),
      pass: Object.freeze(
        Array.isArray(pattern.pass) && pattern.pass.length === n
          ? pattern.pass.map((value) => value === 1)
          : new Array(n).fill(false),
      ),
    });
  });
  const origins = new Map();
  const originOf = (date) => {
    let origin = origins.get(date);
    if (origin === undefined) {
      origin = serviceDayOriginMs(date, timezone);
      origins.set(date, origin);
    }
    return origin;
  };
  const trips = new Map();
  const instances = [];
  let maxDurationMs = 0;
  for (const [tripId, value] of Object.entries(raw.trips)) {
    const pattern = patterns[value?.pattern];
    const profile = raw.profiles[value?.profile];
    if (!pattern || !Array.isArray(profile)) continue;
    if (profile.length !== pattern.stops.length * 2) continue;
    const startSec = Number(value.startSec);
    if (!Number.isFinite(startSec)) continue;
    const trip = Object.freeze({
      id: tripId,
      pattern,
      offsets: profile,
      startSec,
      routeId: value.route == null ? null : String(value.route),
      service: String(value.service ?? ''),
      headsign: value.headsign ? String(value.headsign) : null,
      name: value.name ? String(value.name) : null,
      direction: Number.isInteger(value.direction) ? value.direction : null,
    });
    trips.set(tripId, trip);
    const dates = raw.services[trip.service];
    if (!Array.isArray(dates)) continue;
    const durationMs = profile[profile.length - 1] * 1000;
    if (durationMs > maxDurationMs) maxDurationMs = durationMs;
    for (const date of dates) {
      if (!parseServiceDate(date)) continue;
      const startMs = originOf(date) + startSec * 1000;
      if (Number.isFinite(startMs))
        instances.push({
          trip,
          serviceDate: date,
          startMs,
          endMs: startMs + durationMs,
        });
    }
  }
  instances.sort((a, b) => a.startMs - b.startMs);
  const runsByTrip = new Map();
  for (const instance of instances) {
    let list = runsByTrip.get(instance.trip.id);
    if (!list) runsByTrip.set(instance.trip.id, (list = []));
    list.push(instance);
  }
  return Object.freeze({
    feedId: raw.feedId,
    /**
     * The `builtAt` of the path pack this timetable's shape indices point
     * into (written by the same build), or null in packs that predate it.
     */
    pathsBuiltAt:
      typeof raw.pathsBuiltAt === 'string' ? raw.pathsBuiltAt : null,
    timezone,
    window: raw.window ?? null,
    routes: raw.routes && typeof raw.routes === 'object' ? raw.routes : {},
    stops: Object.freeze(stops),
    patterns: Object.freeze(patterns),
    trips,
    stopIndexById,
    instances: Object.freeze(instances),
    runsByTrip,
    instanceStarts: Float64Array.from(
      instances,
      (instance) => instance.startMs,
    ),
    maxDurationMs,
  });
}

/**
 * When the last run a decoded schedule pack holds arrives (epoch ms): past
 * it the pack's window has ended, and it names no train that can still be
 * running. Each trip counts on the latest date of its service. Read from the
 * raw pack, without indexing it (the server checks a pack it reads only for
 * its routes). Null when the pack names no window (`window.to`), so its end
 * is not known; -Infinity when it holds no run.
 * @param {object} raw The JSON body of `<feedId>.schedule.json`.
 * @returns {number|null}
 */
export function schedulePackEndMs(raw) {
  if (!parseServiceDate(raw?.window?.to)) return null;
  const trips = raw?.trips && typeof raw.trips === 'object' ? raw.trips : {};
  const services =
    raw?.services && typeof raw.services === 'object' ? raw.services : {};
  const profiles = Array.isArray(raw?.profiles) ? raw.profiles : [];
  const zone = isTimeZone(raw?.timezone) ? raw.timezone : 'UTC';
  /** Service id → the origin of its latest date (-Infinity: no date). */
  const lastOrigin = new Map();
  const latestOrigin = (service) => {
    let origin = lastOrigin.get(service);
    if (origin !== undefined) return origin;
    const dates = Object.hasOwn(services, service) ? services[service] : null;
    let latest = -Infinity;
    let latestDate = null;
    for (const date of Array.isArray(dates) ? dates : []) {
      const day = dayNumberOf(date);
      if (day > latest) {
        latest = day;
        latestDate = date;
      }
    }
    origin = latestDate === null ? NaN : serviceDayOriginMs(latestDate, zone);
    if (!Number.isFinite(origin)) origin = -Infinity;
    lastOrigin.set(service, origin);
    return origin;
  };
  let end = -Infinity;
  for (const trip of Object.values(trips)) {
    const profile = profiles[trip?.profile];
    const startSec = Number(trip?.startSec);
    if (!Array.isArray(profile) || !Number.isFinite(startSec)) continue;
    const origin = latestOrigin(String(trip.service ?? ''));
    if (origin === -Infinity) continue;
    const durationSec = Number(profile[profile.length - 1]) || 0;
    end = Math.max(end, origin + (startSec + durationSec) * 1000);
  }
  return end;
}

/** First index whose start is greater than `ms`. */
function upperBound(starts, ms) {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The public view of one run of a trip. */
function runOf(instance) {
  const { trip } = instance;
  return {
    tripId: trip.id,
    serviceDate: instance.serviceDate,
    routeId: trip.routeId,
    headsign: trip.headsign,
    name: trip.name,
    direction: trip.direction,
    pattern: trip.pattern.index,
    shape: trip.pattern.shape,
    scheduledStartMs: instance.startMs,
    scheduledEndMs: instance.endMs,
  };
}

/** The delay entry for a run, honouring a `startDate` pin. */
function delayFor(delays, run) {
  const entry =
    delays && Object.hasOwn(delays, run.tripId) ? delays[run.tripId] : null;
  if (!entry || typeof entry !== 'object') return null;
  if (entry.startDate != null) {
    const pinned = parseServiceDate(entry.startDate);
    const own = parseServiceDate(run.serviceDate);
    if (
      !pinned ||
      !own ||
      pinned.year !== own.year ||
      pinned.month !== own.month ||
      pinned.day !== own.day
    )
      return null;
  }
  return entry;
}

const toMs = (time) => {
  const value = Number(time);
  if (!Number.isFinite(value) || value <= 0) return NaN;
  return value > 1e11 ? value : value * 1000;
};

/** The pattern index each stop update applies to, in order. */
function matchUpdates(schedule, pattern, updates) {
  const byIndex = new Map();
  let from = 0;
  for (const update of updates) {
    if (!update || typeof update !== 'object') continue;
    let found = -1;
    for (let pass = 0; pass < 2 && found < 0; pass++) {
      const start = pass === 0 ? from : 0;
      for (let k = start; k < pattern.stops.length; k++) {
        if (stopMatches(schedule, pattern, k, update)) {
          found = k;
          break;
        }
      }
    }
    if (found < 0) continue;
    byIndex.set(found, update);
    from = found + 1;
  }
  return byIndex;
}

function stopMatches(schedule, pattern, k, update) {
  if (update.stopSequence != null && update.stopSequence !== '')
    return Number(update.stopSequence) === pattern.seq[k];
  if (update.stopId == null) return false;
  const id = String(update.stopId);
  const stop = schedule.stops[pattern.stops[k]];
  if (stop.id === id) return true;
  if (stop.parent !== null && schedule.stops[stop.parent].id === id)
    return true;
  const other = schedule.stopIndexById.get(id);
  if (other === undefined) return false;
  const otherParent = schedule.stops[other].parent;
  return otherParent !== null && otherParent === (stop.parent ?? stop.index);
}

/** Whether a stop update carries this StopTimeUpdate relationship. */
function stopRelationshipIs(update, relationship) {
  return (
    update.relationship === relationship ||
    update.scheduleRelationship === relationship
  );
}

/**
 * Scheduled and expected times of every stop of a run.
 * @returns {{schedArr: number[], schedDep: number[], arr: number[],
 *   dep: number[], skipped: boolean[], hasRealtime: boolean}}
 */
function runTimes(schedule, instance, delays) {
  const { trip } = instance;
  const n = trip.pattern.stops.length;
  const schedArr = new Array(n);
  const schedDep = new Array(n);
  for (let k = 0; k < n; k++) {
    schedArr[k] = instance.startMs + trip.offsets[2 * k] * 1000;
    schedDep[k] = instance.startMs + trip.offsets[2 * k + 1] * 1000;
  }
  const arr = schedArr.slice();
  const dep = schedDep.slice();
  const skipped = new Array(n).fill(false);
  const entry = delayFor(delays, {
    tripId: trip.id,
    serviceDate: instance.serviceDate,
  });
  if (!entry)
    return { schedArr, schedDep, arr, dep, skipped, hasRealtime: false };
  const updates = matchUpdates(
    schedule,
    trip.pattern,
    Array.isArray(entry.stops) ? entry.stops : [],
  );
  let carried = Number.isFinite(Number(entry.delaySec))
    ? Number(entry.delaySec)
    : 0;
  for (let k = 0; k < n; k++) {
    const update = updates.get(k);
    let arrDelay = carried;
    let depDelay = carried;
    if (update && stopRelationshipIs(update, 'NO_DATA')) {
      // No prediction (GTFS-RT NO_DATA): the delay carried so far no longer
      // holds, here or at the stops after it.
      carried = 0;
      arrDelay = 0;
      depDelay = 0;
    } else if (update) {
      if (update.skipped === true || stopRelationshipIs(update, 'SKIPPED'))
        skipped[k] = true;
      const a = update.arrival ?? null;
      const d = update.departure ?? null;
      const aTime = toMs(a?.time);
      const dTime = toMs(d?.time);
      const aDelay = Number(a?.delay);
      const dDelay = Number(d?.delay);
      let arrivalGiven = true;
      if (Number.isFinite(aTime)) arrDelay = (aTime - schedArr[k]) / 1000;
      else if (a && a.delay != null && Number.isFinite(aDelay))
        arrDelay = aDelay;
      else arrivalGiven = false;
      if (Number.isFinite(dTime)) depDelay = (dTime - schedDep[k]) / 1000;
      else if (d && d.delay != null && Number.isFinite(dDelay))
        depDelay = dDelay;
      else if (arrivalGiven) depDelay = arrDelay;
      else depDelay = carried;
      if (!arrivalGiven && (Number.isFinite(dTime) || (d && d.delay != null)))
        arrDelay = Math.min(carried, depDelay);
      carried = depDelay;
    }
    arr[k] = schedArr[k] + arrDelay * 1000;
    dep[k] = schedDep[k] + depDelay * 1000;
  }
  // Predictions are not always consistent; time never runs backwards.
  for (let k = 0; k < n; k++) {
    if (k > 0 && arr[k] < dep[k - 1]) arr[k] = dep[k - 1];
    if (dep[k] < arr[k]) dep[k] = arr[k];
  }
  return { schedArr, schedDep, arr, dep, skipped, hasRealtime: true };
}

/** The instance of `trip` (a run object or a trip id) meant at `nowMs`. */
function resolveInstance(schedule, trip, nowMs, delays) {
  const pinned = trip && typeof trip === 'object';
  const runs = schedule.runsByTrip.get(
    String((pinned ? trip.tripId : trip) ?? ''),
  );
  if (!runs) return null;
  if (pinned && trip.serviceDate != null) {
    const match = runs.find(
      (instance) => instance.serviceDate === trip.serviceDate,
    );
    if (match) return match;
  }
  let best = null;
  let bestScore = Infinity;
  for (const instance of runs) {
    const times = runTimes(schedule, instance, delays);
    const start = times.dep[0];
    const end = times.arr[times.arr.length - 1];
    // Running now wins; else the nearest run, upcoming before past.
    const score =
      nowMs >= start && nowMs <= end
        ? -1
        : nowMs < start
          ? start - nowMs
          : (nowMs - end) * 2;
    if (score < bestScore) {
      bestScore = score;
      best = instance;
    }
  }
  return best;
}

/**
 * Trains the timetable has running at `nowMs`: from the departure at the
 * first stop to the arrival at the last, shifted by realtime delays.
 * @param {object} schedule From createSchedule.
 * @param {number} nowMs
 * @param {{delays?: object, beforeMs?: number, afterMs?: number}} [options]
 *   `beforeMs` / `afterMs` widen the window (a train waiting at its origin,
 *   one just arrived).
 * @returns {object[]} Runs: {tripId, serviceDate, routeId, headsign, name,
 *   direction, pattern, shape, scheduledStartMs, scheduledEndMs,
 *   expectedStartMs, expectedEndMs}.
 */
export function activeTrips(
  schedule,
  nowMs,
  { delays = null, beforeMs = 0, afterMs = 0 } = {},
) {
  if (!schedule || !Number.isFinite(nowMs)) return [];
  const lead = Math.max(0, beforeMs);
  const tail = Math.max(0, afterMs);
  const last = upperBound(
    schedule.instanceStarts,
    nowMs + lead + EARLY_SLACK_MS,
  );
  const floor = nowMs - tail - LATE_SLACK_MS - schedule.maxDurationMs;
  const out = [];
  for (let i = last - 1; i >= 0; i--) {
    const instance = schedule.instances[i];
    if (instance.startMs < floor) break;
    const run = runOf(instance);
    let start = instance.startMs + instance.trip.offsets[1] * 1000;
    let end = instance.endMs;
    const entry = delayFor(delays, run);
    if (entry && CANCELED.has(entry.relationship)) continue;
    if (entry) {
      const times = runTimes(schedule, instance, delays);
      start = times.dep[0];
      end = times.arr[times.arr.length - 1];
    } else if (instance.endMs < nowMs - tail) continue;
    if (nowMs < start - lead || nowMs > end + tail) continue;
    run.expectedStartMs = start;
    run.expectedEndMs = end;
    out.push(run);
  }
  return out.reverse();
}

/**
 * Where the timetable puts a train at `nowMs`, along its pattern's shape.
 * Between two stops the arc runs linearly in time from the departure to the
 * next arrival; during a dwell it holds at the stop. Before the first
 * departure it waits at the origin, after the last arrival at the terminus.
 *
 * @param {object} schedule From createSchedule.
 * @param {object|string} trip A run from activeTrips, or a trip id.
 * @param {number} nowMs
 * @param {object} [delays]
 * @returns {{tripId: string, serviceDate: string, shape: number|null,
 *   s: number, prevStop: number, nextStop: number,
 *   prevStopId: string|null, nextStopId: string|null, dwell: boolean,
 *   state: 'before'|'running'|'arrived', fraction: number, delaySec: number,
 *   lat?: number, lon?: number}|null} Stop fields are pattern indices (-1 for
 *   none). `lat`/`lon` interpolate between the stops and are set only when
 *   the pattern has no shape.
 */
export function scheduledPosition(schedule, trip, nowMs, delays = null) {
  if (!schedule || !Number.isFinite(nowMs)) return null;
  const instance = resolveInstance(schedule, trip, nowMs, delays);
  if (!instance) return null;
  const { pattern } = instance.trip;
  const times = runTimes(schedule, instance, delays);
  // Skipped stops are passed without a stop: their times do not pace the run.
  const nodes = [];
  for (let k = 0; k < pattern.stops.length; k++)
    if (!times.skipped[k]) nodes.push(k);
  if (nodes.length < 2)
    nodes.splice(0, nodes.length, 0, pattern.stops.length - 1);
  const result = {
    tripId: instance.trip.id,
    serviceDate: instance.serviceDate,
    shape: pattern.shape,
    s: 0,
    prevStop: -1,
    nextStop: -1,
    prevStopId: null,
    nextStopId: null,
    dwell: false,
    state: 'running',
    fraction: 0,
    delaySec: 0,
  };
  const first = nodes[0];
  const lastNode = nodes[nodes.length - 1];
  let at = -1;
  let from = -1;
  let to = -1;
  if (nowMs < times.dep[first]) {
    result.state = 'before';
    at = first;
    result.prevStop = -1;
    result.nextStop = first;
  } else if (nowMs >= times.arr[lastNode]) {
    result.state = 'arrived';
    at = lastNode;
    result.prevStop = lastNode;
    result.nextStop = -1;
  } else {
    for (let j = 0; j < nodes.length; j++) {
      const k = nodes[j];
      if (nowMs >= times.arr[k] && nowMs < times.dep[k]) {
        at = k;
        result.prevStop = k;
        result.nextStop = j + 1 < nodes.length ? nodes[j + 1] : -1;
        break;
      }
      if (
        j + 1 < nodes.length &&
        nowMs >= times.dep[k] &&
        nowMs < times.arr[nodes[j + 1]]
      ) {
        from = k;
        to = nodes[j + 1];
        break;
      }
    }
  }
  if (at >= 0) {
    result.dwell = true;
    result.s = pattern.dist[at];
    result.fraction = 0;
    result.delaySec = Math.round(
      (result.state === 'arrived'
        ? times.arr[at] - times.schedArr[at]
        : times.dep[at] - times.schedDep[at]) / 1000,
    );
  } else {
    const span = times.arr[to] - times.dep[from];
    const fraction =
      span > 0 ? Math.min(1, Math.max(0, (nowMs - times.dep[from]) / span)) : 1;
    result.prevStop = from;
    result.nextStop = to;
    result.fraction = fraction;
    result.s =
      pattern.dist[from] + (pattern.dist[to] - pattern.dist[from]) * fraction;
    result.delaySec = Math.round((times.arr[to] - times.schedArr[to]) / 1000);
  }
  if (result.prevStop >= 0)
    result.prevStopId = schedule.stops[pattern.stops[result.prevStop]].id;
  if (result.nextStop >= 0)
    result.nextStopId = schedule.stops[pattern.stops[result.nextStop]].id;
  if (pattern.shape === null) {
    const a =
      schedule.stops[
        pattern.stops[result.prevStop >= 0 ? result.prevStop : result.nextStop]
      ];
    const b = result.dwell ? a : schedule.stops[pattern.stops[result.nextStop]];
    result.lat = a.lat + (b.lat - a.lat) * result.fraction;
    result.lon = a.lon + (b.lon - a.lon) * result.fraction;
  }
  return result;
}

/**
 * A run's stop list for a train card.
 *
 * `state` is 'passed' once the train has left (or, at the terminus, reached)
 * the stop, 'next' for the first stop not yet passed (with `atStop` while the
 * train dwells there) and 'upcoming' after it. `relative` is the chip from
 * formatRelative: for a passed stop the departure (terminus: arrival), for
 * the stop the train stands at its departure, else the arrival.
 *
 * @param {object} schedule
 * @param {object|string} trip A run from activeTrips, or a trip id.
 * @param {number} nowMs
 * @param {object} [delays]
 * @returns {object[]} Per stop: {index, stopId, name, platform, parentId,
 *   parentName, lat, lon, timezone, scheduledArrivalMs,
 *   scheduledDepartureMs, expectedArrivalMs, expectedDepartureMs,
 *   arrivalDelaySec, departureDelaySec, scheduledArrival,
 *   scheduledDeparture, expectedArrival, expectedDeparture (local 'HH:MM'),
 *   passThrough, skipped, realtime, state, atStop, relative, relativeMs}.
 */
export function tripStops(schedule, trip, nowMs, delays = null) {
  if (!schedule || !Number.isFinite(nowMs)) return [];
  const instance = resolveInstance(schedule, trip, nowMs, delays);
  if (!instance) return [];
  const { pattern } = instance.trip;
  const times = runTimes(schedule, instance, delays);
  const n = pattern.stops.length;
  const out = [];
  let nextFound = false;
  for (let k = 0; k < n; k++) {
    const stop = schedule.stops[pattern.stops[k]];
    const parent = stop.parent === null ? null : schedule.stops[stop.parent];
    const zone = stop.timezone;
    const terminus = k === n - 1;
    const leftAt = terminus ? times.arr[k] : times.dep[k];
    let state;
    let atStop = false;
    if (nowMs >= leftAt) state = 'passed';
    else if (!nextFound) {
      state = 'next';
      nextFound = true;
      atStop = nowMs >= times.arr[k] && !times.skipped[k];
    } else state = 'upcoming';
    const eventMs =
      state === 'passed'
        ? leftAt
        : atStop || k === 0
          ? times.dep[k]
          : times.arr[k];
    out.push({
      index: k,
      stopId: stop.id,
      name: stop.name || parent?.name || stop.id,
      platform: stop.platform,
      parentId: parent?.id ?? null,
      parentName: parent?.name ?? null,
      lat: stop.lat,
      lon: stop.lon,
      timezone: zone,
      scheduledArrivalMs: times.schedArr[k],
      scheduledDepartureMs: times.schedDep[k],
      expectedArrivalMs: times.arr[k],
      expectedDepartureMs: times.dep[k],
      arrivalDelaySec: Math.round((times.arr[k] - times.schedArr[k]) / 1000),
      departureDelaySec: Math.round((times.dep[k] - times.schedDep[k]) / 1000),
      scheduledArrival: formatClock(times.schedArr[k], zone),
      scheduledDeparture: formatClock(times.schedDep[k], zone),
      expectedArrival: formatClock(times.arr[k], zone),
      expectedDeparture: formatClock(times.dep[k], zone),
      passThrough: pattern.pass[k],
      skipped: times.skipped[k],
      realtime: times.hasRealtime,
      state,
      atStop,
      relativeMs: eventMs - nowMs,
      relative: formatRelative(eventMs - nowMs),
    });
  }
  return out;
}

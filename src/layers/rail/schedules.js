/**
 * @module layers/rail/schedules
 * @description The Rail layer's schedule tier: each feed's optional schedule
 * pack (src/data/railSchedule.js) and live trip-update delays, read for the
 * selected live train's stops, headsign and delays (the stops provider,
 * `stopsFor`). It never places or moves a train: every train drawn is where
 * its operator last reported it.
 *
 * A schedule pack is fetched the first time a train on that feed is
 * selected, and kept until the feed has been out of use for a while
 * (`forget`). Trip updates are polled every RAIL_UPDATES_POLL_MS while a
 * train on the feed is selected. A feed that publishes none (Irish Rail, SJ
 * Nord) may state each train's delay in its report (`delaySec`): that delay
 * then moves the train's timetable, for its stops and for finding its run.
 *
 * No Cesium, no DOM. Network access goes through the injected source and
 * timers through injected functions, so node:test drives it.
 */

import {
  activeTrips,
  createSchedule,
  liveDelaySec,
  scheduledPosition,
  tripStops,
} from '../../data/railSchedule.js';
import { pointAtS } from '../../data/railPaths.js';

/** Trip updates are re-read this often while needed (ms). */
export const RAIL_UPDATES_POLL_MS = 30_000;
/** Delays older than this are not applied: a stopped poll must not lie (ms). */
export const RAIL_UPDATES_MAX_AGE_MS = 2 * RAIL_UPDATES_POLL_MS + 15_000;
/**
 * A schedule pack that failed (other than a 404) is tried again after
 * SCHEDULE_RETRY_FIRST_MS, then twice as long after each failure in a row,
 * up to SCHEDULE_RETRY_MS (ms): one bad answer from the server does not
 * leave a selected train without its stops for ten minutes.
 */
export const SCHEDULE_RETRY_FIRST_MS = 30_000;
export const SCHEDULE_RETRY_MS = 10 * 60_000;
/**
 * A live train without a known trip id may be matched to a run from this
 * long before its departure (waiting at the origin)...
 */
export const MATCH_BEFORE_MS = 5 * 60_000;
/** ...to this long after its arrival, at the terminus. */
export const MATCH_AFTER_MS = 2 * 60_000;
/** A live train without a known trip id matches a run this close (m). */
export const MATCH_NEAREST_MAX_M = 3_000;
/** How long a nearest-run match is kept before it is looked for again (ms). */
export const MATCH_KEEP_MS = 60_000;

/**
 * How long a schedule pack waits after its nth failure in a row (ms).
 * @param {number} failures 1 after the first.
 * @returns {number}
 */
export function scheduleRetryDelayMs(failures) {
  return Math.min(
    SCHEDULE_RETRY_MS,
    SCHEDULE_RETRY_FIRST_MS * 2 ** Math.max(0, failures - 1),
  );
}

const M_PER_DEG = 111_320;

/** Ground distance in metres, equirectangular: fine at a few kilometres. */
function distanceM(lat1, lon1, lat2, lon2) {
  const kx = M_PER_DEG * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  const dLon = ((((lon2 - lon1 + 180) % 360) + 360) % 360) - 180;
  return Math.hypot(dLon * kx, (lat2 - lat1) * M_PER_DEG);
}

/**
 * GTFS-RT trip records (the `/api/rail/updates` body) as the `delays` map
 * railSchedule reads, keyed by trip id.
 * @param {{trips?: object[]}|null} body
 * @returns {Record<string, object>}
 */
export function delaysFromUpdates(body) {
  const delays = {};
  for (const trip of Array.isArray(body?.trips) ? body.trips : []) {
    if (typeof trip?.tripId !== 'string' || !trip.tripId) continue;
    delays[trip.tripId] = {
      delaySec: Number.isFinite(trip.delaySec) ? trip.delaySec : null,
      startDate: trip.startDate ?? null,
      relationship: trip.relationship ?? null,
      stops: Array.isArray(trip.stops) ? trip.stops : [],
    };
  }
  return delays;
}

/**
 * Whether a timetable's shape indices point into this path pack: the two
 * come from one build. A path pack rebuilt on its own (or a schedule left
 * from an older build) has other shapes at those indices, so its runs are
 * compared between their stops instead of along some other line. Packs that
 * predate the stamps are taken as a pair.
 * @param {{pathsBuiltAt?: string|null}} schedule
 * @param {{builtAt?: string|null}|null} pack
 * @returns {boolean}
 */
export function pathsMatch(schedule, pack) {
  if (!pack) return false;
  if (!schedule?.pathsBuiltAt || !pack.builtAt) return true;
  return schedule.pathsBuiltAt === pack.builtAt;
}

/**
 * Where the timetable has one run now: on its shape when the path pack has
 * it, else between its stops. Only compared with a live train's report, to
 * find the run it is on (stopsFor); never drawn.
 * @param {object} schedule From createSchedule.
 * @param {object|string} run A run from activeTrips, or a trip id.
 * @param {number} nowMs
 * @param {object|null} delays
 * @param {object|null} pack A path pack (createRailPathPack), when loaded.
 * @returns {object|null} scheduledPosition's result plus `lat`, `lon`,
 *   `bearingDeg` (NaN when unknown) and `onShape`.
 */
export function scheduledRunPoint(schedule, run, nowMs, delays, pack) {
  const position = scheduledPosition(schedule, run, nowMs, delays);
  if (!position) return null;
  const path =
    position.shape !== null && pathsMatch(schedule, pack)
      ? pack.pathAt(position.shape)
      : null;
  const point = path ? pointAtS(path, position.s) : null;
  if (point && Number.isFinite(point.lat) && Number.isFinite(point.lon))
    return { ...position, ...point, onShape: true };
  if (Number.isFinite(position.lat) && Number.isFinite(position.lon))
    return { ...position, bearingDeg: NaN, onShape: false };
  // A shaped pattern whose path pack is not here (yet): between the stops.
  const trip = schedule.trips.get(position.tripId);
  if (!trip) return null;
  const stopAt = (k) => (k >= 0 ? schedule.stops[trip.pattern.stops[k]] : null);
  const a = stopAt(
    position.prevStop >= 0 ? position.prevStop : position.nextStop,
  );
  const b =
    position.dwell || position.nextStop < 0 ? a : stopAt(position.nextStop);
  if (!a || !b) return null;
  const f = position.dwell ? 0 : position.fraction;
  return {
    ...position,
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f,
    bearingDeg: NaN,
    onShape: false,
  };
}

/**
 * The schedule tier for one layer instance.
 * @param {{source: object,
 *   hasTripUpdates: (feedId: string) => boolean,
 *   pathPackFor?: (feedId: string) => object|null,
 *   now?: () => number,
 *   setInterval?: Function, clearInterval?: Function,
 *   onChange?: (feedId: string) => void}} options
 * @returns {object}
 */
export function createRailSchedules({
  source,
  hasTripUpdates,
  pathPackFor = () => null,
  now = () => Date.now(),
  setInterval: startInterval = (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: stopInterval = (id) => globalThis.clearInterval(id),
  onChange = () => {},
}) {
  /**
   * feedId → `{status: 'loading'|'ready'|'none', schedule, retryAt, promise,
   * failures}`; `failures` counts failed loads in a row.
   */
  const schedules = new Map();
  /** feedId → `{delays, at, timer, reasons: Set, controller}`. */
  const updates = new Map();
  /** `${feedId}\n${trainId}` → `{tripKey, run, via, at}` for live trains. */
  const matches = new Map();
  let selectedFeed = null;

  /**
   * The feed's schedule, loading it on first ask.
   * @param {string} feedId
   * @returns {Promise<object|null>} The schedule, or null when it has none.
   */
  function loadSchedule(feedId) {
    const known = schedules.get(feedId);
    if (known?.status === 'ready') return Promise.resolve(known.schedule);
    if (known?.status === 'loading') return known.promise;
    if (known?.status === 'none' && now() < known.retryAt)
      return Promise.resolve(null);
    if (typeof source?.requestSchedule !== 'function') {
      schedules.set(feedId, {
        status: 'none',
        schedule: null,
        retryAt: Infinity,
      });
      return Promise.resolve(null);
    }
    const slot = {
      status: 'loading',
      schedule: null,
      retryAt: Infinity,
      failures: known?.failures ?? 0,
    };
    slot.promise = (async () => {
      try {
        const response = await source.requestSchedule(feedId);
        if (!response.ok) {
          const error = new Error(`rail schedule HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        const raw = await response.json();
        let schedule;
        try {
          schedule = createSchedule(raw);
          if (schedule.feedId !== feedId)
            throw new TypeError('rail schedule pack is for another feed');
        } catch (error) {
          error.permanent = true;
          throw error;
        }
        slot.schedule = schedule;
        slot.status = 'ready';
        slot.failures = 0;
        onChange(feedId);
        return schedule;
      } catch (error) {
        slot.status = 'none';
        slot.failures += 1;
        // A 404 is "no timetable for this feed", not a fault to retry; a
        // malformed pack will not mend itself before the next build either.
        slot.retryAt =
          error?.status === 404 || error?.permanent === true
            ? Infinity
            : now() + scheduleRetryDelayMs(slot.failures);
        if (error?.status !== 404)
          console.warn(
            `[Data:Rail] ${feedId} timetable unavailable:`,
            error?.message || error,
          );
        return null;
      } finally {
        slot.promise = null;
      }
    })();
    schedules.set(feedId, slot);
    return slot.promise;
  }

  /** The feed's schedule if loaded; starts the load otherwise. */
  function scheduleFor(feedId) {
    const known = schedules.get(feedId);
    if (known?.status === 'ready') return known.schedule;
    void loadSchedule(feedId);
    return null;
  }

  function updatesSlot(feedId) {
    let slot = updates.get(feedId);
    if (!slot) {
      slot = {
        delays: null,
        at: -Infinity,
        timer: null,
        reasons: new Set(),
        controller: null,
      };
      updates.set(feedId, slot);
    }
    return slot;
  }

  async function fetchUpdates(feedId) {
    const slot = updatesSlot(feedId);
    if (slot.controller || typeof source?.requestUpdates !== 'function') return;
    const controller = new AbortController();
    slot.controller = controller;
    try {
      const response = await source.requestUpdates(feedId, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`rail updates HTTP ${response.status}`);
      const body = await response.json();
      if (slot.controller !== controller) return;
      // Delays are as old as the server's read of the operator (`fetchedAt`),
      // not this answer: a cached copy, or the last good one replayed while
      // the operator fails, stops applying RAIL_UPDATES_MAX_AGE_MS after it,
      // as positions do (ingestion.js applySnapshot).
      const at = now();
      slot.delays = delaysFromUpdates(body);
      slot.at = Math.min(
        Number.isFinite(body?.fetchedAt) ? body.fetchedAt : at,
        at,
      );
      onChange(feedId);
    } catch (error) {
      if (error?.name !== 'AbortError')
        console.warn(
          `[Data:Rail] ${feedId} trip updates unavailable:`,
          error?.message || error,
        );
    } finally {
      if (slot.controller === controller) slot.controller = null;
    }
  }

  /**
   * Poll a feed's trip updates while `reason` needs them. Reasons are
   * counted, so every reader shares one poll.
   * @param {string} feedId
   * @param {string} reason
   */
  function watchUpdates(feedId, reason) {
    if (!hasTripUpdates(feedId)) return;
    const slot = updatesSlot(feedId);
    slot.reasons.add(reason);
    if (slot.timer !== null) return;
    void fetchUpdates(feedId);
    slot.timer = startInterval(
      () => void fetchUpdates(feedId),
      RAIL_UPDATES_POLL_MS,
    );
  }

  function unwatchUpdates(feedId, reason) {
    const slot = updates.get(feedId);
    if (!slot) return;
    slot.reasons.delete(reason);
    if (slot.reasons.size || slot.timer === null) return;
    stopInterval(slot.timer);
    slot.timer = null;
    slot.controller?.abort();
    slot.controller = null;
  }

  /** Current delays for a feed, or null when none are fresh. */
  function delaysFor(feedId) {
    const slot = updates.get(feedId);
    return slot?.delays && now() - slot.at <= RAIL_UPDATES_MAX_AGE_MS
      ? slot.delays
      : null;
  }

  /**
   * The run a live train is on. Its trip id when the timetable has it (live
   * GTFS trip ids are normally the static ones); otherwise, as a fallback,
   * the running run of its route nearest the train's report, kept for a
   * minute so the stop list does not hop between neighbouring runs. A train
   * its own report says is `liveDelayMs` late is compared with where the
   * timetable had each run that long ago.
   */
  function matchRun(schedule, train, nowMs, delays, liveDelayMs = 0) {
    const tripId = train.tripId || null;
    if (tripId && schedule.runsByTrip.has(tripId))
      return { trip: tripId, via: 'trip' };
    const record = train.record || {};
    if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon))
      return null;
    const key = `${train.feedId}\n${record.id ?? ''}`;
    const tripKey = `${tripId ?? ''}\n${train.routeId ?? ''}`;
    const kept = matches.get(key);
    if (kept && kept.tripKey === tripKey && nowMs - kept.at < MATCH_KEEP_MS)
      return kept.run ? { trip: kept.run, via: 'nearest' } : null;
    const pack = pathPackFor(train.feedId);
    // A uniform delay is a time shift: the run as timetabled that long ago.
    const matchMs = nowMs - liveDelayMs;
    let best = null;
    let bestM = MATCH_NEAREST_MAX_M;
    for (const run of activeTrips(schedule, matchMs, {
      delays,
      beforeMs: MATCH_BEFORE_MS,
      afterMs: MATCH_AFTER_MS,
    })) {
      if (train.routeId && run.routeId !== train.routeId) continue;
      const point = scheduledRunPoint(schedule, run, matchMs, delays, pack);
      if (!point) continue;
      const m = distanceM(record.lat, record.lon, point.lat, point.lon);
      if (m < bestM) {
        bestM = m;
        best = run;
      }
    }
    matches.set(key, { tripKey, run: best, at: nowMs });
    return best ? { trip: best, via: 'nearest' } : null;
  }

  /**
   * The stops provider (see createRailLayer): the selected train's stops and
   * headsign, or null until the feed's timetable has loaded (or when it has
   * none, or the train matches no run).
   * @param {{feedId: string, tripId: string|null, routeId: string|null,
   *   record: object}} train
   * @param {number} nowMs
   * @returns {{stops: object[], headsign: string|null,
   *   match: 'trip'|'nearest'}|null}
   */
  function stopsFor(train, nowMs) {
    if (!train?.feedId) return null;
    const schedule = scheduleFor(train.feedId);
    if (!schedule) return null;
    // A feed without trip updates: the delay the train's report states.
    const liveDelay = hasTripUpdates(train.feedId)
      ? null
      : liveDelaySec(train.record);
    const updates = liveDelay === null ? delaysFor(train.feedId) : null;
    const match = matchRun(
      schedule,
      train,
      nowMs,
      updates,
      (liveDelay ?? 0) * 1000,
    );
    if (!match) return null;
    const tripId =
      typeof match.trip === 'string' ? match.trip : match.trip.tripId;
    const delays =
      liveDelay === null
        ? updates
        : {
            [tripId]: {
              delaySec: liveDelay,
              startDate:
                typeof match.trip === 'string' ? null : match.trip.serviceDate,
            },
          };
    const stops = tripStops(schedule, match.trip, nowMs, delays);
    if (!stops.length) return null;
    const trip = schedule.trips.get(tripId);
    return {
      stops,
      headsign: trip?.headsign || null,
      match: match.via,
    };
  }

  /**
   * A train was selected (or the selection cleared): poll its delays once
   * its feed's timetable is loaded. Delays are shown only at the
   * timetable's stops, so a feed without one is not polled.
   */
  function onSelect(train) {
    const feedId = train?.feedId || null;
    if (feedId === selectedFeed) return;
    if (selectedFeed) unwatchUpdates(selectedFeed, 'selection');
    selectedFeed = feedId;
    if (!feedId) return;
    void loadSchedule(feedId).then((schedule) => {
      if (schedule && selectedFeed === feedId)
        watchUpdates(feedId, 'selection');
    });
  }

  /** Stop every poll; loaded schedules stay for the next enable. */
  function stop() {
    onSelect(null);
    for (const [feedId, slot] of updates)
      for (const reason of [...slot.reasons]) unwatchUpdates(feedId, reason);
    matches.clear();
  }

  /**
   * Release what is held for a feed no longer in use: its parsed schedule,
   * its last trip updates and its live-train matches. A load or a poll
   * still under way is left to finish; the feed loads again when next used.
   * @param {string} feedId
   */
  function forget(feedId) {
    if (schedules.get(feedId)?.status !== 'loading') schedules.delete(feedId);
    const slot = updates.get(feedId);
    if (slot && slot.reasons.size === 0 && slot.timer === null) {
      slot.controller?.abort();
      updates.delete(feedId);
    }
    const prefix = `${feedId}
`;
    for (const key of [...matches.keys()])
      if (key.startsWith(prefix)) matches.delete(key);
  }

  /** Counts for QA probes and tests. */
  function stats() {
    return {
      schedules: Object.fromEntries(
        [...schedules].map(([feedId, slot]) => [
          feedId,
          slot.status === 'ready'
            ? {
                status: 'ready',
                trips: slot.schedule.trips.size,
                runs: slot.schedule.instances.length,
              }
            : { status: slot.status },
        ]),
      ),
      updates: Object.fromEntries(
        [...updates].map(([feedId, slot]) => [
          feedId,
          {
            polling: slot.timer !== null,
            reasons: [...slot.reasons],
            trips: slot.delays ? Object.keys(slot.delays).length : 0,
            ageMs: Number.isFinite(slot.at) ? now() - slot.at : null,
          },
        ]),
      ),
    };
  }

  return {
    stopsFor,
    onSelect,
    loadSchedule,
    scheduleFor,
    watchUpdates,
    unwatchUpdates,
    delaysFor,
    stop,
    forget,
    stats,
  };
}

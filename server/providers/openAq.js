import { admitSameSite } from './common/same-site.js';
import {
  readCappedResponseText,
  readResponseJsonCapped,
} from './common/http.js';
import { createOpenAqBudget, OPENAQ_HOURLY_CALLS } from './openAqBudget.js';
import {
  normalizeOpenAqLocations,
  normalizeOpenAqLatest,
  normalizeOpenAqHours,
  normalizeOpenAqHourSeries,
  openAqHourReadings,
  OPENAQ_PARAMETER_NAMES,
} from '../../src/layers/airQuality/openAq.js';
import {
  OZONE_SERIES_HOURS,
  PM_NOWCAST_HOURS,
} from '../../src/layers/airQuality/nowcast.js';
import {
  AQI_MAX_SPREAD_MS,
  AQI_POLLUTANTS,
  aqiStations,
} from '../../src/layers/airQuality/usAqi.js';

/** Stations checked per pass. */
const BATCH = 4;
/** Matching sensors tried at one station before it counts as empty. */
const MAX_SENSORS = 3;
/** Time before retrying a failed station check. */
const STATION_RETRY_MS = 5 * 60_000;
/**
 * Requests one view may spend in an hour: a quarter of the hourly budget,
 * so a view left open cannot drain what pans and other views need.
 */
const VIEW_SHARE = Math.floor(OPENAQ_HOURLY_CALLS / 4);
/** Time between a view's station passes while they bring new readings. */
const PASS_MS = 8000;
/** The longest wait between passes that bring nothing new to the view. */
const MAX_PASS_MS = 2 * 60_000;
/**
 * Degrees from the view centre within which a reading counts as nearby: a
 * view with nearby readings paces its passes and keeps the budget's last
 * requests for them.
 */
const NEARBY_DEG = 5;
/** A reading older than this is no longer shown. */
const FRESH_MS = 6 * 3600_000;
/**
 * A shown station is checked again first once its newest reading is within
 * this of FRESH_MS: time for the view's share to come back (an hour) and
 * for a late hour to arrive, so what a view shows stays shown.
 */
const AGE_MARGIN_MS = 2 * 3600_000;
/**
 * Words of an OpenAQ refusal that is about the key or the account (a
 * missing, invalid or blocked key), not about one resource.
 */
const KEY_REFUSAL =
  /api[\s_-]?key|x-api-key|unauthori[sz]ed|authenticat|credential|blocked|suspended|banned/i;
const ROOT = 'https://api.openaq.org/v3/';
const HOUR = 3600_000;
/**
 * The US AQI view's pollutants read as hourly means (`usAqi.js`), with the
 * hours each one keeps: 12 for the PM NowCast and CO's 8-hour mean, two
 * weeks and two hours for the ozone NowCast. NO2 and SO2 are rated on
 * 1-hour values and read from the station's latest values.
 */
const AQI_HOURLY = Object.freeze({
  'PM2.5': PM_NOWCAST_HOURS,
  PM10: PM_NOWCAST_HOURS,
  O3: OZONE_SERIES_HOURS,
  CO: PM_NOWCAST_HOURS,
});
const AQI_LATEST = Object.freeze(['NO2', 'SO2']);
/** Sensors whose hourly means are kept; the least recently read go first. */
const MAX_SENSOR_SERIES = 2000;
/**
 * A past hour within this of now may still gain hours networks file late
 * (some hours after): its stations and hourly means are read again every
 * PAST_RECHECK_MS. An older hour's are read once.
 */
const PAST_FINAL_MS = 3 * 24 * HOUR;
const PAST_RECHECK_MS = HOUR;
/** A refused key is tried upstream again after this long, unless it changes. */
const REFUSED_KEY_MS = 10 * 60_000;
const error = (status, message) =>
  Object.assign(new Error(message), { status });
/**
 * One view's cache identity: the camera rectangle, what it asks (one
 * pollutant's hourly means or, with `mode: 'aqi'`, every pollutant's latest
 * value) and the hour it is asked for (`at`, none for now).
 */
const viewId = (view, parameter, mode, at) =>
  `${view.join(',')}|${parameter || mode || ''}|${at ?? ''}`;

/**
 * A sensor's hourly means of the six hours ending at `asOf` (at most 24,
 * so a full answer is too many and refused).
 */
async function hourWindow(get, sensor, asOf) {
  const data = await get(
    `sensors/${sensor.id}/hours?limit=24&page=1&datetime_from=${encodeURIComponent(new Date(asOf - 6 * HOUR).toISOString())}&datetime_to=${encodeURIComponent(new Date(asOf).toISOString())}`,
  );
  if (data.results.length >= 24)
    throw error(503, 'OpenAQ station exceeds acquisition limit');
  return data.results;
}

/**
 * The hour a snapshot is asked for: `at` (ms) floored to its hour, or null
 * for now (none asked, or within the current hour). A time ahead of now has
 * nothing to show and is refused.
 */
export function openAqHourAt(at, nowMs) {
  if (at === undefined || at === null) return null;
  if (!Number.isSafeInteger(at) || at < 0 || at > nowMs + 5 * 60_000)
    throw error(400, 'Invalid time');
  const hour = Math.floor(at / HOUR) * HOUR;
  return hour >= Math.floor(nowMs / HOUR) * HOUR ? null : hour;
}

/** Strict numeric viewport, including an optional antimeridian crossing. */
export function parseOpenAqView(value) {
  if (typeof value !== 'string' || value.length > 160)
    throw error(400, 'Invalid viewport');
  const fields = value.split(',');
  const a = fields.map(Number);
  if (
    a.length !== 6 ||
    fields.some((v) => !v.trim()) ||
    a.some((v) => !Number.isFinite(v)) ||
    Math.abs(a[0]) > 180 ||
    Math.abs(a[2]) > 180 ||
    Math.abs(a[4]) > 180 ||
    Math.abs(a[1]) > 90 ||
    Math.abs(a[3]) > 90 ||
    Math.abs(a[5]) > 90 ||
    a[0] === a[2] ||
    a[1] >= a[3]
  )
    throw error(400, 'Invalid viewport');
  return a;
}
const splitBox = ([w, s, e, n]) =>
  w < e
    ? [[w, s, e, n]]
    : [
        [w, s, 180, n],
        [-180, s, e, n],
      ];
const wrapLon = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
const inside = (station, [w, s, e, n]) =>
  station.lat >= s &&
  station.lat <= n &&
  (w <= e
    ? station.lon >= w && station.lon <= e
    : station.lon >= w || station.lon <= e);
// Stable catalog regions survive tiny pans, zooms and pollutant switches.
const catalogBox = ([w, s, e, n]) => {
  const step = e - w > 30 ? 10 : e - w > 10 ? 5 : 1;
  return [
    Math.max(-180, Math.floor(w / step) * step),
    Math.max(-90, Math.floor(s / step) * step),
    Math.min(180, Math.ceil(e / step) * step),
    Math.min(90, Math.ceil(n / step) * step),
  ];
};
function createViewState(view, time, previous) {
  const [w, s, e, n, lon, lat] = view;
  const width = (e - w + 360) % 360 || 360;
  const radius = Math.min(5, width / 2);
  const boxes = splitBox(view).filter((b) => b[0] < b[2]);
  const focus = splitBox([
    wrapLon(lon - radius),
    Math.max(s, lat - 5),
    wrapLon(lon + radius),
    Math.min(n, lat + 5),
  ]);
  const priority = focus
    .flatMap((a) =>
      boxes.map((b) => [
        Math.max(a[0], b[0]),
        Math.max(a[1], b[1]),
        Math.min(a[2], b[2]),
        Math.min(a[3], b[3]),
      ]),
    )
    .filter((b) => b[0] < b[2] && b[1] < b[3]);
  return {
    at: time,
    stations: new Map(),
    readings: previous?.readings ?? new Map(),
    checked: previous?.checked ?? new Map(),
    failed: previous?.failed ?? new Map(),
    // Requests this view spent in the last hour, its passes in a row that
    // brought nothing new, and when its next pass may start.
    spent: previous?.spent ?? [],
    idle: previous?.idle ?? 0,
    nextPassAt: previous?.nextPassAt ?? 0,
    pages: [
      ...new Map(
        [...priority, ...boxes]
          .map(catalogBox)
          .map((b) => [b.join(','), { bbox: b, page: 1, done: false }]),
      ).values(),
    ],
  };
}

/** Cancel upstream work only once all consumers of a coalesced view leave. */
function consumeView(job, signal) {
  return new Promise((resolve, reject) => {
    const consumer = {
      resolve,
      reject,
      leave: () => signal?.removeEventListener('abort', abort),
    };
    const abort = () => {
      consumer.leave();
      job.consumers.delete(consumer);
      if (!job.consumers.size) job.controller.abort();
      reject(signal.reason);
    };
    job.consumers.add(consumer);
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Bounded, demand-driven viewport acquisition with injected IO. */
export function createOpenAqAcquisition({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  getKey = () => process.env.OPENAQ_API_KEY || '',
} = {}) {
  let keyAtCache = null;
  /**
   * The key OpenAQ last refused, with its answer and when: it is not sent
   * upstream again until it changes or `REFUSED_KEY_MS` pass. A refusal is a
   * 401, or a 403 whose answer names the key or the account (`KEY_REFUSAL`);
   * any other 403 is one resource refused, and fails only that request.
   */
  let refused = null;
  const budget = createOpenAqBudget(now);
  const catalogPages = new Map();
  /**
   * Each sensor's hourly means for the AQI view, by sensor id: `{at, hours}`.
   * New hourly means appear once an hour, so a sensor is asked at most once
   * an hour, for the hours since its newest (three back, for late ones).
   */
  const sensorSeries = new Map();
  async function hoursOf(get, sensor, at = null) {
    const keep = AQI_HOURLY[sensor.parameter];
    const asOf = at ?? now();
    const id = `${sensor.id}@${at ?? ''}`;
    const cached = sensorSeries.get(id);
    const since = asOf - (keep + 1) * HOUR;
    const kept = (cached?.hours ?? []).filter((hour) => hour.endMs > since);
    // Now's means are read again hourly, for the hours since the newest
    // (three back, for late ones); a recent past hour's every
    // PAST_RECHECK_MS, all of them (a late network fills any); an older
    // one's once.
    const fresh =
      at === null
        ? now() - cached?.at < HOUR
        : now() - at > PAST_FINAL_MS || now() - cached?.at < PAST_RECHECK_MS;
    if (cached && fresh) return kept;
    const newest = kept.at(-1)?.endMs;
    const from =
      newest === undefined || at !== null
        ? since
        : Math.max(since, newest - 3 * HOUR);
    const data = await get(
      `sensors/${sensor.id}/hours?limit=1000&page=1&datetime_from=${encodeURIComponent(new Date(from).toISOString())}&datetime_to=${encodeURIComponent(new Date(asOf).toISOString())}`,
    );
    if (data.results.length >= 1000)
      throw error(503, 'OpenAQ sensor exceeds acquisition limit');
    const merged = new Map(kept.map((hour) => [hour.endMs, hour]));
    for (const hour of normalizeOpenAqHourSeries(sensor, data.results, asOf))
      if (hour.endMs > since) merged.set(hour.endMs, hour);
    const hours = [...merged.values()].sort((a, b) => a.endMs - b.endMs);
    sensorSeries.delete(id);
    sensorSeries.set(id, { at: now(), hours });
    while (sensorSeries.size > MAX_SENSOR_SERIES)
      sensorSeries.delete(sensorSeries.keys().next().value);
    return hours;
  }
  /**
   * One station's AQI-view reading: PM2.5, PM10, O3 and CO from their
   * sensors' hourly means, NO2 and SO2 from the latest values, folded into
   * one station with each pollutant on its averaging period (`aqiStations`).
   * For a past hour `at`, every pollutant comes from the hourly means up to
   * it: NO2 and SO2 from the newest within six hours, as the latest values
   * are taken now.
   */
  async function aqiStationRows(get, station, at = null) {
    const asOf = at ?? now();
    const rows = [];
    for (const parameter of Object.keys(AQI_HOURLY)) {
      // The first sensor with a current hour (within the last three, the
      // NowCast's window) supplies the pollutant: one whose hours stopped
      // (a replaced instrument) gives way to the next, and only when none
      // is current do the freshest hours stand.
      let best = null;
      for (const sensor of station.sensors
        .filter((s) => s.parameter === parameter)
        .slice(0, MAX_SENSORS)) {
        const hours = await hoursOf(get, sensor, at);
        if (!hours.length) continue;
        if (!best || hours.at(-1).endMs > best.hours.at(-1).endMs)
          best = { sensor, hours };
        if (asOf - hours.at(-1).endMs <= AQI_MAX_SPREAD_MS) break;
      }
      if (best)
        rows.push(...openAqHourReadings(station, best.sensor, best.hours));
    }
    if (at !== null)
      for (const parameter of AQI_LATEST)
        for (const sensor of station.sensors
          .filter((s) => s.parameter === parameter)
          .slice(0, MAX_SENSORS)) {
          const hour = normalizeOpenAqHours(
            station,
            sensor,
            await hourWindow(get, sensor, at),
            at,
          );
          if (!hour.length) continue;
          rows.push(...hour);
          break;
        }
    else if (station.sensors.some((s) => AQI_LATEST.includes(s.parameter))) {
      const data = await get(
        `locations/${station.stationId}/latest?limit=1000&page=1`,
      );
      if (data.results.length >= 1000)
        throw error(503, 'OpenAQ station exceeds acquisition limit');
      rows.push(
        ...normalizeOpenAqLatest(station, data.results, now()).filter((row) =>
          AQI_LATEST.includes(row.parameter),
        ),
      );
    }
    return aqiStations(rows);
  }
  const viewLatest = new Map();
  const views = new Map(),
    viewCache = new Map(),
    viewPending = new Map();
  async function acquireView(
    upstream,
    view,
    parameter,
    mode,
    at,
    signal,
    cancel,
  ) {
    const id = viewId(view, parameter, mode, at);
    // The time the view's readings are for: the hour asked, else now. Ages
    // and windows are judged at it; the budget, backoffs and asks keep the
    // wall clock.
    const asOf = () => at ?? now();
    const rowKey = (station) =>
      `${station.stationId}:${parameter || mode || ''}@${at ?? ''}`;
    let state = views.get(id);
    if (!state || now() - state.at > HOUR)
      state = createViewState(view, now(), state);
    // Requests this view sent to OpenAQ in the last hour.
    const spentInHour = () => {
      state.spent = state.spent.filter((at) => now() - at < HOUR);
      return state.spent.length;
    };
    // The share is checked before every request, and a request counts
    // against it only once it is sent: one refused locally (the shared
    // budget spent, or the view aborted) costs this view nothing.
    const get = (path) => {
      if (spentInHour() >= VIEW_SHARE)
        return Promise.reject(
          Object.assign(error(429, 'OpenAQ view share spent'), {
            shareSpent: true,
          }),
        );
      return upstream(path, () => state.spent.push(now()));
    };
    views.delete(id);
    views.set(id, state);
    while (views.size > 8) {
      const oldest = views.keys().next().value;
      views.delete(oldest);
      viewCache.delete(oldest);
    }
    let catalogFailure = null,
      stationFailure = null,
      limited = false,
      succeeded = 0;
    let timedOut = false;
    const expired = () => signal.aborted && !cancel?.aborted;
    let retryAt = null;
    // Keep observations across view-cache eviction and even when discovery is blocked.
    for (const entry of viewLatest.values())
      if (
        entry.station &&
        inside(entry.station, view) &&
        !state.stations.has(entry.station.stationId)
      )
        state.stations.set(entry.station.stationId, entry.station);
    // Reuse completed covering regions before spending a request. At most one
    // uncached catalog page per pass leaves capacity for actual observations.
    for (let i = 0; i < 4; i++) {
      if (expired()) {
        timedOut = true;
        break;
      }
      signal?.throwIfAborted();
      const page = state.pages.find((p) => !p.done);
      if (!page) break;
      const pageId = `${page.bbox.join(',')}|${page.page}`;
      let cachedPage = catalogPages.get(pageId);
      if (cachedPage && now() - cachedPage.at >= HOUR) cachedPage = null;
      if (!cachedPage && page.page === 1) {
        cachedPage = [...catalogPages.values()].find(
          (p) =>
            p.complete &&
            now() - p.at < HOUR &&
            p.bbox[0] <= page.bbox[0] &&
            p.bbox[1] <= page.bbox[1] &&
            p.bbox[2] >= page.bbox[2] &&
            p.bbox[3] >= page.bbox[3],
        );
      }
      // Discovery keeps to the view's share of the hour too.
      if (!cachedPage && spentInHour() >= VIEW_SHARE) break;
      try {
        const data =
          cachedPage ||
          (await get(
            `locations?bbox=${page.bbox.join(',')}&limit=1000&page=${page.page}&order_by=id&sort_order=asc&mobile=false`,
          ).then((data) => ({
            at: now(),
            bbox: page.bbox,
            stations: normalizeOpenAqLocations(data.results),
            complete: page.page === 1 && data.results.length < 1000,
            done: data.results.length < 1000,
          })));
        if (!cachedPage) {
          catalogPages.set(pageId, data);
          while (catalogPages.size > 64)
            catalogPages.delete(catalogPages.keys().next().value);
        }
        for (const station of data.stations) {
          if (!inside(station, view)) continue;
          if (
            state.stations.size >= 100_000 &&
            !state.stations.has(station.stationId)
          )
            throw error(503, 'OpenAQ viewport exceeds memory limit');
          state.stations.set(station.stationId, station);
        }
        page.page++;
        page.done = data.done;
        if (!cachedPage) break;
      } catch (e) {
        if (expired()) {
          timedOut = true;
          break;
        }
        signal?.throwIfAborted();
        if (e.keyRefused) throw e;
        if (e.shareSpent) break;
        if (e.status === 429) limited = true;
        else catalogFailure = e.status || 503;
        retryAt = e.retryAt || null;
        break;
      }
    }
    const eligible = [...state.stations.values()].filter(
      (s) =>
        (!s.lastObservedMs || asOf() - s.lastObservedMs <= FRESH_MS) &&
        // A past hour spends nothing on a station that began reporting later.
        (!s.firstObservedMs || s.firstObservedMs <= asOf()) &&
        (!parameter ||
          s.sensors.some((sensor) => sensor.parameter === parameter)) &&
        // The AQI view spends no request on a station it cannot rate: one
        // without the index's pollutants, or a low-cost sensor (the EPA's
        // categories are for reference monitors).
        (mode !== 'aqi' ||
          (s.monitor !== false &&
            s.sensors.some((sensor) => AQI_POLLUTANTS[sensor.parameter]))),
    );
    // Overlapping pans/zooms reuse recent station checks without spending the
    // shared request budget again. Only stations discovered in this view join.
    for (const station of eligible) {
      const previous = viewLatest.get(rowKey(station));
      if (
        previous &&
        previous.at >= (state.checked.get(station.stationId) ?? -Infinity)
      ) {
        // A due refresh must not erase still-current observations during cooldown.
        state.readings.set(
          station.stationId,
          previous.readings.filter(
            (row) => asOf() - row.observedMs <= FRESH_MS,
          ),
        );
        state.checked.set(station.stationId, previous.at);
      }
    }
    const distance = (s) =>
      Math.hypot(
        wrapLon(s.lon - view[4]) * Math.cos((view[5] * Math.PI) / 180),
        s.lat - view[5],
      );
    const backoff = (s) =>
      now() - (state.failed.get(s.stationId) ?? -Infinity) < STATION_RETRY_MS;
    // The AQI view's hourly means change once an hour: its stations are
    // checked hourly, the pollutant views' every 20 minutes. A recent past
    // hour's stations are checked again every PAST_RECHECK_MS, for hours
    // filed late; an older hour's once.
    const checkMs =
      at === null
        ? mode === 'aqi'
          ? HOUR
          : 20 * 60_000
        : now() - at > PAST_FINAL_MS
          ? Infinity
          : PAST_RECHECK_MS;
    const needsCheck = (s) =>
      now() - (state.checked.get(s.stationId) ?? -Infinity) >= checkMs;
    const newestOf = (list) =>
      (list ?? []).reduce((at, row) => Math.max(at, row.observedMs), -Infinity);
    // When a station's shown readings age out; -Infinity when none is shown.
    const shownUntil = (s) => {
      const until =
        newestOf(state.readings.get(s.stationId)) + FRESH_MS - asOf() + now();
      return until > now() ? until : -Infinity;
    };
    // Which stations a pass checks first: shown ones about to age out (the
    // soonest first), then those never checked, then the other shown ones
    // (the oldest reading first), then those checked before that had nothing
    // current (the longest ago first); nearest the centre first among equals.
    // What a view shows stays shown and refreshed, and what its share can
    // keep fresh beyond that grows it, so a wide view settles on a stable set.
    const tier = (s) => {
      const until = shownUntil(s);
      if (until === -Infinity) return state.checked.has(s.stationId) ? 3 : 1;
      return until - now() <= AGE_MARGIN_MS ? 0 : 2;
    };
    const due = eligible
      .filter((s) => needsCheck(s) && !backoff(s))
      .map((s) => ({ s, tier: tier(s), until: shownUntil(s) }))
      .sort(
        (a, b) =>
          a.tier - b.tier ||
          (a.tier === 1 || a.tier === 3
            ? (state.checked.get(a.s.stationId) || 0) -
              (state.checked.get(b.s.stationId) || 0)
            : a.until - b.until) ||
          distance(a.s) - distance(b.s),
      )
      .map(({ s }) => s)
      // Leave capacity for subsequent camera moves and other active views.
      // A stationary view continues discovery on its next refresh.
      .slice(0, BATCH);
    const hasNearby = [...state.readings.values()]
      .flat()
      .some((r) => distance(r) < NEARBY_DEG);
    const lastNearbyCheck = eligible.reduce(
      (latest, station) =>
        distance(station) < NEARBY_DEG
          ? Math.max(latest, state.checked.get(station.stationId) || 0)
          : latest,
      0,
    );
    const available = budget.state();
    spentInHour();
    if (due.length && hasNearby && now() - lastNearbyCheck < PASS_MS) {
      due.length = 0;
      retryAt = Math.max(retryAt || 0, lastNearbyCheck + PASS_MS);
    } else if (due.length && state.spent.length >= VIEW_SHARE) {
      due.length = 0;
    } else if (due.length && now() < state.nextPassAt) {
      due.length = 0;
    } else if (due.length && hasNearby && available.remaining <= 16) {
      due.length = 0;
      retryAt = Math.max(
        retryAt || 0,
        available.retryAt || available.nextMinute + 250,
      );
    }
    // Two bounded workers shorten the time to first visible markers; all share
    // the same process request budget as other views.
    let progress = false;
    for (
      let i = 0;
      i < due.length && !limited && !timedOut && spentInHour() < VIEW_SHARE;
      i += 2
    ) {
      if (expired()) {
        timedOut = true;
        break;
      }
      signal?.throwIfAborted();
      const results = await Promise.allSettled(
        due.slice(i, i + 2).map(async (station) => {
          try {
            let rows = [];
            if (mode === 'aqi') rows = await aqiStationRows(get, station, at);
            else
              for (const sensor of parameter
                ? station.sensors
                    .filter((s) => s.parameter === parameter)
                    .slice(0, MAX_SENSORS)
                : [null]) {
                if (sensor)
                  rows = normalizeOpenAqHours(
                    station,
                    sensor,
                    await hourWindow(get, sensor, asOf()),
                    asOf(),
                  );
                else {
                  const data = await get(
                    `locations/${station.stationId}/latest?limit=1000&page=1`,
                  );
                  if (data.results.length >= 1000)
                    throw error(
                      503,
                      'OpenAQ station exceeds acquisition limit',
                    );
                  rows = normalizeOpenAqLatest(station, data.results, now());
                }
                if (rows.length) break;
              }
            const previous = viewLatest.get(rowKey(station));
            if (previous && newestOf(previous.readings) > newestOf(rows))
              rows = previous.readings;
            // A station newly shown or with a newer current reading is
            // progress, wherever it is in the view; rows older than the view
            // keeps are not.
            if (
              newestOf(rows) > asOf() - FRESH_MS &&
              newestOf(rows) > newestOf(state.readings.get(station.stationId))
            )
              progress = true;
            state.readings.set(station.stationId, rows);
            state.checked.set(station.stationId, now());
            state.failed.delete(station.stationId);
            succeeded++;
            viewLatest.delete(rowKey(station));
            viewLatest.set(rowKey(station), {
              at: now(),
              station,
              readings: state.readings.get(station.stationId),
            });
            while (viewLatest.size > 5_000)
              viewLatest.delete(viewLatest.keys().next().value);
          } catch (e) {
            if (expired()) {
              timedOut = true;
              state.failed.set(station.stationId, now());
              return;
            }
            signal?.throwIfAborted();
            if (e.keyRefused) throw e;
            // The share ran out within this station: it is asked again
            // once the share allows, not counted as failed.
            if (e.shareSpent) return;
            if (e.status === 429) limited = true;
            else {
              stationFailure = 503;
              state.failed.set(station.stationId, now());
            }
            retryAt = e.retryAt || retryAt;
          }
        }),
      );
      const rejected = results.find((r) => r.status === 'rejected');
      if (rejected) throw rejected.reason;
    }
    // A pass that brought nothing new to the view doubles the wait before
    // the next one (to MAX_PASS_MS); one that did starts it over.
    if (due.length) {
      state.idle = progress ? 0 : state.idle + 1;
      state.nextPassAt =
        now() + Math.min(MAX_PASS_MS, PASS_MS * 2 ** state.idle);
    }
    const fresh = [...state.readings.values()]
      .flat()
      .filter((r) => asOf() - r.observedMs <= FRESH_MS);
    // A failed station check makes the view stale only once no station of it
    // has a check younger than the check interval.
    const stale =
      limited ||
      catalogFailure !== null ||
      (stationFailure !== null &&
        ![...state.checked.values()].some((at) => now() - at < checkMs));
    const failureStatus = !stale
      ? null
      : limited
        ? 429
        : (catalogFailure ?? stationFailure);
    // Nothing acquired yet: a failure, not a cached view.
    if (stale && !limited && !state.readings.size)
      throw Object.assign(error(failureStatus, 'OpenAQ request unavailable'), {
        retryAt: retryAt ?? now() + 60_000,
      });
    // The deadline before any catalog page or reading: a failure, not an
    // empty view.
    if (
      timedOut &&
      !state.readings.size &&
      state.pages.every((p) => p.page === 1)
    )
      throw Object.assign(error(503, 'OpenAQ request unavailable'), {
        retryAt: now() + 60_000,
      });
    const waiting = eligible.filter(needsCheck);
    // A station's own backoff stays out of the view's retry time: a later
    // refresh asks it again once that backoff ends.
    const ready = waiting.some((s) => !backoff(s));
    // Nothing acquired and every station left only waits out its backoff
    // after failing: still a failure, asked again when the first one ends.
    if (!limited && !state.readings.size && !ready && waiting.some(backoff))
      throw Object.assign(error(503, 'OpenAQ request unavailable'), {
        retryAt: waiting.reduce(
          (at, s) =>
            backoff(s)
              ? Math.min(at, state.failed.get(s.stationId) + STATION_RETRY_MS)
              : at,
          Infinity,
        ),
      });
    const catalogDone = state.pages.every((p) => p.done);
    // When this view may ask again: once its oldest request of the hour
    // leaves the hour when it spent its share, else at its next pass (later
    // after passes that brought nothing new); discovery goes on
    // between passes.
    const shareSpent = spentInHour() >= VIEW_SHARE;
    const nextAsk = shareSpent
      ? state.spent[0] + HOUR
      : !catalogDone || timedOut
        ? now() + PASS_MS
        : ready
          ? Math.max(now() + PASS_MS, state.nextPassAt)
          : null;
    return {
      schemaVersion: 1,
      source: 'OpenAQ',
      sourceUrl: 'https://openaq.org/',
      scope: 'viewport',
      view,
      // The hour answered for, or null for now.
      at,
      // Counts, not the catalogue: the browser reads only how far along
      // discovery is, and the catalogue stays on the server.
      stationCount: state.stations.size,
      // The AQI view answers one reading per station with all its values.
      readings: mode === 'aqi' ? aqiStations(fresh) : fresh,
      checked: eligible.filter((s) => state.checked.has(s.stationId)).length,
      eligible: eligible.length,
      countriesReporting: new Set(fresh.map((r) => r.country)).size,
      catalogComplete: catalogDone,
      partial:
        stale ||
        timedOut ||
        !catalogDone ||
        eligible.some((s) => !state.checked.has(s.stationId)),
      stale,
      failureStatus,
      retryAt: retryAt || (stale ? now() + 60_000 : nextAsk),
    };
  }
  async function acquire(key, view, parameter, mode, at, consumerSignal) {
    const signal = AbortSignal.any([
      AbortSignal.timeout(40_000),
      ...(consumerSignal ? [consumerSignal] : []),
    ]);
    async function get(path, sent) {
      signal.throwIfAborted();
      budget.take();
      sent?.();
      const res = await fetchImpl(ROOT + path, {
        headers: { 'X-API-Key': key, Accept: 'application/json' },
        signal,
        redirect: 'error',
      });
      budget.observe(res);
      if (res.status === 401 || res.status === 403) {
        // A 403 refuses the key only when its answer says so.
        const keyRefused =
          res.status === 401 ||
          KEY_REFUSAL.test(
            (await readCappedResponseText(res, 16 * 1024).catch(() => null))
              ?.text ?? '',
          );
        if (keyRefused) {
          refused = { key, status: res.status, at: now() };
          throw Object.assign(error(res.status, 'OpenAQ key rejected'), {
            keyRefused,
          });
        }
        throw Object.assign(error(503, 'OpenAQ request unavailable'), {
          upstreamStatus: 403,
        });
      }
      if (!res.ok) {
        throw Object.assign(
          error(
            [404, 429].includes(res.status) ? res.status : 503,
            'OpenAQ request unavailable',
          ),
          { retryAt: budget.state().retryAt },
        );
      }
      const data = await readResponseJsonCapped(res, 8 * 1024 * 1024, signal);
      if (!Array.isArray(data?.results) || data.results.length > 1000)
        throw error(503, 'Malformed OpenAQ response');
      return data;
    }
    return acquireView(get, view, parameter, mode, at, signal, consumerSignal);
  }
  return {
    /**
     * A viewport snapshot asks either one `parameter` (its hourly means) or,
     * with `mode: 'aqi'`, every pollutant's latest value per station. `at`
     * (ms) asks a past hour instead of now: the hourly means up to it, for
     * one pollutant or the US AQI view.
     */
    async getSnapshot({ view, parameter, mode, at, signal } = {}) {
      signal?.throwIfAborted();
      if (
        parameter !== undefined &&
        !Object.values(OPENAQ_PARAMETER_NAMES).includes(parameter)
      )
        throw error(400, 'Invalid pollutant');
      if (mode !== undefined && (mode !== 'aqi' || parameter !== undefined))
        throw error(400, 'Invalid air quality mode');
      if (view) view = parseOpenAqView(view.join(','));
      at = openAqHourAt(at, now());
      if (at !== null && !parameter && mode !== 'aqi')
        throw error(400, 'A past hour needs a pollutant');
      const key = getKey().trim();
      if (!key) throw error(428, 'OpenAQ key required');
      if (refused?.key === key && now() - refused.at < REFUSED_KEY_MS)
        throw error(refused.status, 'OpenAQ key rejected');
      if (!view) throw error(400, 'Viewport required');
      if (key !== keyAtCache) {
        if (viewPending.size)
          await Promise.allSettled(
            [...viewPending.values()].map((job) => job.promise),
          );
        keyAtCache = key;
        views.clear();
        catalogPages.clear();
        sensorSeries.clear();
        viewLatest.clear();
        viewCache.clear();
      }
      const id = viewId(view, parameter, mode, at);
      const previous = viewCache.get(id);
      if (previous && now() < (previous.value.retryAt || previous.at + 60_000))
        return previous.value;
      let job = viewPending.get(id);
      if (job?.controller.signal.aborted) {
        await job.promise.catch(() => {});
        job = viewPending.get(id);
      }
      if (!job) {
        if (viewPending.size >= 2)
          throw Object.assign(error(429, 'OpenAQ viewport requests busy'), {
            retryAt: now() + 2000,
          });
        job = { controller: new AbortController(), consumers: new Set() };
        job.promise = acquire(
          key,
          view,
          parameter,
          mode,
          at,
          job.controller.signal,
        )
          .then((value) => {
            if (views.has(id)) viewCache.set(id, { value, at: now() });
            return value;
          })
          .finally(() => {
            if (viewPending.get(id) === job) viewPending.delete(id);
          });
        const settle = (method, outcome) => {
          for (const consumer of job.consumers) {
            consumer.leave();
            consumer[method](outcome);
          }
          job.consumers.clear();
        };
        // One handler per job, which also keeps an abandoned job's rejection handled.
        job.promise.then(
          (value) => settle('resolve', value),
          (e) => settle('reject', e),
        );
        viewPending.set(id, job);
      }
      return consumeView(job, signal);
    },
  };
}

/** Fixed local route. Browser never supplies an upstream URL or credential. */
export function openAqProxy(options = {}) {
  const source = createOpenAqAcquisition(options);
  const handler = async (req, res) => {
    if (admitSameSite(req, res)) return;
    const send = (status, data) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    const controller = new AbortController();
    const disconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once?.('close', disconnect);
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (
        url.pathname !== '/' ||
        [...url.searchParams.keys()].some(
          (k) => !['view', 'parameter', 'mode', 'at'].includes(k),
        ) ||
        url.searchParams.getAll('at').length > 1 ||
        (url.searchParams.has('at') &&
          !/^\d{1,15}$/.test(url.searchParams.get('at'))) ||
        url.searchParams.getAll('view').length > 1 ||
        url.searchParams.getAll('parameter').length > 1 ||
        url.searchParams.getAll('mode').length > 1
      )
        return send(400, { error: 'invalid_air_quality_query' });
      const view = url.searchParams.has('view')
        ? parseOpenAqView(url.searchParams.get('view'))
        : undefined;
      send(
        200,
        await source.getSnapshot({
          view,
          parameter: url.searchParams.get('parameter') ?? undefined,
          mode: url.searchParams.get('mode') ?? undefined,
          at: url.searchParams.has('at')
            ? Number(url.searchParams.get('at'))
            : undefined,
          signal: controller.signal,
        }),
      );
    } catch (e) {
      send(e.status || 503, {
        error:
          e.status === 428
            ? 'no_key'
            : e.status === 403
              ? 'access_denied'
              : e.status === 401
                ? 'key_rejected'
                : 'OpenAQ unavailable',
        retryAt: e.retryAt || null,
      });
    } finally {
      res.removeListener?.('close', disconnect);
    }
  };
  const register = ({ middlewares }) => {
    middlewares.use('/api/air-quality/openaq', handler);
  };
  return {
    name: 'openaq-air-quality',
    configureServer: register,
    configurePreviewServer: register,
  };
}

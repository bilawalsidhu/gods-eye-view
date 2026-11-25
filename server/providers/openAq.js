import { admitSameSite } from './common/same-site.js';
import { readResponseJsonCapped } from './common/http.js';
import { createOpenAqBudget } from './openAqBudget.js';
import {
  normalizeOpenAqLocations,
  normalizeOpenAqLatest,
  normalizeOpenAqHours,
  OPENAQ_PARAMETER_NAMES,
} from '../../src/layers/airQuality/openAq.js';
import {
  AQI_POLLUTANTS,
  aqiStations,
} from '../../src/layers/airQuality/usAqi.js';

/** Stations checked per pass. */
const BATCH = 4;
/** Matching sensors tried at one station before it counts as empty. */
const MAX_SENSORS = 3;
/** Time before retrying a failed station check. */
const STATION_RETRY_MS = 5 * 60_000;
const ROOT = 'https://api.openaq.org/v3/';
const HOUR = 3600_000;
/** A refused key is tried upstream again after this long, unless it changes. */
const REFUSED_KEY_MS = 10 * 60_000;
const error = (status, message) =>
  Object.assign(new Error(message), { status });
/**
 * One view's cache identity: the camera rectangle and what it asks, one
 * pollutant's hourly means or (`mode: 'aqi'`) every pollutant's latest value.
 */
const viewId = (view, parameter, mode) =>
  `${view.join(',')}|${parameter || mode || ''}`;

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
   * The key OpenAQ last refused (401 or 403), with its answer and when: it is
   * not sent upstream again until it changes or `REFUSED_KEY_MS` pass.
   */
  let refused = null;
  const budget = createOpenAqBudget(now);
  const catalogPages = new Map();
  const viewLatest = new Map();
  const views = new Map(),
    viewCache = new Map(),
    viewPending = new Map();
  async function acquireView(get, view, parameter, mode, signal, cancel) {
    const id = viewId(view, parameter, mode);
    let state = views.get(id);
    if (!state || now() - state.at > HOUR)
      state = createViewState(view, now(), state);
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
        if ([401, 403].includes(e.status)) throw e;
        if (e.status === 429) limited = true;
        else catalogFailure = e.status || 503;
        retryAt = e.retryAt || null;
        break;
      }
    }
    const eligible = [...state.stations.values()].filter(
      (s) =>
        (!s.lastObservedMs || now() - s.lastObservedMs <= 6 * HOUR) &&
        (!parameter ||
          s.sensors.some((sensor) => sensor.parameter === parameter)) &&
        // The AQI view spends no request on a station it cannot rate.
        (mode !== 'aqi' ||
          s.sensors.some((sensor) => AQI_POLLUTANTS[sensor.parameter])),
    );
    // Overlapping pans/zooms reuse recent station checks without spending the
    // shared request budget again. Only stations discovered in this view join.
    for (const station of eligible) {
      const previous = viewLatest.get(
        `${station.stationId}:${parameter || ''}`,
      );
      if (
        previous &&
        previous.at >= (state.checked.get(station.stationId) ?? -Infinity)
      ) {
        // A due refresh must not erase still-current observations during cooldown.
        state.readings.set(
          station.stationId,
          previous.readings.filter((row) => now() - row.observedMs <= 6 * HOUR),
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
    const needsCheck = (s) =>
      now() - (state.checked.get(s.stationId) ?? -Infinity) >= 20 * 60_000;
    const due = eligible
      .filter((s) => needsCheck(s) && !backoff(s))
      .sort(
        (a, b) =>
          (state.checked.get(a.stationId) || 0) -
            (state.checked.get(b.stationId) || 0) || distance(a) - distance(b),
      )
      // Leave capacity for subsequent camera moves and other active views.
      // A stationary view continues discovery on its next refresh.
      .slice(0, BATCH);
    const hasNearby = [...state.readings.values()]
      .flat()
      .some((r) => distance(r) < 5);
    const lastNearbyCheck = eligible.reduce(
      (latest, station) =>
        distance(station) < 5
          ? Math.max(latest, state.checked.get(station.stationId) || 0)
          : latest,
      0,
    );
    const available = budget.state();
    if (due.length && hasNearby && now() - lastNearbyCheck < 8000) {
      due.length = 0;
      retryAt = Math.max(retryAt || 0, lastNearbyCheck + 8000);
    } else if (due.length && hasNearby && available.remaining <= 16) {
      due.length = 0;
      retryAt = Math.max(
        retryAt || 0,
        available.retryAt || available.nextMinute + 250,
      );
    }
    // Two bounded workers shorten the time to first visible markers; all share
    // the same process request budget as other views.
    for (let i = 0; i < due.length && !limited && !timedOut; i += 2) {
      if (expired()) {
        timedOut = true;
        break;
      }
      signal?.throwIfAborted();
      const results = await Promise.allSettled(
        due.slice(i, i + 2).map(async (station) => {
          try {
            const sensors = parameter
              ? station.sensors
                  .filter((s) => s.parameter === parameter)
                  .slice(0, MAX_SENSORS)
              : [null];
            let rows = [];
            for (const sensor of sensors) {
              const data = await get(
                sensor
                  ? `sensors/${sensor.id}/hours?limit=24&page=1&datetime_from=${encodeURIComponent(new Date(now() - 6 * HOUR).toISOString())}&datetime_to=${encodeURIComponent(new Date(now()).toISOString())}`
                  : `locations/${station.stationId}/latest?limit=1000&page=1`,
              );
              if (data.results.length >= (sensor ? 24 : 1000))
                throw error(503, 'OpenAQ station exceeds acquisition limit');
              rows = sensor
                ? normalizeOpenAqHours(station, sensor, data.results, now())
                : normalizeOpenAqLatest(station, data.results, now());
              if (rows.length) break;
            }
            const key = `${station.stationId}:${parameter || ''}`;
            const previous = viewLatest.get(key);
            const newest = (list) =>
              list.reduce((at, row) => Math.max(at, row.observedMs), -Infinity);
            if (previous && newest(previous.readings) > newest(rows))
              rows = previous.readings;
            state.readings.set(station.stationId, rows);
            state.checked.set(station.stationId, now());
            state.failed.delete(station.stationId);
            succeeded++;
            viewLatest.delete(`${station.stationId}:${parameter || ''}`);
            viewLatest.set(`${station.stationId}:${parameter || ''}`, {
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
            if ([401, 403].includes(e.status)) throw e;
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
    const fresh = [...state.readings.values()]
      .flat()
      .filter((r) => now() - r.observedMs <= 6 * HOUR);
    // A failed station check makes the view stale only once no station of it
    // has a check younger than the check interval.
    const stale =
      limited ||
      catalogFailure !== null ||
      (stationFailure !== null &&
        ![...state.checked.values()].some((at) => now() - at < 20 * 60_000));
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
    const catalogDone = state.pages.every((p) => p.done);
    const waiting = eligible.filter(needsCheck);
    // A station's own backoff stays out of the view's retry time: a later
    // refresh asks it again once that backoff ends.
    const ready = waiting.some((s) => !backoff(s));
    return {
      schemaVersion: 1,
      source: 'OpenAQ',
      sourceUrl: 'https://openaq.org/',
      scope: 'viewport',
      view,
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
      retryAt:
        retryAt ||
        (stale
          ? now() + 60_000
          : !catalogDone || ready || timedOut
            ? now() + 8000
            : null),
    };
  }
  async function acquire(key, view, parameter, mode, consumerSignal) {
    const signal = AbortSignal.any([
      AbortSignal.timeout(40_000),
      ...(consumerSignal ? [consumerSignal] : []),
    ]);
    async function get(path) {
      signal.throwIfAborted();
      budget.take();
      const res = await fetchImpl(ROOT + path, {
        headers: { 'X-API-Key': key, Accept: 'application/json' },
        signal,
        redirect: 'error',
      });
      budget.observe(res);
      if (res.status === 401 || res.status === 403)
        refused = { key, status: res.status, at: now() };
      if (!res.ok) {
        throw Object.assign(
          error(
            [401, 403, 404, 429].includes(res.status) ? res.status : 503,
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
    return acquireView(get, view, parameter, mode, signal, consumerSignal);
  }
  return {
    /**
     * A viewport snapshot asks either one `parameter` (its hourly means) or,
     * with `mode: 'aqi'`, every pollutant's latest value per station.
     */
    async getSnapshot({ view, parameter, mode, signal } = {}) {
      signal?.throwIfAborted();
      if (
        parameter !== undefined &&
        !Object.values(OPENAQ_PARAMETER_NAMES).includes(parameter)
      )
        throw error(400, 'Invalid pollutant');
      if (mode !== undefined && (mode !== 'aqi' || parameter !== undefined))
        throw error(400, 'Invalid air quality mode');
      if (view) view = parseOpenAqView(view.join(','));
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
        viewLatest.clear();
        viewCache.clear();
      }
      const id = viewId(view, parameter, mode);
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
        job.promise = acquire(key, view, parameter, mode, job.controller.signal)
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
          (k) => !['view', 'parameter', 'mode'].includes(k),
        ) ||
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

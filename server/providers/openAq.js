import { readResponseJsonCapped } from './common/http.js';
import {
  normalizeOpenAqLocations,
  normalizeOpenAqLatest,
  normalizeOpenAqHours,
  OPENAQ_PARAMETER_NAMES,
} from '../../src/layers/airQuality/openAq.js';

// Geographic scope is configuration, not a station/city allowlist. UN M49 Africa
// countries/areas, including Indian/Atlantic Ocean islands and territories.
// https://unstats.un.org/unsd/methodology/m49/
export const AFRICA_SCOPE = Object.freeze({
  id: 'africa',
  countries: Object.freeze(
    'DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU YT MA MZ NA NE NG RE RW SH ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW IO TF'.split(
      ' ',
    ),
  ),
});
export const GLOBAL_SCOPE = Object.freeze({ id: 'global', countries: null });
const ROOT = 'https://api.openaq.org/v3/';
const HOUR = 3600_000;
const error = (status, message) =>
  Object.assign(new Error(message), { status });

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
function createViewState(view, time) {
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
    readings: new Map(),
    checked: new Map(),
    pages: [
      ...new Map(
        [...priority, ...boxes].map((b) => [
          b.join(','),
          { bbox: b, page: 1, done: false },
        ]),
      ).values(),
    ],
  };
}

/** Bounded, demand-driven acquisition with injected scope and IO. */
export function createOpenAqAcquisition({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  getKey = () => process.env.OPENAQ_API_KEY || '',
  scope = GLOBAL_SCOPE,
  batchSize = 24,
} = {}) {
  if (
    !(scope.countries === null || scope.countries?.length) ||
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 24
  )
    throw new TypeError('Invalid OpenAQ scope or batch size');
  let keyAtCache = null,
    catalog = null,
    catalogAt = 0,
    pending = null,
    cached = null,
    cachedAt = 0,
    blockedUntil = 0;
  const readings = new Map(),
    checked = new Map();
  let calls = [];
  let discoveryPage = 1,
    discoveryDone = false,
    discoveryAt = 0;
  const globalCatalog = new Map();
  let discoverySeen = new Set(),
    parameterPages = null,
    parameterCursor = 0;
  const globalReadings = new Map();
  const viewLatest = new Map();
  const views = new Map(),
    viewCache = new Map(),
    viewPending = new Map();
  async function acquireView(get, view, parameter) {
    const id = `${view.join(',')}|${parameter || ''}`;
    let state = views.get(id);
    if (!state || now() - state.at > HOUR) state = createViewState(view, now());
    views.delete(id);
    views.set(id, state);
    while (views.size > 8) {
      const oldest = views.keys().next().value;
      views.delete(oldest);
      viewCache.delete(oldest);
    }
    let failed = false;
    let failureStatus = null;
    // Query the focus area first, then resume the full viewport catalog.
    for (let i = 0; i < 2; i++) {
      const page = state.pages.find((p) => !p.done);
      if (!page) break;
      try {
        const data = await get(
          `locations?bbox=${page.bbox.join(',')}&limit=1000&page=${page.page}&order_by=id&sort_order=asc`,
        );
        for (const station of normalizeOpenAqLocations(data.results)) {
          if (scope.countries && !scope.countries.includes(station.country))
            continue;
          if (
            state.stations.size >= 100_000 &&
            !state.stations.has(station.stationId)
          )
            throw error(503, 'OpenAQ viewport exceeds memory limit');
          state.stations.set(station.stationId, station);
        }
        page.page++;
        page.done = data.results.length < 1000;
      } catch (e) {
        if ([401, 403].includes(e.status)) throw e;
        failed = true;
        failureStatus = e.status || 503;
        break;
      }
    }
    const eligible = [...state.stations.values()].filter(
      (s) =>
        (!s.lastObservedMs || now() - s.lastObservedMs <= 6 * HOUR) &&
        (!parameter ||
          s.sensors.some((sensor) => sensor.parameter === parameter)),
    );
    // Overlapping pans/zooms reuse recent station checks without spending the
    // shared request budget again. Only stations discovered in this view join.
    for (const station of eligible) {
      const previous = viewLatest.get(
        `${station.stationId}:${parameter || ''}`,
      );
      if (previous && now() - previous.at < 20 * 60_000) {
        state.readings.set(station.stationId, previous.readings);
        state.checked.set(station.stationId, previous.at);
      }
    }
    const distance = (s) =>
      Math.hypot(
        wrapLon(s.lon - view[4]) * Math.cos((view[5] * Math.PI) / 180),
        s.lat - view[5],
      );
    const due = eligible
      .filter(
        (s) => now() - (state.checked.get(s.stationId) || 0) >= 20 * 60_000,
      )
      .sort(
        (a, b) =>
          (state.checked.get(a.stationId) || 0) -
            (state.checked.get(b.stationId) || 0) || distance(a) - distance(b),
      )
      // Leave capacity for subsequent camera moves and other active views.
      // A stationary view continues discovery on its next refresh.
      .slice(0, Math.min(batchSize, 8));
    // Four bounded workers shorten the time to first visible markers; all share
    // the same process request budget as global acquisition and other views.
    for (let i = 0; i < due.length && failureStatus !== 429; i += 4) {
      const results = await Promise.allSettled(
        due.slice(i, i + 4).map(async (station) => {
          try {
            const sensor =
              parameter &&
              station.sensors.find((s) => s.parameter === parameter);
            const data = await get(
              sensor
                ? `sensors/${sensor.id}/hours?limit=24&page=1&datetime_from=${encodeURIComponent(new Date(now() - 6 * HOUR).toISOString())}&datetime_to=${encodeURIComponent(new Date(now()).toISOString())}`
                : `locations/${station.stationId}/latest?limit=1000&page=1`,
            );
            if (data.results.length >= (sensor ? 24 : 1000))
              throw error(503, 'OpenAQ station exceeds acquisition limit');
            state.readings.set(
              station.stationId,
              sensor
                ? normalizeOpenAqHours(station, sensor, data.results, now())
                : normalizeOpenAqLatest(station, data.results, now()),
            );
            state.checked.set(station.stationId, now());
            viewLatest.delete(`${station.stationId}:${parameter || ''}`);
            viewLatest.set(`${station.stationId}:${parameter || ''}`, {
              at: now(),
              readings: state.readings.get(station.stationId),
            });
            while (viewLatest.size > 5_000)
              viewLatest.delete(viewLatest.keys().next().value);
          } catch (e) {
            if ([401, 403].includes(e.status)) throw e;
            failed = true;
            failureStatus = e.status === 429 ? 429 : failureStatus || 503;
          }
        }),
      );
      const rejected = results.find((r) => r.status === 'rejected');
      if (rejected) throw rejected.reason;
    }
    const fresh = [...state.readings.values()]
      .flat()
      .filter((r) => now() - r.observedMs <= 6 * HOUR);
    return {
      schemaVersion: 1,
      fetchedAt: now(),
      source: 'OpenAQ',
      sourceUrl: 'https://openaq.org/',
      scope: 'viewport',
      view,
      stations: [...state.stations.values()],
      readings: fresh,
      checked: eligible.filter((s) => state.checked.has(s.stationId)).length,
      eligible: eligible.length,
      countriesReporting: new Set(fresh.map((r) => r.country)).size,
      catalogComplete: state.pages.every((p) => p.done),
      partial:
        failed ||
        state.pages.some((p) => !p.done) ||
        eligible.some((s) => !state.checked.has(s.stationId)),
      stale: failed,
      failureStatus,
    };
  }
  async function acquireGlobal(request) {
    const started = Date.now();
    let failed = false;
    const get = async (path) => {
      if (failed || Date.now() - started > 30_000) return null;
      try {
        return await request(path);
      } catch (e) {
        if ([401, 403].includes(e.status)) throw e;
        if (e.status === 404 && path.startsWith('parameters/'))
          return { results: [] };
        failed = true;
        return null;
      }
    };
    // Resume catalog pagination across refreshes: never truncate at a regional
    // page limit, and leave request capacity for observations on every refresh.
    if (discoveryDone && now() - discoveryAt > HOUR) {
      discoveryPage = 1;
      discoveryDone = false;
      discoverySeen = new Set();
    }
    for (let i = 0; i < 8 && !discoveryDone; i++) {
      const data = await get(
        `locations?limit=1000&page=${discoveryPage}&order_by=id&sort_order=asc`,
      );
      if (!data) break;
      for (const station of normalizeOpenAqLocations(data.results)) {
        if (scope.countries && !scope.countries.includes(station.country))
          continue;
        discoverySeen.add(station.stationId);
        globalCatalog.set(station.stationId, station);
      }
      if (globalCatalog.size > 100_000)
        throw error(503, 'OpenAQ catalog exceeds memory limit');
      discoveryPage++;
      if (data.results.length < 1000) {
        discoveryDone = true;
        discoveryAt = now();
        for (const id of globalCatalog.keys())
          if (!discoverySeen.has(id)) globalCatalog.delete(id);
        for (const [id, row] of globalReadings)
          if (!globalCatalog.has(row.stationId)) globalReadings.delete(id);
      }
    }
    if (!parameterPages) {
      const data = await get('parameters?limit=1000&page=1');
      if (data)
        parameterPages = data.results
          .filter(
            (p) => Number.isSafeInteger(p.id) && OPENAQ_PARAMETER_NAMES[p.name],
          )
          .map((p) => ({
            id: p.id,
            page: 1,
            since: new Date(now() - 6 * HOUR).toISOString(),
            complete: false,
          }));
    }
    // Global parameter endpoints return up to 1,000 observations per request.
    // Round-robin pagination prevents large pollutant networks starving others.
    const finishedThisRefresh = new Set();
    for (
      let i = 0;
      i < 16 && finishedThisRefresh.size < (parameterPages?.length || 0);
      i++
    ) {
      const cursor = parameterPages[parameterCursor++ % parameterPages.length];
      if (finishedThisRefresh.has(cursor.id)) continue;
      const data = await get(
        `parameters/${cursor.id}/latest?limit=1000&page=${cursor.page}&datetime_min=${encodeURIComponent(cursor.since)}`,
      );
      if (!data) break;
      const groups = new Map();
      for (const item of data.results) {
        const id = String(item.locationsId);
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(item);
      }
      for (const [id, items] of groups) {
        const station = globalCatalog.get(id);
        if (!station) continue; // Joined on a later sweep as discovery advances.
        for (const row of normalizeOpenAqLatest(station, items, now())) {
          const old = globalReadings.get(row.id);
          if (
            !old ||
            row.observedMs > old.observedMs ||
            (row.observedMs === old.observedMs && row.sensorId < old.sensorId)
          )
            globalReadings.set(row.id, row);
        }
      }
      if (data.results.length < 1000) {
        cursor.page = 1;
        cursor.since = new Date(now() - 6 * HOUR).toISOString();
        cursor.complete = true;
        finishedThisRefresh.add(cursor.id);
      } else cursor.page++;
    }
    for (const [id, row] of globalReadings)
      if (now() - row.observedMs > 6 * HOUR) globalReadings.delete(id);
    const fresh = [...globalReadings.values()];
    const stations = [...globalCatalog.values()];
    return {
      schemaVersion: 1,
      fetchedAt: now(),
      source: 'OpenAQ',
      scope: scope.id,
      sourceUrl: 'https://openaq.org/',
      stations,
      readings: fresh,
      checked: new Set(fresh.map((r) => r.stationId)).size,
      eligible: stations.filter(
        (s) => !s.lastObservedMs || now() - s.lastObservedMs <= 6 * HOUR,
      ).length,
      countriesReporting: new Set(fresh.map((r) => r.country)).size,
      catalogComplete: discoveryDone,
      partial:
        failed ||
        !discoveryDone ||
        !parameterPages?.length ||
        parameterPages.some((p) => !p.complete),
      stale: failed,
    };
  }
  async function acquire(key, view, parameter) {
    const signal = AbortSignal.timeout(40_000);
    async function get(path) {
      const time = now();
      calls = calls.filter((t) => time - t < HOUR);
      if (
        time < blockedUntil ||
        calls.length >= 1800 ||
        calls.filter((t) => time - t < 60_000).length >= 45
      )
        throw error(429, 'OpenAQ request budget reached');
      calls.push(time);
      const res = await fetchImpl(ROOT + path, {
        headers: { 'X-API-Key': key, Accept: 'application/json' },
        signal,
        redirect: 'error',
      });
      if (!res.ok) {
        if (res.status === 429) {
          const seconds = Number(res.headers.get('Retry-After'));
          blockedUntil =
            time +
            (Number.isFinite(seconds) && seconds > 0
              ? Math.min(seconds, 86400) * 1000
              : 60_000);
        }
        throw error(
          [401, 403, 404, 429].includes(res.status) ? res.status : 503,
          'OpenAQ request unavailable',
        );
      }
      const data = await readResponseJsonCapped(res, 8 * 1024 * 1024, signal);
      if (!Array.isArray(data?.results) || data.results.length > 1000)
        throw error(503, 'Malformed OpenAQ response');
      return data;
    }
    if (view) return acquireView(get, view, parameter);
    if (scope.countries === null) return acquireGlobal(get);
    if (!catalog || now() - catalogAt > HOUR) {
      const countries = await get('countries?limit=1000&page=1');
      const ids = countries.results
        .filter(
          (c) => scope.countries.includes(c.code) && Number.isSafeInteger(c.id),
        )
        .map((c) => c.id);
      const locations = [];
      if (ids.length) {
        let complete = false;
        for (let page = 1; page <= 10; page++) {
          const data = await get(
            `locations?countries_id=${ids.join(',')}&limit=1000&page=${page}&order_by=id&sort_order=asc`,
          );
          locations.push(...data.results);
          if (
            data.results.length < 1000 ||
            (typeof data.meta?.found === 'number' &&
              Number.isFinite(data.meta.found) &&
              locations.length >= Number(data.meta.found))
          ) {
            complete = true;
            break;
          }
        }
        if (!complete)
          throw error(503, 'OpenAQ catalog exceeds acquisition limit');
      }
      catalog = normalizeOpenAqLocations(locations).filter((s) =>
        scope.countries.includes(s.country),
      );
      catalogAt = now();
      const retained = new Set(catalog.map((station) => station.stationId));
      for (const id of readings.keys())
        if (!retained.has(id)) readings.delete(id);
      for (const id of checked.keys())
        if (!retained.has(id)) checked.delete(id);
    }
    const eligible = catalog.filter(
      (s) => !s.lastObservedMs || now() - s.lastObservedMs <= 6 * HOUR,
    );
    const due = eligible
      .filter((s) => now() - (checked.get(s.stationId) || 0) >= 20 * 60_000)
      .sort(
        (a, b) =>
          (checked.get(a.stationId) || 0) - (checked.get(b.stationId) || 0) ||
          a.stationId.localeCompare(b.stationId),
      )
      .slice(0, batchSize);
    let failed = false;
    for (const station of due) {
      try {
        const result = await get(
          `locations/${station.stationId}/latest?limit=1000&page=1`,
        );
        if (result.results.length === 1000)
          throw error(503, 'OpenAQ station exceeds acquisition limit');
        readings.set(
          station.stationId,
          normalizeOpenAqLatest(station, result.results, now()),
        );
        checked.set(station.stationId, now());
      } catch (e) {
        if ([401, 403, 429].includes(e.status)) throw e;
        failed = true;
        checked.set(station.stationId, now());
        if (signal.aborted) break;
      }
    }
    const fresh = [...readings.values()]
      .flat()
      .filter((r) => now() - r.observedMs <= 6 * HOUR);
    return {
      schemaVersion: 1,
      fetchedAt: now(),
      source: 'OpenAQ',
      scope: scope.id,
      sourceUrl: 'https://openaq.org/',
      stations: catalog,
      readings: fresh,
      checked: eligible.filter((s) => readings.has(s.stationId)).length,
      eligible: eligible.length,
      countriesReporting: new Set(fresh.map((r) => r.country)).size,
      partial: failed || eligible.some((s) => !readings.has(s.stationId)),
      stale: failed,
    };
  }
  return {
    async getSnapshot({ view, parameter } = {}) {
      if (
        parameter !== undefined &&
        (!view || !Object.values(OPENAQ_PARAMETER_NAMES).includes(parameter))
      )
        throw error(400, 'Invalid pollutant');
      if (view) view = parseOpenAqView(view.join(','));
      const key = getKey().trim();
      if (!key) throw error(428, 'OpenAQ key required');
      if (key !== keyAtCache) {
        if (pending) await pending.catch(() => {});
        if (viewPending.size)
          await Promise.allSettled([...viewPending.values()]);
        keyAtCache = key;
        views.clear();
        viewLatest.clear();
        viewCache.clear();
        catalog = null;
        cached = null;
        discoveryPage = 1;
        discoveryDone = false;
        globalCatalog.clear();
        discoverySeen.clear();
        globalReadings.clear();
        parameterPages = null;
        parameterCursor = 0;
        readings.clear();
        checked.clear();
      }
      if (view) {
        const id = `${view.join(',')}|${parameter || ''}`;
        const previous = viewCache.get(id);
        if (previous && now() - previous.fetchedAt < 60_000) return previous;
        if (viewPending.has(id)) return viewPending.get(id);
        if (viewPending.size >= 2)
          throw error(429, 'OpenAQ viewport requests busy');
        const job = acquire(key, view, parameter)
          .then((value) => {
            if (views.has(id)) viewCache.set(id, value);
            return value;
          })
          .finally(() => viewPending.delete(id));
        viewPending.set(id, job);
        return job;
      }
      if (cached && now() - cachedAt < 60_000) return cached;
      if (!pending)
        pending = acquire(key)
          .then((value) => {
            cached = value;
            cachedAt = now();
            return value;
          })
          .catch((e) => {
            if (
              cached &&
              ![401, 403].includes(e.status) &&
              now() - cachedAt <= 6 * HOUR
            )
              return { ...cached, stale: true, partial: true };
            throw e;
          })
          .finally(() => {
            pending = null;
          });
      return pending;
    },
  };
}

/** Fixed local route. Browser never supplies an upstream URL or credential. */
export function openAqProxy(options = {}) {
  const source = createOpenAqAcquisition(options);
  const handler = async (req, res) => {
    const send = (status, data) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (
        url.pathname !== '/' ||
        [...url.searchParams.keys()].some(
          (k) => !['view', 'parameter'].includes(k),
        ) ||
        url.searchParams.getAll('view').length > 1 ||
        url.searchParams.getAll('parameter').length > 1
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
        }),
      );
    } catch (e) {
      send(e.status || 503, {
        error: e.status === 428 ? 'no_key' : 'OpenAQ unavailable',
      });
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

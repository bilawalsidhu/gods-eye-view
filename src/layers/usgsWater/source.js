import { readResponseBytesCapped } from '../../sources/httpBody.js';
import {
  USGS_WATER_API,
  USGS_WATER_BBOX,
  USGS_WATER_LIMITS,
  USGS_OBSERVATION_TTL_MS,
  USGS_METADATA_TTL_MS,
  USGS_WINDOW_MS,
} from './config.js';
import { waterTime } from './records.js';

const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (id) =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
const invalid = (detail) => new Error(`Invalid USGS water source: ${detail}`);
const stationId = (id) => typeof id === 'string' && /^USGS-\d{4,15}$/.test(id);
const OBSERVATION_FIELDS = [
  'time_series_id',
  'monitoring_location_id',
  'parameter_code',
  'statistic_id',
  'time',
  'value',
  'unit_of_measure',
  'approval_status',
  'qualifier',
  'last_modified',
];
const STATION_FIELDS = [
  'monitoring_location_name',
  'agency_code',
  'site_type',
  'state_code',
  'state_name',
  'county_code',
  'county_name',
];
const SERIES_FIELDS = [
  'monitoring_location_id',
  'parameter_code',
  'statistic_id',
  'parameter_name',
  'parameter_description',
  'sublocation_identifier',
  'computation_identifier',
  'computation_period_identifier',
  'web_description',
];

function fields(properties, names) {
  const output = {};
  for (const name of names) {
    const value = properties[name] ?? null;
    if (name === 'qualifier' && Array.isArray(value)) {
      if (
        value.length > 32 ||
        value.some((item) => typeof item !== 'string' || item.length > 1024)
      )
        throw invalid('qualifier list');
      output[name] = value.slice();
      continue;
    }
    if (value !== null && (typeof value !== 'string' || value.length > 1024))
      throw invalid(`field type or length: ${name}`);
    output[name] = value;
  }
  return output;
}

function project(feature, collection) {
  if (
    !object(feature) ||
    feature.type !== 'Feature' ||
    !validId(feature.id) ||
    !object(feature.properties)
  )
    throw invalid('malformed feature');
  const p = feature.properties;
  if (collection === 'latest-continuous') {
    const result = { id: feature.id, ...fields(p, OBSERVATION_FIELDS) };
    if (
      !stationId(result.monitoring_location_id) ||
      !validId(result.time_series_id) ||
      !/^\d{5}$/.test(result.parameter_code) ||
      waterTime(result.time) === null
    )
      throw invalid('observation identity, parameter or measurement time');
    return result;
  }
  if (p.id !== feature.id) throw invalid('metadata identity mismatch');
  if (collection === 'time-series-metadata') {
    const result = { id: feature.id, ...fields(p, SERIES_FIELDS) };
    if (
      !stationId(result.monitoring_location_id) ||
      !/^\d{5}$/.test(result.parameter_code)
    )
      throw invalid('time-series identity or parameter');
    return result;
  }
  const coordinates = feature.geometry?.coordinates;
  const [west, south, east, north] = USGS_WATER_BBOX;
  if (
    !stationId(feature.id) ||
    feature.geometry?.type !== 'Point' ||
    !Array.isArray(coordinates) ||
    coordinates.length < 2 ||
    coordinates.length > 3 ||
    !coordinates.every(Number.isFinite) ||
    coordinates[0] < west ||
    coordinates[0] > east ||
    coordinates[1] < south ||
    coordinates[1] > north
  )
    throw invalid('monitoring location identity or coordinates');
  const result = {
    id: feature.id,
    ...fields(p, STATION_FIELDS),
    lon: coordinates[0],
    lat: coordinates[1],
  };
  if (result.agency_code !== 'USGS') throw invalid('non-USGS source agency');
  return result;
}

function abortable(run, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run();
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', abort);
          if (signal.aborted) abort();
          else resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          reject(signal.aborted ? signal.reason : error);
        },
      );
  });
}

/** Honor delta-seconds and HTTP-date rate limits, capped to a one-day hold. */
export function waterRetryAfter(value, now) {
  const seconds =
    typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value)
      : null;
  const date = seconds === null ? Date.parse(value) : NaN;
  const delay = seconds === null ? date - now : seconds * 1000;
  return Number.isFinite(delay)
    ? Math.max(0, Math.min(USGS_WINDOW_MS, delay))
    : 0;
}

/** Keyless, bounded OGC acquisition with atomic publication and factory-owned caches. */
export function createUsgsWaterSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
  limits: suppliedLimits = {},
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof now !== 'function')
    throw new TypeError('USGS water source requires fetch and clock functions');
  const limits = { ...USGS_WATER_LIMITS, ...suppliedLimits };
  for (const [name, value] of Object.entries(limits))
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > (USGS_WATER_LIMITS[name] ?? 0)
    )
      throw new TypeError(`Invalid USGS acquisition limit: ${name}`);
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TypeError('Invalid USGS clock');
    return value;
  };
  const metadataCache = {
    'monitoring-locations': new Map(),
    'time-series-metadata': new Map(),
  };
  let cached = null;
  let failures = 0;
  let retryAt = 0;
  let generation = 0;

  async function acquire(signal, windowEnd) {
    const budget = { pages: 0, bytes: 0 };
    const read = async (url) => {
      if (++budget.pages > limits.maxPages)
        throw invalid('request/page limit exceeded');
      signal.throwIfAborted();
      const response = await abortable(async () => {
        const result = await fetchImpl(url, {
          signal,
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          headers: { Accept: 'application/geo+json, application/json' },
        });
        if (signal.aborted) void result.body?.cancel().catch(() => {});
        return result;
      }, signal);
      if (!response.ok || response.redirected) {
        void response.body?.cancel().catch(() => {});
        const error = new Error(`USGS water HTTP ${response.status}`);
        if (response.status === 429) {
          error.rateLimited = true;
          error.retryDelay = waterRetryAfter(
            response.headers.get('retry-after'),
            clock(),
          );
        }
        throw error;
      }
      const remaining = limits.maxTotalBytes - budget.bytes;
      if (remaining <= 0) {
        void response.body?.cancel().catch(() => {});
        throw invalid('total byte limit exceeded');
      }
      let bytes;
      try {
        bytes = await abortable(
          () =>
            readResponseBytesCapped(
              response,
              Math.min(limits.maxResponseBytes, remaining),
              signal,
            ),
          signal,
        );
      } catch (failure) {
        const error =
          failure instanceof Error ? failure : new Error(String(failure));
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      budget.bytes += bytes.byteLength;
      signal.throwIfAborted();
      try {
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw invalid('malformed JSON');
      }
    };

    async function collection(
      name,
      parameters,
      maxRecords,
      requestedIds = null,
    ) {
      const initial = new URL(`${USGS_WATER_API}${name}/items`);
      initial.search = new URLSearchParams({
        f: 'json',
        limit: String(limits.pageSize),
        ...parameters,
      });
      let next = initial;
      let matched = null;
      const seenLinks = new Set();
      const rows = new Map();
      while (next) {
        // Compare sorted query fields too: reordering a repeated link is not progress.
        next.searchParams.sort();
        if (seenLinks.has(next.href)) throw invalid('repeated pagination link');
        seenLinks.add(next.href);
        const page = await read(next.href);
        if (
          !object(page) ||
          page.type !== 'FeatureCollection' ||
          !Array.isArray(page.features) ||
          page.features.length > limits.pageSize ||
          !Array.isArray(page.links)
        )
          throw invalid('malformed feature page');
        if (
          page.numberReturned !== undefined &&
          (!Number.isSafeInteger(page.numberReturned) ||
            page.numberReturned !== page.features.length)
        )
          throw invalid('numberReturned mismatch');
        if (page.numberMatched !== undefined) {
          if (
            !Number.isSafeInteger(page.numberMatched) ||
            page.numberMatched < 0 ||
            page.numberMatched > maxRecords ||
            (matched !== null && matched !== page.numberMatched)
          )
            throw invalid('numberMatched mismatch or limit');
          matched = page.numberMatched;
        }
        for (const feature of page.features) {
          const row = project(feature, name);
          if (requestedIds && !requestedIds.has(row.id))
            throw invalid('unrequested metadata identity');
          const previous = rows.get(row.id);
          if (previous && JSON.stringify(previous) !== JSON.stringify(row))
            throw invalid('conflicting duplicate feature');
          rows.set(row.id, row);
          if (rows.size > maxRecords) throw invalid('record limit exceeded');
        }
        const links = page.links.filter((link) => link?.rel === 'next');
        if (links.length > 1 || (links.length && !page.features.length))
          throw invalid('ambiguous or stalled pagination');
        next = null;
        if (links.length) {
          if (typeof links[0].href !== 'string' || links[0].href.length > 8192)
            throw invalid('invalid pagination link');
          next = new URL(links[0].href, initial);
          if (
            next.origin !== initial.origin ||
            next.pathname !== initial.pathname ||
            next.username ||
            next.password ||
            next.hash
          )
            throw invalid('unsafe pagination destination');
          // Some provider links omit f=json; retaining the negotiated representation is safe.
          if (!next.searchParams.has('f')) next.searchParams.set('f', 'json');
          if (next.searchParams.get('f') !== 'json')
            throw invalid('pagination representation changed');
          for (const [key, value] of Object.entries(parameters))
            if (next.searchParams.get(key) !== value)
              throw invalid('pagination query scope changed');
          const size = Number(next.searchParams.get('limit'));
          if (!Number.isSafeInteger(size) || size < 1 || size > limits.pageSize)
            throw invalid('pagination limit changed');
        }
      }
      if (matched !== null && matched !== rows.size)
        throw invalid('incomplete pagination');
      return [...rows.values()];
    }

    const windowStart = windowEnd - USGS_WINDOW_MS;
    const raw = await collection(
      'latest-continuous',
      {
        bbox: USGS_WATER_BBOX.join(','),
        datetime: `${new Date(windowStart).toISOString()}/..`,
      },
      limits.maxObservations,
    );
    // Recheck measurement time independently of server filtering; database updates cannot revive old observations.
    const observations = raw.filter((row) => {
      const time = waterTime(row.time);
      return time >= windowStart && time <= windowEnd;
    });
    const locationIds = [
      ...new Set(observations.map((row) => row.monitoring_location_id)),
    ];
    const seriesIds = [
      ...new Set(observations.map((row) => row.time_series_id)),
    ];
    if (
      locationIds.length > limits.maxLocations ||
      seriesIds.length > limits.maxSeries
    )
      throw invalid('metadata join limit exceeded');
    const pendingCaches = [];
    const metadata = async (name, ids, cap) => {
      const result = new Map();
      const missing = [];
      for (const id of ids) {
        const entry = metadataCache[name].get(id);
        const age = entry ? windowEnd - entry.fetchedAt : null;
        if (entry && age >= 0 && age < USGS_METADATA_TTL_MS)
          result.set(id, entry.row);
        else missing.push(id);
      }
      for (let i = 0; i < missing.length; i += limits.batchSize) {
        const chunk = missing.slice(i, i + limits.batchSize);
        const rows = await collection(
          name,
          {
            'filter-lang': 'cql2-text',
            filter: `id IN (${chunk.map((id) => `'${id}'`).join(',')})`,
          },
          cap,
          new Set(chunk),
        );
        for (const row of rows) {
          result.set(row.id, row);
          pendingCaches.push({ name, row });
        }
      }
      if (ids.some((id) => !result.has(id)))
        throw invalid(`incomplete ${name} join`);
      return [...result.values()];
    };
    const stations = await metadata(
      'monitoring-locations',
      locationIds,
      limits.maxLocations,
    );
    const series = await metadata(
      'time-series-metadata',
      seriesIds,
      limits.maxSeries,
    );
    const bySeries = new Map(series.map((row) => [row.id, row]));
    const seenSeries = new Map();
    for (const row of observations) {
      const joined = bySeries.get(row.time_series_id);
      if (
        joined.monitoring_location_id !== row.monitoring_location_id ||
        joined.parameter_code !== row.parameter_code ||
        joined.statistic_id !== row.statistic_id
      )
        throw invalid('conflicting series join');
      const previous = seenSeries.get(row.time_series_id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(row))
        throw invalid('conflicting latest time-series readings');
      seenSeries.set(row.time_series_id, row);
    }
    return {
      snapshot: {
        observations: [...seenSeries.values()],
        stations,
        series,
        fetchedAt: clock(),
        windowStart,
        windowEnd,
        excludedOldCount: raw.length - observations.length,
      },
      pendingCaches,
    };
  }

  return {
    /** Failed or cancelled acquisitions never publish a partial or stale source snapshot. */
    async getSnapshot({ signal, force = false } = {}) {
      signal?.throwIfAborted();
      const startedAt = clock();
      const age = cached ? startedAt - cached.fetchedAt : null;
      if (!force && cached && age >= 0 && age < USGS_OBSERVATION_TTL_MS)
        return structuredClone(cached);
      if (startedAt < retryAt)
        throw Object.assign(
          new Error(
            `USGS water retry held until ${new Date(retryAt).toISOString()}`,
          ),
          { retryAt },
        );
      const token = ++generation;
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () =>
          controller.abort(
            Object.assign(new Error('USGS water acquisition timed out'), {
              name: 'TimeoutError',
            }),
          ),
        limits.timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const { snapshot, pendingCaches } = await acquire(
          controller.signal,
          startedAt,
        );
        controller.signal.throwIfAborted();
        const result = structuredClone(snapshot);
        if (token === generation) {
          cached = snapshot;
          failures = 0;
          retryAt = 0;
          for (const { name, row } of pendingCaches) {
            const cache = metadataCache[name];
            cache.delete(row.id);
            cache.set(row.id, { row, fetchedAt: snapshot.fetchedAt });
            const max =
              name === 'monitoring-locations'
                ? limits.maxLocations
                : limits.maxSeries;
            while (cache.size > max) cache.delete(cache.keys().next().value);
          }
        }
        return result;
      } catch (failure) {
        const error =
          failure instanceof Error ? failure : new Error(String(failure));
        if (
          token === generation &&
          !signal?.aborted &&
          (!controller.signal.aborted ||
            controller.signal.reason?.name === 'TimeoutError')
        ) {
          failures = Math.min(7, failures + 1);
          // A failed explicit refresh invalidates even a still-young observation
          // cache. A later cache hit must not erase the provider failure.
          cached = null;
          retryAt =
            clock() +
            Math.max(
              Math.min(300000, 5000 * 2 ** (failures - 1)),
              error.retryDelay || 0,
            );
          error.retryAt = retryAt;
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}

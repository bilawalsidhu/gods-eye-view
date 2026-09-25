import { readResponseTextCapped } from './common/http.js';

const STATUS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const GIS =
  'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer';
const HOUR = 3600_000;
const COVERAGE =
  'Atlantic and eastern/central North Pacific; not worldwide cyclone coverage.';
const LAYERS = [
  { id: 5, cap: 512 * 1024, count: 500, kind: 'points' },
  { id: 6, cap: 512 * 1024, count: 32, kind: 'track' },
  { id: 7, cap: 2 * 1024 * 1024, count: 32, kind: 'cone' },
];

function invalid() {
  return new Error('invalid_cyclone_data');
}
function text(value, max = 80) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f<>]/.test(value)
  )
    throw invalid();
  return value.trim();
}
function advisory(value) {
  if (typeof value !== 'string' || !/^\d{1,3}[A-Z]?$/i.test(value))
    throw invalid();
  return value.replace(/^0+(?=\d)/, '').toUpperCase();
}
function number(value, min, max) {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    !['string', 'number'].includes(typeof value)
  )
    return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
function iso(value, now) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
  )
    throw invalid();
  const n = Date.parse(value);
  if (
    !Number.isFinite(n) ||
    n > now + 5 * 60_000 ||
    now - n > 12 * HOUR ||
    new Date(n).toISOString().replace('.000Z', 'Z') !==
      value.replace('.000Z', 'Z')
  )
    throw invalid();
  return new Date(n).toISOString();
}
function position(coordinates) {
  if (
    !Array.isArray(coordinates) ||
    coordinates.length !== 2 ||
    !coordinates.every((n) => typeof n === 'number' && Number.isFinite(n)) ||
    Math.abs(coordinates[0]) > 180 ||
    Math.abs(coordinates[1]) > 90
  )
    throw invalid();
  return { longitude: coordinates[0], latitude: coordinates[1] };
}
function officialLink(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const url = new URL(value);
    return url.origin === 'https://www.nhc.noaa.gov' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/text\/[A-Z0-9]+\.shtml$/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function parseCycloneStatus(payload, now = Date.now()) {
  if (!Array.isArray(payload?.activeStorms) || payload.activeStorms.length > 32)
    throw invalid();
  const seen = new Set();
  return payload.activeStorms.map((raw) => {
    if (
      typeof raw?.id !== 'string' ||
      !/^(?:al|ep|cp)\d{6}$/.test(raw.id) ||
      seen.has(raw.id)
    )
      throw invalid();
    seen.add(raw.id);
    const forecast = raw.forecastAdvisory;
    const issuedAt = iso(forecast?.issuance, now);
    const advisoryNumber = advisory(forecast?.advNum);
    const positionAt = iso(raw.lastUpdate, now);
    return {
      id: raw.id,
      name: text(raw.name),
      classification: text(raw.classification, 16),
      basin: raw.id.slice(0, 2).toUpperCase(),
      position: position([raw.longitudeNumeric, raw.latitudeNumeric]),
      positionAt,
      advisoryNumber,
      issuedAt,
      windKt: number(raw.intensity, 0, 300),
      pressureHpa: number(raw.pressure, 800, 1100),
      movement: {
        directionDegrees: number(raw.movementDir, 0, 360),
        speedKt: number(raw.movementSpeed, 0, 200),
      },
      advisoryUrl: officialLink(forecast.url),
      outlookUrl: raw.id.startsWith('al')
        ? 'https://www.nhc.noaa.gov/gtwo.php?basin=atlc&fdays=7'
        : raw.id.startsWith('cp')
          ? 'https://www.nhc.noaa.gov/gtwo.php?basin=cpac&fdays=7'
          : 'https://www.nhc.noaa.gov/gtwo.php?basin=epac&fdays=7',
      geometryStatus: 'pending',
      geometryAdvisoryNumber: null,
      forecastPoints: [],
      track: null,
      cone: null,
    };
  });
}

function geometry(raw, kind, budget) {
  const types =
    kind === 'points'
      ? ['Point']
      : kind === 'track'
        ? ['LineString', 'MultiLineString']
        : ['Polygon', 'MultiPolygon'];
  if (!types.includes(raw?.type)) throw invalid();
  const point = (value) => {
    position(value);
    if (++budget.count > 25_000) throw invalid();
    return [...value];
  };
  const line = (value, ring = false) => {
    if (
      !Array.isArray(value) ||
      value.length < (ring ? 4 : 2) ||
      value.length > 10_000
    )
      throw invalid();
    const result = value.map(point);
    if (
      ring &&
      (result[0][0] !== result.at(-1)[0] || result[0][1] !== result.at(-1)[1])
    )
      throw invalid();
    return result;
  };
  const list = (value, read) => {
    if (!Array.isArray(value) || !value.length || value.length > 128)
      throw invalid();
    return value.map(read);
  };
  const polygon = (value) => list(value, (ring) => line(ring, true));
  const coordinates =
    raw.type === 'Point'
      ? point(raw.coordinates)
      : raw.type === 'LineString'
        ? line(raw.coordinates)
        : raw.type === 'MultiLineString'
          ? list(raw.coordinates, (part) => line(part))
          : raw.type === 'Polygon'
            ? polygon(raw.coordinates)
            : list(raw.coordinates, polygon);
  return { type: raw.type, coordinates };
}

/** Never relabel earlier GIS geometry with the newer status advisory. */
export function attachCycloneGeometry(storms, collections) {
  const budget = { count: 0 };
  const parsed = LAYERS.map((spec, index) => {
    const payload = collections[index];
    if (
      payload?.type !== 'FeatureCollection' ||
      payload.exceededTransferLimit ||
      !Array.isArray(payload.features) ||
      payload.features.length > spec.count
    )
      throw invalid();
    return payload.features.map((feature) => {
      if (feature?.type !== 'Feature') throw invalid();
      const p = feature.properties;
      const source =
        typeof p?.idp_source === 'string' &&
        p.idp_source.match(
          /^((?:al|ep|cp)\d{6})-(\d{1,3}[a-z]?)_5day_(pts|lin|pgn)$/i,
        );
      if (!source || source[3].toLowerCase() !== ['pts', 'lin', 'pgn'][index])
        throw invalid();
      const adv = advisory(p.advisnum);
      if (adv !== advisory(source[2])) throw invalid();
      return {
        id: source[1].toLowerCase(),
        advisoryNumber: adv,
        geometry: geometry(feature.geometry, spec.kind, budget),
        tauHours: number(p.tau, 0, 168),
        windKt: number(p.maxwind, 0, 300),
        gustKt: number(p.gust, 0, 350),
      };
    });
  });
  return storms.map((storm) => {
    const groups = parsed.map((items) =>
      items.filter(
        (item) =>
          item.id === storm.id && item.advisoryNumber === storm.advisoryNumber,
      ),
    );
    if (groups[1].length > 1 || groups[2].length > 1) throw invalid();
    if (!groups[0].length || groups[1].length !== 1 || groups[2].length !== 1)
      return storm;
    const taus = new Set();
    const forecastPoints = groups[0]
      .map((item) => {
        if (item.tauHours === null || taus.has(item.tauHours)) throw invalid();
        taus.add(item.tauHours);
        return {
          position: position(item.geometry.coordinates),
          tauHours: item.tauHours,
          windKt: item.windKt,
          gustKt: item.gustKt,
        };
      })
      .sort((a, b) => a.tauHours - b.tauHours);
    return {
      ...storm,
      geometryStatus: 'current',
      geometryAdvisoryNumber: storm.advisoryNumber,
      forecastPoints,
      track: groups[1][0].geometry,
      cone: groups[2][0].geometry,
    };
  });
}

/** Fixed official endpoints; one shared bounded refresh, no user destinations. */
export function cycloneProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = 12_000,
} = {}) {
  let cache = null;
  let operation = null;
  let attemptedAt = -Infinity;
  async function upstream(url, cap, signal) {
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: {
        Accept: 'application/geo+json,application/json',
        'User-Agent': 'Gods Eye View (public NOAA weather context)',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('cyclone_upstream_unavailable');
    }
    const result = JSON.parse(
      await readResponseTextCapped(response, cap, signal),
    );
    signal.throwIfAborted();
    return result;
  }
  async function refresh(signal) {
    let storms = parseCycloneStatus(
      await upstream(STATUS_URL, 128 * 1024, signal),
      now(),
    );
    if (storms.length) {
      try {
        const results = await Promise.allSettled(
          LAYERS.map(async (spec) => {
            const url = new URL(`${GIS}/${spec.id}/query`);
            url.search = new URLSearchParams({
              where: '1=1',
              outFields:
                spec.kind === 'points'
                  ? 'idp_source,advisnum,tau,maxwind,gust'
                  : 'idp_source,advisnum',
              outSR: '4326',
              resultRecordCount: String(spec.count),
              geometryPrecision: '4',
              f: 'geojson',
            }).toString();
            return upstream(url.href, spec.cap, signal);
          }),
        );
        if (results.some((result) => result.status === 'rejected'))
          throw invalid();
        storms = attachCycloneGeometry(
          storms,
          results.map((result) => result.value),
        );
      } catch {
        storms = storms.map((storm) => ({
          ...storm,
          geometryStatus: 'unavailable',
        }));
      }
    }
    signal.throwIfAborted();
    cache = { storms, fetchedAt: now() };
    return cache;
  }
  async function acquire(signal) {
    signal.throwIfAborted();
    if (cache && now() - cache.fetchedAt < 300_000) return cache;
    if (operation?.controller.signal.aborted) operation = null;
    if (!operation) {
      if (now() - attemptedAt < 60_000) throw new Error('cyclone_retry_later');
      attemptedAt = now();
      const controller = new AbortController();
      const owned = { controller, waiters: 0 };
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      owned.promise = refresh(controller.signal).finally(() => {
        clearTimeout(timer);
        if (operation === owned) operation = null;
      });
      operation = owned;
    }
    const owned = operation;
    if (owned.waiters >= 32)
      throw Object.assign(new Error('cyclone_busy'), { status: 429 });
    owned.waiters++;
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(signal.reason ?? new Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([owned.promise, cancelled]);
    } finally {
      signal.removeEventListener('abort', abort);
      if (--owned.waiters === 0 && operation === owned) {
        owned.controller.abort();
        if (signal.aborted) attemptedAt = -Infinity;
      }
    }
  }
  function describe(value, stale = false) {
    return {
      schemaVersion: 1,
      source: 'NOAA NHC / CPHC',
      attribution:
        'NOAA/NWS National Hurricane Center / Central Pacific Hurricane Center',
      coverage: COVERAGE,
      fetchedAt: value?.fetchedAt ?? null,
      stale: stale || !value,
      unavailable: !value,
      reason: !value
        ? 'Cyclone data unavailable'
        : stale
          ? 'Cached cyclone advisory; upstream unavailable'
          : null,
      storms: value?.storms ?? [],
    };
  }
  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    const json = (status, value) => {
      if (controller.signal.aborted) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 429 ? { 'Retry-After': '2' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET')
        return json(405, { error: 'method_not_allowed' });
      if (req.url !== '/' && req.url !== '')
        return json(400, { error: 'invalid_cyclone_query' });
      try {
        json(200, describe(await acquire(controller.signal)));
      } catch (error) {
        if (error.status === 429) return json(429, { error: 'cyclone_busy' });
        const usable =
          cache &&
          now() - cache.fetchedAt <= 12 * HOUR &&
          cache.storms.every(
            (storm) => now() - Date.parse(storm.issuedAt) <= 12 * HOUR,
          );
        json(200, describe(usable ? cache : null, true));
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }
  return {
    name: 'cyclones',
    configureServer({ middlewares }) {
      middlewares.use('/api/cyclones', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/cyclones', handler);
    },
  };
}

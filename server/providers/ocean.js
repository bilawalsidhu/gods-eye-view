import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { readResponseTextCapped, coalesceProxyRequest } from './common/http.js';
import { fetchRegionalJson, fetchRegionalText } from './regional/http.js';
import { validRegionalPoint } from './regional/query.js';
import {
  parseNdbcLatestObs,
  parseActiveStationsXml,
} from '../../src/data/ndbcText.js';
// The ocean-field tier logic lives in src/server/ocean/*: /api/ocean/field is
// a thin handler over buildFieldPayload, the same split issue #41 asked for.
import {
  buildFieldPayload,
  tryNormalizeBox,
  DEFAULT_TARGET_CELLS,
  MIN_TARGET_CELLS,
  MAX_TARGET_CELLS,
} from '../../src/server/ocean/fieldGrid.js';

/** Open-Meteo point-forecast body cap, matching the weather-effects provider. */
const OCEAN_POINT_MAX_RESPONSE_BYTES = 512 * 1024;

// ── Ocean conditions: NDBC bulk observations + Open-Meteo Marine forecasts ──
const OCEAN_OBS_URL =
  'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt';
const OCEAN_STATIONS_URL = 'https://www.ndbc.noaa.gov/activestations.xml';
const OCEAN_OBS_CACHE_MS = 10 * 60_000;
const OCEAN_OBS_STALE_MS = 60 * 60_000;
const OCEAN_STATIONS_CACHE_MS = 24 * 3600_000;
const OCEAN_MARINE_CACHE_MS = 15 * 60_000;
const OCEAN_MARINE_STALE_MS = 60 * 60_000;
const OCEAN_MARINE_MAX_CACHE = 120;
const OCEAN_GRID_CACHE_MS = 30 * 60_000;
const OCEAN_GRID_STALE_MS = 120 * 60_000;
const OCEAN_GRID_MAX_CACHE = 24;
const OCEAN_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const OCEAN_ETOPO_CACHE_MS = 7 * 24 * 3600_000;
// Bathymetry is static — a stale cache entry is never wrong, serve it forever.
const OCEAN_ETOPO_STALE_MS = Number.POSITIVE_INFINITY;
const OCEAN_ETOPO_MAX_CACHE = 24;
let _oceanObsCache = null;
let _oceanStationsCache = null;
const _oceanObsInFlight = new Map();
const _oceanMarineCache = new Map();
const _oceanMarineInFlight = new Map();
const _oceanGridCache = new Map();
const _oceanGridInFlight = new Map();
const _oceanEtopoCache = new Map();
const _oceanEtopoInFlight = new Map();
const _oceanObsRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 30,
  globalMax: 90,
});
const _oceanMarineRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 45,
  globalMax: 120,
});
const _oceanGridRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 6,
  globalMax: 18,
});
const _oceanEtopoRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 6,
  globalMax: 18,
});
// Ocean current field. The HF-radar tier issues several upstream requests per
// build (a probe plus a window fetch per ladder rung), so it is limited harder
// than the point endpoints and cached on a coarse view-box key: panning by less
// than a cell must not re-analyse. Fields are large; keep few of them.
const OCEAN_FIELD_CACHE_MS = 10 * 60_000;
const OCEAN_FIELD_STALE_MS = 6 * 3600_000;
const OCEAN_FIELD_MAX_CACHE = 12;
const _oceanFieldCache = new Map();
const _oceanFieldInFlight = new Map();
const _oceanFieldRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 12,
  globalMax: 30,
});

/**
 * Join station names/types from activestations.xml metadata onto parsed
 * observation records; stations without metadata keep null name/type.
 */
export function normalizeOceanObs(records, stationsMeta) {
  return records.map((record) => {
    const meta = stationsMeta ? stationsMeta.get(record.stationId) : undefined;
    return { ...record, name: meta?.name || null, type: meta?.type || null };
  });
}

/**
 * 5×5 forecast-grid axes at 0.5° spacing centered on the drift seed —
 * 24 h of drift at ~1 m/s is ≈0.8°, so the ±1.0° box covers the ensemble.
 * Values are range-clamped (a near-pole/dateline seed degrades gracefully
 * to duplicate edge nodes) and rounded so cache keys stay stable.
 */
export function buildMarineGridAxes(latitude, longitude) {
  const axis = (center, min, max) => {
    const values = [];
    for (let i = -2; i <= 2; i += 1) {
      values.push(
        Number(Math.min(max, Math.max(min, center + i * 0.5)).toFixed(4)),
      );
    }
    return values;
  };
  return { lats: axis(latitude, -90, 90), lons: axis(longitude, -180, 180) };
}

/**
 * Bathymetry request box centered on the drift seed: forcing box ±1.0° plus
 * 0.5° drift margin = ±1.5°. Edges are range-clamped (near-pole/dateline
 * seeds degrade to a truncated box) and rounded to 4 decimals so upstream
 * URLs and cache keys stay stable.
 */
export function buildEtopoBox(latitude, longitude) {
  const edge = (value, min, max) =>
    Number(Math.min(max, Math.max(min, value)).toFixed(4));
  return {
    lat0: edge(latitude - 1.5, -90, 90),
    lat1: edge(latitude + 1.5, -90, 90),
    lon0: edge(longitude - 1.5, -180, 180),
    lon1: edge(longitude + 1.5, -180, 180),
  };
}

/**
 * Normalize an ERDDAP griddap table-JSON response into `{lats, lons, z}` with
 * `z` row-major over ascending axes: `z[latIndex * lons.length + lonIndex]`.
 * Columns are looked up by NAME so row-order or column-order drift upstream
 * still parses. Returns null on any shape drift — missing table/column,
 * non-finite value, or rows not covering the full lats×lons grid — so
 * callers treat drift as an upstream failure, never as empty bathymetry.
 */
export function normalizeEtopoUpstream(json) {
  const names = json?.table?.columnNames;
  const rows = json?.table?.rows;
  if (!Array.isArray(names) || !Array.isArray(rows) || rows.length === 0)
    return null;
  const latCol = names.indexOf('latitude');
  const lonCol = names.indexOf('longitude');
  const altCol = names.indexOf('altitude');
  if (latCol === -1 || lonCol === -1 || altCol === -1) return null;
  const latSet = new Set();
  const lonSet = new Set();
  for (const row of rows) {
    if (!Array.isArray(row)) return null;
    if (
      !Number.isFinite(row[latCol]) ||
      !Number.isFinite(row[lonCol]) ||
      !Number.isFinite(row[altCol])
    )
      return null;
    latSet.add(row[latCol]);
    lonSet.add(row[lonCol]);
  }
  const lats = [...latSet].sort((a, b) => a - b);
  const lons = [...lonSet].sort((a, b) => a - b);
  if (lats.length * lons.length !== rows.length) return null;
  const latIndex = new Map(lats.map((value, i) => [value, i]));
  const lonIndex = new Map(lons.map((value, i) => [value, i]));
  const z = new Array(rows.length).fill(null);
  for (const row of rows) {
    z[latIndex.get(row[latCol]) * lons.length + lonIndex.get(row[lonCol])] =
      row[altCol];
  }
  // Duplicate rows leave unfilled cells — that's drift too.
  if (z.includes(null)) return null;
  return { lats, lons, z };
}

/**
 * Open-Meteo hourly times are ISO strings WITHOUT a zone suffix but are UTC
 * when requested with timezone=UTC — append the zone explicitly. Returns
 * null when any entry is unparseable or the list is empty.
 */
export function marineHoursToMs(times) {
  if (!Array.isArray(times) || times.length === 0) return null;
  // Strict format gate first — V8's lenient Date.parse would accept garbage.
  if (
    !times.every(
      (time) =>
        typeof time === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(time),
    )
  )
    return null;
  const hoursMs = times.map((time) => Date.parse(`${time}:00Z`));
  return hoursMs.every(Number.isFinite) ? hoursMs : null;
}

/**
 * Build the two Open-Meteo query param sets refreshGrid sends for the drift
 * forcing grid — one against the marine API, one against the forecast (wind)
 * API. Nodes are flattened row-major (`latIndex * lons.length + lonIndex`)
 * into comma-separated coordinate lists.
 */
export function buildMarineGridParams(axes) {
  // Row-major node order: nodes[latIndex * lons.length + lonIndex].
  const lats = [];
  const lons = [];
  for (const lat of axes.lats) {
    for (const lon of axes.lons) {
      lats.push(lat);
      lons.push(lon);
    }
  }
  const shared = {
    latitude: lats.join(','),
    longitude: lons.join(','),
    // 4 days forward, not 2: the panel offers a 48 h horizon, and forecast_days=2
    // ends the axis at (today + 1) 23:00 UTC, so a run launched at hour h has only
    // (47 − h) h of forward lead — short of 48 for every h, hence
    // EVERY 48 h run used to integrate its tail on a frozen last-hour field
    // (clamped with w = 0) while still reporting degraded = false. Measured
    // cost of that clamp at Monterey: mean endpoint shifted 10.653 km against a
    // correctly-forced mean drift of 5.575 km — 1.9x the entire drift signal.
    forecast_days: '4',
    past_days: '2', // hindcast mode — hourly.time extends 48 h into the past
    timezone: 'UTC',
  };
  const marineParams = new URLSearchParams({
    ...shared,
    hourly: 'wave_height,ocean_current_velocity,ocean_current_direction',
  });
  const windParams = new URLSearchParams({
    ...shared,
    hourly: 'wind_speed_10m,wind_direction_10m',
    wind_speed_unit: 'ms',
  });
  return { marineParams, windParams, nodeCount: lats.length };
}

/** Native Open-Meteo marine cell size, degrees (1/12°). */
const OCEAN_NATIVE_CELL_DEG = 1 / 12;
/**
 * A node whose SERVED centre sits further than half a native cell from its
 * row/column consensus is not this node snapped — it is a different cell
 * substituted upstream (typically the nearest wet cell for a request that
 * landed on land). Its series describes water somewhere else entirely, so it
 * is dropped rather than georeferenced to a coordinate it was not sampled at.
 */
const OCEAN_NODE_SNAP_TOLERANCE_DEG = OCEAN_NATIVE_CELL_DEG / 2;

/**
 * Great-circle separation in metres (haversine, R = 6371 km). Used to size how
 * far a served cell centre sits from the coordinate it was requested at.
 */
export function oceanSeparationM(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Most-common value among those within `tolerance` of `anchor`, or the
 * analytic native-grid snap of `anchor` when none qualifies.
 *
 * ANCHORING IS THE POINT. A plain plurality has no reference to what was
 * requested, so three or more co-located land substitutions in one row or
 * column capture the axis: reproduced at a Chesapeake seed (38.0, −76.0),
 * column j=1 voted [−76.375, −76.542, −76.542, −76.375, −76.375] and took
 * −76.375 — 10.95 km from the requested −76.5, against a physical snap bound of
 * 5.94 km. Restricting the vote to candidates that could actually BE this
 * node's cell makes the result robust to any number of substitutions.
 *
 * @param {number[]} values - Served coordinates along one row or column.
 * @param {number} anchor - The coordinate that was requested for that line.
 * @param {number} tolerance - Half a native cell, degrees.
 * @returns {number}
 */
function consensusOf(values, anchor, tolerance) {
  const counts = new Map();
  for (const value of values) {
    if (Math.abs(value - anchor) > tolerance) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  // Every node on this line was substituted, so there is nothing to vote on.
  // Fall back to the REQUESTED coordinate rather than an analytic snap: a
  // request landing exactly on a cell boundary has no derivable centre — for
  // −122.0 the two adjacent centres are −122.0417 and −121.9583, and upstream
  // was observed to return the western one, which `Math.round`'s round-half-up
  // does not reproduce. Every node on this line is dropped anyway, so nothing
  // is georeferenced to it; the entry exists only to keep the axis monotone,
  // and the request is within half a cell of the truth by construction.
  return best === undefined ? anchor : best;
}

/**
 * Reconstruct the rectilinear axes the upstream ACTUALLY served, from the
 * per-node coordinates it echoed back.
 *
 * Open-Meteo snaps every requested coordinate independently to its own 1/12°
 * cell centre, so the served lattice is offset from the requested one (measured
 * live at Monterey: all 25 nodes displaced, median 3.83 km, max 22.51 km) and
 * is only *approximately* rectilinear — a request landing on land comes back as
 * a substituted wet cell far off the lattice. Row/column consensus recovers the
 * true axes; nodes disagreeing with their own row or column by more than
 * {@link OCEAN_NODE_SNAP_TOLERANCE_DEG} are reported as `dropped` so the caller
 * can null their series instead of attributing a distant cell's water to this
 * grid position.
 *
 * @param {number[]} servedLats - Per-node served latitude, row-major.
 * @param {number[]} servedLons - Per-node served longitude, row-major.
 * @param {{lats: number[], lons: number[]}} requested - The lattice that was
 *   asked for. Each axis entry is anchored to its requested coordinate, so no
 *   number of upstream substitutions can move an axis outside its own cell.
 * @returns {?{lats: number[], lons: number[], dropped: number[]}} Null when a
 *   coordinate is missing or non-finite — shape drift, never a silent guess.
 */
export function resolveServedAxes(servedLats, servedLons, requested) {
  const nLat = requested?.lats?.length ?? 0;
  const nLon = requested?.lons?.length ?? 0;
  if (!nLat || !nLon) return null;
  if (servedLats.length !== nLat * nLon || servedLons.length !== nLat * nLon)
    return null;
  if (!servedLats.every(Number.isFinite) || !servedLons.every(Number.isFinite))
    return null;
  const tol = OCEAN_NODE_SNAP_TOLERANCE_DEG;
  const lats = [];
  for (let i = 0; i < nLat; i += 1) {
    lats.push(
      consensusOf(
        servedLats.slice(i * nLon, (i + 1) * nLon),
        requested.lats[i],
        tol,
      ),
    );
  }
  const lons = [];
  for (let j = 0; j < nLon; j += 1) {
    const column = [];
    for (let i = 0; i < nLat; i += 1) column.push(servedLons[i * nLon + j]);
    lons.push(consensusOf(column, requested.lons[j], tol));
  }
  const dropped = [];
  for (let i = 0; i < nLat; i += 1) {
    for (let j = 0; j < nLon; j += 1) {
      const node = i * nLon + j;
      if (
        Math.abs(servedLats[node] - lats[i]) > OCEAN_NODE_SNAP_TOLERANCE_DEG ||
        Math.abs(servedLons[node] - lons[j]) > OCEAN_NODE_SNAP_TOLERANCE_DEG
      ) {
        dropped.push(node);
      }
    }
  }
  return { lats, lons, dropped };
}

/**
 * Georeference a normalized marine grid to the coordinates upstream SERVED,
 * and measure how far that is from what was requested.
 *
 * Open-Meteo snaps each requested coordinate to its own 1/12° cell centre, so
 * the requested lattice attributes every velocity to a point it was never
 * sampled at (measured at Monterey: median 3.82 km, max 3.87 km of snap, within
 * the 5.94 km half-diagonal bound). Nodes whose served centre is a substituted
 * cell entirely — upstream answering a land request with distant water, up to
 * 22.5 km away — are dropped rather than re-georeferenced.
 *
 * Extracted from `refreshGrid` so it is reachable from a test: the wiring, not
 * just `resolveServedAxes` in isolation, is what the A1 defect lived in, and
 * reverting it used to leave the whole suite green.
 *
 * @param {{lats: number[], lons: number[]}} axes - The requested lattice.
 * @param {Object} grid - {@link normalizeMarineGridUpstream} output. Its
 *   `nodes` are MUTATED: a dropped node's series are blanked in place.
 * @param {number} nodeCount - Expected node count (axes.lats × axes.lons).
 * @returns {{grid: Object, requestedGrid: Object, hoursMs: number[],
 *   nodes: Object[], validation: Object}} Payload fields.
 */
export function georeferenceMarineGrid(axes, grid, nodeCount) {
  const served = resolveServedAxes(grid.servedLats, grid.servedLons, axes);
  const gridAxes = served ? { lats: served.lats, lons: served.lons } : axes;
  const dropped = served ? served.dropped : [];
  // A dropped node describes a different cell's water. Blank its series so the
  // sampler NaN-gaps it rather than interpolating a stranger's current.
  for (const node of dropped) {
    grid.nodes[node] = {
      waveHeightM: [],
      currentKmh: [],
      currentDirDeg: [],
      windMs: [],
      windDirDeg: [],
    };
  }
  let maxNodeSnapM = 0;
  let maxWindSkewM = 0;
  for (let i = 0; i < axes.lats.length; i += 1) {
    for (let j = 0; j < axes.lons.length; j += 1) {
      const node = i * axes.lons.length + j;
      maxNodeSnapM = Math.max(
        maxNodeSnapM,
        oceanSeparationM(
          axes.lats[i],
          axes.lons[j],
          gridAxes.lats[i],
          gridAxes.lons[j],
        ),
      );
      if (
        Number.isFinite(grid.windLats[node]) &&
        Number.isFinite(grid.windLons[node])
      ) {
        maxWindSkewM = Math.max(
          maxWindSkewM,
          oceanSeparationM(
            gridAxes.lats[i],
            gridAxes.lons[j],
            grid.windLats[node],
            grid.windLons[node],
          ),
        );
      }
    }
  }
  return {
    grid: gridAxes,
    requestedGrid: axes,
    hoursMs: grid.hoursMs,
    nodes: grid.nodes,
    validation: {
      // `nodesDropped`, `maxNodeSnapM` and `clampedFrames` are surfaced in the
      // drift panel; the rest are for API consumers and debugging. The layer's
      // quality surface used to be a single latching boolean that read `true`
      // on every coastal run, which carried no information.
      nodesTotal: nodeCount,
      nodesDropped: dropped.length,
      droppedNodes: dropped,
      maxNodeSnapM: Math.round(maxNodeSnapM),
      maxWindSkewM: Math.round(maxWindSkewM),
      servedAxes: Boolean(served),
      hoursCovered: grid.hoursMs.length,
      forecastEndMs: grid.hoursMs[grid.hoursMs.length - 1] ?? null,
    },
  };
}

/**
 * Zip multi-point marine + wind upstream responses into per-node forcing
 * arrays. Open-Meteo returns an ARRAY for comma-separated coordinate lists
 * (confirmed live 2026-08-28) and a single object for one point — both are
 * accepted. Returns null on node-count mismatch or missing hours so callers
 * treat a shape drift as an upstream failure, never as empty forcing.
 *
 * Also returns the SERVED coordinates of every node, for both endpoints: the
 * marine and forecast APIs snap independently and do not agree (measured: node
 * 12 differs by 3.2 km between them), so the caller georeferences the grid to
 * the marine axes and reports the wind disagreement rather than assuming one.
 */
export function normalizeMarineGridUpstream(
  marineUpstream,
  windUpstream,
  nodeCount,
) {
  const marine = Array.isArray(marineUpstream)
    ? marineUpstream
    : [marineUpstream];
  const wind = Array.isArray(windUpstream) ? windUpstream : [windUpstream];
  if (marine.length !== nodeCount || wind.length !== nodeCount) return null;
  const hoursMs = marineHoursToMs(marine[0]?.hourly?.time);
  if (!hoursMs) return null;
  const nodes = [];
  const servedLats = [];
  const servedLons = [];
  const windLats = [];
  const windLons = [];
  for (let i = 0; i < nodeCount; i += 1) {
    const marineHourly = marine[i]?.hourly ?? {};
    const windHourly = wind[i]?.hourly ?? {};
    servedLats.push(marine[i]?.latitude);
    servedLons.push(marine[i]?.longitude);
    windLats.push(wind[i]?.latitude);
    windLons.push(wind[i]?.longitude);
    nodes.push({
      waveHeightM: marineHourly.wave_height ?? [],
      currentKmh: marineHourly.ocean_current_velocity ?? [],
      currentDirDeg: marineHourly.ocean_current_direction ?? [],
      windMs: windHourly.wind_speed_10m ?? [],
      windDirDeg: windHourly.wind_direction_10m ?? [],
    });
  }
  return { hoursMs, nodes, servedLats, servedLons, windLats, windLons };
}

/**
 * Fetch and parse the NDBC bulk latest-observations feed. Throws on HTTP
 * errors and on non-NDBC bodies (HTML error pages) so broken upstream
 * payloads are never cached. `fetchImpl` is injectable for tests.
 */
export async function fetchOceanObs({
  fetchImpl = fetch,
  timeoutMs = 20_000,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(OCEAN_OBS_URL, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
    const text = await readResponseTextCapped(
      response,
      OCEAN_MAX_RESPONSE_BYTES,
    );
    const records = parseNdbcLatestObs(text);
    if (records === null) throw new Error('non-NDBC upstream response');
    return { fetchedAtMs: Date.now(), stations: records };
  } finally {
    clearTimeout(timeout);
  }
}

function trimOceanCache(cache, maxEntries) {
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * The `/api/ocean` plugin. Exported so `src/data/oceanProxy.test.mjs` can drive
 * the MIDDLEWARE — dispatch, validation and status codes — rather than only the
 * pure helpers it happens to hang off. Every one of that file's assertions used
 * to call a helper directly, so no route's method check, sub-path routing or
 * 400 handling was covered by anything, which is how the `/field` box guard sat
 * unreachable and answered 500.
 *
 * @returns {{name: string, configureServer: Function, configurePreviewServer: Function}}
 */
export function oceanProxy() {
  async function loadOceanStationsMeta() {
    const now = Date.now();
    if (
      _oceanStationsCache &&
      now - _oceanStationsCache.cachedAt <= OCEAN_STATIONS_CACHE_MS
    ) {
      return _oceanStationsCache.stations;
    }
    try {
      const xml = await fetchRegionalText(OCEAN_STATIONS_URL, {
        maxBytes: OCEAN_MAX_RESPONSE_BYTES,
        timeoutMs: 15_000,
      });
      const stations = parseActiveStationsXml(xml);
      if (stations.size > 0) _oceanStationsCache = { stations, cachedAt: now };
      return stations;
    } catch {
      // Name/type enrichment is decorative — never let it take obs down.
      return _oceanStationsCache?.stations ?? new Map();
    }
  }

  async function refreshObs() {
    const obs = await fetchOceanObs();
    const stationsMeta = await loadOceanStationsMeta();
    const payload = {
      status: 'ready',
      fetchedAtMs: obs.fetchedAtMs,
      count: obs.stations.length,
      stations: normalizeOceanObs(obs.stations, stationsMeta),
    };
    _oceanObsCache = { payload, cachedAt: Date.now() };
    return payload;
  }

  async function refreshMarine(point, key) {
    const shared = {
      latitude: point.latitude.toFixed(5),
      longitude: point.longitude.toFixed(5),
      forecast_days: '2',
      timezone: 'UTC',
    };
    const marineParams = new URLSearchParams({
      ...shared,
      hourly:
        'wave_height,wave_direction,wave_period,sea_surface_temperature,ocean_current_velocity,ocean_current_direction',
    });
    const windParams = new URLSearchParams({
      ...shared,
      hourly: 'wind_speed_10m,wind_direction_10m',
      wind_speed_unit: 'ms', // forecast API defaults to km/h — request m/s explicitly
    });
    const [marineResult, windResult] = await Promise.allSettled([
      fetchRegionalJson(
        `https://marine-api.open-meteo.com/v1/marine?${marineParams}`,
        {
          maxBytes: OCEAN_POINT_MAX_RESPONSE_BYTES,
        },
      ),
      fetchRegionalJson(
        `https://api.open-meteo.com/v1/forecast?${windParams}`,
        {
          maxBytes: OCEAN_POINT_MAX_RESPONSE_BYTES,
        },
      ),
    ]);
    const marine =
      marineResult.status === 'fulfilled' ? marineResult.value : null;
    const wind = windResult.status === 'fulfilled' ? windResult.value : null;
    if (!marine && !wind) throw new Error('Marine forecast unavailable');
    const payload = {
      status: marine && wind ? 'ready' : 'partial',
      retrievedAt: new Date().toISOString(),
      coordinates: point,
      marine: marine?.hourly ?? null,
      marineUnits: marine?.hourly_units ?? null,
      wind: wind?.hourly ?? null,
      windUnits: wind?.hourly_units ?? null,
    };
    _oceanMarineCache.set(key, { payload, cachedAt: Date.now() });
    trimOceanCache(_oceanMarineCache, OCEAN_MARINE_MAX_CACHE);
    return payload;
  }

  async function refreshGrid(point, key) {
    const axes = buildMarineGridAxes(point.latitude, point.longitude);
    const { marineParams, windParams, nodeCount } = buildMarineGridParams(axes);
    const [marineUpstream, windUpstream] = await Promise.all([
      fetchRegionalJson(
        `https://marine-api.open-meteo.com/v1/marine?${marineParams}`,
        {
          maxBytes: OCEAN_MAX_RESPONSE_BYTES,
          timeoutMs: 15_000,
        },
      ),
      fetchRegionalJson(
        `https://api.open-meteo.com/v1/forecast?${windParams}`,
        {
          maxBytes: OCEAN_MAX_RESPONSE_BYTES,
          timeoutMs: 15_000,
        },
      ),
    ]);
    const grid = normalizeMarineGridUpstream(
      marineUpstream,
      windUpstream,
      nodeCount,
    );
    if (!grid) throw new Error('Marine grid response shape mismatch');

    const payload = {
      status: 'ready',
      retrievedAt: new Date().toISOString(),
      seed: point,
      ...georeferenceMarineGrid(axes, grid, nodeCount),
    };
    _oceanGridCache.set(key, { payload, cachedAt: Date.now() });
    trimOceanCache(_oceanGridCache, OCEAN_GRID_MAX_CACHE);
    return payload;
  }

  async function refreshEtopo(point, key) {
    const box = buildEtopoBox(point.latitude, point.longitude);
    // Stride 2 = 2 arc-min (~3.7 km): 91×91 nodes ≈ 150–250 KB JSON vs ~2 MB
    // at stride 1, and 3.7 km is far finer than the 0.5° forcing grid.
    const query =
      `altitude[(${box.lat0}):2:(${box.lat1})][(${box.lon0}):2:(${box.lon1})]`
        .replace(/\[/g, '%5B')
        .replace(/\]/g, '%5D');
    const upstream = await fetchRegionalJson(
      `https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.json?${query}`,
      { maxBytes: OCEAN_MAX_RESPONSE_BYTES, timeoutMs: 20_000 },
    );
    const grid = normalizeEtopoUpstream(upstream);
    if (!grid) throw new Error('ETOPO response shape mismatch');
    const payload = {
      status: 'ready',
      retrievedAt: new Date().toISOString(),
      seed: point,
      lats: grid.lats,
      lons: grid.lons,
      z: grid.z,
    };
    _oceanEtopoCache.set(key, { payload, cachedAt: Date.now() });
    trimOceanCache(_oceanEtopoCache, OCEAN_ETOPO_MAX_CACHE);
    return payload;
  }

  function install(middlewares) {
    middlewares.use('/api/ocean', async (req, res) => {
      const sendJson = (status, headers, body) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          ...headers,
        });
        res.end(JSON.stringify(body));
      };
      try {
        if (req.method !== 'GET') {
          sendJson(405, {}, { error: 'Method Not Allowed' });
          return;
        }
        const subPath = String(req.url || '').split('?')[0];

        if (subPath === '/obs') {
          if (!_oceanObsRateLimiter(clientKey(req))) {
            sendJson(
              429,
              { 'Retry-After': '10' },
              { error: 'Rate limit exceeded' },
            );
            return;
          }
          const now = Date.now();
          if (
            _oceanObsCache &&
            now - _oceanObsCache.cachedAt <= OCEAN_OBS_CACHE_MS
          ) {
            sendJson(
              200,
              { 'Cache-Control': 'public, max-age=120', 'X-Ocean-Obs': 'HIT' },
              { ..._oceanObsCache.payload, status: 'cached' },
            );
            return;
          }
          const request = coalesceProxyRequest(_oceanObsInFlight, 'obs', () =>
            refreshObs(),
          );
          try {
            const payload = await request.promise;
            sendJson(
              200,
              {
                'Cache-Control': 'public, max-age=120',
                'X-Ocean-Obs': request.shared ? 'INFLIGHT' : 'MISS',
              },
              payload,
            );
          } catch {
            if (
              _oceanObsCache &&
              now - _oceanObsCache.cachedAt <= OCEAN_OBS_STALE_MS
            ) {
              sendJson(
                200,
                { 'Cache-Control': 'no-store', 'X-Ocean-Obs': 'STALE' },
                { ..._oceanObsCache.payload, status: 'stale' },
              );
              return;
            }
            sendJson(
              503,
              { 'Cache-Control': 'no-store' },
              { error: 'Ocean observations are temporarily unavailable' },
            );
          }
          return;
        }

        if (subPath === '/marine' || subPath === '/marine-grid') {
          const isGrid = subPath === '/marine-grid';
          const limiter = isGrid
            ? _oceanGridRateLimiter
            : _oceanMarineRateLimiter;
          if (!limiter(clientKey(req))) {
            sendJson(
              429,
              { 'Retry-After': '10' },
              { error: 'Rate limit exceeded' },
            );
            return;
          }
          const url = new URL(req.url || '', 'http://localhost');
          const point = validRegionalPoint(url.searchParams);
          if (!point) {
            sendJson(
              400,
              {},
              { error: 'Valid latitude and longitude are required' },
            );
            return;
          }
          const cache = isGrid ? _oceanGridCache : _oceanMarineCache;
          const inFlight = isGrid ? _oceanGridInFlight : _oceanMarineInFlight;
          const cacheMs = isGrid ? OCEAN_GRID_CACHE_MS : OCEAN_MARINE_CACHE_MS;
          const staleMs = isGrid ? OCEAN_GRID_STALE_MS : OCEAN_MARINE_STALE_MS;
          const header = isGrid ? 'X-Ocean-Grid' : 'X-Ocean-Marine';
          // Grid keys use coarser 0.25° cells — nearby drift seeds share forcing.
          const cell = isGrid ? 4 : 10;
          const key = `${(Math.round(point.latitude * cell) / cell).toFixed(2)},${(Math.round(point.longitude * cell) / cell).toFixed(2)}`;
          const now = Date.now();
          const cached = cache.get(key);
          if (cached && now - cached.cachedAt <= cacheMs) {
            sendJson(
              200,
              { 'Cache-Control': 'public, max-age=120', [header]: 'HIT' },
              { ...cached.payload, status: 'cached' },
            );
            return;
          }
          const refresh = isGrid ? refreshGrid : refreshMarine;
          const request = coalesceProxyRequest(inFlight, key, () =>
            refresh(point, key),
          );
          try {
            const payload = await request.promise;
            sendJson(
              200,
              {
                'Cache-Control': 'public, max-age=120',
                [header]: request.shared ? 'INFLIGHT' : 'MISS',
              },
              payload,
            );
          } catch {
            if (cached && now - cached.cachedAt <= staleMs) {
              sendJson(
                200,
                { 'Cache-Control': 'no-store', [header]: 'STALE' },
                { ...cached.payload, status: 'stale' },
              );
              return;
            }
            sendJson(
              503,
              { 'Cache-Control': 'no-store' },
              { error: 'Marine forecast is temporarily unavailable' },
            );
          }
          return;
        }

        if (subPath === '/etopo') {
          if (!_oceanEtopoRateLimiter(clientKey(req))) {
            sendJson(
              429,
              { 'Retry-After': '10' },
              { error: 'Rate limit exceeded' },
            );
            return;
          }
          const url = new URL(req.url || '', 'http://localhost');
          const point = validRegionalPoint(url.searchParams);
          if (!point) {
            sendJson(
              400,
              {},
              { error: 'Valid latitude and longitude are required' },
            );
            return;
          }
          // 0.25° cells like the forcing grid — nearby drift seeds share bathymetry.
          const key = `${(Math.round(point.latitude * 4) / 4).toFixed(2)},${(Math.round(point.longitude * 4) / 4).toFixed(2)}`;
          const now = Date.now();
          const cached = _oceanEtopoCache.get(key);
          if (cached && now - cached.cachedAt <= OCEAN_ETOPO_CACHE_MS) {
            sendJson(
              200,
              {
                'Cache-Control': 'public, max-age=86400',
                'X-Ocean-Etopo': 'HIT',
              },
              { ...cached.payload, status: 'cached' },
            );
            return;
          }
          const request = coalesceProxyRequest(_oceanEtopoInFlight, key, () =>
            refreshEtopo(point, key),
          );
          try {
            const payload = await request.promise;
            sendJson(
              200,
              {
                'Cache-Control': 'public, max-age=86400',
                'X-Ocean-Etopo': request.shared ? 'INFLIGHT' : 'MISS',
              },
              payload,
            );
          } catch {
            if (cached && now - cached.cachedAt <= OCEAN_ETOPO_STALE_MS) {
              sendJson(
                200,
                { 'Cache-Control': 'no-store', 'X-Ocean-Etopo': 'STALE' },
                { ...cached.payload, status: 'stale' },
              );
              return;
            }
            sendJson(
              503,
              { 'Cache-Control': 'no-store' },
              { error: 'Bathymetry is temporarily unavailable' },
            );
          }
          return;
        }

        if (subPath === '/field') {
          if (!_oceanFieldRateLimiter(clientKey(req))) {
            sendJson(
              429,
              { 'Retry-After': '10' },
              { error: 'Rate limit exceeded' },
            );
            return;
          }
          const url = new URL(req.url || '', 'http://localhost');
          // Presence, not finiteness — the same trap the `cells` note below
          // describes: `Number(null) === 0`, so reading an OMITTED bound with
          // `Number(...)` turns it into a valid 0 and the box degenerates to a
          // zero-area rectangle on the Gulf of Guinea rather than being refused
          // as missing. NaN here reaches normalizeBox as "not a finite number",
          // which is what it is.
          const bound = (name) => {
            const raw = url.searchParams.get(name);
            return raw === null ? Number.NaN : Number(raw);
          };
          // `tryNormalizeBox`, not `normalizeBox`: the latter signals refusal by
          // THROWING, so testing its return value for falsiness was unreachable
          // code and every malformed request answered 500 `ocean proxy error`
          // out of the outer catch instead of 400.
          const { box, error: boxError } = tryNormalizeBox({
            latMin: bound('latMin'),
            latMax: bound('latMax'),
            lonMin: bound('lonMin'),
            lonMax: bound('lonMax'),
          });
          if (!box) {
            sendJson(
              400,
              {},
              {
                error: 'Valid latMin/latMax/lonMin/lonMax are required',
                detail: boxError,
              },
            );
            return;
          }
          // Presence, not finiteness: `Number(null) === 0`, which IS finite, so
          // testing the coerced value made an omitted `cells` clamp to the
          // MINIMUM (63 nodes for the Monterey box) and left DEFAULT_TARGET_CELLS
          // unreachable. Latent only because the in-repo client always sends it.
          const rawCells = url.searchParams.get('cells');
          const requestedCells =
            rawCells === null ? Number.NaN : Number(rawCells);
          const targetCells = Number.isFinite(requestedCells)
            ? Math.min(
                MAX_TARGET_CELLS,
                Math.max(MIN_TARGET_CELLS, Math.trunc(requestedCells)),
              )
            : DEFAULT_TARGET_CELLS;
          // Cache on a 0.5°-quantized box plus the cell budget. Panning within
          // half a degree reuses the analysis; the HF-radar tier costs several
          // upstream round trips and a Barnes pass per distinct key.
          const q = (value) => (Math.round(value * 2) / 2).toFixed(1);
          const key = `${q(box.latMin)},${q(box.lonMin)},${q(box.latMax)},${q(box.lonMax)},${targetCells}`;
          const now = Date.now();
          const cached = _oceanFieldCache.get(key);
          if (cached && now - cached.cachedAt <= OCEAN_FIELD_CACHE_MS) {
            sendJson(
              200,
              {
                'Cache-Control': 'public, max-age=300',
                'X-Ocean-Field': 'HIT',
              },
              cached.payload,
            );
            return;
          }
          const request = coalesceProxyRequest(
            _oceanFieldInFlight,
            key,
            async () => {
              const payload = await buildFieldPayload({
                box,
                atMs: now,
                targetCells,
                fetchImpl: (input, init) => fetch(input, init),
              });
              // An `unavailable` payload is a legitimate answer (open ocean with
              // no radar, upstream down) and is cached like any other, so a dead
              // region does not re-probe every ERDDAP rung on each camera move.
              _oceanFieldCache.set(key, { payload, cachedAt: Date.now() });
              trimOceanCache(_oceanFieldCache, OCEAN_FIELD_MAX_CACHE);
              return payload;
            },
          );
          try {
            const payload = await request.promise;
            sendJson(
              200,
              {
                'Cache-Control': 'public, max-age=300',
                'X-Ocean-Field': request.shared ? 'INFLIGHT' : 'MISS',
              },
              payload,
            );
          } catch {
            if (cached && now - cached.cachedAt <= OCEAN_FIELD_STALE_MS) {
              sendJson(
                200,
                { 'Cache-Control': 'no-store', 'X-Ocean-Field': 'STALE' },
                cached.payload,
              );
              return;
            }
            sendJson(
              503,
              { 'Cache-Control': 'no-store' },
              { error: 'Ocean current field is temporarily unavailable' },
            );
          }
          return;
        }

        sendJson(404, {}, { error: 'Unknown ocean endpoint' });
      } catch (err) {
        console.error('[ocean-proxy]', err?.message || err);
        sendJson(
          500,
          { 'Cache-Control': 'no-store' },
          { error: 'ocean proxy error' },
        );
      }
    });
  }

  return {
    name: 'ocean-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

/**
 * USGS FDSN Event Web Service adapter — deterministic query validation,
 * request building and GeoJSON normalization. No LLM involved anywhere in
 * this module.
 *
 * Upstream docs: https://earthquake.usgs.gov/fdsnws/event/1/ (the `query`
 * and `count` methods; times are UTC by default and every parameter is
 * sent to USGS exactly once — see `validateQuery` below).
 *
 * This is a SERVER-SIDE adapter for the FDSN *query* API (arbitrary time
 * window / magnitude / geographic filters, on demand). It is intentionally
 * separate from the browser layer `src/layers/earthquakes/source.js`, which
 * polls USGS's rolling "all_day" *summary* feed
 * (https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson)
 * directly from the client for the live globe view. The two are not
 * duplicates: the summary feed has no query parameters and always means
 * "the last 24 hours, everything"; this adapter answers a parameterised
 * search and is consumed via `server/serverless/earthquakes-route.js`.
 */

export const USGS_QUERY_URL =
  'https://earthquake.usgs.gov/fdsnws/event/1/query';
export const USGS_COUNT_URL =
  'https://earthquake.usgs.gov/fdsnws/event/1/count';

/**
 * Every query parameter this adapter forwards to USGS. `mode` is accepted
 * alongside these but is a LOCAL switch (selects the query vs. count
 * endpoint) — it is never itself forwarded upstream.
 */
export const ALLOWED_PARAMS = Object.freeze([
  'starttime',
  'endtime',
  'minmagnitude',
  'maxmagnitude',
  'latitude',
  'longitude',
  'maxradiuskm',
  'minlatitude',
  'maxlatitude',
  'minlongitude',
  'maxlongitude',
  'limit',
  'orderby',
]);

const CIRCLE_KEYS = Object.freeze(['latitude', 'longitude', 'maxradiuskm']);
const BBOX_KEYS = Object.freeze([
  'minlatitude',
  'maxlatitude',
  'minlongitude',
  'maxlongitude',
]);
const ORDERBY_VALUES = Object.freeze([
  'time',
  'time-asc',
  'magnitude',
  'magnitude-asc',
]);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MIN_MAG = -2;
const MAX_MAG = 10;
const MAX_RADIUS_KM = 20001.6;
const LICENSE_NOTE =
  'USGS data are in the public domain (https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)';

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z?$/;

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isValidCalendarDate(year, month, day) {
  if (month < 1 || month > 12) return false;
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day >= 1 && day <= daysInMonth[month - 1];
}

/**
 * Validate + normalise an ISO-8601 UTC timestamp for starttime/endtime.
 * Accepts `YYYY-MM-DD` (midnight UTC) or `YYYY-MM-DDTHH:MM:SS(.sss)(Z)`
 * (fractional seconds allowed on input, dropped on output). Parsed by hand
 * (rather than `new Date()`) so the result never depends on the host
 * timezone: a date-time string with no offset is UTC per USGS convention,
 * which is NOT how the ECMAScript Date Time String Format treats it.
 * Returns a canonical `YYYY-MM-DDTHH:MM:SSZ` string, or `null` if invalid.
 */
function normalizeIsoTimestamp(rawValue) {
  const value = String(rawValue);

  const dateOnly = DATE_ONLY_RE.exec(value);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    if (!isValidCalendarDate(Number(y), Number(mo), Number(d))) return null;
    return `${y}-${mo}-${d}T00:00:00Z`;
  }

  const dateTime = DATE_TIME_RE.exec(value);
  if (dateTime) {
    const [, y, mo, d, h, mi, s] = dateTime;
    if (!isValidCalendarDate(Number(y), Number(mo), Number(d))) return null;
    if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
    return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  }

  return null;
}

/**
 * Validate a raw query-params object against `ALLOWED_PARAMS` (+`mode`) and
 * build the exact param set to forward to USGS.
 *
 * @param {Record<string, unknown>} [rawParams]
 * @returns {{ok: true, forwarded: Record<string, string|number>, mode: 'query'|'count'}
 *   | {ok: false, status: 400, error: string, unknown: string[]}}
 */
export function validateQuery(rawParams) {
  const params = rawParams && typeof rawParams === 'object' ? rawParams : {};

  const fail = (error) => ({ ok: false, status: 400, error, unknown: [] });

  const unknown = Object.keys(params).filter(
    (key) => key !== 'mode' && !ALLOWED_PARAMS.includes(key),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `Unknown parameter(s): ${unknown.join(', ')}`,
      unknown,
    };
  }

  let mode = 'query';
  if (params.mode !== undefined) {
    mode = String(params.mode);
    if (mode !== 'query' && mode !== 'count') {
      return fail(`Invalid mode: expected "query" or "count", got "${mode}"`);
    }
  }

  const forwarded = {};

  for (const key of ['starttime', 'endtime']) {
    if (params[key] === undefined) continue;
    const normalized = normalizeIsoTimestamp(params[key]);
    if (!normalized) {
      return fail(
        `Invalid ${key}: expected YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS(Z) (UTC)`,
      );
    }
    forwarded[key] = normalized;
  }

  const magnitudeRanges = {
    minmagnitude: [MIN_MAG, MAX_MAG],
    maxmagnitude: [MIN_MAG, MAX_MAG],
  };
  const bboxRanges = {
    latitude: [-90, 90],
    minlatitude: [-90, 90],
    maxlatitude: [-90, 90],
    longitude: [-180, 180],
    minlongitude: [-180, 180],
    maxlongitude: [-180, 180],
  };
  for (const [key, [min, max]] of Object.entries({
    ...magnitudeRanges,
    ...bboxRanges,
  })) {
    if (params[key] === undefined) continue;
    const value = Number(params[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      return fail(`Invalid ${key}: expected a number in [${min}, ${max}]`);
    }
    forwarded[key] = value;
  }

  if (params.maxradiuskm !== undefined) {
    const value = Number(params.maxradiuskm);
    if (!Number.isFinite(value) || value <= 0 || value > MAX_RADIUS_KM) {
      return fail(
        `Invalid maxradiuskm: expected a number in (0, ${MAX_RADIUS_KM}]`,
      );
    }
    forwarded.maxradiuskm = value;
  }

  if (
    forwarded.minlatitude !== undefined &&
    forwarded.maxlatitude !== undefined &&
    forwarded.minlatitude > forwarded.maxlatitude
  ) {
    return fail('Invalid bbox: minlatitude must be <= maxlatitude');
  }
  if (
    forwarded.minlongitude !== undefined &&
    forwarded.maxlongitude !== undefined &&
    forwarded.minlongitude > forwarded.maxlongitude
  ) {
    return fail('Invalid bbox: minlongitude must be <= maxlongitude');
  }

  const circleProvided = CIRCLE_KEYS.filter((key) => params[key] !== undefined);
  const bboxProvided = BBOX_KEYS.filter((key) => params[key] !== undefined);
  if (circleProvided.length > 0 && bboxProvided.length > 0) {
    return fail(
      'circle (latitude/longitude/maxradiuskm) and bbox (minlatitude/maxlatitude/minlongitude/maxlongitude) are mutually exclusive',
    );
  }
  if (circleProvided.length > 0 && circleProvided.length < CIRCLE_KEYS.length) {
    return fail(
      'circle search requires latitude, longitude and maxradiuskm together',
    );
  }

  if (params.limit === undefined) {
    forwarded.limit = DEFAULT_LIMIT;
  } else {
    const value = Number(params.limit);
    if (!Number.isInteger(value) || value < 1) {
      return fail('Invalid limit: expected an integer >= 1');
    }
    forwarded.limit = Math.min(value, MAX_LIMIT);
  }

  if (params.orderby === undefined) {
    forwarded.orderby = 'time';
  } else if (!ORDERBY_VALUES.includes(params.orderby)) {
    return fail(
      `Invalid orderby: expected one of ${ORDERBY_VALUES.join(', ')}`,
    );
  } else {
    forwarded.orderby = params.orderby;
  }

  // Added exactly once, here, so every caller (fetchEarthquakes) building a
  // request from `forwarded` never needs to (and cannot accidentally
  // duplicate) it again.
  forwarded.format = 'geojson';

  return { ok: true, forwarded, mode };
}

/**
 * Normalise one USGS GeoJSON Feature into the flat event shape this
 * adapter promises callers.
 *
 * @param {object} feature a GeoJSON Feature from the FDSN `query` response
 * @param {string} retrievedAtUtc ISO timestamp of when the response was fetched
 */
export function normalizeFeature(feature, retrievedAtUtc) {
  const properties = feature?.properties || {};
  const coordinates = feature?.geometry?.coordinates || [];
  return {
    id: feature?.id ?? null,
    time_utc:
      typeof properties.time === 'number'
        ? new Date(properties.time).toISOString()
        : null,
    magnitude: typeof properties.mag === 'number' ? properties.mag : null,
    mag_type: properties.magType ?? null,
    depth_km: typeof coordinates[2] === 'number' ? coordinates[2] : null,
    lat: typeof coordinates[1] === 'number' ? coordinates[1] : null,
    lon: typeof coordinates[0] === 'number' ? coordinates[0] : null,
    place: properties.place ?? null,
    tsunami: properties.tsunami === 1 ? 1 : 0,
    alert: properties.alert ?? null,
    url: properties.url ?? null,
    source: 'USGS',
    coverage: 'observed',
    retrieved_at_utc: retrievedAtUtc,
  };
}

/** Build a request URL from a fully-validated `forwarded` param set (each key appears exactly once). */
function buildRequestUrl(baseUrl, forwarded) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(forwarded)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  return `${baseUrl}?${search.toString()}`;
}

async function readTextSafely(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function buildProvenance(metadata, url, retrievedAtUtc) {
  return {
    source: 'USGS FDSN Event Web Service',
    url,
    generated:
      typeof metadata?.generated === 'number'
        ? new Date(metadata.generated).toISOString()
        : null,
    api: metadata?.api ?? null,
    title: metadata?.title ?? null,
    retrieved_at_utc: retrievedAtUtc,
    license: LICENSE_NOTE,
  };
}

async function parseSuccessResponse(response, url, mode, retrievedAtUtc) {
  let body;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      status: 502,
      error: 'usgs_unavailable',
      detail: 'USGS returned a response that was not valid JSON',
    };
  }
  const provenance = buildProvenance(body?.metadata, url, retrievedAtUtc);

  if (mode === 'count') {
    const count = Number(body?.count);
    return {
      ok: true,
      status: 200,
      count: Number.isFinite(count) ? count : 0,
      provenance,
    };
  }

  const features = Array.isArray(body?.features) ? body.features : [];
  return {
    ok: true,
    status: 200,
    count: features.length,
    events: features.map((feature) =>
      normalizeFeature(feature, retrievedAtUtc),
    ),
    provenance,
  };
}

/**
 * Issue the (already-validated) request against USGS with one retry on
 * network/timeout errors or a 5xx response. 4xx responses are returned
 * immediately, without retrying — USGS reports bad query combinations as a
 * plain-text 400/404 body.
 */
async function requestUsgs(
  baseUrl,
  forwarded,
  { fetchImpl, timeoutMs, retries, now, mode },
) {
  const url = buildRequestUrl(baseUrl, forwarded);
  const maxAttempts = Math.max(1, retries + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt < maxAttempts) continue;
      const isTimeout = error?.name === 'TimeoutError';
      return {
        ok: false,
        status: 504,
        error: isTimeout ? 'usgs_timeout' : 'usgs_unavailable',
        detail: String(error?.message || error?.name || 'network error'),
      };
    }

    if (response.ok) {
      return parseSuccessResponse(response, url, mode, now().toISOString());
    }

    if (response.status >= 500) {
      if (attempt < maxAttempts) continue;
      const detail = (await readTextSafely(response)).slice(0, 200);
      return {
        ok: false,
        status: response.status,
        error: 'usgs_unavailable',
        detail,
      };
    }

    // 4xx (or any other non-5xx failure): USGS's own status if it is one it
    // documents for bad requests, otherwise normalised to 400. Never retried.
    const detail = (await readTextSafely(response)).slice(0, 200);
    const status =
      response.status === 400 || response.status === 404
        ? response.status
        : 400;
    return { ok: false, status, error: 'usgs_rejected', detail };
  }

  // Unreachable: the loop above always returns by its last iteration.
  return {
    ok: false,
    status: 504,
    error: 'usgs_unavailable',
    detail: 'exhausted retries',
  };
}

/**
 * Query USGS FDSN Event Web Service (or its `count` sibling when
 * `mode: 'count'` is passed) for earthquakes matching the given filters.
 *
 * @param {Record<string, unknown>} params raw query params (+ optional `mode`)
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, retries?: number, now?: () => Date}} [options]
 */
export async function fetchEarthquakes(
  params,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
    retries = 1,
    now = () => new Date(),
  } = {},
) {
  const validated = validateQuery(params);
  if (!validated.ok) return validated;

  const { forwarded, mode } = validated;
  const baseUrl = mode === 'count' ? USGS_COUNT_URL : USGS_QUERY_URL;
  return requestUsgs(baseUrl, forwarded, {
    fetchImpl,
    timeoutMs,
    retries,
    now,
    mode,
  });
}

/** Convenience wrapper: same as `fetchEarthquakes` with `mode` forced to `'count'`. */
export async function countEarthquakes(params, options) {
  return fetchEarthquakes({ ...(params || {}), mode: 'count' }, options);
}

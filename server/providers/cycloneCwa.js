import { readResponseTextCapped } from './common/http.js';

export const CWA_CYCLONE_DATASET_URL =
  'https://opendata.cwa.gov.tw/dataset/forecast/W-C0034-005';
export const CWA_CYCLONE_API_URL =
  'https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-005?format=JSON';
export const CWA_CYCLONE_MAX_RESPONSE_BYTES = 1024 * 1024;

const HOUR = 60 * 60 * 1000;
const MAX_STORMS = 32;
const MAX_FIXES = 256;
const MAX_FORECAST_POINTS = 32;
const MAX_TOTAL_FORECAST_POINTS = 256;
const MAX_ISSUED_FUTURE_MS = 90 * 60 * 1000;
const MAX_AGE_MS = 12 * HOUR;
const SOURCE = 'Taiwan Central Weather Administration (CWA)';

function invalid() {
  return new Error('invalid_cwa_cyclone_data');
}

const key = (value) =>
  String(value)
    .replace(/[^a-z\d]/gi, '')
    .toLowerCase();

function get(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const wanted = key(name);
  const entry = Object.entries(value).find(
    ([candidate]) => key(candidate) === wanted,
  );
  return entry?.[1];
}

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function scalar(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return get(value, '#text') ?? get(value, 'Value') ?? get(value, 'value');
}

function cleanText(value, max = 160) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f<>]/.test(value)
  )
    throw invalid();
  return value.trim();
}

function number(value, low, high, { required = false } = {}) {
  value = scalar(value);
  if (value === null || value === undefined || value === '') {
    if (required) throw invalid();
    return null;
  }
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(result) || result < low || result > high)
    throw invalid();
  return result;
}

function timestamp(value, now, { fresh = false } = {}) {
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/i.test(
      value,
    )
  )
    throw invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw invalid();
  if (
    fresh &&
    (parsed > now + MAX_ISSUED_FUTURE_MS || now - parsed > MAX_AGE_MS)
  )
    throw invalid();
  return new Date(parsed).toISOString();
}

function longitude(value) {
  const input = number(value, -360, 360, { required: true });
  const normalized =
    input > 180 ? input - 360 : input < -180 ? input + 360 : input;
  if (normalized < -180 || normalized > 180) throw invalid();
  return normalized;
}

function position(value) {
  const lon = get(value, 'CoordinateLongitude') ?? get(value, 'Longitude');
  const lat = get(value, 'CoordinateLatitude') ?? get(value, 'Latitude');
  return {
    longitude: longitude(lon),
    latitude: number(lat, -90, 90, { required: true }),
  };
}

function timeFromForecast(value, initTime, now) {
  value = scalar(value);
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid();
  const raw = String(value).trim();
  if (!raw) throw invalid();
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(raw)) return timestamp(raw, now);
  const tauHours = number(raw, 0, 168, { required: true });
  return new Date(Date.parse(initTime) + tauHours * HOUR).toISOString();
}

function probabilityRadius(value) {
  if (value === null || value === undefined || value === '') return null;
  const radius = get(value, 'Radius') ?? value;
  const unit = scalar(get(radius, 'unit') ?? get(value, 'unit'));
  if (
    unit !== null &&
    unit !== undefined &&
    !['km', 'kilometer', 'kilometre', '公里'].includes(
      String(unit).trim().toLowerCase(),
    )
  )
    throw invalid();
  return number(radius, 0, 3000);
}

function collectForecastRecords(
  value,
  inheritedInitTime,
  records,
  budget,
  depth = 0,
) {
  if (depth > 12 || ++budget.nodes > 20_000) throw invalid();
  if (Array.isArray(value)) {
    if (value.length > MAX_TOTAL_FORECAST_POINTS) throw invalid();
    for (const item of value)
      collectForecastRecords(
        item,
        inheritedInitTime,
        records,
        budget,
        depth + 1,
      );
    return;
  }
  if (!value || typeof value !== 'object') return;

  const ownInitTime =
    scalar(get(value, 'InitTime') ?? get(value, 'InitialTime')) ??
    inheritedInitTime;
  const rawLongitude =
    get(value, 'CoordinateLongitude') ?? get(value, 'Longitude');
  const rawLatitude =
    get(value, 'CoordinateLatitude') ?? get(value, 'Latitude');
  const rawValidTime =
    get(value, 'CoordinateTau') ?? get(value, 'ForecastHour');
  if (
    rawLongitude !== undefined &&
    rawLatitude !== undefined &&
    rawValidTime !== undefined
  ) {
    if (typeof ownInitTime !== 'string') throw invalid();
    const initAt = timestamp(ownInitTime, budget.now, { fresh: true });
    const validAt = timeFromForecast(rawValidTime, initAt, budget.now);
    const validMs = Date.parse(validAt);
    if (
      validMs < Date.parse(initAt) ||
      validMs > Date.parse(initAt) + 168 * HOUR
    )
      throw invalid();
    if (validMs > budget.now && validMs > Date.parse(initAt)) {
      if (records.length >= MAX_TOTAL_FORECAST_POINTS) throw invalid();
      records.push({
        initAt,
        validAt,
        position: position(value),
        windMs: number(get(value, 'MaxWindSpeed'), 0, 150),
        gustMs: number(get(value, 'MaxGustSpeed'), 0, 180),
        pressureHpa: number(get(value, 'Pressure'), 800, 1100),
        probabilityRadiusKm: probabilityRadius(
          get(value, 'RadiusOf70PercentProbability') ??
            get(value, 'Radius70PercentProbability'),
        ),
      });
    }
  }

  for (const child of Object.values(value))
    if (child && typeof child === 'object')
      collectForecastRecords(child, ownInitTime, records, budget, depth + 1);
}

function splitDateLine(line) {
  const pieces = [];
  let current = [line[0]];
  for (let index = 1; index < line.length; index++) {
    const from = line[index - 1];
    const to = line[index];
    const delta = to[0] - from[0];
    if (Math.abs(delta) > 180) {
      const adjustedTo = to[0] + (delta > 180 ? -360 : 360);
      const edge = delta > 180 ? -180 : 180;
      const fraction = (edge - from[0]) / (adjustedTo - from[0]);
      const crossingLat = from[1] + (to[1] - from[1]) * fraction;
      current.push([edge, crossingLat]);
      if (current.length >= 2) pieces.push(current);
      current = [[-edge, crossingLat], to];
    } else current.push(to);
  }
  if (current.length >= 2) pieces.push(current);
  return pieces;
}

function cycloneId(raw, year) {
  const depressionNumber = get(raw, 'CwaTdNo');
  const typhoonNumber = get(raw, 'CwaTyNo');
  const depression = number(depressionNumber, 1, 99);
  const typhoon = depression === null ? number(typhoonNumber, 1, 99) : null;
  const numberValue = depression ?? typhoon;
  if (!numberValue) throw invalid();
  const kind = depression !== null ? 'td' : 'ty';
  return `cwa-${year}-${kind}${numberValue}`;
}

/**
 * Normalize the documented CWA W-C0034-005 JSON representation.
 *
 * @param {object} payload CWA Open Data API response.
 * @param {number} [now=Date.now()] Current time in milliseconds.
 * @returns {Array<object>} Fresh active storms with official future points.
 */
export function parseCwaCyclones(payload, now = Date.now()) {
  const apiRecords = get(payload, 'records');
  const apiResult = get(payload, 'result');
  const apiEnvelope = apiRecords !== undefined;
  if (apiEnvelope && ![true, 'true'].includes(get(payload, 'success')))
    throw invalid();

  const root = get(payload, 'Cwaopendata') ?? payload;
  if (!apiEnvelope && get(root, 'Status') !== 'Actual') throw invalid();
  const productIssuedAt = apiEnvelope
    ? null
    : timestamp(get(root, 'Sent'), now, { fresh: true });
  const productId = cleanText(
    String(
      (apiEnvelope ? get(apiRecords, 'dataid') : get(root, 'Identifier')) ??
        get(apiResult, 'resource_id') ??
        '',
    ),
    160,
  );
  const dataset = apiEnvelope ? apiRecords : get(root, 'Dataset');
  const tropicalCyclones = get(dataset, 'TropicalCyclones');
  if (!dataset || (!tropicalCyclones && !apiEnvelope)) throw invalid();
  const entries = asArray(
    tropicalCyclones ? get(tropicalCyclones, 'TropicalCyclone') : null,
  );
  if (entries.length > MAX_STORMS) throw invalid();

  const ids = new Set();
  let totalForecastPoints = 0;
  const storms = entries.map((raw) => {
    const year = cleanText(String(get(raw, 'Year') ?? ''), 4);
    if (!/^\d{4}$/.test(year)) throw invalid();
    const id = cycloneId(raw, year);
    if (ids.has(id)) throw invalid();
    ids.add(id);

    const analysis = get(raw, 'AnalysisData');
    const fixes = asArray(get(analysis, 'Fix'));
    if (!analysis || !fixes.length || fixes.length > MAX_FIXES) throw invalid();
    const normalizedFixes = fixes.map((fix) => ({
      at: timestamp(scalar(get(fix, 'DateTime')), now),
      position: position(fix),
      windMs: number(get(fix, 'MaxWindSpeed'), 0, 150),
      gustMs: number(get(fix, 'MaxGustSpeed'), 0, 180),
      pressureHpa: number(get(fix, 'Pressure'), 800, 1100),
      movementSpeedKmh: number(get(fix, 'MovingSpeed'), 0, 500),
      movementDirection: scalar(get(fix, 'MovingDirection')) ?? null,
    }));
    normalizedFixes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const current = normalizedFixes.at(-1);
    if (
      Date.parse(current.at) > now + MAX_ISSUED_FUTURE_MS ||
      now - Date.parse(current.at) > MAX_AGE_MS
    )
      throw invalid();

    const forecastData = get(raw, 'ForecastData');
    const rawForecastFixes = asArray(get(forecastData, 'Fix'));
    const containerCycle = scalar(
      get(forecastData, 'InitialTime') ?? get(forecastData, 'InitTime'),
    );
    const rawCycleValues = [
      ...(containerCycle === null || containerCycle === undefined
        ? []
        : [containerCycle]),
      ...rawForecastFixes
        .map((fix) => scalar(get(fix, 'InitialTime') ?? get(fix, 'InitTime')))
        .filter((value) => value !== null && value !== undefined),
    ];
    const rawCycles = new Set(
      rawCycleValues.map((value) => timestamp(value, now, { fresh: true })),
    );
    if (rawCycles.size > 1) throw invalid();
    const cycleAt = rawCycles.values().next().value ?? null;
    const records = [];
    const budget = { now, nodes: 0 };
    if (forecastData)
      collectForecastRecords(forecastData, null, records, budget);
    if (records.length > MAX_FORECAST_POINTS) throw invalid();
    totalForecastPoints += records.length;
    if (totalForecastPoints > MAX_TOTAL_FORECAST_POINTS) throw invalid();
    const cycles = new Set(records.map((record) => record.initAt));
    if (cycles.size > 1) throw invalid();
    if (cycles.size && cycleAt && !cycles.has(cycleAt)) throw invalid();
    const effectiveCycle = cycles.values().next().value ?? cycleAt;
    const cycleId = effectiveCycle ? `${id}:${effectiveCycle}` : null;
    const futureRecords = records.filter(
      (record) => Date.parse(record.validAt) > Date.parse(current.at),
    );
    const forecastPoints = futureRecords
      .sort((a, b) => Date.parse(a.validAt) - Date.parse(b.validAt))
      .filter((record, index, list) => {
        if (index > 0 && record.validAt === list[index - 1].validAt)
          throw invalid();
        return true;
      })
      .map((record) => ({
        position: record.position,
        validAt: record.validAt,
        tauHours:
          (Date.parse(record.validAt) - Date.parse(effectiveCycle)) / HOUR,
        windKt: null,
        gustKt: null,
        windMs: record.windMs,
        gustMs: record.gustMs,
        pressureHpa: record.pressureHpa,
        probabilityRadiusKm: record.probabilityRadiusKm,
      }));

    const trackLine = [
      [current.position.longitude, current.position.latitude],
      ...forecastPoints.map((point) => [
        point.position.longitude,
        point.position.latitude,
      ]),
    ];
    const trackParts = forecastPoints.length ? splitDateLine(trackLine) : [];
    const name =
      (typeof get(raw, 'TyphoonName') === 'string' &&
        get(raw, 'TyphoonName').trim()) ||
      (typeof get(raw, 'CwaTyphoonName') === 'string' &&
        get(raw, 'CwaTyphoonName').trim()) ||
      id;
    return {
      id,
      provider: 'cwa',
      source: SOURCE,
      sourceUrl: CWA_CYCLONE_DATASET_URL,
      name: cleanText(name),
      classification: 'Tropical cyclone',
      basin: 'WP',
      position: current.position,
      positionAt: current.at,
      issuedAt: productIssuedAt ?? effectiveCycle ?? current.at,
      advisoryNumber: null,
      advisoryId: `${productId}:${id}`,
      cycleId,
      windKt: null,
      windMs: current.windMs,
      windAveragingMinutes: null,
      pressureHpa: current.pressureHpa,
      movement: {
        directionDegrees: null,
        speedKt: null,
        speedKmh: current.movementSpeedKmh,
        direction: current.movementDirection,
      },
      advisoryUrl: CWA_CYCLONE_DATASET_URL,
      outlookUrl: null,
      geometryStatus: forecastPoints.length ? 'current' : 'unavailable',
      geometryAdvisoryNumber: null,
      geometryCycleId: forecastPoints.length ? cycleId : null,
      coneStatus: 'not_provided',
      forecastPoints,
      track: trackParts.length
        ? {
            type: trackParts.length === 1 ? 'LineString' : 'MultiLineString',
            coordinates: trackParts.length === 1 ? trackParts[0] : trackParts,
          }
        : null,
      cone: null,
    };
  });
  return storms;
}

/** Drop expired future points from a cached CWA forecast and rebuild its line. */
export function pruneCwaForecasts(storms, now = Date.now()) {
  return storms
    .filter((storm) => now - Date.parse(storm.positionAt) <= MAX_AGE_MS)
    .map((storm) => {
      const forecastPoints = storm.forecastPoints.filter(
        (point) => Date.parse(point.validAt) > now,
      );
      const line = [
        [storm.position.longitude, storm.position.latitude],
        ...forecastPoints.map((point) => [
          point.position.longitude,
          point.position.latitude,
        ]),
      ];
      const parts = forecastPoints.length ? splitDateLine(line) : [];
      return {
        ...storm,
        forecastPoints,
        geometryStatus: forecastPoints.length ? 'current' : 'unavailable',
        geometryCycleId: forecastPoints.length ? storm.cycleId : null,
        track: parts.length
          ? {
              type: parts.length === 1 ? 'LineString' : 'MultiLineString',
              coordinates: parts.length === 1 ? parts[0] : parts,
            }
          : null,
      };
    });
}

/** Fetch CWA's fixed active tropical cyclone product using a server-only key. */
export async function fetchCwaCyclones({
  apiKey,
  fetchImpl = fetch,
  now = () => Date.now(),
  signal,
  timeoutMs = 12_000,
  maxBytes = CWA_CYCLONE_MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim())
    return { configured: false, storms: [], fetchedAt: null };
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(CWA_CYCLONE_API_URL, {
    signal: requestSignal,
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      Authorization: apiKey.trim(),
      'User-Agent': 'Gods Eye View (public tropical cyclone context)',
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('cwa_cyclone_upstream_unavailable');
  }
  const payload = JSON.parse(
    await readResponseTextCapped(response, maxBytes, requestSignal),
  );
  requestSignal.throwIfAborted();
  return {
    configured: true,
    storms: parseCwaCyclones(payload, now()),
    fetchedAt: now(),
  };
}

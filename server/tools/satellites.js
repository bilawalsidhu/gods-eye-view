/**
 * server/tools/satellites.js — OnDemand-callable satellite tools backed by the
 * existing CelesTrak proxy (server/providers/space/celestrak.js) run
 * IN-PROCESS through server/tools/_invoke.js, so the 6 h TLE cache, the
 * celestrak.org → celestrak.com → cache → bundled-snapshot fallback chain and
 * the structured provider status are shared with the browser layer.
 *
 *   list_satellites_in_scene  SGP4-propagate every satellite of the requested
 *                             CelesTrak groups at "now" and return the ones
 *                             whose sub-satellite point is within `radiusKm`
 *                             of the scene point (and above `minElevationDeg`
 *                             for that observer), nearest first.
 *   satellite_passes          rise / culmination / set predictions for one
 *                             satellite (by NORAD id or name) over an observer
 *                             for the next `hours`.
 *
 * Every handler returns `{ ok:true, data, provider, provenance }` or
 * `{ ok:false, status, error:{ code, message }, provider? }` — it never throws
 * for an upstream problem and never echoes an environment value.
 */
import {
  twoline2satrec,
  propagate,
  gstime,
  eciToGeodetic,
  eciToEcf,
  ecfToLookAngles,
  degreesLat,
  degreesLong,
} from 'satellite.js';
import { celestrakProxy } from '../providers/space/celestrak.js';
import { createPluginInvoker, providerFromHeaders } from './_invoke.js';

export const SATELLITE_GROUPS = Object.freeze([
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
]);
export const DEFAULT_SCENE_GROUPS = Object.freeze([
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
]);

/** Common names → the CelesTrak catalogue name (lower-cased, exact query match only). */
export const NAME_ALIASES = Object.freeze({
  iss: 'iss (zarya)',
  'international space station': 'iss (zarya)',
  zarya: 'iss (zarya)',
  tiangong: 'css (tianhe)',
  'tiangong space station': 'css (tianhe)',
  tianhe: 'css (tianhe)',
  css: 'css (tianhe)',
  hubble: 'hst',
  'hubble space telescope': 'hst',
});

const EARTH_RADIUS_KM = 6371.0088;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const STATUS_RANK = { live: 0, stale: 1, degraded: 2, unavailable: 3 };

const defaultInvoke = createPluginInvoker(() => celestrakProxy());

const isoUtc = (ms) => new Date(ms).toISOString();
const round = (value, digits = 3) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const normalizeAzimuth = (deg) => ((deg % 360) + 360) % 360;

/** Great-circle distance between two points in kilometres (haversine). */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** TLE epoch (line 1 columns 19–32: YYDDD.DDDDDDDD) as an ISO UTC string. */
export function tleEpochUtc(line1) {
  const yy = Number(String(line1).slice(18, 20));
  const day = Number(String(line1).slice(20, 32));
  if (!Number.isFinite(yy) || !Number.isFinite(day)) return null;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return isoUtc(Date.UTC(year, 0, 1) + (day - 1) * 86_400_000);
}

/**
 * Parse CelesTrak 3-line TLE text into `{ name, noradId, line1, line2 }`
 * records (same triplet rule as src/layers/satellites/orbits.js parseTLE).
 */
export function parseTleText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const result = [];
  for (let i = 0; i < lines.length - 2; i += 1) {
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (!line1?.startsWith('1 ') || !line2?.startsWith('2 ')) continue;
    const name = lines[i].trim();
    const catalog = line1.slice(2, 7).trim();
    const numeric = /^\d+$/.test(catalog) ? Number(catalog) : null;
    result.push({
      name,
      noradId: numeric ?? catalog,
      line1,
      line2,
    });
    i += 2;
  }
  return result;
}

/** A satrec for a TLE record, or null when satellite.js rejects it. */
export function satrecFor(record) {
  try {
    const satrec = twoline2satrec(record.line1, record.line2);
    if (!satrec || satrec.error) return null;
    // satellite.js does not validate the columns: garbage parses to NaN elements.
    if (
      ![satrec.no, satrec.ecco, satrec.inclo, satrec.jdsatepoch].every(
        Number.isFinite,
      ) ||
      satrec.no <= 0
    )
      return null;
    return satrec;
  } catch {
    return null;
  }
}

/**
 * Propagate one satrec at `date`: sub-satellite point, altitude, speed and
 * the observer's look angles. Null when SGP4 fails (decayed / bad elements).
 */
export function observe(satrec, date, observer) {
  let pv;
  try {
    pv = propagate(satrec, date);
  } catch {
    return null;
  }
  if (satrec.error || !pv || !pv.position || typeof pv.position !== 'object')
    return null;
  const { position, velocity } = pv;
  if (![position.x, position.y, position.z].every(Number.isFinite)) return null;
  const gmst = gstime(date);
  const geodetic = eciToGeodetic(position, gmst);
  const lat = degreesLat(geodetic.latitude);
  const lon = degreesLong(geodetic.longitude);
  const altKm = geodetic.height;
  if (![lat, lon, altKm].every(Number.isFinite)) return null;
  const velocityKms =
    velocity && typeof velocity === 'object'
      ? Math.hypot(velocity.x, velocity.y, velocity.z)
      : null;
  const result = {
    lat,
    lon,
    altKm,
    velocityKms: Number.isFinite(velocityKms) ? velocityKms : null,
  };
  if (observer) {
    const ecf = eciToEcf(position, gmst);
    const look = ecfToLookAngles(
      {
        latitude: observer.lat * D2R,
        longitude: observer.lon * D2R,
        height: (observer.altitudeKm ?? 0) || 0,
      },
      ecf,
    );
    result.elevationDeg = look.elevation * R2D;
    result.azimuthDeg = normalizeAzimuth(look.azimuth * R2D);
    result.rangeKm = look.rangeSat;
  }
  return result;
}

/** Elevation in degrees at `ms` for an observer (−90 when propagation fails). */
function elevationAt(satrec, ms, observer) {
  const look = observe(satrec, new Date(ms), observer);
  return look ? look.elevationDeg : -90;
}

/** Bisect the horizon crossing between two samples (one above, one below). */
function refineCrossing(satrec, observer, belowMs, aboveMs, threshold) {
  let lo = belowMs;
  let hi = aboveMs;
  for (let i = 0; i < 12; i += 1) {
    const mid = (lo + hi) / 2;
    if (elevationAt(satrec, mid, observer) >= threshold) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Pass detection: sample elevation every `stepSec`, rise when it crosses
 * `minElevationDeg` upward, set when it crosses downward; culmination is
 * refined with a finer scan around the coarse maximum. A pass already in
 * progress at the window start (or still up at its end) is reported with
 * `inProgress` / `truncated` set.
 */
export function findPasses(
  satrec,
  observer,
  { startMs, endMs, stepSec = 30, minElevationDeg = 10 },
) {
  const stepMs = Math.max(1, stepSec) * 1000;
  const passes = [];
  let current = null;
  let prevMs = null;

  const finish = (setMs, truncated) => {
    if (!current) return;
    // Refine the culmination around the coarse maximum.
    const fineStep = Math.max(1000, stepMs / 10);
    let { maxMs, maxElev } = current;
    for (
      let t = Math.max(current.riseMs, current.maxMs - stepMs);
      t <= Math.min(setMs, current.maxMs + stepMs);
      t += fineStep
    ) {
      const e = elevationAt(satrec, t, observer);
      if (e > maxElev) {
        maxElev = e;
        maxMs = t;
      }
    }
    const rise = observe(satrec, new Date(current.riseMs), observer);
    const set = observe(satrec, new Date(setMs), observer);
    const max = observe(satrec, new Date(maxMs), observer);
    const pass = {
      riseUtc: isoUtc(current.riseMs),
      maxUtc: isoUtc(maxMs),
      setUtc: isoUtc(setMs),
      maxElevationDeg: round(maxElev, 1),
      durationSec: Math.round((setMs - current.riseMs) / 1000),
      riseAzimuthDeg: round(rise?.azimuthDeg, 1),
      maxAzimuthDeg: round(max?.azimuthDeg, 1),
      setAzimuthDeg: round(set?.azimuthDeg, 1),
      maxRangeKm: round(max?.rangeKm, 1),
    };
    if (current.inProgress) pass.inProgress = true;
    if (truncated) pass.truncated = true;
    passes.push(pass);
    current = null;
  };

  for (let t = startMs; t <= endMs; t += stepMs) {
    const elev = elevationAt(satrec, t, observer);
    const above = elev >= minElevationDeg;
    if (above && !current) {
      const riseMs =
        prevMs == null
          ? t
          : refineCrossing(satrec, observer, prevMs, t, minElevationDeg);
      current = {
        riseMs,
        maxMs: t,
        maxElev: elev,
        inProgress: prevMs == null,
      };
    } else if (above && current) {
      if (elev > current.maxElev) {
        current.maxElev = elev;
        current.maxMs = t;
      }
    } else if (!above && current) {
      const setMs = refineCrossing(
        satrec,
        observer,
        t,
        prevMs,
        minElevationDeg,
      );
      finish(setMs, false);
    }
    prevMs = t;
  }
  if (current) finish(Math.min(endMs, prevMs ?? endMs), true);
  return passes;
}

/** Worst provider status across several proxy answers (live < stale < degraded < unavailable). */
export function mergeProviders(entries, { failedGroups = [] } = {}) {
  const present = entries.filter(Boolean);
  if (!present.length) {
    return {
      status: 'unavailable',
      source: 'CelesTrak',
      fetchedAt: null,
      ageSec: null,
      error: failedGroups.length
        ? `no TLE data for ${failedGroups.join(', ')}`
        : 'no TLE data',
      count: null,
    };
  }
  let status = present.reduce(
    (worst, p) =>
      (STATUS_RANK[p.status] ?? 3) > (STATUS_RANK[worst] ?? 3)
        ? p.status
        : worst,
    'live',
  );
  if (failedGroups.length && (STATUS_RANK[status] ?? 3) < STATUS_RANK.degraded)
    status = 'degraded';
  const sources = [...new Set(present.map((p) => p.source).filter(Boolean))];
  const ages = present.map((p) => p.ageSec).filter(Number.isFinite);
  const oldest = present
    .map((p) => p.fetchedAt)
    .filter(Boolean)
    .sort()[0];
  const errors = [
    ...present.map((p) => p.error).filter(Boolean),
    ...(failedGroups.length
      ? [`no TLE data for group(s) ${failedGroups.join(', ')}`]
      : []),
  ];
  const counts = present.map((p) => p.count).filter(Number.isFinite);
  return {
    status,
    source: sources.join(' + ') || 'CelesTrak',
    fetchedAt: oldest || null,
    ageSec: ages.length ? Math.max(...ages) : null,
    error: errors.length ? [...new Set(errors)].join('; ').slice(0, 200) : null,
    count: counts.length ? counts.reduce((a, b) => a + b, 0) : null,
  };
}

/**
 * Fetch one CelesTrak group through the proxy. Resolves to
 * { group, ok, records, provider, tleSource, cache, error }.
 */
async function loadGroup(invoke, group, signal) {
  let answer;
  try {
    answer = await invoke(`/api/celestrak/${encodeURIComponent(group)}`, {
      signal,
    });
  } catch (error) {
    return {
      group,
      ok: false,
      records: [],
      provider: null,
      tleSource: null,
      cache: null,
      error: `CelesTrak proxy failed for ${group}: ${String(error?.message || error).slice(0, 120)}`,
    };
  }
  const provider = providerFromHeaders(answer.headers);
  const tleSource = answer.headers?.['x-tle-source'] ?? null;
  const cache = answer.headers?.['x-tle-cache'] ?? null;
  if (answer.status !== 200 || !answer.text || answer.json) {
    return {
      group,
      ok: false,
      records: [],
      provider,
      tleSource,
      cache,
      error:
        answer.json?.error ||
        provider?.error ||
        `CelesTrak proxy answered HTTP ${answer.status} for ${group}`,
    };
  }
  const records = parseTleText(answer.text);
  return {
    group,
    ok: records.length > 0,
    records,
    provider,
    tleSource,
    cache,
    error: records.length ? null : `no TLE records in group ${group}`,
  };
}

function provenanceFor(results, nowMs) {
  // x-tle-source per group: celestrak.org | celestrak.com | cache | snapshot
  const upstreams = [
    ...new Set(results.map((r) => r.tleSource).filter(Boolean)),
  ];
  return {
    source: 'CelesTrak GP element sets via /api/celestrak/<group>',
    fetchedAtUtc: isoUtc(nowMs),
    upstream: upstreams.length ? upstreams.join(' + ') : 'celestrak.org',
    completeness: 'partial',
    groups: results.map((r) => ({
      group: r.group,
      ok: r.ok,
      status: r.provider?.status ?? (r.ok ? 'live' : 'unavailable'),
      source: r.provider?.source ?? null,
      tleSource: r.tleSource,
      cache: r.cache,
      fetchedAt: r.provider?.fetchedAt ?? null,
      ageSec: r.provider?.ageSec ?? null,
      satellites: r.records.length,
      ...(r.error ? { error: r.error } : {}),
    })),
    note: 'Positions are SGP4 propagations of the newest element sets the proxy holds (live, cached or bundled snapshot); accuracy degrades with element-set age.',
  };
}

const LAT = {
  type: 'number',
  required: true,
  min: -90,
  max: 90,
  description: 'Scene / observer latitude in decimal degrees (WGS84).',
};
const LON = {
  type: 'number',
  required: true,
  min: -180,
  max: 180,
  description: 'Scene / observer longitude in decimal degrees (WGS84).',
};

/**
 * Build the tool list. `invoke` is injectable so tests can run the handlers
 * against a fake CelesTrak proxy answer without touching the network.
 */
export function createSatelliteTools({ invoke = defaultInvoke } = {}) {
  const listSatellitesInScene = {
    name: 'list_satellites_in_scene',
    summary: 'Satellites currently over a scene (SGP4 from CelesTrak TLEs)',
    description:
      'Propagates every satellite of the requested CelesTrak groups to the current time with SGP4 and returns those whose sub-satellite point lies within radiusKm of the scene point and whose elevation for an observer at that point is at least minElevationDeg. Results are sorted nearest-first and capped by limit; each row carries the sub-satellite latitude/longitude, altitude, speed, ground distance and the observer look angles (elevation, azimuth, slant range). Groups: stations (ISS, Tiangong, crewed/cargo vehicles), visual (brightest objects), gps-ops, glo-ops, galileo (navigation constellations), geo (geostationary belt) and starlink (large; opt-in). Use minElevationDeg ≥ 0 to keep only satellites above the local horizon.',
    cacheSeconds: 60,
    params: {
      lat: LAT,
      lon: LON,
      radiusKm: {
        type: 'number',
        default: 1500,
        min: 50,
        max: 6000,
        description:
          'Maximum ground distance (km) from the scene point to a satellite sub-satellite point. Default 1500.',
      },
      groups: {
        type: 'csv',
        default: [...DEFAULT_SCENE_GROUPS],
        values: [...SATELLITE_GROUPS],
        description:
          'Comma-separated CelesTrak groups to search: stations, visual, gps-ops, glo-ops, galileo, geo, starlink. Default stations,visual,gps-ops,glo-ops,galileo,geo.',
      },
      minElevationDeg: {
        type: 'number',
        default: -90,
        min: -90,
        max: 90,
        description:
          'Minimum elevation (degrees above the horizon) for an observer at the scene point. Default -90 (no elevation filter); use 0 for "above the horizon", 10 for comfortably visible.',
      },
      limit: {
        type: 'integer',
        default: 50,
        min: 1,
        max: 500,
        description:
          'Maximum number of satellites returned (nearest first). Default 50.',
      },
    },
    async handler(params, ctx = {}) {
      const nowDate = typeof ctx.now === 'function' ? ctx.now() : new Date();
      const nowMs = nowDate.getTime();
      const groups = [...new Set(params.groups || DEFAULT_SCENE_GROUPS)];
      const observer = { lat: params.lat, lon: params.lon };
      try {
        const results = await Promise.all(
          groups.map((group) => loadGroup(invoke, group, ctx.signal)),
        );
        const okResults = results.filter((r) => r.ok);
        const failedGroups = results.filter((r) => !r.ok).map((r) => r.group);
        const provider = mergeProviders(
          okResults.map((r) => r.provider),
          { failedGroups },
        );
        if (!okResults.length) {
          return {
            ok: false,
            status: 503,
            error: {
              code: 'upstream_unavailable',
              message:
                results.map((r) => r.error).filter(Boolean)[0] ||
                'CelesTrak TLE data is unavailable for every requested group',
            },
            provider,
          };
        }
        const seen = new Set();
        const rows = [];
        let total = 0;
        for (const result of okResults) {
          for (const record of result.records) {
            const key = String(record.noradId);
            if (seen.has(key)) continue;
            seen.add(key);
            total += 1;
            const satrec = satrecFor(record);
            if (!satrec) continue;
            const look = observe(satrec, nowDate, observer);
            if (!look) continue;
            const groundDistanceKm = haversineKm(
              params.lat,
              params.lon,
              look.lat,
              look.lon,
            );
            if (groundDistanceKm > params.radiusKm) continue;
            if (look.elevationDeg < params.minElevationDeg) continue;
            rows.push({
              name: record.name,
              noradId: record.noradId,
              group: result.group,
              lat: round(look.lat, 4),
              lon: round(look.lon, 4),
              altKm: round(look.altKm, 1),
              velocityKms: round(look.velocityKms, 3),
              groundDistanceKm: round(groundDistanceKm, 1),
              elevationDeg: round(look.elevationDeg, 2),
              azimuthDeg: round(look.azimuthDeg, 2),
              rangeKm: round(look.rangeKm, 1),
              tleEpochUtc: tleEpochUtc(record.line1),
            });
          }
        }
        rows.sort((a, b) => a.groundDistanceKm - b.groundDistanceKm);
        const satellites = rows.slice(0, params.limit);
        return {
          ok: true,
          data: {
            scene: {
              lat: params.lat,
              lon: params.lon,
              radiusKm: params.radiusKm,
              minElevationDeg: params.minElevationDeg,
            },
            epochUtc: isoUtc(nowMs),
            groups,
            count: satellites.length,
            matched: rows.length,
            total,
            satellites,
          },
          provider,
          provenance: provenanceFor(results, nowMs),
        };
      } catch (error) {
        return {
          ok: false,
          status: 502,
          error: {
            code: 'tool_failed',
            message: `list_satellites_in_scene failed: ${String(error?.message || error).slice(0, 160)}`,
          },
        };
      }
    },
  };

  const satellitePasses = {
    name: 'satellite_passes',
    summary: 'Upcoming passes of one satellite over an observer',
    description:
      'Predicts the rise, culmination and set times of one satellite (identified by NORAD catalogue id or a case-insensitive name substring such as "ISS" or "TIANGONG") for an observer at lat/lon over the next `hours`, using SGP4 on the newest CelesTrak element set. The `group` is searched first, then every other CelesTrak group (starlink last). Each pass reports UTC rise/max/set times, the maximum elevation, duration and rise/set azimuths; a pass already under way at the window start is flagged inProgress. Exactly one of noradId or name must be supplied. A satellite that is not in any group answers 404 not_found.',
    cacheSeconds: 300,
    params: {
      lat: LAT,
      lon: LON,
      noradId: {
        type: 'integer',
        min: 1,
        max: 999999,
        description:
          'NORAD catalogue number of the satellite (e.g. 25544 for the ISS). Supply either noradId or name.',
      },
      name: {
        type: 'string',
        maxLength: 64,
        description:
          'Case-insensitive satellite name substring (e.g. "ISS", "CSS (TIANHE)", "HST"). An exact name match wins over a substring match. Supply either noradId or name.',
      },
      group: {
        type: 'enum',
        default: 'stations',
        values: [...SATELLITE_GROUPS],
        description:
          'CelesTrak group to search first (default stations); the other groups are searched when the satellite is not found there.',
      },
      hours: {
        type: 'number',
        default: 24,
        min: 1,
        max: 72,
        description: 'Prediction window length in hours from now. Default 24.',
      },
      minElevationDeg: {
        type: 'number',
        default: 10,
        min: 0,
        max: 90,
        description:
          'Elevation threshold (degrees) that defines a pass. Default 10.',
      },
      stepSec: {
        type: 'integer',
        default: 30,
        min: 10,
        max: 120,
        description:
          'Coarse propagation step in seconds (rise/set are refined by bisection). Default 30.',
      },
    },
    async handler(params, ctx = {}) {
      const hasId = params.noradId !== undefined && params.noradId !== null;
      const hasName =
        typeof params.name === 'string' && params.name.trim().length > 0;
      if (!hasId && !hasName) {
        return {
          ok: false,
          status: 400,
          error: {
            code: 'missing_param',
            message: 'supply exactly one of "noradId" or "name"',
            param: 'noradId',
          },
        };
      }
      if (hasId && hasName) {
        return {
          ok: false,
          status: 400,
          error: {
            code: 'invalid_param',
            message: 'supply either "noradId" or "name", not both',
            param: 'name',
          },
        };
      }
      const nowDate = typeof ctx.now === 'function' ? ctx.now() : new Date();
      const startMs = nowDate.getTime();
      const endMs = startMs + params.hours * 3_600_000;
      const observer = { lat: params.lat, lon: params.lon };
      const rawName = hasName ? params.name.trim().toLowerCase() : null;
      const wanted = hasName ? NAME_ALIASES[rawName] || rawName : null;
      const order = [
        params.group,
        ...SATELLITE_GROUPS.filter((g) => g !== params.group),
      ];
      const matches = (record) =>
        hasId
          ? String(record.noradId) === String(params.noradId)
          : record.name.toLowerCase().includes(wanted);
      try {
        const results = [];
        let found = null;
        for (const group of order) {
          const result = await loadGroup(invoke, group, ctx.signal);
          results.push(result);
          if (!result.ok) continue;
          const candidates = result.records.filter(matches);
          if (!candidates.length) continue;
          const exact = hasName
            ? candidates.find((r) => r.name.toLowerCase() === wanted)
            : null;
          found = { record: exact || candidates[0], group, candidates };
          break;
        }
        const failedGroups = results.filter((r) => !r.ok).map((r) => r.group);
        const provider = mergeProviders(
          results.filter((r) => r.ok).map((r) => r.provider),
          { failedGroups },
        );
        if (!found) {
          if (!results.some((r) => r.ok)) {
            return {
              ok: false,
              status: 503,
              error: {
                code: 'upstream_unavailable',
                message:
                  results.map((r) => r.error).filter(Boolean)[0] ||
                  'CelesTrak TLE data is unavailable',
              },
              provider,
            };
          }
          return {
            ok: false,
            status: 404,
            error: {
              code: 'not_found',
              message: hasId
                ? `no satellite with NORAD id ${params.noradId} in groups ${order.join(', ')}`
                : `no satellite whose name contains "${params.name.trim()}" in groups ${order.join(', ')}`,
              param: hasId ? 'noradId' : 'name',
            },
            provider,
          };
        }
        const satrec = satrecFor(found.record);
        if (!satrec) {
          return {
            ok: false,
            status: 502,
            error: {
              code: 'malformed_upstream',
              message: `the element set for ${found.record.name} could not be initialised`,
            },
            provider,
          };
        }
        const passes = findPasses(satrec, observer, {
          startMs,
          endMs,
          stepSec: params.stepSec,
          minElevationDeg: params.minElevationDeg,
        });
        const now = observe(satrec, nowDate, observer);
        return {
          ok: true,
          data: {
            satellite: {
              name: found.record.name,
              noradId: found.record.noradId,
              group: found.group,
              tleEpochUtc: tleEpochUtc(found.record.line1),
              ...(hasName && wanted !== rawName
                ? { matchedName: wanted.toUpperCase() }
                : {}),
              ...(hasName && found.candidates.length > 1
                ? { otherMatches: found.candidates.length - 1 }
                : {}),
            },
            observer: { lat: params.lat, lon: params.lon },
            windowStartUtc: isoUtc(startMs),
            windowEndUtc: isoUtc(endMs),
            minElevationDeg: params.minElevationDeg,
            stepSec: params.stepSec,
            current: now
              ? {
                  lat: round(now.lat, 4),
                  lon: round(now.lon, 4),
                  altKm: round(now.altKm, 1),
                  elevationDeg: round(now.elevationDeg, 2),
                  azimuthDeg: round(now.azimuthDeg, 2),
                  rangeKm: round(now.rangeKm, 1),
                }
              : null,
            count: passes.length,
            passes,
          },
          provider,
          provenance: provenanceFor(results, startMs),
        };
      } catch (error) {
        return {
          ok: false,
          status: 502,
          error: {
            code: 'tool_failed',
            message: `satellite_passes failed: ${String(error?.message || error).slice(0, 160)}`,
          },
        };
      }
    },
  };

  return [listSatellitesInScene, satellitePasses];
}

export const plugin = Object.freeze({
  id: 'satellites',
  name: 'OnDemand Spatial Satellites (CelesTrak)',
  description:
    'Live satellite situational awareness from CelesTrak general-perturbation element sets, propagated server-side with SGP4: which satellites are over a place right now (with altitude, speed, ground distance and observer look angles) and when a given satellite — the ISS, Tiangong, a GPS/GLONASS/Galileo vehicle, a geostationary bird or a Starlink — next rises, culminates and sets for an observer. Backed by the same cached, fallback-protected CelesTrak proxy the OnDemand Spatial satellites layer uses; answers carry a provider status (live / stale / degraded / unavailable) and element-set provenance.',
  category: 'Research',
  conversationStarters: [
    'Which satellites are over Austin, Texas right now within 1000 km?',
    'When does the ISS next pass over London above 10° elevation?',
    'List the GPS satellites currently above the horizon for 48.85, 2.35.',
    'Show the next Tiangong (CSS) passes over Tokyo in the coming 48 hours.',
    'Are any geostationary satellites within 2000 km of the sub-satellite point over Nairobi?',
  ],
});

export const tools = createSatelliteTools();

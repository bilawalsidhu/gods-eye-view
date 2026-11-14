import { readResponseJsonCapped } from '../common/http.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const UPSTREAM_URL =
  process.env.STARSHIP_LIVE_URL ||
  'https://sxcontent9668.azureedge.us/cms-assets/starship_tracker_public.json';
const RESERVED_KEYS = new Set(['ctl', 'focus', 'metadata', 'names', 'status']);

const finite = (value, fallback = null) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const STARDASH_EARTH_MEAN_RADIUS_M = 6_371_008.8;
const STARDASH_MIN_SPEED_WINDOW_SEC = 7.5;
const STARDASH_MAX_SPEED_WINDOW_SEC = 60;
const STARDASH_MAX_SPEED_MPS = 12_000;

/**
 * Parse a trajectory point from either the public mirror's array shape or
 * SpaceX's object shape.
 * @param {Array|object|null} value Trajectory point.
 * @returns {{lat:number,lon:number,alt:number,time:number}|null} Parsed point.
 */
function trajectoryPoint(value) {
  if (Array.isArray(value) && value.length >= 4) {
    const lat = finite(value[0]);
    const lon = finite(value[1]);
    const alt = finite(value[2], 0) ?? 0;
    const time = finite(value[3]);
    return lat === null || lon === null || time === null
      ? null
      : { lat, lon, alt, time };
  }
  if (!value || typeof value !== 'object') return null;
  const lat = finite(value.lat ?? value.latitude);
  const lon = finite(value.lon ?? value.longitude);
  const alt = finite(value.alt ?? value.altitude, 0) ?? 0;
  const time = finite(value.time ?? value.gps_time ?? value.gpsTime);
  return lat === null || lon === null || time === null
    ? null
    : { lat, lon, alt, time };
}

/**
 * Parse a live telemetry sample for Stardash-compatible speed history.
 * @param {object} raw Current telemetry object.
 * @returns {{lat:number,lon:number,alt:number,time:number}|null} Parsed sample.
 */
function liveSample(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = finite(raw.lat ?? raw.latitude);
  const lon = finite(raw.lon ?? raw.longitude);
  const alt = finite(raw.alt ?? raw.altitude, 0) ?? 0;
  const time = finite(
    raw.gps ?? raw.gps_time ?? raw.gpsTime ?? raw.wall ?? raw.time,
  );
  return lat === null || lon === null || time === null
    ? null
    : { lat, lon, alt, time };
}

/**
 * Great-circle horizontal distance on the mean-radius sphere used by Stardash.
 * @param {{lat:number,lon:number}} from Starting point.
 * @param {{lat:number,lon:number}} to Ending point.
 * @returns {number} Horizontal distance in metres.
 */
function horizontalDistanceM(from, to) {
  const toRad = Math.PI / 180;
  const deltaLat = (to.lat - from.lat) * toRad;
  const deltaLon = (to.lon - from.lon) * toRad;
  const lat1 = from.lat * toRad;
  const lat2 = to.lat * toRad;
  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return (
    2 *
    STARDASH_EARTH_MEAN_RADIUS_M *
    Math.asin(Math.min(1, Math.sqrt(haversine)))
  );
}

/**
 * Derive Stardash-compatible speed from two live or trajectory samples.
 * Stardash combines mean-sphere horizontal distance with altitude change; this
 * intentionally matches its public readout rather than WGS84 ECEF distance.
 * @param {{lat:number,lon:number,alt:number,time:number}} from Starting sample.
 * @param {{lat:number,lon:number,alt:number,time:number}} to Ending sample.
 * @param {boolean} [enforceWindow=true] Require Stardash's 7.5–60 s window.
 * @returns {number} Speed in m/s, or 0 when the pair is unusable.
 */
function sampleSpeedMps(from, to, enforceWindow = true) {
  if (!from || !to) return 0;
  const elapsedSec = to.time - from.time;
  if (
    !(elapsedSec > 0) ||
    (enforceWindow &&
      (elapsedSec < STARDASH_MIN_SPEED_WINDOW_SEC ||
        elapsedSec > STARDASH_MAX_SPEED_WINDOW_SEC))
  )
    return 0;
  const horizontal = horizontalDistanceM(from, to);
  const vertical = to.alt - from.alt;
  const speed = Math.hypot(horizontal, vertical) / elapsedSec;
  return Number.isFinite(speed) && speed <= STARDASH_MAX_SPEED_MPS ? speed : 0;
}

/**
 * Derive speed from the current and next trajectory points. The public speed
 * field is metres per second but can stay at zero for an entire flight.
 * @param {Array|object|null} from Current trajectory point.
 * @param {Array|object|null} to Next trajectory point.
 * @returns {number} Speed in m/s, or 0 when the segment is unusable.
 */
function trajectorySpeedMps(from, to) {
  const fromPoint = trajectoryPoint(from);
  const toPoint = trajectoryPoint(to);
  return sampleSpeedMps(fromPoint, toPoint, false);
}

/**
 * Derive an initial true heading from two feed trajectory points.
 * @param {{lat:number,lon:number}} from Current point.
 * @param {{lat:number,lon:number}} to Next trajectory point.
 * @returns {number} Heading in degrees, or 0 when the segment is degenerate.
 */
function headingFromSegment(from, to) {
  if (!from || !to) return 0;
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const deltaLon = ((to.lon - from.lon) * Math.PI) / 180;
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  const heading = (Math.atan2(y, x) * 180) / Math.PI;
  return Number.isFinite(heading) ? (heading + 360) % 360 : 0;
}

/**
 * Convert one current telemetry object into the layer's bounded contract.
 * @param {string} id Stable vehicle id from the feed.
 * @param {object} raw Current telemetry object.
 * @param {object|null} names Optional feed-provided display names.
 * @returns {object|null} Normalized vehicle, or null when unusable.
 */
function vehicleFromCurrent(id, raw, names, sampleHistory) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = finite(raw.lat ?? raw.latitude);
  const lon = finite(raw.lon ?? raw.longitude);
  if (lat === null || lon === null) return null;
  const trajectory = Array.isArray(raw.traj) ? raw.traj : [];
  const currentPoint = trajectoryPoint(trajectory[0]);
  const nextPoint = trajectoryPoint(trajectory[1]);
  const derivedHeading = nextPoint
    ? headingFromSegment({ lat, lon }, nextPoint)
    : 0;
  const reportedSpeed = finite(raw.spd ?? raw.speed ?? raw.velocity, 0) ?? 0;
  const currentSample = liveSample(raw);
  const previousSample = sampleHistory?.get(id) ?? null;
  const observedSpeed = sampleSpeedMps(previousSample, currentSample);
  const derivedSpeed =
    reportedSpeed > 0
      ? reportedSpeed
      : observedSpeed || trajectorySpeedMps(currentPoint, nextPoint);
  if (
    currentSample &&
    (!previousSample || currentSample.time > previousSample.time)
  )
    sampleHistory?.set(id, currentSample);
  return {
    id,
    name: typeof names?.[id] === 'string' ? names[id] : id,
    lat,
    lon,
    alt: finite(raw.alt ?? raw.altitude, 0) ?? 0,
    speed: derivedSpeed,
    heading: finite(raw.hdg ?? raw.heading, derivedHeading) ?? derivedHeading,
    positionAt:
      finite(raw.wall ?? raw.time) !== null
        ? finite(raw.wall ?? raw.time) * 1000
        : Date.now(),
  };
}

/**
 * Normalize the public Starship tracker feed published by SpaceX. The upstream shape can
 * expose vehicle keys directly or a samples array; both are accepted because
 * they are the documented public webcast feed and its public mirror shape.
 * @param {object} raw Upstream JSON.
 * @param {number} [now] Fetch time in epoch milliseconds.
 * @returns {object} Bounded same-origin snapshot contract.
 */
export function normalizeStarshipLiveSnapshot(
  raw,
  now = Date.now(),
  sampleHistory = new Map(),
) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('starship_live_malformed');

  const names = raw.names && typeof raw.names === 'object' ? raw.names : null;
  const vehicles = [];

  if (Array.isArray(raw.samples)) {
    raw.samples.forEach((sample, index) => {
      const id = String(sample?.veh ?? sample?.name ?? `vehicle-${index}`);
      const vehicle = vehicleFromCurrent(id, sample, names, sampleHistory);
      if (vehicle) vehicles.push(vehicle);
    });
  } else {
    for (const [id, value] of Object.entries(raw)) {
      if (RESERVED_KEYS.has(id)) continue;
      const current = value?.current ?? value;
      const vehicle = vehicleFromCurrent(
        String(id),
        current,
        names,
        sampleHistory,
      );
      if (vehicle) vehicles.push(vehicle);
    }
  }

  if (vehicles.length > 2) throw new Error('starship_live_too_many_vehicles');

  return {
    schemaVersion: 1,
    source: 'SpaceX',
    fetchedAt: now,
    active: vehicles.length > 0,
    vehicles,
    status:
      raw.status && typeof raw.status === 'object'
        ? {
            connected: raw.status.connected === true,
            t0: finite(raw.status.t0),
            serverTime: finite(raw.status.server_time ?? raw.status.serverTime),
          }
        : null,
  };
}

/**
 * Same-origin proxy for the public Starship telemetry feed.
 * @returns {import('vite').Plugin}
 */
export function starshipLiveProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const sampleHistory = new Map();
  const json = (res, status, value) => {
    if (res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(status === 405 ? { Allow: 'GET' } : {}),
    });
    res.end(JSON.stringify(value));
  };

  async function handler(req, res) {
    if (req.method !== 'GET')
      return json(res, 405, { error: 'method_not_allowed' });
    const path = String(req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(res, 404, { error: 'unknown_route' });
    try {
      const nowMs = now();
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      const response = await fetchImpl(UPSTREAM_URL, {
        signal,
        redirect: 'follow',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'gods-eye-view-starship-live/1.0',
        },
      });
      if (!response.ok) {
        await response.body?.cancel?.().catch?.(() => {});
        return json(res, 502, { error: 'starship_live_unavailable' });
      }
      const raw = await readResponseJsonCapped(
        response,
        MAX_RESPONSE_BYTES,
        signal,
      );
      return json(
        res,
        200,
        normalizeStarshipLiveSnapshot(raw, nowMs, sampleHistory),
      );
    } catch {
      return json(res, 502, { error: 'starship_live_unavailable' });
    }
  }

  const install = (server) => {
    server.middlewares.use('/api/starship-live', handler);
  };
  return {
    name: 'starship-live',
    configureServer: install,
    configurePreviewServer: install,
  };
}

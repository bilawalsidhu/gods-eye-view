/**
 * Simulation scenarios: the pure file format, timeline and sampling behind the
 * Simulation layer. A scenario is a list of aircraft, each flying a list of
 * hand-written waypoints (position, altitude, speed). Timing is derived: a leg
 * takes as long as its length divided by the mean of its endpoint speeds, so
 * authors never type timestamps. Positions between waypoints follow a
 * Catmull-Rom spline through the neighbouring waypoints, so turns are smooth
 * and heading and pitch come from the spline's tangent.
 *
 * No Cesium, DOM or i18n imports: the tests run without WebGL.
 * @module layers/simulation/scenario
 */
import { classifyAircraft } from '../../data/aircraftClass.js';
import { normalizeCameraList } from '../cameras/policy.js';

export const SCENARIO_VERSION = 1;
export const MAX_AIRCRAFT = 64;
export const MAX_WAYPOINTS = 512;
export const MIN_SPEED_MPS = 5;
export const MAX_SPEED_MPS = 1200;
export const MIN_ALTITUDE_M = -500;
export const MAX_ALTITUDE_M = 30_000;
export const FT_TO_M = 0.3048;
export const KT_TO_MPS = 0.514444;
export const DEFAULT_SCENARIO_ID = 'fleet-week-sf';
export const DEFAULT_AIRCRAFT_COLOR = '#9be7ff';

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function fail(message) {
  throw new TypeError(`Scenario: ${message}`);
}

/**
 * Validate and normalise a scenario document. Altitudes may be given in feet
 * (`altFt`) or metres (`altM`), speeds in knots (`speedKt`) or metres per
 * second (`speedMps`); the result is metric. Throws on anything malformed, so
 * a bad file never half-loads.
 * @param {object} json Parsed scenario file.
 * @returns {{version:number, id:string, title:string, aircraft:object[], cameras:object[]}}
 */
export function normalizeScenario(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json))
    fail('document must be an object');
  if (json.version !== SCENARIO_VERSION)
    fail(`version must be ${SCENARIO_VERSION}`);
  const id = String(json.id || '');
  if (!ID_PATTERN.test(id))
    fail('id must be lowercase letters, digits, dashes');
  const title = String(json.title || id).slice(0, 120);
  if (!Array.isArray(json.aircraft) || json.aircraft.length === 0)
    fail('aircraft must be a non-empty array');
  if (json.aircraft.length > MAX_AIRCRAFT)
    fail(`at most ${MAX_AIRCRAFT} aircraft`);
  const ids = new Set();
  const aircraft = json.aircraft.map((entry, index) => {
    const label = `aircraft[${index}]`;
    if (!entry || typeof entry !== 'object') fail(`${label} must be an object`);
    const aircraftId = String(entry.id || '');
    if (!ID_PATTERN.test(aircraftId)) fail(`${label}.id is invalid`);
    if (ids.has(aircraftId)) fail(`${label}.id "${aircraftId}" repeats`);
    ids.add(aircraftId);
    const callsign = String(entry.callsign || aircraftId)
      .trim()
      .slice(0, 12)
      .toUpperCase();
    const typeCode = entry.typeCode
      ? String(entry.typeCode).trim().toUpperCase().slice(0, 8)
      : null;
    const category = entry.category
      ? String(entry.category).trim().toUpperCase().slice(0, 3)
      : null;
    const color = COLOR_PATTERN.test(String(entry.color || ''))
      ? String(entry.color).toLowerCase()
      : DEFAULT_AIRCRAFT_COLOR;
    if (!Array.isArray(entry.waypoints) || entry.waypoints.length < 2)
      fail(`${label} needs at least two waypoints`);
    if (entry.waypoints.length > MAX_WAYPOINTS)
      fail(`${label} has more than ${MAX_WAYPOINTS} waypoints`);
    const waypoints = entry.waypoints.map((wp, w) => {
      const where = `${label}.waypoints[${w}]`;
      const lat = finite(wp?.lat);
      const lon = finite(wp?.lon);
      if (
        lat === null ||
        lon === null ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180
      )
        fail(`${where} needs lat/lon`);
      const altM = finite(wp.altM) ?? (finite(wp.altFt) ?? 0) * FT_TO_M;
      const speedMps =
        finite(wp.speedMps) ?? (finite(wp.speedKt) ?? 0) * KT_TO_MPS;
      if (altM < MIN_ALTITUDE_M || altM > MAX_ALTITUDE_M)
        fail(`${where} altitude out of range`);
      return {
        lat,
        lon,
        altM,
        speedMps: clamp(speedMps, MIN_SPEED_MPS, MAX_SPEED_MPS),
      };
    });
    return {
      id: aircraftId,
      callsign,
      typeCode,
      category,
      klass: classifyAircraft({ typeCode, category }),
      loop: entry.loop === true,
      color,
      waypoints,
    };
  });
  const cameras = normalizeCameraList(
    json.cameras,
    aircraft.map((entry) => entry.id),
  );
  return { version: SCENARIO_VERSION, id, title, aircraft, cameras };
}

/** Horizontal great-circle distance plus the altitude change, metres. */
export function legLengthM(a, b) {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  const ground = 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.hypot(ground, b.altM - a.altM);
}

/**
 * The timed path of one aircraft. `points` are the waypoints (plus the first
 * one again when looping); `times[i]` is when the aircraft reaches
 * `points[i]`, seconds from scenario start.
 * @param {object} aircraft Normalised aircraft.
 * @returns {{points:object[], times:number[], durationS:number, loop:boolean}}
 */
export function buildTimeline(aircraft) {
  const points = aircraft.loop
    ? [...aircraft.waypoints, aircraft.waypoints[0]]
    : [...aircraft.waypoints];
  const times = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const speed = Math.max(MIN_SPEED_MPS, (a.speedMps + b.speedMps) / 2);
    times.push(times[i - 1] + Math.max(legLengthM(a, b), 1) / speed);
  }
  return {
    points,
    times,
    durationS: times[times.length - 1],
    loop: aircraft.loop,
  };
}

/** Time inside the timeline for a scenario time: wrapped when looping, clamped otherwise. */
export function localTime(timeline, tS) {
  const duration = timeline.durationS;
  if (!(duration > 0)) return 0;
  if (timeline.loop) return ((tS % duration) + duration) % duration;
  return clamp(tS, 0, duration);
}

function segmentIndex(times, t) {
  let lo = 0;
  let hi = times.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function controlPoint(timeline, index) {
  const { points, loop } = timeline;
  if (loop) {
    const n = points.length - 1; // the closing point repeats points[0]
    return points[((index % n) + n) % n];
  }
  return points[clamp(index, 0, points.length - 1)];
}

/** Local east/north/up metres of `p` around `ref`. */
function toLocal(p, ref) {
  const cosLat = Math.cos(ref.lat * DEG);
  return {
    x: (p.lon - ref.lon) * DEG * EARTH_RADIUS_M * cosLat,
    y: (p.lat - ref.lat) * DEG * EARTH_RADIUS_M,
    z: p.altM,
  };
}

function fromLocal(local, ref) {
  const cosLat = Math.cos(ref.lat * DEG);
  return {
    lon: ref.lon + local.x / (DEG * EARTH_RADIUS_M * cosLat),
    lat: ref.lat + local.y / (DEG * EARTH_RADIUS_M),
    altM: local.z,
  };
}

/** Uniform Catmull-Rom position and tangent for one axis. */
function catmullRom(p0, p1, p2, p3, u) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * p0 - 5 * p1 + 4 * p2 - p3;
  const c = -p0 + p2;
  return {
    value: 0.5 * (a * u * u * u + b * u * u + c * u + 2 * p1),
    tangent: 0.5 * (3 * a * u * u + 2 * b * u + c),
  };
}

/**
 * Where an aircraft is at a scenario time.
 * @param {object} timeline From `buildTimeline`.
 * @param {number} tS Scenario time, seconds.
 * @returns {{lat:number, lon:number, altM:number, headingDeg:number,
 *   pitchDeg:number, speedMps:number, localS:number, progress:number, done:boolean}}
 */
export function sampleTimeline(timeline, tS) {
  const { points, times, durationS } = timeline;
  const t = localTime(timeline, tS);
  const done = !timeline.loop && tS >= durationS;
  const i = segmentIndex(times, t);
  const span = times[i + 1] - times[i];
  const u = span > 0 ? clamp((t - times[i]) / span, 0, 1) : 0;
  const ref = points[i];
  const c0 = toLocal(controlPoint(timeline, i - 1), ref);
  const c1 = toLocal(points[i], ref);
  const c2 = toLocal(points[i + 1], ref);
  const c3 = toLocal(controlPoint(timeline, i + 2), ref);
  const x = catmullRom(c0.x, c1.x, c2.x, c3.x, u);
  const y = catmullRom(c0.y, c1.y, c2.y, c3.y, u);
  const z = catmullRom(c0.z, c1.z, c2.z, c3.z, u);
  const position = fromLocal({ x: x.value, y: y.value, z: z.value }, ref);
  const horizontal = Math.hypot(x.tangent, y.tangent);
  let headingDeg =
    horizontal > 1e-6
      ? (Math.atan2(x.tangent, y.tangent) / DEG + 360) % 360
      : (Math.atan2(c2.x - c1.x, c2.y - c1.y) / DEG + 360) % 360;
  const pitchDeg =
    horizontal > 1e-6 ? Math.atan2(z.tangent, horizontal) / DEG : 0;
  const speedMps =
    points[i].speedMps + (points[i + 1].speedMps - points[i].speedMps) * u;
  return {
    lat: position.lat,
    lon: position.lon,
    altM: position.altM,
    headingDeg,
    pitchDeg: clamp(pitchDeg, -60, 60),
    speedMps,
    localS: t,
    progress: durationS > 0 ? t / durationS : 0,
    done,
  };
}

/**
 * Positions along the path between two scenario times, oldest first, at a
 * fixed step. Loop paths keep sampling across the wrap, so a trail follows
 * the aircraft round the circuit; finite paths stop at their ends.
 * @param {object} timeline
 * @param {number} fromS
 * @param {number} toS
 * @param {number} [stepS]
 * @returns {{lat:number, lon:number, altM:number}[]}
 */
export function pathPositions(timeline, fromS, toS, stepS = 1) {
  const step = Math.max(0.05, stepS);
  let start = fromS;
  let end = toS;
  if (!timeline.loop) {
    start = clamp(start, 0, timeline.durationS);
    end = clamp(end, 0, timeline.durationS);
  }
  if (!(end > start)) {
    const one = sampleTimeline(timeline, end);
    return [{ lat: one.lat, lon: one.lon, altM: one.altM }];
  }
  const count = Math.min(4096, Math.ceil((end - start) / step));
  const out = [];
  for (let k = 0; k <= count; k++) {
    const t = k === count ? end : start + k * step;
    const s = sampleTimeline(timeline, t);
    out.push({ lat: s.lat, lon: s.lon, altM: s.altM });
  }
  return out;
}

/** The whole route of a timeline, for the faint "where it will fly" line. */
export function routePositions(timeline, stepS = 2) {
  return pathPositions(timeline, 0, timeline.durationS, stepS);
}

/**
 * Scenario length: the longest finite path, or the longest loop when every
 * aircraft loops. The clock wraps at this length.
 * @param {object[]} timelines
 * @returns {number}
 */
export function scenarioDurationS(timelines) {
  let longest = 0;
  for (const timeline of timelines)
    longest = Math.max(longest, timeline.durationS);
  return longest;
}

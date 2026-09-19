/**
 * server/providers/vessels/ais-demo-replay.js — a deterministic, clearly
 * labelled SYNTHETIC vessel dataset for the serverless AIS route when no
 * AISSTREAM_API_KEY (and no AISHUB_USERNAME) is configured.
 *
 * Twelve vessels ping-pong along hand-drawn waypoint polylines on the Texas
 * Gulf coast — the Houston Ship Channel from the Galveston entrance channel
 * to Baytown, the Bayport / Texas City / Galveston channels, the Gulf
 * Intracoastal Waterway on both sides of Bolivar Roads, and the offshore
 * fairways and anchorages. Positions are a pure function of the wall clock,
 * so successive polls see them move and any two function instances agree.
 *
 * Nothing here pretends to be live: every row carries MMSI 9990000NN, the
 * name "DEMO REPLAY N" and the ship type "Demo replay (not live AIS)", and
 * the route reports it with provider status `degraded`, source
 * "Demo replay" and the error text below, so the DATA LAYERS row reads
 * "DEGRADED · Demo replay · AISSTREAM_API_KEY not set - demo replay, not
 * live AIS" rather than a healthy LIVE. (ASCII hyphen on purpose: the text
 * also travels in the X-Provider-Error header, which cannot carry UTF-8.)
 */

export const DEMO_REPLAY_SOURCE = 'Demo replay';
export const DEMO_REPLAY_TYPE = 'Demo replay (not live AIS)';
export const DEMO_REPLAY_ERROR =
  'AISSTREAM_API_KEY not set - demo replay, not live AIS';
export const DEMO_REPLAY_EMPTY_MESSAGE =
  'No vessels in scene (demo replay covers the Texas Gulf coast)';
export const DEMO_REPLAY_MMSI_BASE = 999000000;

/** Bounding box the replay covers (Texas Gulf coast: Houston / Galveston / Gulf approaches). */
export const DEMO_REPLAY_AREA = Object.freeze({
  lamin: 28.85,
  lomin: -95.35,
  lamax: 29.85,
  lomax: -94.0,
});

// Shared waypoints ([lat, lon] degrees, approximate but realistic).
const SEA_BUOY = [29.29, -94.58]; // Galveston Bay entrance channel, offshore end
const JETTIES = [29.34, -94.69]; // tips of the Galveston jetties
const BOLIVAR_ROADS = [29.355, -94.775];
const HSC_BAY = [
  [29.4, -94.81],
  [29.47, -94.845],
  [29.55, -94.885],
  [29.62, -94.93],
]; // Houston Ship Channel across Galveston Bay
const MORGANS_POINT = [29.685, -94.985];
const BARBOURS_CUT = [29.683, -94.99];
const BAYPORT = [29.61, -95.01];
const SAN_JACINTO = [29.73, -95.06];
const LYNCHBURG = [29.765, -95.08];
const TEXAS_CITY = [29.375, -94.885];
const GALVESTON_HARBOR = [29.315, -94.86];
const GALVESTON_CHANNEL = [29.31, -94.8];
const FAIRWAY_SE = [
  [29.15, -94.4],
  [28.95, -94.15],
];

/**
 * @typedef {object} DemoVessel
 * @property {number} index 1-based
 * @property {string} destination
 * @property {number} speedKt
 * @property {number} phase 0…1 fraction of the round trip at t = 0
 * @property {Array<[number, number]>} route waypoints [lat, lon]
 */

/** @type {ReadonlyArray<DemoVessel>} */
export const DEMO_REPLAY_FLEET = Object.freeze([
  {
    index: 1,
    destination: 'BAYPORT',
    speedKt: 12,
    phase: 0.12,
    route: [
      FAIRWAY_SE[1],
      FAIRWAY_SE[0],
      SEA_BUOY,
      JETTIES,
      BOLIVAR_ROADS,
      ...HSC_BAY.slice(0, 3),
      [29.61, -94.93],
      BAYPORT,
    ],
  },
  {
    index: 2,
    destination: 'BAYTOWN',
    speedKt: 9,
    phase: 0.41,
    route: [
      SEA_BUOY,
      JETTIES,
      BOLIVAR_ROADS,
      ...HSC_BAY,
      [29.665, -94.965],
      MORGANS_POINT,
      SAN_JACINTO,
      LYNCHBURG,
    ],
  },
  {
    index: 3,
    destination: 'TEXAS CITY',
    speedKt: 10,
    phase: 0.7,
    route: [
      FAIRWAY_SE[0],
      SEA_BUOY,
      JETTIES,
      BOLIVAR_ROADS,
      [29.37, -94.8],
      TEXAS_CITY,
    ],
  },
  {
    index: 4,
    destination: 'GALVESTON',
    speedKt: 15,
    phase: 0.55,
    route: [
      GALVESTON_HARBOR,
      GALVESTON_CHANNEL,
      [29.345, -94.78],
      JETTIES,
      SEA_BUOY,
      FAIRWAY_SE[0],
      FAIRWAY_SE[1],
    ],
  },
  {
    index: 5,
    destination: 'GIWW EAST',
    speedKt: 6,
    phase: 0.3,
    route: [
      [29.36, -94.76],
      [29.45, -94.6],
      [29.55, -94.4],
      [29.62, -94.2],
    ],
  },
  {
    index: 6,
    destination: 'GIWW WEST',
    speedKt: 6,
    phase: 0.83,
    route: [
      [29.3, -94.83],
      [29.22, -95.0],
      [29.12, -95.15],
      [29.02, -95.28],
    ],
  },
  {
    index: 7,
    destination: 'PILOT STATION',
    speedKt: 18,
    phase: 0.05,
    route: [BOLIVAR_ROADS, JETTIES, SEA_BUOY],
  },
  {
    index: 8,
    destination: 'GALVESTON FAIRWAY',
    speedKt: 13,
    phase: 0.62,
    route: [[28.9, -94.05], [29.05, -94.3], [29.2, -94.5], SEA_BUOY],
  },
  {
    index: 9,
    destination: 'OFFSHORE BLOCK',
    speedKt: 11,
    phase: 0.9,
    route: [
      GALVESTON_CHANNEL,
      [29.345, -94.78],
      JETTIES,
      [29.25, -94.62],
      [29.1, -94.55],
      [28.9, -94.45],
    ],
  },
  {
    index: 10,
    destination: 'BARBOURS CUT',
    speedKt: 8,
    phase: 0.22,
    route: [BOLIVAR_ROADS, ...HSC_BAY, [29.665, -94.965], BARBOURS_CUT],
  },
  {
    index: 11,
    destination: 'BOLIVAR FERRY',
    speedKt: 10,
    phase: 0.48,
    route: [
      [29.305, -94.785],
      [29.33, -94.78],
      [29.365, -94.78],
    ],
  },
  {
    index: 12,
    destination: 'FISHING GROUNDS',
    speedKt: 4,
    phase: 0.77,
    route: [
      [29.12, -94.6],
      [29.08, -94.66],
      [29.14, -94.72],
      [29.18, -94.64],
    ],
  },
]);

const NM_PER_DEG_LAT = 60;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Equirectangular leg length in nautical miles (routes are < 100 nm). */
function legNm([lat1, lon1], [lat2, lon2]) {
  const dLat = (lat2 - lat1) * NM_PER_DEG_LAT;
  const dLon =
    (lon2 - lon1) * NM_PER_DEG_LAT * Math.cos(toRad((lat1 + lat2) / 2));
  return Math.hypot(dLat, dLon);
}

/** Initial bearing (degrees true, 0…360) from a to b. */
function bearingDeg([lat1, lon1], [lat2, lon2]) {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const routeCache = new Map();
function routeGeometry(vessel) {
  let geometry = routeCache.get(vessel.index);
  if (geometry) return geometry;
  const legs = [];
  let total = 0;
  for (let i = 1; i < vessel.route.length; i++) {
    const nm = legNm(vessel.route[i - 1], vessel.route[i]);
    legs.push({ from: vessel.route[i - 1], to: vessel.route[i], nm });
    total += nm;
  }
  geometry = { legs, totalNm: total };
  routeCache.set(vessel.index, geometry);
  return geometry;
}

/** Position, course and heading of one demo vessel at `nowMs`. */
export function demoVesselStateAt(vessel, nowMs) {
  const { legs, totalNm } = routeGeometry(vessel);
  const roundTrip = totalNm * 2;
  const travelled =
    (vessel.phase * roundTrip + (vessel.speedKt * nowMs) / 3_600_000) %
    roundTrip;
  const outbound = travelled <= totalNm;
  let along = outbound ? travelled : roundTrip - travelled;
  let leg = legs[legs.length - 1];
  for (const candidate of legs) {
    if (along <= candidate.nm) {
      leg = candidate;
      break;
    }
    along -= candidate.nm;
  }
  const fraction = leg.nm > 0 ? Math.min(1, along / leg.nm) : 0;
  const lat = leg.from[0] + (leg.to[0] - leg.from[0]) * fraction;
  const lon = leg.from[1] + (leg.to[1] - leg.from[1]) * fraction;
  const course = outbound
    ? bearingDeg(leg.from, leg.to)
    : bearingDeg(leg.to, leg.from);
  return {
    lat: +lat.toFixed(5),
    lon: +lon.toFixed(5),
    course: +course.toFixed(1),
    heading: Math.round(course) % 360,
    outbound,
  };
}

export function demoReplayMmsi(index) {
  return String(DEMO_REPLAY_MMSI_BASE + index);
}

/** Whether `mmsi` names one of the replay vessels. */
export function isDemoReplayMmsi(mmsi) {
  const number = Number(mmsi);
  return (
    Number.isInteger(number) &&
    number > DEMO_REPLAY_MMSI_BASE &&
    number <= DEMO_REPLAY_MMSI_BASE + DEMO_REPLAY_FLEET.length
  );
}

function insideBbox(lat, lon, bbox) {
  if (!bbox) return true;
  return (
    lat >= bbox.lamin &&
    lat <= bbox.lamax &&
    lon >= bbox.lomin &&
    lon <= bbox.lomax
  );
}

/**
 * Replay rows (same shape as server/providers/vessels/ais-store.js rows) for
 * the vessels currently inside `bbox` (all of them when bbox is null).
 *
 * @param {{bbox?: {lamin:number,lomin:number,lamax:number,lomax:number}|null, now?: number, maxRows?: number}} [options]
 */
export function demoReplayRows({
  bbox = null,
  now = Date.now(),
  maxRows = Infinity,
} = {}) {
  const epochSec = Math.floor(now / 1000);
  const iso = new Date(epochSec * 1000).toISOString();
  const rows = [];
  for (const vessel of DEMO_REPLAY_FLEET) {
    const state = demoVesselStateAt(vessel, now);
    if (!insideBbox(state.lat, state.lon, bbox)) continue;
    rows.push({
      lat: state.lat,
      lon: state.lon,
      name: `DEMO REPLAY ${vessel.index}`,
      mmsi: demoReplayMmsi(vessel.index),
      imo: '',
      type: DEMO_REPLAY_TYPE,
      destination: `${vessel.destination} (DEMO)`,
      speed: vessel.speedKt,
      course: state.course,
      heading: state.heading,
      last_position_UTC: iso,
      last_position_epoch: epochSec,
    });
    if (rows.length >= maxRows) break;
  }
  return rows;
}

/**
 * Recent-path samples for one replay vessel (chronological, oldest first),
 * so selecting a demo vessel still draws a trail. Empty for a non-demo MMSI.
 *
 * @param {string|number} mmsi
 * @param {{now?: number, minutes?: number, stepSec?: number}} [options]
 * @returns {Array<{lat:number,lon:number,t:number}>}
 */
export function demoReplayTrack(
  mmsi,
  { now = Date.now(), minutes = 60, stepSec = 120 } = {},
) {
  if (!isDemoReplayMmsi(mmsi)) return [];
  const vessel = DEMO_REPLAY_FLEET[Number(mmsi) - DEMO_REPLAY_MMSI_BASE - 1];
  const samples = [];
  const steps = Math.max(1, Math.floor((minutes * 60) / stepSec));
  for (let i = steps; i >= 0; i--) {
    const at = now - i * stepSec * 1000;
    const state = demoVesselStateAt(vessel, at);
    samples.push({ lat: state.lat, lon: state.lon, t: Math.floor(at / 1000) });
  }
  return samples;
}

/** Whether a scene bbox overlaps the replay's coverage area at all. */
export function demoReplayCoversBbox(bbox) {
  if (!bbox) return true;
  return !(
    bbox.lamax < DEMO_REPLAY_AREA.lamin ||
    bbox.lamin > DEMO_REPLAY_AREA.lamax ||
    bbox.lomax < DEMO_REPLAY_AREA.lomin ||
    bbox.lomin > DEMO_REPLAY_AREA.lomax
  );
}

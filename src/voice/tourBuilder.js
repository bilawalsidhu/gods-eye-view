/**
 * Auto-Director tour builder. Pure: turns live analyst records plus the
 * current camera into a Director scene document (version 6) with 4-8 shots,
 * a title and a narration line per shot, inside a requested time budget.
 *
 * The scene is the Director's native shape: inline camera poses in degrees
 * and ellipsoidal meters, an optional pose-to-pose `move` for sweeps, and
 * `layers` declaring only the theme's layer. No renderer, storage or network.
 */

/** Theme catalogue: which layer feeds it and how its records are described. */
export const TOUR_THEMES = Object.freeze({
  airspace: {
    layer: 'flights',
    noun: 'aircraft',
    title: 'Busiest airspace',
    wideAltM: 130_000,
  },
  military: {
    layer: 'military',
    noun: 'military aircraft',
    title: 'Military air picture',
    wideAltM: 130_000,
  },
  ships: {
    layer: 'ais-live-vessels',
    noun: 'vessels',
    title: 'Busiest waters',
    wideAltM: 60_000,
  },
  fires: {
    layer: 'local-firms',
    noun: 'fire detections',
    title: 'Fire front',
    wideAltM: 90_000,
  },
  quakes: {
    layer: 'earthquakes',
    noun: 'earthquakes',
    title: 'Seismic activity',
    wideAltM: 160_000,
  },
  view: {
    layer: null,
    noun: 'records',
    title: 'Around the current view',
    wideAltM: null,
  },
});

export const TOUR_SCENE_ID = 'auto-tour';
const THEME_WORDS = [
  ['military', /\b(military|jets?|fighters?|warplanes?|air ?force)\b/],
  ['ships', /\b(ships?|vessels?|harbou?rs?|ports?|maritime|shipping|sea)\b/],
  ['fires', /\b(fires?|wildfires?|firms|burning|hotspots?)\b/],
  ['quakes', /\b(quakes?|earthquakes?|seismic|tremors?)\b/],
  [
    'airspace',
    /\b(airspace|flights?|planes?|aircraft|airliners?|air ?traffic|sky|skies)\b/,
  ],
  ['view', /\b(here|view|around|current|this)\b/],
];

/** Major hubs used for offline place naming; nearest within 150 km wins. */
export const TOUR_HUBS = Object.freeze(
  [
    ['Dallas–Fort Worth', 32.9, -97.04],
    ['Houston', 29.98, -95.34],
    ['Atlanta', 33.64, -84.43],
    ['Chicago', 41.98, -87.9],
    ['New York', 40.64, -73.78],
    ['Washington DC', 38.85, -77.04],
    ['Boston', 42.36, -71.01],
    ['Miami', 25.79, -80.29],
    ['Orlando', 28.43, -81.31],
    ['Charlotte', 35.21, -80.94],
    ['Denver', 39.86, -104.67],
    ['Phoenix', 33.43, -112.01],
    ['Las Vegas', 36.08, -115.15],
    ['Los Angeles', 33.94, -118.41],
    ['San Francisco Bay', 37.62, -122.38],
    ['Seattle', 47.45, -122.31],
    ['Minneapolis', 44.88, -93.22],
    ['Detroit', 42.21, -83.35],
    ['Toronto', 43.68, -79.63],
    ['Vancouver', 49.19, -123.18],
    ['Mexico City', 19.44, -99.07],
    ['São Paulo', -23.43, -46.47],
    ['Buenos Aires', -34.82, -58.54],
    ['Bogotá', 4.7, -74.15],
    ['Panama Canal', 9.08, -79.68],
    ['London', 51.47, -0.45],
    ['Paris', 49.01, 2.55],
    ['Amsterdam', 52.31, 4.76],
    ['Frankfurt', 50.04, 8.57],
    ['Munich', 48.35, 11.79],
    ['Zurich', 47.46, 8.55],
    ['Madrid', 40.47, -3.56],
    ['Barcelona', 41.3, 2.08],
    ['Rome', 41.8, 12.24],
    ['Milan', 45.63, 8.72],
    ['Vienna', 48.11, 16.57],
    ['Copenhagen', 55.62, 12.65],
    ['Stockholm', 59.65, 17.92],
    ['Oslo', 60.19, 11.1],
    ['Helsinki', 60.32, 24.95],
    ['Dublin', 53.43, -6.25],
    ['Brussels', 50.9, 4.48],
    ['Lisbon', 38.77, -9.13],
    ['Athens', 37.94, 23.94],
    ['Istanbul', 41.26, 28.74],
    ['Warsaw', 52.17, 20.97],
    ['Moscow', 55.97, 37.41],
    ['Rotterdam', 51.9, 4.4],
    ['Hamburg', 53.55, 9.97],
    ['Antwerp', 51.28, 4.34],
    ['Gibraltar Strait', 35.95, -5.6],
    ['Suez Canal', 30.6, 32.3],
    ['Dubai', 25.25, 55.36],
    ['Doha', 25.27, 51.61],
    ['Riyadh', 24.96, 46.7],
    ['Tel Aviv', 32.01, 34.89],
    ['Cairo', 30.12, 31.41],
    ['Johannesburg', -26.14, 28.25],
    ['Lagos', 6.58, 3.32],
    ['Nairobi', -1.32, 36.93],
    ['Delhi', 28.56, 77.1],
    ['Mumbai', 19.09, 72.87],
    ['Bangalore', 13.2, 77.71],
    ['Karachi', 24.91, 67.16],
    ['Dhaka', 23.84, 90.4],
    ['Bangkok', 13.69, 100.75],
    ['Singapore', 1.36, 103.99],
    ['Strait of Malacca', 2.5, 101.5],
    ['Kuala Lumpur', 2.75, 101.71],
    ['Jakarta', -6.13, 106.66],
    ['Manila', 14.51, 121.02],
    ['Ho Chi Minh City', 10.82, 106.65],
    ['Hong Kong', 22.31, 113.91],
    ['Shenzhen', 22.64, 113.81],
    ['Guangzhou', 23.39, 113.3],
    ['Shanghai', 31.14, 121.81],
    ['Beijing', 40.08, 116.58],
    ['Taipei', 25.08, 121.23],
    ['Seoul', 37.46, 126.44],
    ['Busan', 35.18, 128.94],
    ['Tokyo', 35.55, 139.78],
    ['Osaka', 34.43, 135.24],
    ['Sydney', -33.95, 151.18],
    ['Melbourne', -37.67, 144.84],
    ['Brisbane', -27.38, 153.12],
    ['Perth', -31.94, 115.97],
    ['Auckland', -37.01, 174.79],
    ['Honolulu', 21.32, -157.92],
    ['Anchorage', 61.17, -149.99],
    ['Reykjavik', 63.99, -22.62],
    ['Kathmandu', 27.7, 85.36],
  ].map(([name, lat, lon]) => Object.freeze({ name, lat, lon })),
);

const EARTH_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const round1 = (n) => Math.round(n * 10) / 10;
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
const clampLat = (lat) => Math.max(-89.9, Math.min(89.9, lat));
const norm360 = (h) => ((h % 360) + 360) % 360;
const finite = (n) => Number.isFinite(n);

/** Great-circle distance in km. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from point 1 to point 2, degrees clockwise from north. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x =
    Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
    Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return norm360(deg(Math.atan2(y, x)));
}

/** Destination point from a start, bearing (deg) and distance (km). */
export function offsetPoint(lat, lon, bearing, distanceKm) {
  const d = distanceKm / EARTH_KM;
  const b = rad(bearing);
  const lat1 = rad(lat);
  const lon1 = rad(lon);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: clampLat(deg(lat2)), lon: wrapLon(deg(lon2)) };
}

/** Map free text ("busiest airspace right now") to a theme key. */
export function resolveTheme(text) {
  const q = String(text || '')
    .trim()
    .toLowerCase();
  if (!q) return 'airspace';
  if (TOUR_THEMES[q]) return q;
  for (const [key, pattern] of THEME_WORDS) if (pattern.test(q)) return key;
  return 'view';
}

/** Nearest bundled hub within maxKm, or null. */
export function nearestHub(lat, lon, maxKm = 150) {
  if (!finite(lat) || !finite(lon)) return null;
  let best = null;
  for (const hub of TOUR_HUBS) {
    const km = haversineKm(lat, lon, hub.lat, hub.lon);
    if (km <= maxKm && (!best || km < best.km)) best = { ...hub, km };
  }
  return best;
}

/** Spoken name for a point: hub, caller-supplied name, else coordinates. */
export function describePlace(lat, lon, placeName = null) {
  const hub = nearestHub(lat, lon);
  if (hub) return hub.name;
  const named = typeof placeName === 'function' ? placeName(lat, lon) : null;
  if (named) return String(named);
  return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
}

const located = (records) =>
  (Array.isArray(records) ? records : []).filter(
    (r) => finite(r?.lat) && finite(r?.lon) && r.onGround !== true,
  );

/**
 * Densest 1° cell of the records: centroid of its members plus everything
 * within radiusKm of that centroid (the spoken count).
 */
export function densestCell(records, { degrees = 1, radiusKm = 60 } = {}) {
  const rows = located(records);
  if (!rows.length) return null;
  const cells = new Map();
  for (const r of rows) {
    const key = `${Math.floor(r.lat / degrees)}:${Math.floor(r.lon / degrees)}`;
    const cell = cells.get(key) || [];
    cell.push(r);
    cells.set(key, cell);
  }
  const members = [...cells.values()].sort((a, b) => b.length - a.length)[0];
  const lat = members.reduce((s, r) => s + r.lat, 0) / members.length;
  const lon = members.reduce((s, r) => s + r.lon, 0) / members.length;
  const nearby = rows.filter(
    (r) => haversineKm(lat, lon, r.lat, r.lon) <= radiusKm,
  );
  return { lat, lon, cellCount: members.length, count: nearby.length, nearby };
}

/** Records within radiusKm of a point, nearest first. */
function around(records, lat, lon, radiusKm) {
  return located(records)
    .map((r) => ({ r, km: haversineKm(lat, lon, r.lat, r.lon) }))
    .filter((x) => x.km <= radiusKm)
    .sort((a, b) => a.km - b.km)
    .map((x) => x.r);
}

const recordKey = (r) => String(r.icao24 || r.mmsi || r.id);
const byDesc = (field) => (a, b) => (b[field] ?? -1) - (a[field] ?? -1);

/** Ordered highlight targets: a superlative first, then variety. */
export function pickHighlights(theme, records, count) {
  const rows = located(records);
  const chosen = [];
  const seen = new Set();
  const take = (r) => {
    if (!r || seen.has(recordKey(r))) return;
    seen.add(recordKey(r));
    chosen.push(r);
  };
  const distinct = (field, sorted) => {
    const used = new Set(chosen.map((r) => r[field]).filter(Boolean));
    for (const r of sorted) {
      if (chosen.length >= count) break;
      if (r[field] && !used.has(r[field])) {
        used.add(r[field]);
        take(r);
      }
    }
  };
  if (theme === 'airspace' || theme === 'military') {
    const byAlt = [...rows].sort(byDesc('altitudeM'));
    take(byAlt[0]);
    take([...rows].sort(byDesc('speedMps'))[0]);
    distinct('operator', byAlt);
    for (const r of byAlt) if (chosen.length < count) take(r);
  } else if (theme === 'ships') {
    const bySpeed = [...rows].sort(byDesc('speedKts'));
    take(bySpeed[0]);
    distinct('shipType', bySpeed);
    for (const r of bySpeed) if (chosen.length < count) take(r);
  } else if (theme === 'fires') {
    for (const r of [...rows].sort(byDesc('frp')))
      if (chosen.length < count) take(r);
  } else if (theme === 'quakes') {
    for (const r of [...rows].sort(byDesc('magnitude')))
      if (chosen.length < count) take(r);
  } else {
    for (const r of rows) if (chosen.length < count) take(r);
  }
  return chosen.slice(0, count);
}

const compass = (h) =>
  [
    'north',
    'northeast',
    'east',
    'southeast',
    'south',
    'southwest',
    'west',
    'northwest',
  ][Math.round(norm360(h) / 45) % 8];
const aircraftLabel = (r) =>
  [r.operator, r.callsign || r.id].filter(Boolean).join(' ').trim() ||
  String(r.id);
const shipLabel = (r) => r.name || `MMSI ${r.mmsi || r.id}`;
const labelFor = (theme, r) =>
  theme === 'ships'
    ? shipLabel(r)
    : theme === 'airspace' || theme === 'military'
      ? aircraftLabel(r)
      : String(r.id);
const nounForLayer = (layerId) =>
  Object.values(TOUR_THEMES).find((t) => t.layer === layerId)?.noun ||
  'records';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Spoken line and title for one highlight record. */
export function describeHighlight(theme, r, now = Date.now()) {
  if (theme === 'airspace' || theme === 'military') {
    const parts = [];
    if (finite(r.altitudeM)) parts.push(`${Math.round(r.altitudeM)} m`);
    if (finite(r.speedMps)) parts.push(`${Math.round(r.speedMps * 3.6)} km/h`);
    if (finite(r.heading)) parts.push(`heading ${compass(r.heading)}`);
    if (r.routeOrigin && r.routeDestination)
      parts.push(`${r.routeOrigin} to ${r.routeDestination}`);
    const label = aircraftLabel(r);
    return {
      title: label,
      line: parts.length ? `${label}: ${parts.join(', ')}.` : `${label}.`,
    };
  }
  if (theme === 'ships') {
    const parts = [];
    if (r.shipType) parts.push(r.shipType);
    if (finite(r.speedKts)) parts.push(`${Math.round(r.speedKts)} knots`);
    if (finite(r.courseDeg)) parts.push(`course ${compass(r.courseDeg)}`);
    if (r.destination) parts.push(`bound for ${r.destination}`);
    const label = shipLabel(r);
    return {
      title: label,
      line: parts.length ? `${label}: ${parts.join(', ')}.` : `${label}.`,
    };
  }
  if (theme === 'fires') {
    const mw = finite(r.frp)
      ? `${Math.round(r.frp)} megawatts`
      : 'unknown power';
    const sat = r.satellite ? ` seen by ${r.satellite}` : '';
    return {
      title: `Hotspot ${Math.round(r.frp || 0)} MW`,
      line: `Hotspot at ${mw}${sat}.`,
    };
  }
  if (theme === 'quakes') {
    const m = finite(r.magnitude)
      ? `Magnitude ${r.magnitude.toFixed(1)}`
      : 'Earthquake';
    const depth = finite(r.depthKm) ? `, ${Math.round(r.depthKm)} km deep` : '';
    const age = finite(r.timeMs) ? `, ${ageText(now - r.timeMs)}` : '';
    const place = r.place ? ` near ${r.place}` : '';
    return { title: m, line: `${m}${place}${depth}${age}.` };
  }
  return { title: String(r.id), line: `${r.id}.` };
}

function ageText(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${plural(min, 'minute')} ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${plural(h, 'hour')} ago`;
  return `${plural(Math.round(h / 24), 'day')} ago`;
}

/** Establishing narration per theme. */
function establishingLine(theme, place, focus, top) {
  const n = focus.count;
  const km = focus.radiusKm;
  if (theme === 'airspace' || theme === 'military') {
    const noun = TOUR_THEMES[theme].noun;
    const high =
      top && finite(top.altitudeM)
        ? `; the highest is ${aircraftLabel(top)} at ${Math.round(top.altitudeM)} m`
        : '';
    return `Now over ${place}: ${n} ${noun} within ${km} km${high}.`;
  }
  if (theme === 'ships') {
    const fast =
      top && finite(top.speedKts)
        ? `; the fastest is ${shipLabel(top)} at ${Math.round(top.speedKts)} knots`
        : '';
    return `Now over ${place}: ${plural(n, 'vessel')} within ${km} km${fast}.`;
  }
  if (theme === 'fires') {
    const strong =
      top && finite(top.frp)
        ? `; the strongest burns at ${Math.round(top.frp)} megawatts`
        : '';
    return `Now over ${place}: ${plural(n, 'fire detection')} within ${km} km${strong}.`;
  }
  if (theme === 'quakes') {
    const big =
      top && finite(top.magnitude)
        ? `; the largest is magnitude ${top.magnitude.toFixed(1)}`
        : '';
    return `Now over ${place}: ${plural(n, 'earthquake')} within ${km} km${big}.`;
  }
  return `Now over ${place}.`;
}

function sweepLine(theme, place, rows) {
  if (theme === 'airspace' || theme === 'military') {
    const ops = new Set(rows.map((r) => r.operator).filter(Boolean)).size;
    const mil = rows.filter((r) => r.military).length;
    const bits = [];
    if (ops) bits.push(`${plural(ops, 'operator')} in the air`);
    if (mil) bits.push(`${plural(mil, 'military contact')}`);
    return `Sweeping ${place}${bits.length ? `: ${bits.join(', ')}` : ''}.`;
  }
  if (theme === 'ships') {
    const types = new Set(rows.map((r) => r.shipType).filter(Boolean)).size;
    const dest = mode(rows.map((r) => r.destination));
    const bits = [];
    if (types) bits.push(`${plural(types, 'ship type')}`);
    if (dest) bits.push(`most are bound for ${dest}`);
    return `Sweeping ${place}${bits.length ? `: ${bits.join('; ')}` : ''}.`;
  }
  if (theme === 'fires') {
    const total = rows.reduce((s, r) => s + (finite(r.frp) ? r.frp : 0), 0);
    return `Sweeping the ${place} fire front: about ${Math.round(total)} megawatts combined.`;
  }
  if (theme === 'quakes') {
    const recent = rows.filter(
      (r) => finite(r.magnitude) && r.magnitude >= 4,
    ).length;
    return `Sweeping ${place}: ${plural(recent, 'quake')} at magnitude four or more.`;
  }
  return `Sweeping ${place}.`;
}

function mode(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

/** Camera pose that stands off a target and looks back at it. */
function lookAt(target, { bearing, distanceKm, heightM, pitch }) {
  const at = offsetPoint(target.lat, target.lon, bearing, distanceKm);
  return {
    lat: at.lat,
    lon: at.lon,
    alt: Math.max(50, (target.altM || 0) + heightM),
    heading: round1(bearingDeg(at.lat, at.lon, target.lat, target.lon)),
    pitch,
    roll: 0,
  };
}

const withRef = (pose) => ({ ...pose, altitudeReference: 'ellipsoid' });

/**
 * Split the time budget over the shots. Each shot keeps at least 0.3 s of
 * hold; the last shot absorbs rounding so the total equals `seconds`.
 */
export function budgetShots(kinds, seconds) {
  const share = seconds / kinds.length;
  const fraction = {
    establishing: 0.45,
    sweep: 0.8,
    highlight: 0.4,
    closing: 0.5,
  };
  const out = kinds.map((kind) => {
    let durationSec = round1(
      Math.min(6, Math.max(0.8, share * (fraction[kind] || 0.45))),
    );
    if (durationSec > share - 0.3)
      durationSec = round1(Math.max(0.2, share - 0.3));
    return {
      kind,
      durationSec,
      holdSec: round1(Math.max(0.3, share - durationSec)),
    };
  });
  const spent = out.reduce((s, x) => s + x.durationSec + x.holdSec, 0);
  const last = out[out.length - 1];
  last.holdSec = round1(Math.max(0.3, last.holdSec + (seconds - spent)));
  return out;
}

/** Shot count for a budget: roughly one every ten seconds, 4-8. */
export const shotCountFor = (seconds) =>
  Math.max(4, Math.min(8, Math.round(seconds / 10)));

/** Where the camera currently looks on the ground, from altitude and pitch. */
export function lookTarget(camera) {
  const pitch = Math.min(-5, camera.pitch ?? -35);
  const groundKm = Math.min(
    400,
    (camera.alt || 1000) / Math.tan(rad(-pitch)) / 1000,
  );
  const at = offsetPoint(camera.lat, camera.lon, camera.heading || 0, groundKm);
  return { ...at, altM: 0, groundKm };
}

/** Choose the theme's focus before any naming: layer, centre and members. */
export function pickFocus({
  theme = 'airspace',
  records = {},
  camera = null,
} = {}) {
  const key = TOUR_THEMES[theme] ? theme : resolveTheme(theme);
  const spec = TOUR_THEMES[key];
  let layer = spec.layer;
  let rows = layer ? records[layer] : null;
  if (
    key === 'airspace' &&
    !located(rows).length &&
    located(records.military).length
  ) {
    layer = 'military';
    rows = records.military;
  }
  if (layer && located(rows).length) {
    const cell = densestCell(rows);
    return {
      theme: key,
      layer,
      fallback: null,
      focus: {
        lat: cell.lat,
        lon: cell.lon,
        count: cell.count,
        radiusKm: 60,
        rows: cell.nearby,
      },
    };
  }
  if (!camera || !finite(camera.lat) || !finite(camera.lon)) {
    return {
      theme: 'view',
      layer: null,
      fallback: key === 'view' ? 'no-camera' : 'no-data',
      focus: null,
    };
  }
  const target = lookTarget(camera);
  const nearby = Object.entries(records)
    .map(([id, list]) => [id, around(list, target.lat, target.lon, 100)])
    .filter(([, list]) => list.length);
  return {
    theme: 'view',
    layer: null,
    fallback: key === 'view' ? null : 'no-data',
    focus: {
      lat: target.lat,
      lon: target.lon,
      count: nearby.reduce((s, [, l]) => s + l.length, 0),
      radiusKm: 100,
      rows: [],
      nearby,
      target,
      camera,
    },
  };
}

/**
 * Build the tour.
 * @param {object} options
 * @param {string} [options.theme] - theme key or free text
 * @param {number} [options.seconds=60] - total budget (8-900)
 * @param {Object<string, Array>} [options.records] - analyst records by layer id
 * @param {object|null} [options.camera] - current camera state (deg / m)
 * @param {object|null} [options.visual] - current visual state to keep per shot
 * @param {(lat:number, lon:number) => string|null} [options.placeName] - naming fallback
 * @param {number} [options.now]
 */
export function buildTour({
  theme = 'airspace',
  seconds = 60,
  records = {},
  camera = null,
  visual = null,
  placeName = null,
  now = Date.now(),
} = {}) {
  const budget = Math.max(8, Math.min(900, Number(seconds) || 60));
  const plan = pickFocus({ theme, records, camera });
  if (!plan.focus) {
    return {
      ok: false,
      error:
        plan.fallback === 'no-camera'
          ? 'No live records loaded and no camera position to orbit'
          : 'No live records loaded for that theme and no camera position to fall back to',
      theme: plan.theme,
      fallback: plan.fallback,
    };
  }
  const n = shotCountFor(budget);
  const spec = TOUR_THEMES[plan.theme];
  const { focus } = plan;
  const place = describePlace(focus.lat, focus.lon, placeName);
  const shots = [];
  const narration = [];
  const chosen = [];
  const push = (kind, title, line, pose, extra = {}) => {
    const id = `${TOUR_SCENE_ID}-shot-${shots.length + 1}`;
    shots.push({ id, kind, title, camera: pose, ...extra });
    narration.push({ shotId: id, title, line });
  };
  const keep = visual && typeof visual === 'object' ? visual : {};
  const layers = plan.layer ? { [plan.layer]: { enabled: true } } : {};

  if (plan.theme === 'view') {
    const { target, camera: cam, nearby } = focus;
    const summary = nearby
      .map(([id, list]) => `${list.length} ${nounForLayer(id)}`)
      .join(', ');
    const pose0 = {
      lat: cam.lat,
      lon: cam.lon,
      alt: Math.max(50, cam.alt || 1000),
      heading: round1(norm360(cam.heading || 0)),
      pitch: Math.max(-89, Math.min(-5, cam.pitch ?? -35)),
      roll: 0,
    };
    push(
      'establishing',
      `Around ${place}`,
      summary
        ? `Around ${place}: ${summary} within 100 km.`
        : `Orbiting ${place}.`,
      pose0,
    );
    const radiusKm = Math.max(0.5, target.groundKm);
    const startBearing = norm360((cam.heading || 0) + 180);
    const step = 360 / (n - 1);
    let previous = withRef(pose0);
    for (let i = 1; i < n; i++) {
      const to = withRef(
        lookAt(target, {
          bearing: startBearing + step * i,
          distanceKm: radiusKm,
          heightM: pose0.alt,
          pitch: pose0.pitch,
        }),
      );
      const kind = i === n - 1 ? 'closing' : 'sweep';
      push(
        kind,
        i === n - 1 ? `Back over ${place}` : `Orbit ${i} of ${n - 2}`,
        i === n - 1
          ? `That completes the orbit of ${place}.`
          : `Orbit ${i}, looking ${compass(to.heading)}.`,
        to,
        { move: { from: previous, easing: 'cubic-in-out' } },
      );
      previous = to;
    }
  } else {
    const rows = focus.rows;
    const highlightCount = Math.max(0, n - 3);
    const highlights = pickHighlights(plan.theme, rows, highlightCount);
    const top = highlights[0] || pickHighlights(plan.theme, rows, 1)[0] || null;
    chosen.push(...highlights);
    const center = { lat: focus.lat, lon: focus.lon, altM: 0 };
    push(
      'establishing',
      `${spec.title}: ${place}`,
      establishingLine(plan.theme, place, focus, top),
      lookAt(center, {
        bearing: 180,
        distanceKm: 45,
        heightM: spec.wideAltM,
        pitch: -58,
      }),
    );
    const from = withRef(
      lookAt(center, {
        bearing: 240,
        distanceKm: 40,
        heightM: spec.wideAltM * 0.35,
        pitch: -38,
      }),
    );
    const to = withRef(
      lookAt(center, {
        bearing: 120,
        distanceKm: 40,
        heightM: spec.wideAltM * 0.35,
        pitch: -38,
      }),
    );
    push(
      'sweep',
      `Sweep over ${place}`,
      sweepLine(plan.theme, place, rows),
      to,
      {
        move: { from, easing: 'cubic-in-out' },
      },
    );
    const airborne = plan.theme === 'airspace' || plan.theme === 'military';
    for (const r of highlights) {
      const { title, line } = describeHighlight(plan.theme, r, now);
      const target = {
        lat: r.lat,
        lon: r.lon,
        altM: airborne && finite(r.altitudeM) ? r.altitudeM : 0,
      };
      const behind =
        airborne && finite(r.heading) ? norm360(r.heading + 180) : 200;
      push(
        'highlight',
        title,
        line,
        lookAt(
          target,
          airborne
            ? { bearing: behind, distanceKm: 7, heightM: 2500, pitch: -20 }
            : { bearing: behind, distanceKm: 4, heightM: 3000, pitch: -36 },
        ),
      );
    }
    while (shots.length < n - 1) {
      const extra = shots.length - 1;
      push(
        'highlight',
        `${place} from the ${compass(90 * extra)}`,
        `${place} from the ${compass(90 * extra)}.`,
        lookAt(center, {
          bearing: 90 * extra,
          distanceKm: 30,
          heightM: spec.wideAltM * 0.25,
          pitch: -40,
        }),
      );
    }
    push(
      'closing',
      `${place} wide`,
      `That's ${place}: ${focus.count} ${spec.noun} in one frame.`,
      lookAt(center, {
        bearing: 0,
        distanceKm: 45,
        heightM: spec.wideAltM * 0.8,
        pitch: -55,
      }),
    );
  }

  const timing = budgetShots(
    shots.map((s) => s.kind),
    budget,
  );
  const documentShots = shots.map((shot, i) => {
    const { kind, ...rest } = shot;
    void kind;
    return {
      ...rest,
      durationSec: timing[i].durationSec,
      holdSec: timing[i].holdSec,
      visual: keep,
      layers,
    };
  });
  const scene = {
    id: TOUR_SCENE_ID,
    title: `Auto-Director: ${spec.title} — ${place}`,
    releaseLayerIds: [],
    appliedShotPacks: [],
    shots: documentShots,
  };
  const durationSec = round1(
    timing.reduce((s, t) => s + t.durationSec + t.holdSec, 0),
  );
  return {
    ok: true,
    scene,
    narration,
    shots: documentShots.map((s, i) => ({
      title: s.title,
      line: narration[i].line,
      durationSec: s.durationSec,
      holdSec: s.holdSec,
    })),
    durationSec,
    theme: plan.theme,
    layer: plan.layer,
    fallback: plan.fallback,
    place,
    focus: {
      lat: Math.round(focus.lat * 100) / 100,
      lon: Math.round(focus.lon * 100) / 100,
      count: focus.count,
      radiusKm: focus.radiusKm,
    },
    highlights: chosen.map((r) => ({
      id: recordKey(r),
      label: labelFor(plan.theme, r),
      layer: plan.layer,
    })),
  };
}

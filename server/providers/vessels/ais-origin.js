/**
 * Where a vessel has come from.
 *
 * AIS broadcasts a destination but never an origin, so this is reconstructed
 * from the app's own voyage history. Three grades of evidence, strongest
 * first, and the weakest of them is an admission rather than an answer:
 *
 *   DEPARTED  — the vessel was observed stopped for a sustained period and
 *               then left. That is a real departure, with a place and a time.
 *   PREVIOUS  — its declared destination changed. The port it previously
 *               named is usually the one it has just called at.
 *   UNOBSERVED— tracking began with the hull already under way. Nothing about
 *               its origin was seen, only the direction it came from.
 */

const EARTH_RADIUS_M = 6371008.8;

export const ORIGIN_DEFAULTS = Object.freeze({
  // Below this a vessel is alongside, anchored or drifting, not on passage.
  stoppedKnots: 1.0,
  // A stop must last this long to be a call rather than a lock, a pilot
  // boarding or a traffic hold.
  minStopSec: 1800,
  // Movement away from the stop before it counts as a departure.
  minDepartureM: 5000,
});

/** Great-circle distance in metres. */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing in degrees from point 1 to point 2. */
export function bearingDegrees(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x =
    Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
    Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** Compass point for a bearing, for prose rather than navigation. */
export function compassPoint(bearing) {
  const points = [
    'north',
    'north-east',
    'east',
    'south-east',
    'south',
    'south-west',
    'west',
    'north-west',
  ];
  return points[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

/**
 * Finds the last sustained stop in a chronological track.
 *
 * @param {Array<{lat:number,lon:number,t:number,sog:number|null}>} track Ascending by time.
 * @returns {{lat:number,lon:number,from:number,to:number,durationSec:number}|null}
 */
export function findLastStop(track, options = {}) {
  const stoppedKnots = options.stoppedKnots ?? ORIGIN_DEFAULTS.stoppedKnots;
  const minStopSec = options.minStopSec ?? ORIGIN_DEFAULTS.minStopSec;
  const minDepartureM = options.minDepartureM ?? ORIGIN_DEFAULTS.minDepartureM;
  const points = Array.isArray(track) ? track : [];
  if (points.length < 2) return null;

  let best = null;
  let runStart = null;
  let previous = null;
  for (const point of points) {
    // Number(null) is 0, which would read every speed-less position report as
    // a vessel sitting still and invent a port call out of missing data.
    const raw = point?.sog;
    const sog =
      raw === null || raw === undefined || raw === ''
        ? Number.NaN
        : Number(raw);
    const stopped = Number.isFinite(sog) && sog <= stoppedKnots;
    if (stopped) {
      if (!runStart) runStart = point;
      previous = point;
      continue;
    }
    if (runStart && previous) {
      const durationSec = previous.t - runStart.t;
      if (durationSec >= minStopSec) best = { runStart, previous, durationSec };
    }
    runStart = null;
    previous = null;
  }
  // A stop still in progress is where the vessel is, not where it came from.
  if (!best) return null;

  const last = points[points.length - 1];
  const moved = distanceMeters(
    best.previous.lat,
    best.previous.lon,
    last.lat,
    last.lon,
  );
  if (moved < minDepartureM) return null;

  return {
    lat: best.runStart.lat,
    lon: best.runStart.lon,
    from: best.runStart.t,
    to: best.previous.t,
    durationSec: best.durationSec,
  };
}

/**
 * Builds the origin account.
 *
 * @param {Array<Object>} track Chronological track points.
 * @param {Array<Object>} voyages Voyage rows, newest first.
 * @param {{lat:number, lon:number}} current Current position.
 * @returns {{confidence:'DEPARTED'|'PREVIOUS'|'UNOBSERVED'|'NONE', statement:string, detail:Object|null}}
 */
export function inferOrigin(track, voyages = [], current = null, options = {}) {
  const points = (Array.isArray(track) ? track : [])
    .filter(
      (p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lon)),
    )
    .map((p) => ({
      lat: Number(p.lat),
      lon: Number(p.lon),
      t: Number(p.t),
      sog: p.sog,
    }))
    .sort((a, b) => a.t - b.t);

  if (!points.length) {
    return {
      confidence: 'NONE',
      statement:
        'No track history, so nothing is known about where it came from.',
      detail: null,
    };
  }

  const here =
    current && Number.isFinite(Number(current.lat))
      ? { lat: Number(current.lat), lon: Number(current.lon) }
      : points[points.length - 1];

  const stop = findLastStop(points, options);
  if (stop) {
    const hours = Math.round((stop.durationSec / 3600) * 10) / 10;
    const away = distanceMeters(stop.lat, stop.lon, here.lat, here.lon);
    return {
      confidence: 'DEPARTED',
      statement: `Departed ${formatPosition(stop.lat, stop.lon)} after ${hours}h stopped, now ${formatDistance(away)} away.`,
      detail: { ...stop, distanceM: away },
    };
  }

  // A changed destination names the port it was previously heading for, which
  // for a vessel now elsewhere is usually the one it has just left.
  const declared = (Array.isArray(voyages) ? voyages : [])
    .filter((v) => String(v?.destination || '').trim())
    .sort((a, b) => b.observed - a.observed);
  const latest = declared[0]?.destination;
  const earlier = declared.find((v) => v.destination !== latest);
  if (earlier) {
    return {
      confidence: 'PREVIOUS',
      statement: `Previously declared ${earlier.destination}, so it has most likely just called there.`,
      detail: { destination: earlier.destination, observed: earlier.observed },
    };
  }

  // Nothing was observed: report the direction it came from, and say so.
  const first = points[0];
  const away = distanceMeters(first.lat, first.lon, here.lat, here.lon);
  const bearing = bearingDegrees(here.lat, here.lon, first.lat, first.lon);
  return {
    confidence: 'UNOBSERVED',
    statement:
      `Origin not observed — first tracked ${formatPosition(first.lat, first.lon)}, ` +
      `already under way ${formatDistance(away)} to the ${compassPoint(bearing)}.`,
    detail: {
      lat: first.lat,
      lon: first.lon,
      t: first.t,
      distanceM: away,
      bearing,
    },
  };
}

function formatPosition(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(lon).toFixed(2)}°${ew}`;
}

function formatDistance(meters) {
  const km = meters / 1000;
  if (km < 1) return `${Math.round(meters)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

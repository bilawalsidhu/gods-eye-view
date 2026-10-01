/**
 * NOAA CO-OPS tide stations the coastal-tides layer can draw.
 *
 * Each station carries the two vertical offsets that turn a NOAA prediction
 * (metres above MLLW) into a WGS84 ellipsoid height, which is what both
 * Google Photorealistic 3D Tiles and the ellipsoidal terrain meshes use:
 *
 *   ellipsoid = tide(MLLW) + mllwAboveNavd88 + geoidN
 *
 * - `mllwAboveNavd88`: station datum sheet, MLLW minus NAVD88 (metres). For
 *   subordinate stations with no datum sheet (Santa Cruz) the reference
 *   station's sheet is used and `datumFrom` says which.
 * - `geoidN`: NGS GEOID18 geoid height at the station (metres, negative on the
 *   US West Coast). NAD83 vs WGS84 still leaves roughly a metre of slack,
 *   which the panel's calibration slider absorbs.
 *
 * `box` is the half-size, in degrees, of the water surface drawn around the
 * station. Keep it inside the stretch of coast the station actually
 * represents; tides change phase and range along a coastline.
 *
 * To add a station: look up its datum sheet
 * (https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/<id>/datums.json?units=metric)
 * and its geoid height (https://geodesy.noaa.gov/api/geoid/ght?lat=..&lon=..),
 * then append a row.
 */
export const TIDE_STATIONS = Object.freeze([
  Object.freeze({
    id: '9413745',
    name: 'Santa Cruz, Monterey Bay',
    lat: 36.9583,
    lon: -122.0173,
    mllwAboveNavd88: 0.043,
    datumFrom: 'Monterey 9413450',
    geoidN: -33.509,
    timeZone: 'America/Los_Angeles',
    box: Object.freeze({ lon: 0.12, lat: 0.06 }),
  }),
  Object.freeze({
    id: '9414290',
    name: 'San Francisco, Golden Gate',
    lat: 37.8063,
    lon: -122.4659,
    mllwAboveNavd88: 0.018,
    datumFrom: '9414290',
    geoidN: -32.555,
    timeZone: 'America/Los_Angeles',
    box: Object.freeze({ lon: 0.1, lat: 0.06 }),
  }),
  Object.freeze({
    id: '9410230',
    name: 'La Jolla, Scripps Pier',
    lat: 32.8669,
    lon: -117.2571,
    mllwAboveNavd88: -0.058,
    datumFrom: '9410230',
    geoidN: -35.026,
    timeZone: 'America/Los_Angeles',
    box: Object.freeze({ lon: 0.08, lat: 0.08 }),
  }),
]);

const RADIANS = Math.PI / 180;
const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in kilometres. */
export function distanceKm(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * RADIANS;
  const dLon = (bLon - aLon) * RADIANS;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * RADIANS) * Math.cos(bLat * RADIANS) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The station nearest a point, or null when none is within `maxKm`.
 * @returns {{station: object, km: number}|null}
 */
export function nearestTideStation(
  lat,
  lon,
  { stations = TIDE_STATIONS, maxKm = 150 } = {},
) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best = null;
  for (const station of stations) {
    const km = distanceKm(lat, lon, station.lat, station.lon);
    if (km <= maxKm && (!best || km < best.km)) best = { station, km };
  }
  return best;
}

export function findTideStation(id, stations = TIDE_STATIONS) {
  return stations.find((station) => station.id === id) ?? null;
}

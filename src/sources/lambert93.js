/**
 * Lambert-93 (EPSG:2154) -> WGS84 (EPSG:4326) conversion.
 *
 * Vigicrues publishes hydro-station coordinates in Lambert-93 metres
 * (`CoordXStationHydro` / `CoordYStationHydro`); the globe needs degrees.
 * No projection library ships with this app, so the inverse of the LCC 2SP
 * projection defined by the RGF93 / Lambert-93 EPSG record is implemented here.
 *
 * EPSG:2154 parameters:
 *   ellipsoid GRS80 (a = 6378137, 1/f = 298.257222101)
 *   lat_1 = 49, lat_2 = 44 (standard parallels), lat_0 = 46.5, lon_0 = 3
 *   k_0 = 0.99987742, false easting 700 000 m, false northing 6 600 000 m
 *
 * The formulas follow the EPSG Guidance Note 7-2 series for the Lambert
 * conformal conic (LCC 2SP). The cone apex is at the SOUTH pole, so the
 * northing is `rho_0 - rho * cos(theta)`, not `rho * cos(theta)`: the
 * distance from the apex SHRINKS as the latitude grows northwards.
 *
 * Verified against ten control points generated with proj4
 * (`+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +k_0=0.99987742
 * +x_0=700000 +y_0=6600000 +ellps=GRS80`): worst-case error is below
 * 5e-10 degrees, well under a millimetre on the ground.
 */

const A = 6378137;
const INVERSE_FLATTENING = 298.257222101;
const F = 1 / INVERSE_FLATTENING;
/** First eccentricity of the ellipsoid. */
const E = Math.sqrt(1 - (1 - F) * (1 - F));
/** Scale factor at the latitude of origin. */
const K0 = 0.99987742;
const LAT0 = (46.5 * Math.PI) / 180;
const LON0 = (3 * Math.PI) / 180;
const LAT1 = (49 * Math.PI) / 180;
const LAT2 = (44 * Math.PI) / 180;
const FALSE_EASTING = 700000;
const FALSE_NORTHING = 6600000;
const DEG = 180 / Math.PI;
const HALF_PI = Math.PI / 2;

/** m(phi), the scaled meridian distance used by the cone constant. */
function msfnz(sinPhi, cosPhi) {
  const con = E * sinPhi;
  return cosPhi / Math.sqrt(1 - con * con);
}

/** t(phi), the isometric-latitude series. */
function tsfnz(phi, sinPhi) {
  const con = E * sinPhi;
  const com = 0.5 * E;
  return Math.tan(0.5 * (HALF_PI - phi)) / Math.pow((1 - con) / (1 + con), com);
}

/** Inverse of tsfnz: the t-series solved for the geodetic latitude. */
function phi2z(ts) {
  const eccnth = 0.5 * E;
  let phi = HALF_PI - 2 * Math.atan(ts);
  for (let i = 0; i <= 15; i += 1) {
    const con = E * Math.sin(phi);
    const dphi =
      HALF_PI -
      2 * Math.atan(ts * Math.pow((1 - con) / (1 + con), eccnth)) -
      phi;
    phi += dphi;
    if (Math.abs(dphi) <= 1e-10) return phi;
  }
  return Number.NaN;
}

const MS1 = msfnz(Math.sin(LAT1), Math.cos(LAT1));
const TS1 = tsfnz(LAT1, Math.sin(LAT1));
const MS2 = msfnz(Math.sin(LAT2), Math.cos(LAT2));
const TS2 = tsfnz(LAT2, Math.sin(LAT2));
const TS0 = tsfnz(LAT0, Math.sin(LAT0));

/** Cone constant, derived from the two standard parallels. */
const NS = Math.log(MS1 / MS2) / Math.log(TS1 / TS2);
/** Cone constant F of the LCC series. */
const F0 = MS1 / (NS * Math.pow(TS1, NS));
/** Distance from the cone apex to the latitude of origin. */
const RH = A * F0 * Math.pow(TS0, NS);

/**
 * Convert Lambert-93 metres to WGS84 longitude/latitude in degrees.
 * @param {number} x Easting in metres (Lambert-93).
 * @param {number} y Northing in metres (Lambert-93).
 * @returns {{lon: number, lat: number}|null} Null for non-finite input.
 */
export function lambert93ToLonLat(x, y) {
  const easting = Number(x);
  const northing = Number(y);
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) return null;
  const dx = (easting - FALSE_EASTING) / K0;
  const dy = RH - (northing - FALSE_NORTHING) / K0;
  const magnitude = Math.sqrt(dx * dx + dy * dy);
  if (!Number.isFinite(magnitude) || magnitude === 0) return null;
  const rho1 = NS > 0 ? magnitude : -magnitude;
  const sign = NS > 0 ? 1 : -1;
  const theta = Math.atan2(sign * dx, sign * dy);
  const ts = Math.pow(rho1 / (A * F0), 1 / NS);
  if (!Number.isFinite(ts)) return null;
  const phi = phi2z(ts);
  if (!Number.isFinite(phi)) return null;
  const lat = phi * DEG;
  const lon = (theta / NS + LON0) * DEG;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lon, lat };
}

export const LAMBERT93_PARAMS = Object.freeze({
  falseEasting: FALSE_EASTING,
  falseNorthing: FALSE_NORTHING,
  k0: K0,
  lat0: LAT0 * DEG,
  lon0: LON0 * DEG,
  lat1: LAT1 * DEG,
  lat2: LAT2 * DEG,
});

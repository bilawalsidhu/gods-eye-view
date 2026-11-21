/**
 * IGRF main-field evaluation.
 *
 * Schmidt semi-normalised spherical harmonics to degree 13, from the vendored
 * IAGA table. No network: the coefficients are public-domain U.S. government
 * work and ship with the app, so the field is available before any feed is.
 *
 * This models the field produced INSIDE the Earth. It is accurate near the
 * surface and degrades with altitude as external magnetospheric currents come
 * to dominate — by a few Earth radii it is no longer the whole story. The
 * layer is explicit about where that boundary falls; see `docs/CURRENT-STATE`.
 *
 * @module layers/magnetosphere/field
 */
import table from '../../data/local_data/igrf/igrf-coefficients.json' with { type: 'json' };

/** IAGA reference radius for the spherical-harmonic expansion, in km. */
export const IGRF_REFERENCE_RADIUS_KM = 6371.2;

const N_MAX = table.nMax;

function emptyTriangle() {
  return Array.from({ length: N_MAX + 1 }, () => new Float64Array(N_MAX + 1));
}

const G = emptyTriangle();
const H = emptyTriangle();
const G_SV = emptyTriangle();
const H_SV = emptyTriangle();
for (const [cs, n, m, value, sv] of table.rows) {
  if (cs === 'g') {
    G[n][m] = value;
    G_SV[n][m] = sv;
  } else {
    H[n][m] = value;
    H_SV[n][m] = sv;
  }
}

/** The table's epoch and the last year its secular variation covers. */
export const IGRF_EPOCH = table.epoch;
export const IGRF_VALID_UNTIL = table.validUntil;
export const IGRF_RIGHTS = table.rights;

/**
 * Decimal year for a Date, e.g. 2026.75.
 *
 * Leap years matter here only in the fourth decimal place, but getting it
 * right costs one line and removes a question a reader would otherwise have.
 */
export function decimalYear(date = new Date()) {
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  return year + (date.getTime() - start) / (end - start);
}

/**
 * Coefficients extrapolated to `year` by secular variation.
 *
 * Past `validUntil` the extrapolation is no longer supported by IAGA. We keep
 * evaluating rather than failing — a slightly stale field is far better than a
 * blank globe — but the staleness is reported so the UI can say so.
 */
export function coefficientsFor(year) {
  const dt = year - IGRF_EPOCH;
  const g = emptyTriangle();
  const h = emptyTriangle();
  for (let n = 1; n <= N_MAX; n++) {
    for (let m = 0; m <= n; m++) {
      g[n][m] = G[n][m] + G_SV[n][m] * dt;
      h[n][m] = H[n][m] + H_SV[n][m] * dt;
    }
  }
  return { g, h, year, extrapolatedBeyondModel: year > IGRF_VALID_UNTIL };
}

/**
 * Field in local spherical components at a geocentric point.
 *
 * @param {object} coefficients From `coefficientsFor`.
 * @param {number} radiusKm Geocentric radius in km.
 * @param {number} colatitudeRad Angle from the north pole, 0..pi.
 * @param {number} longitudeRad East longitude in radians.
 * @returns {{br:number, btheta:number, bphi:number}} nT, geocentric spherical.
 */
export function fieldSpherical(
  coefficients,
  radiusKm,
  colatitudeRad,
  longitudeRad,
) {
  const { g, h } = coefficients;
  // The poles are a coordinate singularity for B_phi, not a physical one.
  // Nudge off the axis rather than dividing by a vanishing sine.
  const EPS = 1e-8;
  const theta = Math.min(Math.max(colatitudeRad, EPS), Math.PI - EPS);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const ratio = IGRF_REFERENCE_RADIUS_KM / radiusKm;

  // Schmidt semi-normalised associated Legendre values and their derivatives
  // with respect to theta, built by recursion in place.
  const p = emptyTriangle();
  const dp = emptyTriangle();
  p[0][0] = 1;
  dp[0][0] = 0;
  for (let n = 1; n <= N_MAX; n++) {
    for (let m = 0; m <= n; m++) {
      if (n === m) {
        // Schmidt semi-normalisation seeds the sectoral term at P(1,1) = sin,
        // and only applies sqrt((2n-1)/2n) from n = 2 upward. Applying it at
        // n = 1 as well leaves every sectoral term short by sqrt(2), which
        // reads as a plausible field that is wrong by ~10% at the equator.
        const k = n === 1 ? 1 : Math.sqrt(1 - 1 / (2 * n));
        p[n][n] = k * (s * p[n - 1][n - 1]);
        dp[n][n] = k * (s * dp[n - 1][n - 1] + c * p[n - 1][n - 1]);
      } else {
        const k1 = Math.sqrt(n * n - m * m);
        const k2 = n - 1 >= m ? Math.sqrt((n - 1) * (n - 1) - m * m) : 0;
        const prev2 = n - 2 >= m ? p[n - 2][m] : 0;
        const dprev2 = n - 2 >= m ? dp[n - 2][m] : 0;
        p[n][m] = ((2 * n - 1) * c * p[n - 1][m] - k2 * prev2) / k1;
        dp[n][m] =
          ((2 * n - 1) * (c * dp[n - 1][m] - s * p[n - 1][m]) - k2 * dprev2) /
          k1;
      }
    }
  }

  const cosM = new Float64Array(N_MAX + 1);
  const sinM = new Float64Array(N_MAX + 1);
  for (let m = 0; m <= N_MAX; m++) {
    cosM[m] = Math.cos(m * longitudeRad);
    sinM[m] = Math.sin(m * longitudeRad);
  }

  let br = 0;
  let btheta = 0;
  let bphi = 0;
  let rPow = ratio * ratio; // (a/r)^(n+2) with n starting at 1 -> start at ^2
  for (let n = 1; n <= N_MAX; n++) {
    rPow *= ratio; // now (a/r)^(n+2)
    let sumR = 0;
    let sumT = 0;
    let sumP = 0;
    for (let m = 0; m <= n; m++) {
      const gh = g[n][m] * cosM[m] + h[n][m] * sinM[m];
      const dgh = m * (-g[n][m] * sinM[m] + h[n][m] * cosM[m]);
      sumR += gh * p[n][m];
      sumT += gh * dp[n][m];
      sumP += dgh * p[n][m];
    }
    br += (n + 1) * rPow * sumR;
    btheta -= rPow * sumT;
    bphi -= rPow * sumP;
  }
  bphi /= s;
  return { br, btheta, bphi };
}

/**
 * Field as a geocentric Cartesian vector, in the same frame as the position.
 *
 * X through the prime meridian at the equator, Z through the north pole —
 * geocentric Earth-fixed, which is what the tracer and the renderer both want.
 *
 * @returns {{x:number,y:number,z:number}} nT.
 */
export function fieldCartesian(coefficients, position) {
  const { x, y, z } = position;
  const r = Math.hypot(x, y, z);
  if (!(r > 0)) throw new Error('field position must not be the geocentre');
  const theta = Math.acos(Math.min(1, Math.max(-1, z / r)));
  const phi = Math.atan2(y, x);
  const { br, btheta, bphi } = fieldSpherical(coefficients, r, theta, phi);
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  return {
    x: (br * st + btheta * ct) * cp - bphi * sp,
    y: (br * st + btheta * ct) * sp + bphi * cp,
    z: br * ct - btheta * st,
  };
}

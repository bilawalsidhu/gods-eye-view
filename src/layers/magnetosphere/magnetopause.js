/**
 * Shue et al. (1998) empirical magnetopause.
 *
 * The boundary where the solar wind's pressure balances Earth's field. It is
 * the part of this layer that actually moves: the field itself changes over
 * decades, but the boundary responds to the solar wind within minutes, and
 * compressing it is what a geomagnetic storm looks like from outside.
 *
 * Empirical, not first-principles — a fit to spacecraft crossings. It is the
 * standard closed form for this and is honest within its fitted range; well
 * outside that range it is an extrapolation and the layer says so.
 *
 * Reference: Shue, J.-H., et al. (1998), "Magnetopause location under extreme
 * solar wind conditions", J. Geophys. Res., 103(A8), 17691-17700.
 *
 * @module layers/magnetosphere/magnetopause
 */

/** Earth radii. Geosynchronous orbit sits at 6.6, which is why it matters. */
export const GEOSYNCHRONOUS_RE = 6.6;

/**
 * Solar wind dynamic pressure in nPa.
 *
 * P = rho * v^2 with proton mass folded into the constant, which is how the
 * Shue fit is parameterised.
 *
 * @param {number} densityPerCm3 Proton number density.
 * @param {number} speedKmPerS Bulk speed.
 */
export function dynamicPressureNPa(densityPerCm3, speedKmPerS) {
  if (!Number.isFinite(densityPerCm3) || !Number.isFinite(speedKmPerS))
    return null;
  if (densityPerCm3 <= 0 || speedKmPerS <= 0) return null;
  return 1.6726e-6 * densityPerCm3 * speedKmPerS * speedKmPerS;
}

/**
 * Subsolar standoff distance and flaring, in Earth radii.
 *
 * Bz enters through a tanh: southward IMF erodes the dayside boundary by
 * reconnection, and the effect saturates rather than growing without bound.
 */
export function shueParameters(dynamicPressure, bzNT) {
  if (!Number.isFinite(dynamicPressure) || dynamicPressure <= 0) return null;
  if (!Number.isFinite(bzNT)) return null;
  const r0 =
    (10.22 + 1.29 * Math.tanh(0.184 * (bzNT + 8.14))) *
    dynamicPressure ** (-1 / 6.6);
  const alpha = (0.58 - 0.007 * bzNT) * (1 + 0.024 * Math.log(dynamicPressure));
  return { r0, alpha };
}

/**
 * Boundary radius at an angle from the Sun-Earth line.
 *
 * theta = 0 points at the Sun. The form flares open down the tail and is only
 * meaningful ahead of the terminator region; past roughly 160 degrees it
 * diverges, which is physical — the tail does not close — but is not a surface
 * you can draw, so callers bound it.
 */
export function boundaryRadius({ r0, alpha }, thetaRad) {
  return r0 * (2 / (1 + Math.cos(thetaRad))) ** alpha;
}

/**
 * The fitted range of the published model. Outside it the form still evaluates
 * and still behaves sensibly, but it is extrapolation and should be labelled.
 */
export const SHUE_FITTED_RANGE = Object.freeze({
  dynamicPressureNPa: [0.5, 8.5],
  bzNT: [-18, 15],
});

export function withinFittedRange(dynamicPressure, bzNT) {
  const [pLo, pHi] = SHUE_FITTED_RANGE.dynamicPressureNPa;
  const [bLo, bHi] = SHUE_FITTED_RANGE.bzNT;
  return (
    dynamicPressure >= pLo &&
    dynamicPressure <= pHi &&
    bzNT >= bLo &&
    bzNT <= bHi
  );
}

/** Everything the client needs to draw and caption the boundary. */
export function describeMagnetopause(densityPerCm3, speedKmPerS, bzNT) {
  const dynamicPressure = dynamicPressureNPa(densityPerCm3, speedKmPerS);
  if (dynamicPressure === null) return null;
  const parameters = shueParameters(dynamicPressure, bzNT);
  if (!parameters) return null;
  return {
    dynamicPressureNPa: dynamicPressure,
    bzNT,
    standoffRe: parameters.r0,
    flaring: parameters.alpha,
    // Stated rather than left for the reader to work out: this is the whole
    // reason the boundary is worth watching.
    insideGeosynchronous: parameters.r0 < GEOSYNCHRONOUS_RE,
    extrapolatedBeyondFit: !withinFittedRange(dynamicPressure, bzNT),
  };
}

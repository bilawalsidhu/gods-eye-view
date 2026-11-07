/**
 * @module geo/geodesic
 * @description Surface distance along the WGS84 geodesic between two
 * points, by the default renderer's own method (`EllipsoidGeodesic`,
 * Vincenty's inverse formula): the same series in the same order, so the
 * distance agrees with the renderer's to floating-point noise. Angles in
 * radians, distances in metres.
 */
import { WGS84 } from './ellipsoid.js';

const MAJOR = WGS84.radii.x;
const MINOR = WGS84.radii.z;
const FLATTENING = (MAJOR - MINOR) / MAJOR;
const EPSILON12 = 1e-12;
/**
 * Vincenty converges in a handful of steps except between nearly antipodal
 * points, where it may not converge at all; stop there instead of hanging.
 */
const MAX_ITERATIONS = 200;

/** Vincenty's longitude correction, shared with the direct series. */
export function deltaLambda(
  sineAlpha,
  cosineSquaredAlpha,
  sigma,
  sineSigma,
  cosineSigma,
  cosineTwiceSigmaMidpoint,
) {
  const f = FLATTENING;
  const C =
    (f * cosineSquaredAlpha * (4.0 + f * (4.0 - 3.0 * cosineSquaredAlpha))) /
    16.0;
  return (
    (1.0 - C) *
    f *
    sineAlpha *
    (sigma +
      C *
        sineSigma *
        (cosineTwiceSigmaMidpoint +
          C *
            cosineSigma *
            (2.0 * cosineTwiceSigmaMidpoint * cosineTwiceSigmaMidpoint - 1.0)))
  );
}

/**
 * Vincenty's inverse: the geodesic from (lon1, lat1) to (lon2, lat2),
 * radians, as its length in metres, its start heading and its u².
 */
export function geodesicInverse(lon1, lat1, lon2, lat2) {
  const l = lon2 - lon1;
  const u1 = Math.atan((1 - FLATTENING) * Math.tan(lat1));
  const u2 = Math.atan((1 - FLATTENING) * Math.tan(lat2));
  const cosineU1 = Math.cos(u1);
  const sineU1 = Math.sin(u1);
  const cosineU2 = Math.cos(u2);
  const sineU2 = Math.sin(u2);
  const cc = cosineU1 * cosineU2;
  const cs = cosineU1 * sineU2;
  const ss = sineU1 * sineU2;
  const sc = sineU1 * cosineU2;

  let lambda = l;
  let lambdaDot;
  let cosineLambda;
  let sineLambda;
  let sigma;
  let cosineSigma;
  let sineSigma;
  let cosineSquaredAlpha;
  let cosineTwiceSigmaMidpoint;
  let iterations = 0;
  do {
    cosineLambda = Math.cos(lambda);
    sineLambda = Math.sin(lambda);
    const temp = cs - sc * cosineLambda;
    sineSigma = Math.sqrt(
      cosineU2 * cosineU2 * sineLambda * sineLambda + temp * temp,
    );
    cosineSigma = ss + cc * cosineLambda;
    sigma = Math.atan2(sineSigma, cosineSigma);
    let sineAlpha;
    if (sineSigma === 0.0) {
      sineAlpha = 0.0;
      cosineSquaredAlpha = 1.0;
    } else {
      sineAlpha = (cc * sineLambda) / sineSigma;
      cosineSquaredAlpha = 1.0 - sineAlpha * sineAlpha;
    }
    lambdaDot = lambda;
    cosineTwiceSigmaMidpoint = cosineSigma - (2.0 * ss) / cosineSquaredAlpha;
    if (!isFinite(cosineTwiceSigmaMidpoint)) cosineTwiceSigmaMidpoint = 0.0;
    lambda =
      l +
      deltaLambda(
        sineAlpha,
        cosineSquaredAlpha,
        sigma,
        sineSigma,
        cosineSigma,
        cosineTwiceSigmaMidpoint,
      );
  } while (
    Math.abs(lambda - lambdaDot) > EPSILON12 &&
    ++iterations < MAX_ITERATIONS
  );

  const uSquared =
    (cosineSquaredAlpha * (MAJOR * MAJOR - MINOR * MINOR)) / (MINOR * MINOR);
  const A =
    1.0 +
    (uSquared *
      (4096.0 + uSquared * (uSquared * (320.0 - 175.0 * uSquared) - 768.0))) /
      16384.0;
  const B =
    (uSquared *
      (256.0 + uSquared * (uSquared * (74.0 - 47.0 * uSquared) - 128.0))) /
    1024.0;
  const cosineSquaredTwiceSigmaMidpoint =
    cosineTwiceSigmaMidpoint * cosineTwiceSigmaMidpoint;
  const deltaSigma =
    B *
    sineSigma *
    (cosineTwiceSigmaMidpoint +
      (B *
        (cosineSigma * (2.0 * cosineSquaredTwiceSigmaMidpoint - 1.0) -
          (B *
            cosineTwiceSigmaMidpoint *
            (4.0 * sineSigma * sineSigma - 3.0) *
            (4.0 * cosineSquaredTwiceSigmaMidpoint - 3.0)) /
            6.0)) /
        4.0);
  return {
    distance: MINOR * A * (sigma - deltaSigma),
    startHeading: Math.atan2(cosineU2 * sineLambda, cs - sc * cosineLambda),
    uSquared,
  };
}

/**
 * Geodesic surface distance between two points; heights are ignored.
 * @param {{lon: number, lat: number}} start Radians.
 * @param {{lon: number, lat: number}} end Radians.
 * @returns {number} Metres.
 */
export function surfaceDistance(start, end) {
  return geodesicInverse(start.lon, start.lat, end.lon, end.lat).distance;
}

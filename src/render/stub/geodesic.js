/**
 * @module render/stub/geodesic
 * @description The point a fraction of the way along the WGS84 geodesic
 * between two places: Vincenty's inverse formula, then the series the
 * default renderer interpolates with, term for term, so a rectangle's
 * centre matches its to floating-point noise.
 */
import { TWO_PI, WGS84 } from './math.js';

const EPSILON12 = 1e-12;
const A = WGS84.radii.x;
const B = WGS84.radii.z;
const F = (A - B) / A;

function deltaLambda(sineAlpha, cos2Alpha, sigma, sinSigma, cosSigma, cos2Sm) {
  const C = (F * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha))) / 16;
  return (
    (1 - C) *
    F *
    sineAlpha *
    (sigma + C * sinSigma * (cos2Sm + C * cosSigma * (2 * cos2Sm * cos2Sm - 1)))
  );
}

/** Distance, start heading and u² of the geodesic from (lon1, lat1) to (lon2, lat2), radians. */
function inverse(lon1, lat1, lon2, lat2) {
  const l = lon2 - lon1;
  const u1 = Math.atan((1 - F) * Math.tan(lat1));
  const u2 = Math.atan((1 - F) * Math.tan(lat2));
  const cosU1 = Math.cos(u1);
  const sinU1 = Math.sin(u1);
  const cosU2 = Math.cos(u2);
  const sinU2 = Math.sin(u2);
  const cc = cosU1 * cosU2;
  const cs = cosU1 * sinU2;
  const ss = sinU1 * sinU2;
  const sc = sinU1 * cosU2;
  let lambda = l;
  let lambdaDot = TWO_PI;
  let cosLambda;
  let sinLambda;
  let sigma;
  let cosSigma;
  let sinSigma;
  let cos2Alpha;
  let cos2Sm;
  do {
    cosLambda = Math.cos(lambda);
    sinLambda = Math.sin(lambda);
    const temp = cs - sc * cosLambda;
    sinSigma = Math.sqrt(cosU2 * cosU2 * sinLambda * sinLambda + temp * temp);
    cosSigma = ss + cc * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    let sineAlpha;
    if (sinSigma === 0) {
      sineAlpha = 0;
      cos2Alpha = 1;
    } else {
      sineAlpha = (cc * sinLambda) / sinSigma;
      cos2Alpha = 1 - sineAlpha * sineAlpha;
    }
    lambdaDot = lambda;
    cos2Sm = cosSigma - (2 * ss) / cos2Alpha;
    if (!isFinite(cos2Sm)) cos2Sm = 0;
    lambda =
      l + deltaLambda(sineAlpha, cos2Alpha, sigma, sinSigma, cosSigma, cos2Sm);
  } while (Math.abs(lambda - lambdaDot) > EPSILON12);
  const uSquared = (cos2Alpha * (A * A - B * B)) / (B * B);
  const bigA =
    1 +
    (uSquared * (4096 + uSquared * (uSquared * (320 - 175 * uSquared) - 768))) /
      16384;
  const bigB =
    (uSquared * (256 + uSquared * (uSquared * (74 - 47 * uSquared) - 128))) /
    1024;
  const cos2Sm2 = cos2Sm * cos2Sm;
  const deltaSigma =
    bigB *
    sinSigma *
    (cos2Sm +
      (bigB *
        (cosSigma * (2 * cos2Sm2 - 1) -
          (bigB * cos2Sm * (4 * sinSigma * sinSigma - 3) * (4 * cos2Sm2 - 3)) /
            6)) /
        4);
  return {
    distance: B * bigA * (sigma - deltaSigma),
    startHeading: Math.atan2(cosU2 * sinLambda, cs - sc * cosLambda),
    uSquared,
  };
}

/**
 * The longitude and latitude (radians) `fraction` of the way along the
 * geodesic from (lon1, lat1) to (lon2, lat2).
 */
export function geodesicAt(lon1, lat1, lon2, lat2, fraction) {
  const { distance, startHeading, uSquared } = inverse(lon1, lat1, lon2, lat2);
  const cosH = Math.cos(startHeading);
  const sinH = Math.sin(startHeading);
  const tanU = (1 - F) * Math.tan(lat1);
  const cosU = 1 / Math.sqrt(1 + tanU * tanU);
  const sinU = cosU * tanU;
  const sigma1 = Math.atan2(tanU, cosH);
  const sineAlpha = cosU * sinH;
  const cos2Alpha = 1 - sineAlpha * sineAlpha;
  const cosAlpha = Math.sqrt(cos2Alpha);
  const u2 = uSquared / 4;
  const u4 = u2 * u2;
  const u6 = u4 * u2;
  const u8 = u4 * u4;
  const a0 = 1 + u2 - (3 * u4) / 4 + (5 * u6) / 4 - (175 * u8) / 64;
  const a1 = 1 - u2 + (15 * u4) / 8 - (35 * u6) / 8;
  const a2 = 1 - 3 * u2 + (35 * u4) / 4;
  const a3 = 1 - 5 * u2;
  const distanceRatio =
    a0 * sigma1 -
    (a1 * Math.sin(2 * sigma1) * u2) / 2 -
    (a2 * Math.sin(4 * sigma1) * u4) / 16 -
    (a3 * Math.sin(6 * sigma1) * u6) / 48 -
    (Math.sin(8 * sigma1) * 5 * u8) / 512;

  const s = distanceRatio + (distance * fraction) / B;
  const cos2S = Math.cos(2 * s);
  const cos4S = Math.cos(4 * s);
  const cos6S = Math.cos(6 * s);
  const sin2S = Math.sin(2 * s);
  const sin4S = Math.sin(4 * s);
  const sin6S = Math.sin(6 * s);
  const sin8S = Math.sin(8 * s);
  const s2 = s * s;
  const s3 = s * s2;
  let sigma =
    (2 * s3 * u8 * cos2S) / 3 +
    s *
      (1 -
        u2 +
        (7 * u4) / 4 -
        (15 * u6) / 4 +
        (579 * u8) / 64 -
        (u4 - (15 * u6) / 4 + (187 * u8) / 16) * cos2S -
        ((5 * u6) / 4 - (115 * u8) / 16) * cos4S -
        (29 * u8 * cos6S) / 16) +
    (u2 / 2 - u4 + (71 * u6) / 32 - (85 * u8) / 16) * sin2S +
    ((5 * u4) / 16 - (5 * u6) / 4 + (383 * u8) / 96) * sin4S -
    s2 * ((u6 - (11 * u8) / 2) * sin2S + (5 * u8 * sin4S) / 2) +
    ((29 * u6) / 96 - (29 * u8) / 16) * sin6S +
    (539 * u8 * sin8S) / 1536;

  const theta = Math.asin(Math.sin(sigma) * cosAlpha);
  const lat = Math.atan((A / B) * Math.tan(theta));
  sigma -= sigma1;
  const cos2Sm = Math.cos(2 * sigma1 + sigma);
  const sinSigma = Math.sin(sigma);
  const cosSigma = Math.cos(sigma);
  const lambda = Math.atan2(
    sinSigma * sinH,
    cosU * cosSigma - sinU * sinSigma * cosH,
  );
  const l =
    lambda -
    deltaLambda(sineAlpha, cos2Alpha, sigma, sinSigma, cosSigma, cos2Sm);
  return { lon: lon1 + l, lat };
}

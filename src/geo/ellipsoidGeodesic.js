// Ported from CesiumJS 1.138 (Apache-2.0) — EllipsoidGeodesic.js.
// Vincenty inverse and surface interpolation, preserving operation order.
import * as Cartographic from './cartographic.js';
import * as Ellipsoid from './ellipsoid.js';
import * as CesiumMath from './math.js';
const defined = (value) => value !== null && value !== undefined;
function setConstants(ellipsoidGeodesic) {
  const uSquared = ellipsoidGeodesic._uSquared;
  const a = ellipsoidGeodesic._ellipsoid.maximumRadius;
  const b = ellipsoidGeodesic._ellipsoid.minimumRadius;
  const f = (a - b) / a;

  const cosineHeading = Math.cos(ellipsoidGeodesic._startHeading);
  const sineHeading = Math.sin(ellipsoidGeodesic._startHeading);

  const tanU = (1 - f) * Math.tan(ellipsoidGeodesic._start.latitude);

  const cosineU = 1.0 / Math.sqrt(1.0 + tanU * tanU);
  const sineU = cosineU * tanU;

  const sigma = Math.atan2(tanU, cosineHeading);

  const sineAlpha = cosineU * sineHeading;
  const sineSquaredAlpha = sineAlpha * sineAlpha;

  const cosineSquaredAlpha = 1.0 - sineSquaredAlpha;
  const cosineAlpha = Math.sqrt(cosineSquaredAlpha);

  const u2Over4 = uSquared / 4.0;
  const u4Over16 = u2Over4 * u2Over4;
  const u6Over64 = u4Over16 * u2Over4;
  const u8Over256 = u4Over16 * u4Over16;

  const a0 =
    1.0 +
    u2Over4 -
    (3.0 * u4Over16) / 4.0 +
    (5.0 * u6Over64) / 4.0 -
    (175.0 * u8Over256) / 64.0;
  const a1 = 1.0 - u2Over4 + (15.0 * u4Over16) / 8.0 - (35.0 * u6Over64) / 8.0;
  const a2 = 1.0 - 3.0 * u2Over4 + (35.0 * u4Over16) / 4.0;
  const a3 = 1.0 - 5.0 * u2Over4;

  const distanceRatio =
    a0 * sigma -
    (a1 * Math.sin(2.0 * sigma) * u2Over4) / 2.0 -
    (a2 * Math.sin(4.0 * sigma) * u4Over16) / 16.0 -
    (a3 * Math.sin(6.0 * sigma) * u6Over64) / 48.0 -
    (Math.sin(8.0 * sigma) * 5.0 * u8Over256) / 512;

  const constants = ellipsoidGeodesic._constants;

  constants.a = a;
  constants.b = b;
  constants.f = f;
  constants.cosineHeading = cosineHeading;
  constants.sineHeading = sineHeading;
  constants.tanU = tanU;
  constants.cosineU = cosineU;
  constants.sineU = sineU;
  constants.sigma = sigma;
  constants.sineAlpha = sineAlpha;
  constants.sineSquaredAlpha = sineSquaredAlpha;
  constants.cosineSquaredAlpha = cosineSquaredAlpha;
  constants.cosineAlpha = cosineAlpha;
  constants.u2Over4 = u2Over4;
  constants.u4Over16 = u4Over16;
  constants.u6Over64 = u6Over64;
  constants.u8Over256 = u8Over256;
  constants.a0 = a0;
  constants.a1 = a1;
  constants.a2 = a2;
  constants.a3 = a3;
  constants.distanceRatio = distanceRatio;
}

function computeC(f, cosineSquaredAlpha) {
  return (
    (f * cosineSquaredAlpha * (4.0 + f * (4.0 - 3.0 * cosineSquaredAlpha))) /
    16.0
  );
}

function computeDeltaLambda(
  f,
  sineAlpha,
  cosineSquaredAlpha,
  sigma,
  sineSigma,
  cosineSigma,
  cosineTwiceSigmaMidpoint,
) {
  const C = computeC(f, cosineSquaredAlpha);

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

function vincentyInverseFormula(
  ellipsoidGeodesic,
  major,
  minor,
  firstLongitude,
  firstLatitude,
  secondLongitude,
  secondLatitude,
) {
  const eff = (major - minor) / major;
  const l = secondLongitude - firstLongitude;

  const u1 = Math.atan((1 - eff) * Math.tan(firstLatitude));
  const u2 = Math.atan((1 - eff) * Math.tan(secondLatitude));

  const cosineU1 = Math.cos(u1);
  const sineU1 = Math.sin(u1);
  const cosineU2 = Math.cos(u2);
  const sineU2 = Math.sin(u2);

  const cc = cosineU1 * cosineU2;
  const cs = cosineU1 * sineU2;
  const ss = sineU1 * sineU2;
  const sc = sineU1 * cosineU2;

  let lambda = l;
  let lambdaDot = CesiumMath.TWO_PI;

  let cosineLambda = Math.cos(lambda);
  let sineLambda = Math.sin(lambda);

  let sigma;
  let cosineSigma;
  let sineSigma;
  let cosineSquaredAlpha;
  let cosineTwiceSigmaMidpoint;

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

    if (!isFinite(cosineTwiceSigmaMidpoint)) {
      cosineTwiceSigmaMidpoint = 0.0;
    }

    lambda =
      l +
      computeDeltaLambda(
        eff,
        sineAlpha,
        cosineSquaredAlpha,
        sigma,
        sineSigma,
        cosineSigma,
        cosineTwiceSigmaMidpoint,
      );
  } while (Math.abs(lambda - lambdaDot) > CesiumMath.EPSILON12);

  const uSquared =
    (cosineSquaredAlpha * (major * major - minor * minor)) / (minor * minor);
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

  const distance = minor * A * (sigma - deltaSigma);

  const startHeading = Math.atan2(
    cosineU2 * sineLambda,
    cs - sc * cosineLambda,
  );
  const endHeading = Math.atan2(cosineU1 * sineLambda, cs * cosineLambda - sc);

  ellipsoidGeodesic._distance = distance;
  ellipsoidGeodesic._startHeading = startHeading;
  ellipsoidGeodesic._endHeading = endHeading;
  ellipsoidGeodesic._uSquared = uSquared;
}

function computeProperties(ellipsoidGeodesic, start, end, ellipsoid) {
  vincentyInverseFormula(
    ellipsoidGeodesic,
    ellipsoid.maximumRadius,
    ellipsoid.minimumRadius,
    start.longitude,
    start.latitude,
    end.longitude,
    end.latitude,
  );

  ellipsoidGeodesic._start = Cartographic.clone(
    start,
    ellipsoidGeodesic._start,
  );
  ellipsoidGeodesic._end = Cartographic.clone(end, ellipsoidGeodesic._end);
  ellipsoidGeodesic._start.height = 0;
  ellipsoidGeodesic._end.height = 0;

  setConstants(ellipsoidGeodesic);
}

/**
 * Initializes a geodesic on the ellipsoid connecting the two provided planetodetic points.
 *
 * @alias EllipsoidGeodesic
 * @constructor
 *
 * @param {Cartographic} [start] The initial planetodetic point on the path.
 * @param {Cartographic} [end] The final planetodetic point on the path.
 * @param {Ellipsoid} [ellipsoid=Ellipsoid.WGS84] The ellipsoid on which the geodesic lies.
 */
function EllipsoidGeodesic(start, end, ellipsoid) {
  const e = ellipsoid ?? Ellipsoid.WGS84;
  this._ellipsoid = e;
  this._start = Cartographic.create();
  this._end = Cartographic.create();

  this._constants = {};
  this._startHeading = undefined;
  this._endHeading = undefined;
  this._distance = undefined;
  this._uSquared = undefined;

  if (defined(start) && defined(end)) {
    computeProperties(this, start, end, e);
  }
}

Object.defineProperties(EllipsoidGeodesic.prototype, {
  /**
   * Gets the ellipsoid.
   * @memberof EllipsoidGeodesic.prototype
   * @type {Ellipsoid}
   * @readonly
   */
  ellipsoid: {
    get: function () {
      return this._ellipsoid;
    },
  },

  /**
   * Gets the surface distance between the start and end point
   * @memberof EllipsoidGeodesic.prototype
   * @type {number}
   * @readonly
   */
  surfaceDistance: {
    get: function () {
      return this._distance;
    },
  },

  /**
   * Gets the initial planetodetic point on the path.
   * @memberof EllipsoidGeodesic.prototype
   * @type {Cartographic}
   * @readonly
   */
  start: {
    get: function () {
      return this._start;
    },
  },

  /**
   * Gets the final planetodetic point on the path.
   * @memberof EllipsoidGeodesic.prototype
   * @type {Cartographic}
   * @readonly
   */
  end: {
    get: function () {
      return this._end;
    },
  },

  /**
   * Gets the heading at the initial point.
   * @memberof EllipsoidGeodesic.prototype
   * @type {number}
   * @readonly
   */
  startHeading: {
    get: function () {
      return this._startHeading;
    },
  },

  /**
   * Gets the heading at the final point.
   * @memberof EllipsoidGeodesic.prototype
   * @type {number}
   * @readonly
   */
  endHeading: {
    get: function () {
      return this._endHeading;
    },
  },
});

/**
 * Sets the start and end points of the geodesic
 *
 * @param {Cartographic} start The initial planetodetic point on the path.
 * @param {Cartographic} end The final planetodetic point on the path.
 */
EllipsoidGeodesic.prototype.setEndPoints = function (start, end) {
  computeProperties(this, start, end, this._ellipsoid);
};

/**
 * Provides the location of a point at the indicated portion along the geodesic.
 *
 * @param {number} fraction The portion of the distance between the initial and final points.
 * @param {Cartographic} [result] The object in which to store the result.
 * @returns {Cartographic} The location of the point along the geodesic.
 */
EllipsoidGeodesic.prototype.interpolateUsingFraction = function (
  fraction,
  result,
) {
  return this.interpolateUsingSurfaceDistance(
    this._distance * fraction,
    result,
  );
};

/**
 * Provides the location of a point at the indicated distance along the geodesic.
 *
 * @param {number} distance The distance from the initial point to the point of interest along the geodesic
 * @param {Cartographic} [result] The object in which to store the result.
 * @returns {Cartographic} The location of the point along the geodesic.
 */
EllipsoidGeodesic.prototype.interpolateUsingSurfaceDistance = function (
  distance,
  result,
) {
  const constants = this._constants;

  const s = constants.distanceRatio + distance / constants.b;

  const cosine2S = Math.cos(2.0 * s);
  const cosine4S = Math.cos(4.0 * s);
  const cosine6S = Math.cos(6.0 * s);
  const sine2S = Math.sin(2.0 * s);
  const sine4S = Math.sin(4.0 * s);
  const sine6S = Math.sin(6.0 * s);
  const sine8S = Math.sin(8.0 * s);

  const s2 = s * s;
  const s3 = s * s2;

  const u8Over256 = constants.u8Over256;
  const u2Over4 = constants.u2Over4;
  const u6Over64 = constants.u6Over64;
  const u4Over16 = constants.u4Over16;
  let sigma =
    (2.0 * s3 * u8Over256 * cosine2S) / 3.0 +
    s *
      (1.0 -
        u2Over4 +
        (7.0 * u4Over16) / 4.0 -
        (15.0 * u6Over64) / 4.0 +
        (579.0 * u8Over256) / 64.0 -
        (u4Over16 - (15.0 * u6Over64) / 4.0 + (187.0 * u8Over256) / 16.0) *
          cosine2S -
        ((5.0 * u6Over64) / 4.0 - (115.0 * u8Over256) / 16.0) * cosine4S -
        (29.0 * u8Over256 * cosine6S) / 16.0) +
    (u2Over4 / 2.0 -
      u4Over16 +
      (71.0 * u6Over64) / 32.0 -
      (85.0 * u8Over256) / 16.0) *
      sine2S +
    ((5.0 * u4Over16) / 16.0 -
      (5.0 * u6Over64) / 4.0 +
      (383.0 * u8Over256) / 96.0) *
      sine4S -
    s2 *
      ((u6Over64 - (11.0 * u8Over256) / 2.0) * sine2S +
        (5.0 * u8Over256 * sine4S) / 2.0) +
    ((29.0 * u6Over64) / 96.0 - (29.0 * u8Over256) / 16.0) * sine6S +
    (539.0 * u8Over256 * sine8S) / 1536.0;

  const theta = Math.asin(Math.sin(sigma) * constants.cosineAlpha);
  const latitude = Math.atan((constants.a / constants.b) * Math.tan(theta));

  // Redefine in terms of relative argument of latitude.
  sigma = sigma - constants.sigma;

  const cosineTwiceSigmaMidpoint = Math.cos(2.0 * constants.sigma + sigma);

  const sineSigma = Math.sin(sigma);
  const cosineSigma = Math.cos(sigma);

  const cc = constants.cosineU * cosineSigma;
  const ss = constants.sineU * sineSigma;

  const lambda = Math.atan2(
    sineSigma * constants.sineHeading,
    cc - ss * constants.cosineHeading,
  );

  const l =
    lambda -
    computeDeltaLambda(
      constants.f,
      constants.sineAlpha,
      constants.cosineSquaredAlpha,
      sigma,
      sineSigma,
      cosineSigma,
      cosineTwiceSigmaMidpoint,
    );

  if (defined(result)) {
    result.longitude = this._start.longitude + l;
    result.latitude = latitude;
    result.height = 0.0;
    return result;
  }

  return Cartographic.create(this._start.longitude + l, latitude, 0.0);
};
export function create(start, end, ellipsoid) {
  return new EllipsoidGeodesic(start, end, ellipsoid);
}

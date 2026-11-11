// Ported from CesiumJS 1.138 (Apache-2.0) — Simon1994PlanetaryPositions.js
//
// The Sun's and the Moon's positions in the Earth-centred inertial frame
// (Simon et al. 1994), for the celestial ring on a page without the Cesium
// SDK. The operation order matches Cesium so the outputs are bit-identical;
// Cesium's debug range checks are left out (its inputs are its own orbit
// constants). Dates are geo/julianDate.js values.

import * as Cartesian3 from './cartesian3.js';
import * as Matrix3 from './matrix3.js';
import * as CesiumMath from './math.js';
import * as JulianDate from './julianDate.js';

const SECONDS_PER_DAY = 86400.0;
const DAYS_PER_JULIAN_CENTURY = 36525.0;
const RADIANS_PER_ARCSECOND = CesiumMath.RADIANS_PER_DEGREE / 3600.0;

/** Cesium's `new Matrix3(...)`: row-major arguments, column-major storage. */
function rowMajor(c0r0, c1r0, c2r0, c0r1, c1r1, c2r1, c0r2, c1r2, c2r2) {
  return [c0r0, c0r1, c0r2, c1r0, c1r1, c1r2, c2r0, c2r1, c2r2];
}

function computeTdbMinusTtSpice(daysSinceJ2000InTerrestrialTime) {
  /* STK Comments ------------------------------------------------------
   * This function uses constants designed to be consistent with
   * the SPICE Toolkit from JPL version N0051 (unitim.c)
   * M0 = 6.239996
   * M0Dot = 1.99096871e-7 rad/s = 0.01720197 rad/d
   * EARTH_ECC = 1.671e-2
   * TDB_AMPL = 1.657e-3 secs
   *--------------------------------------------------------------------*/

  //* Values taken as specified in STK Comments except: 0.01720197 rad/day = 1.99096871e-7 rad/sec
  //* Here we use the more precise value taken from the SPICE value 1.99096871e-7 rad/sec converted to rad/day
  //* All other constants are consistent with the SPICE implementation of the TDB conversion
  //* except where we treat the independent time parameter to be in TT instead of TDB.
  //* This is an approximation made to facilitate performance due to the higher prevalance of
  //* the TT2TDB conversion over TDB2TT in order to avoid having to iterate when converting to TDB for the JPL ephemeris.
  //* Days are used instead of seconds to provide a slight improvement in numerical precision.

  //* For more information see:
  //* http://www.cv.nrao.edu/~rfisher/Ephemerides/times.html#TDB
  //* ftp://ssd.jpl.nasa.gov/pub/eph/planets/ioms/ExplSupplChap8.pdf

  const g = 6.239996 + 0.0172019696544 * daysSinceJ2000InTerrestrialTime;
  return 1.657e-3 * Math.sin(g + 1.671e-2 * Math.sin(g));
}

const TdtMinusTai = 32.184;
const J2000d = 2451545;
function taiToTdb(date, result) {
  //Converts TAI to TT
  result = JulianDate.addSeconds(date, TdtMinusTai, result);

  //Converts TT to TDB
  const days = JulianDate.totalDays(result) - J2000d;
  result = JulianDate.addSeconds(result, computeTdbMinusTtSpice(days), result);

  return result;
}

const epoch = JulianDate.fromTai(2451545, 0); //Actually TDB (not TAI)
const MetersPerKilometer = 1000.0;
const RadiansPerDegree = CesiumMath.RADIANS_PER_DEGREE;
const RadiansPerArcSecond = RADIANS_PER_ARCSECOND;
const MetersPerAstronomicalUnit = 1.4959787e11; // IAU 1976 value

const perifocalToEquatorial = Matrix3.create();
function elementsToCartesian(
  semimajorAxis,
  eccentricity,
  inclination,
  longitudeOfPerigee,
  longitudeOfNode,
  meanLongitude,
  result,
) {
  if (inclination < 0.0) {
    inclination = -inclination;
    longitudeOfNode += Math.PI;
  }

  const radiusOfPeriapsis = semimajorAxis * (1.0 - eccentricity);
  const argumentOfPeriapsis = longitudeOfPerigee - longitudeOfNode;
  const rightAscensionOfAscendingNode = longitudeOfNode;
  const trueAnomaly = meanAnomalyToTrueAnomaly(
    meanLongitude - longitudeOfPerigee,
    eccentricity,
  );
  const type = chooseOrbit(eccentricity, 0.0);

  perifocalToCartesianMatrix(
    argumentOfPeriapsis,
    inclination,
    rightAscensionOfAscendingNode,
    perifocalToEquatorial,
  );
  const semilatus = radiusOfPeriapsis * (1.0 + eccentricity);
  const costheta = Math.cos(trueAnomaly);
  const sintheta = Math.sin(trueAnomaly);

  const denom = 1.0 + eccentricity * costheta;

  const radius = semilatus / denom;
  if (result == null) {
    result = Cartesian3.create(radius * costheta, radius * sintheta, 0.0);
  } else {
    result.x = radius * costheta;
    result.y = radius * sintheta;
    result.z = 0.0;
  }

  return Matrix3.multiplyByVector(perifocalToEquatorial, result, result);
}

function chooseOrbit(eccentricity, tolerance) {
  if (eccentricity <= tolerance) {
    return 'Circular';
  } else if (eccentricity < 1.0 - tolerance) {
    return 'Elliptical';
  } else if (eccentricity <= 1.0 + tolerance) {
    return 'Parabolic';
  }
  return 'Hyperbolic';
}

// Calculates the true anomaly given the mean anomaly and the eccentricity.
function meanAnomalyToTrueAnomaly(meanAnomaly, eccentricity) {
  const eccentricAnomaly = meanAnomalyToEccentricAnomaly(
    meanAnomaly,
    eccentricity,
  );
  return eccentricAnomalyToTrueAnomaly(eccentricAnomaly, eccentricity);
}

const maxIterationCount = 50;
const keplerEqConvergence = 1.0e-8;
// Calculates the eccentric anomaly given the mean anomaly and the eccentricity.
function meanAnomalyToEccentricAnomaly(meanAnomaly, eccentricity) {
  const revs = Math.floor(meanAnomaly / CesiumMath.TWO_PI);

  // Find angle in current revolution
  meanAnomaly -= revs * CesiumMath.TWO_PI;

  // calculate starting value for iteration sequence
  let iterationValue =
    meanAnomaly +
    (eccentricity * Math.sin(meanAnomaly)) /
      (1.0 - Math.sin(meanAnomaly + eccentricity) + Math.sin(meanAnomaly));

  // Perform Newton-Raphson iteration on Kepler's equation
  let eccentricAnomaly = Number.MAX_VALUE;

  let count;
  for (
    count = 0;
    count < maxIterationCount &&
    Math.abs(eccentricAnomaly - iterationValue) > keplerEqConvergence;
    ++count
  ) {
    eccentricAnomaly = iterationValue;
    const NRfunction =
      eccentricAnomaly -
      eccentricity * Math.sin(eccentricAnomaly) -
      meanAnomaly;
    const dNRfunction = 1 - eccentricity * Math.cos(eccentricAnomaly);
    iterationValue = eccentricAnomaly - NRfunction / dNRfunction;
  }

  eccentricAnomaly = iterationValue + revs * CesiumMath.TWO_PI;
  return eccentricAnomaly;
}

// Calculates the true anomaly given the eccentric anomaly and the eccentricity.
function eccentricAnomalyToTrueAnomaly(eccentricAnomaly, eccentricity) {
  // Calculate the number of previous revolutions
  const revs = Math.floor(eccentricAnomaly / CesiumMath.TWO_PI);

  // Find angle in current revolution
  eccentricAnomaly -= revs * CesiumMath.TWO_PI;

  // Calculate true anomaly from eccentric anomaly
  const trueAnomalyX = Math.cos(eccentricAnomaly) - eccentricity;
  const trueAnomalyY =
    Math.sin(eccentricAnomaly) * Math.sqrt(1 - eccentricity * eccentricity);

  let trueAnomaly = Math.atan2(trueAnomalyY, trueAnomalyX);

  // Ensure the correct quadrant
  trueAnomaly = CesiumMath.zeroToTwoPi(trueAnomaly);
  if (eccentricAnomaly < 0) {
    trueAnomaly -= CesiumMath.TWO_PI;
  }

  // Add on previous revolutions
  trueAnomaly += revs * CesiumMath.TWO_PI;

  return trueAnomaly;
}

// Calculates the transformation matrix to convert from the perifocal (PQW) coordinate
// system to inertial cartesian coordinates.
function perifocalToCartesianMatrix(
  argumentOfPeriapsis,
  inclination,
  rightAscension,
  result,
) {
  const cosap = Math.cos(argumentOfPeriapsis);
  const sinap = Math.sin(argumentOfPeriapsis);

  const cosi = Math.cos(inclination);
  const sini = Math.sin(inclination);

  const cosraan = Math.cos(rightAscension);
  const sinraan = Math.sin(rightAscension);
  if (result == null) {
    result = rowMajor(
      cosraan * cosap - sinraan * sinap * cosi,
      -cosraan * sinap - sinraan * cosap * cosi,
      sinraan * sini,

      sinraan * cosap + cosraan * sinap * cosi,
      -sinraan * sinap + cosraan * cosap * cosi,
      -cosraan * sini,

      sinap * sini,
      cosap * sini,
      cosi,
    );
  } else {
    result[0] = cosraan * cosap - sinraan * sinap * cosi;
    result[1] = sinraan * cosap + cosraan * sinap * cosi;
    result[2] = sinap * sini;
    result[3] = -cosraan * sinap - sinraan * cosap * cosi;
    result[4] = -sinraan * sinap + cosraan * cosap * cosi;
    result[5] = cosap * sini;
    result[6] = sinraan * sini;
    result[7] = -cosraan * sini;
    result[8] = cosi;
  }
  return result;
}

// From section 5.8
const semiMajorAxis0 = 1.0000010178 * MetersPerAstronomicalUnit;
const meanLongitude0 = 100.46645683 * RadiansPerDegree;
const meanLongitude1 = 1295977422.83429 * RadiansPerArcSecond;

// From table 6
const p1u = 16002;
const p2u = 21863;
const p3u = 32004;
const p4u = 10931;
const p5u = 14529;
const p6u = 16368;
const p7u = 15318;
const p8u = 32794;

const Ca1 = 64 * 1e-7 * MetersPerAstronomicalUnit;
const Ca2 = -152 * 1e-7 * MetersPerAstronomicalUnit;
const Ca3 = 62 * 1e-7 * MetersPerAstronomicalUnit;
const Ca4 = -8 * 1e-7 * MetersPerAstronomicalUnit;
const Ca5 = 32 * 1e-7 * MetersPerAstronomicalUnit;
const Ca6 = -41 * 1e-7 * MetersPerAstronomicalUnit;
const Ca7 = 19 * 1e-7 * MetersPerAstronomicalUnit;
const Ca8 = -11 * 1e-7 * MetersPerAstronomicalUnit;

const Sa1 = -150 * 1e-7 * MetersPerAstronomicalUnit;
const Sa2 = -46 * 1e-7 * MetersPerAstronomicalUnit;
const Sa3 = 68 * 1e-7 * MetersPerAstronomicalUnit;
const Sa4 = 54 * 1e-7 * MetersPerAstronomicalUnit;
const Sa5 = 14 * 1e-7 * MetersPerAstronomicalUnit;
const Sa6 = 24 * 1e-7 * MetersPerAstronomicalUnit;
const Sa7 = -28 * 1e-7 * MetersPerAstronomicalUnit;
const Sa8 = 22 * 1e-7 * MetersPerAstronomicalUnit;

const q1u = 10;
const q2u = 16002;
const q3u = 21863;
const q4u = 10931;
const q5u = 1473;
const q6u = 32004;
const q7u = 4387;
const q8u = 73;

const Cl1 = -325 * 1e-7;
const Cl2 = -322 * 1e-7;
const Cl3 = -79 * 1e-7;
const Cl4 = 232 * 1e-7;
const Cl5 = -52 * 1e-7;
const Cl6 = 97 * 1e-7;
const Cl7 = 55 * 1e-7;
const Cl8 = -41 * 1e-7;

const Sl1 = -105 * 1e-7;
const Sl2 = -137 * 1e-7;
const Sl3 = 258 * 1e-7;
const Sl4 = 35 * 1e-7;
const Sl5 = -116 * 1e-7;
const Sl6 = -88 * 1e-7;
const Sl7 = -112 * 1e-7;
const Sl8 = -80 * 1e-7;

const scratchDate = JulianDate.fromTai(0, 0.0);
// Gets a point describing the motion of the Earth-Moon barycenter according to the equations described in section 6.
function computeSimonEarthMoonBarycenter(date, result) {
  // t is thousands of years from J2000 TDB
  taiToTdb(date, scratchDate);
  const x =
    scratchDate.dayNumber -
    epoch.dayNumber +
    (scratchDate.secondsOfDay - epoch.secondsOfDay) / SECONDS_PER_DAY;
  const t = x / (DAYS_PER_JULIAN_CENTURY * 10.0);

  const u = 0.3595362 * t;
  const semimajorAxis =
    semiMajorAxis0 +
    Ca1 * Math.cos(p1u * u) +
    Sa1 * Math.sin(p1u * u) +
    Ca2 * Math.cos(p2u * u) +
    Sa2 * Math.sin(p2u * u) +
    Ca3 * Math.cos(p3u * u) +
    Sa3 * Math.sin(p3u * u) +
    Ca4 * Math.cos(p4u * u) +
    Sa4 * Math.sin(p4u * u) +
    Ca5 * Math.cos(p5u * u) +
    Sa5 * Math.sin(p5u * u) +
    Ca6 * Math.cos(p6u * u) +
    Sa6 * Math.sin(p6u * u) +
    Ca7 * Math.cos(p7u * u) +
    Sa7 * Math.sin(p7u * u) +
    Ca8 * Math.cos(p8u * u) +
    Sa8 * Math.sin(p8u * u);
  const meanLongitude =
    meanLongitude0 +
    meanLongitude1 * t +
    Cl1 * Math.cos(q1u * u) +
    Sl1 * Math.sin(q1u * u) +
    Cl2 * Math.cos(q2u * u) +
    Sl2 * Math.sin(q2u * u) +
    Cl3 * Math.cos(q3u * u) +
    Sl3 * Math.sin(q3u * u) +
    Cl4 * Math.cos(q4u * u) +
    Sl4 * Math.sin(q4u * u) +
    Cl5 * Math.cos(q5u * u) +
    Sl5 * Math.sin(q5u * u) +
    Cl6 * Math.cos(q6u * u) +
    Sl6 * Math.sin(q6u * u) +
    Cl7 * Math.cos(q7u * u) +
    Sl7 * Math.sin(q7u * u) +
    Cl8 * Math.cos(q8u * u) +
    Sl8 * Math.sin(q8u * u);

  // All constants in this part are from section 5.8
  const eccentricity = 0.0167086342 - 0.0004203654 * t;
  const longitudeOfPerigee =
    102.93734808 * RadiansPerDegree + 11612.3529 * RadiansPerArcSecond * t;
  const inclination = 469.97289 * RadiansPerArcSecond * t;
  const longitudeOfNode =
    174.87317577 * RadiansPerDegree - 8679.27034 * RadiansPerArcSecond * t;

  return elementsToCartesian(
    semimajorAxis,
    eccentricity,
    inclination,
    longitudeOfPerigee,
    longitudeOfNode,
    meanLongitude,
    result,
  );
}

// Gets a point describing the position of the moon according to the equations described in section 4.
function computeSimonMoon(date, result) {
  taiToTdb(date, scratchDate);
  const x =
    scratchDate.dayNumber -
    epoch.dayNumber +
    (scratchDate.secondsOfDay - epoch.secondsOfDay) / SECONDS_PER_DAY;
  const t = x / DAYS_PER_JULIAN_CENTURY;
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;

  // Terms from section 3.4 (b.1)
  let semimajorAxis = 383397.7725 + 0.004 * t;
  let eccentricity = 0.055545526 - 0.000000016 * t;
  const inclinationConstant = 5.15668983 * RadiansPerDegree;
  let inclinationSecPart =
    -0.00008 * t + 0.02966 * t2 - 0.000042 * t3 - 0.00000013 * t4;
  const longitudeOfPerigeeConstant = 83.35324312 * RadiansPerDegree;
  let longitudeOfPerigeeSecPart =
    14643420.2669 * t - 38.2702 * t2 - 0.045047 * t3 + 0.00021301 * t4;
  const longitudeOfNodeConstant = 125.04455501 * RadiansPerDegree;
  let longitudeOfNodeSecPart =
    -6967919.3631 * t + 6.3602 * t2 + 0.007625 * t3 - 0.00003586 * t4;
  const meanLongitudeConstant = 218.31664563 * RadiansPerDegree;
  let meanLongitudeSecPart =
    1732559343.4847 * t - 6.391 * t2 + 0.006588 * t3 - 0.00003169 * t4;

  // Delaunay arguments from section 3.5 b
  const D =
    297.85019547 * RadiansPerDegree +
    RadiansPerArcSecond *
      (1602961601.209 * t - 6.3706 * t2 + 0.006593 * t3 - 0.00003169 * t4);
  const F =
    93.27209062 * RadiansPerDegree +
    RadiansPerArcSecond *
      (1739527262.8478 * t - 12.7512 * t2 - 0.001037 * t3 + 0.00000417 * t4);
  const l =
    134.96340251 * RadiansPerDegree +
    RadiansPerArcSecond *
      (1717915923.2178 * t + 31.8792 * t2 + 0.051635 * t3 - 0.0002447 * t4);
  const lprime =
    357.52910918 * RadiansPerDegree +
    RadiansPerArcSecond *
      (129596581.0481 * t - 0.5532 * t2 + 0.000136 * t3 - 0.00001149 * t4);
  const psi =
    310.17137918 * RadiansPerDegree -
    RadiansPerArcSecond *
      (6967051.436 * t + 6.2068 * t2 + 0.007618 * t3 - 0.00003219 * t4);

  // Add terms from Table 4
  const twoD = 2.0 * D;
  const fourD = 4.0 * D;
  const sixD = 6.0 * D;
  const twol = 2.0 * l;
  const threel = 3.0 * l;
  const fourl = 4.0 * l;
  const twoF = 2.0 * F;
  semimajorAxis +=
    3400.4 * Math.cos(twoD) -
    635.6 * Math.cos(twoD - l) -
    235.6 * Math.cos(l) +
    218.1 * Math.cos(twoD - lprime) +
    181.0 * Math.cos(twoD + l);
  eccentricity +=
    0.014216 * Math.cos(twoD - l) +
    0.008551 * Math.cos(twoD - twol) -
    0.001383 * Math.cos(l) +
    0.001356 * Math.cos(twoD + l) -
    0.001147 * Math.cos(fourD - threel) -
    0.000914 * Math.cos(fourD - twol) +
    0.000869 * Math.cos(twoD - lprime - l) -
    0.000627 * Math.cos(twoD) -
    0.000394 * Math.cos(fourD - fourl) +
    0.000282 * Math.cos(twoD - lprime - twol) -
    0.000279 * Math.cos(D - l) -
    0.000236 * Math.cos(twol) +
    0.000231 * Math.cos(fourD) +
    0.000229 * Math.cos(sixD - fourl) -
    0.000201 * Math.cos(twol - twoF);
  inclinationSecPart +=
    486.26 * Math.cos(twoD - twoF) -
    40.13 * Math.cos(twoD) +
    37.51 * Math.cos(twoF) +
    25.73 * Math.cos(twol - twoF) +
    19.97 * Math.cos(twoD - lprime - twoF);
  longitudeOfPerigeeSecPart +=
    -55609 * Math.sin(twoD - l) -
    34711 * Math.sin(twoD - twol) -
    9792 * Math.sin(l) +
    9385 * Math.sin(fourD - threel) +
    7505 * Math.sin(fourD - twol) +
    5318 * Math.sin(twoD + l) +
    3484 * Math.sin(fourD - fourl) -
    3417 * Math.sin(twoD - lprime - l) -
    2530 * Math.sin(sixD - fourl) -
    2376 * Math.sin(twoD) -
    2075 * Math.sin(twoD - threel) -
    1883 * Math.sin(twol) -
    1736 * Math.sin(sixD - 5.0 * l) +
    1626 * Math.sin(lprime) -
    1370 * Math.sin(sixD - threel);
  longitudeOfNodeSecPart +=
    -5392 * Math.sin(twoD - twoF) -
    540 * Math.sin(lprime) -
    441 * Math.sin(twoD) +
    423 * Math.sin(twoF) -
    288 * Math.sin(twol - twoF);
  meanLongitudeSecPart +=
    -3332.9 * Math.sin(twoD) +
    1197.4 * Math.sin(twoD - l) -
    662.5 * Math.sin(lprime) +
    396.3 * Math.sin(l) -
    218.0 * Math.sin(twoD - lprime);

  // Add terms from Table 5
  const twoPsi = 2.0 * psi;
  const threePsi = 3.0 * psi;
  inclinationSecPart +=
    46.997 * Math.cos(psi) * t -
    0.614 * Math.cos(twoD - twoF + psi) * t +
    0.614 * Math.cos(twoD - twoF - psi) * t -
    0.0297 * Math.cos(twoPsi) * t2 -
    0.0335 * Math.cos(psi) * t2 +
    0.0012 * Math.cos(twoD - twoF + twoPsi) * t2 -
    0.00016 * Math.cos(psi) * t3 +
    0.00004 * Math.cos(threePsi) * t3 +
    0.00004 * Math.cos(twoPsi) * t3;
  const perigeeAndMean =
    2.116 * Math.sin(psi) * t -
    0.111 * Math.sin(twoD - twoF - psi) * t -
    0.0015 * Math.sin(psi) * t2;
  longitudeOfPerigeeSecPart += perigeeAndMean;
  meanLongitudeSecPart += perigeeAndMean;
  longitudeOfNodeSecPart +=
    -520.77 * Math.sin(psi) * t +
    13.66 * Math.sin(twoD - twoF + psi) * t +
    1.12 * Math.sin(twoD - psi) * t -
    1.06 * Math.sin(twoF - psi) * t +
    0.66 * Math.sin(twoPsi) * t2 +
    0.371 * Math.sin(psi) * t2 -
    0.035 * Math.sin(twoD - twoF + twoPsi) * t2 -
    0.015 * Math.sin(twoD - twoF + psi) * t2 +
    0.0014 * Math.sin(psi) * t3 -
    0.0011 * Math.sin(threePsi) * t3 -
    0.0009 * Math.sin(twoPsi) * t3;

  // Add constants and convert units
  semimajorAxis *= MetersPerKilometer;
  const inclination =
    inclinationConstant + inclinationSecPart * RadiansPerArcSecond;
  const longitudeOfPerigee =
    longitudeOfPerigeeConstant +
    longitudeOfPerigeeSecPart * RadiansPerArcSecond;
  const meanLongitude =
    meanLongitudeConstant + meanLongitudeSecPart * RadiansPerArcSecond;
  const longitudeOfNode =
    longitudeOfNodeConstant + longitudeOfNodeSecPart * RadiansPerArcSecond;

  return elementsToCartesian(
    semimajorAxis,
    eccentricity,
    inclination,
    longitudeOfPerigee,
    longitudeOfNode,
    meanLongitude,
    result,
  );
}

// Gets a point describing the motion of the Earth.  This point uses the Moon point and
// the 1992 mu value (ratio between Moon and Earth masses) in Table 2 of the paper in order
// to determine the position of the Earth relative to the Earth-Moon barycenter.
const moonEarthMassRatio = 0.012300034; // From 1992 mu value in Table 2
const factor = (moonEarthMassRatio / (moonEarthMassRatio + 1.0)) * -1;
function computeSimonEarth(date, result) {
  result = computeSimonMoon(date, result);
  return Cartesian3.multiplyByScalar(result, factor, result);
}

// Values for the <code>axesTransformation</code> needed for the rotation were found using the STK Components
// GeographicTransformer on the position of the sun center of mass point and the earth J2000 frame.

const axesTransformation = rowMajor(
  1.0000000000000002,
  5.619723173785822e-16,
  4.690511510146299e-19,
  -5.154129427414611e-16,
  0.9174820620691819,
  -0.39777715593191376,
  -2.23970096136568e-16,
  0.39777715593191376,
  0.9174820620691819,
);
let translation = Cartesian3.create();

/**
 * Computes the position of the Sun in the Earth-centered inertial frame
 *
 * @param {JulianDate} [julianDate] The time at which to compute the Sun's position, if not provided the current system time is used.
 * @param {Cartesian3} [result] The object onto which to store the result.
 * @returns {Cartesian3} Calculated sun position
 */
export function computeSunPositionInEarthInertialFrame(julianDate, result) {
  if (result == null) result = Cartesian3.create();

  //first forward transformation
  translation = computeSimonEarthMoonBarycenter(julianDate, translation);
  result = Cartesian3.negate(translation, result);

  //second forward transformation
  computeSimonEarth(julianDate, translation);

  Cartesian3.subtract(result, translation, result);
  Matrix3.multiplyByVector(axesTransformation, result, result);

  return result;
}

/**
 * Computes the position of the Moon in the Earth-centered inertial frame
 *
 * @param {JulianDate} [julianDate] The time at which to compute the Moon's position, if not provided the current system time is used.
 * @param {Cartesian3} [result] The object onto which to store the result.
 * @returns {Cartesian3} Calculated moon position
 */
export function computeMoonPositionInEarthInertialFrame(julianDate, result) {
  result = computeSimonMoon(julianDate, result);
  Matrix3.multiplyByVector(axesTransformation, result, result);

  return result;
}

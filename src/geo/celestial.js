/**
 * @module geo/celestial
 * @description The sun and the moon: a port of Cesium 1.138's
 * `Simon1994PlanetaryPositions` (positions in Cesium's Earth inertial frame)
 * and `Transforms.computeTemeToPseudoFixedMatrix` (inertial to Earth-fixed),
 * with epoch milliseconds (UTC, as `Date.now()` gives) as the only time
 * input. The time-scale handling (UTC to TAI through Cesium's leap-second
 * table, TAI to TT to TDB) follows `JulianDate` step for step, so results
 * are identical to Cesium's, bit for bit. Constants and operation order
 * are Cesium's; do not "simplify" them. No engine.
 *
 * A rotation is returned as its axes `{x, y, z}` (the columns of Cesium's
 * `Matrix3`), the form `geo/frames` uses. Times must be finite and inside
 * what `Date` represents, and the model holds for a few thousand years
 * either side of J2000; outside that its orbital elements leave their
 * ranges and the functions throw a RangeError, where Cesium's debug build
 * throws.
 */
import { frameVector } from './frames.js';
import { RADIANS_PER_DEGREE, TWO_PI, vec, zeroToTwoPi } from './vector.js';

// ---------------------------------------------------------------------------
// Constants (Core/Math.js, Core/TimeConstants.js)

const PI = Math.PI;
const RADIANS_PER_ARCSECOND = RADIANS_PER_DEGREE / 3600.0;
const SECONDS_PER_MILLISECOND = 0.001;
const SECONDS_PER_MINUTE = 60.0;
const SECONDS_PER_HOUR = 3600.0;
const SECONDS_PER_DAY = 86400.0;
const DAYS_PER_JULIAN_CENTURY = 36525.0;

// ---------------------------------------------------------------------------
// Julian dates (Core/JulianDate.js). A date is `{dayNumber, secondsOfDay}`,
// in TAI unless a comment says otherwise, as Cesium keeps them.

function setComponents(wholeDays, secondsOfDay, julianDate) {
  const extraDays = (secondsOfDay / SECONDS_PER_DAY) | 0;
  wholeDays += extraDays;
  secondsOfDay -= SECONDS_PER_DAY * extraDays;

  if (secondsOfDay < 0) {
    wholeDays--;
    secondsOfDay += SECONDS_PER_DAY;
  }

  julianDate.dayNumber = wholeDays;
  julianDate.secondsOfDay = secondsOfDay;
  return julianDate;
}

const taiDate = (dayNumber, secondsOfDay) =>
  setComponents(dayNumber, secondsOfDay, {});

const addSeconds = (julianDate, seconds, result) =>
  setComponents(
    julianDate.dayNumber,
    julianDate.secondsOfDay + seconds,
    result,
  );

const totalDays = (julianDate) =>
  julianDate.dayNumber + julianDate.secondsOfDay / SECONDS_PER_DAY;

function secondsDifference(left, right) {
  const dayDifference = (left.dayNumber - right.dayNumber) * SECONDS_PER_DAY;
  return dayDifference + (left.secondsOfDay - right.secondsOfDay);
}

function compare(left, right) {
  const julianDayNumberDifference = left.dayNumber - right.dayNumber;
  if (julianDayNumberDifference !== 0) return julianDayNumberDifference;
  return left.secondsOfDay - right.secondsOfDay;
}

/** `JulianDate.leapSeconds`: the TAI instant of each leap second, and TAI−UTC from it. */
const LEAP_SECONDS = [
  [2441317, 43210.0, 10], // January 1, 1972 00:00:00 UTC
  [2441499, 43211.0, 11], // July 1, 1972 00:00:00 UTC
  [2441683, 43212.0, 12], // January 1, 1973 00:00:00 UTC
  [2442048, 43213.0, 13], // January 1, 1974 00:00:00 UTC
  [2442413, 43214.0, 14], // January 1, 1975 00:00:00 UTC
  [2442778, 43215.0, 15], // January 1, 1976 00:00:00 UTC
  [2443144, 43216.0, 16], // January 1, 1977 00:00:00 UTC
  [2443509, 43217.0, 17], // January 1, 1978 00:00:00 UTC
  [2443874, 43218.0, 18], // January 1, 1979 00:00:00 UTC
  [2444239, 43219.0, 19], // January 1, 1980 00:00:00 UTC
  [2444786, 43220.0, 20], // July 1, 1981 00:00:00 UTC
  [2445151, 43221.0, 21], // July 1, 1982 00:00:00 UTC
  [2445516, 43222.0, 22], // July 1, 1983 00:00:00 UTC
  [2446247, 43223.0, 23], // July 1, 1985 00:00:00 UTC
  [2447161, 43224.0, 24], // January 1, 1988 00:00:00 UTC
  [2447892, 43225.0, 25], // January 1, 1990 00:00:00 UTC
  [2448257, 43226.0, 26], // January 1, 1991 00:00:00 UTC
  [2448804, 43227.0, 27], // July 1, 1992 00:00:00 UTC
  [2449169, 43228.0, 28], // July 1, 1993 00:00:00 UTC
  [2449534, 43229.0, 29], // July 1, 1994 00:00:00 UTC
  [2450083, 43230.0, 30], // January 1, 1996 00:00:00 UTC
  [2450630, 43231.0, 31], // July 1, 1997 00:00:00 UTC
  [2451179, 43232.0, 32], // January 1, 1999 00:00:00 UTC
  [2453736, 43233.0, 33], // January 1, 2006 00:00:00 UTC
  [2454832, 43234.0, 34], // January 1, 2009 00:00:00 UTC
  [2456109, 43235.0, 35], // July 1, 2012 00:00:00 UTC
  [2457204, 43236.0, 36], // July 1, 2015 00:00:00 UTC
  [2457754, 43237.0, 37], // January 1, 2017 00:00:00 UTC
].map(([dayNumber, secondsOfDay, offset]) =>
  Object.freeze({ julianDate: taiDate(dayNumber, secondsOfDay), offset }),
);

/** Core/binarySearch.js over the leap-second table. */
function searchLeapSeconds(julianDate) {
  let low = 0;
  let high = LEAP_SECONDS.length - 1;
  while (low <= high) {
    const i = ~~((low + high) / 2);
    const comparison = compare(LEAP_SECONDS[i].julianDate, julianDate);
    if (comparison < 0) {
      low = i + 1;
      continue;
    }
    if (comparison > 0) {
      high = i - 1;
      continue;
    }
    return i;
  }
  return ~(high + 1);
}

/** `convertUtcToTai`: shifts a UTC date to TAI in place. */
function convertUtcToTai(julianDate) {
  // Even though julianDate is in UTC, Cesium treats it as TAI to search.
  let index = searchLeapSeconds(julianDate);
  if (index < 0) index = ~index;
  if (index >= LEAP_SECONDS.length) index = LEAP_SECONDS.length - 1;

  let offset = LEAP_SECONDS[index].offset;
  if (index > 0) {
    const difference = secondsDifference(
      LEAP_SECONDS[index].julianDate,
      julianDate,
    );
    if (difference > offset) {
      index--;
      offset = LEAP_SECONDS[index].offset;
    }
  }

  addSeconds(julianDate, offset, julianDate);
}

/** `JulianDate.computeTaiMinusUtc`. */
function computeTaiMinusUtc(julianDate) {
  let index = searchLeapSeconds(julianDate);
  if (index < 0) {
    index = ~index;
    --index;
    if (index < 0) index = 0;
  }
  return LEAP_SECONDS[index].offset;
}

/**
 * `JulianDate.fromDate(new Date(ms))`: the TAI Julian date of a UTC epoch
 * millisecond (Seidelmann 1992, Explanatory Supplement p. 604).
 */
function julianDateFromEpochMs(ms) {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime()))
    throw new RangeError(`not a representable time: ${ms}`);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  let hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const second = date.getUTCSeconds();
  const millisecond = date.getUTCMilliseconds();

  const a = ((month - 14) / 12) | 0;
  const b = year + 4800 + a;
  let dayNumber =
    (((1461 * b) / 4) | 0) +
    (((367 * (month - 2 - 12 * a)) / 12) | 0) -
    (((3 * (((b + 100) / 100) | 0)) / 4) | 0) +
    day -
    32075;

  // Julian dates are noon-based.
  hour = hour - 12;
  if (hour < 0) hour += 24;

  let secondsOfDay =
    second +
    (hour * SECONDS_PER_HOUR +
      minute * SECONDS_PER_MINUTE +
      millisecond * SECONDS_PER_MILLISECOND);

  if (secondsOfDay >= 43200.0) dayNumber -= 1;

  // The JulianDate constructor: split a fractional day number (none here).
  const wholeDays = dayNumber | 0;
  secondsOfDay = secondsOfDay + (dayNumber - wholeDays) * SECONDS_PER_DAY;
  const julianDate = setComponents(wholeDays, secondsOfDay, {});
  convertUtcToTai(julianDate);
  return julianDate;
}

// ---------------------------------------------------------------------------
// Matrices

/** Cesium's `Matrix3.multiplyByVector`, column-major. */
function multiplyByVector(matrix, v) {
  return {
    x: matrix[0] * v.x + matrix[3] * v.y + matrix[6] * v.z,
    y: matrix[1] * v.x + matrix[4] * v.y + matrix[7] * v.z,
    z: matrix[2] * v.x + matrix[5] * v.y + matrix[8] * v.z,
  };
}

// ---------------------------------------------------------------------------
// Simon 1994 (Core/Simon1994PlanetaryPositions.js)

function computeTdbMinusTtSpice(daysSinceJ2000InTerrestrialTime) {
  // SPICE N0051 (unitim.c) constants, with TT taken as the independent
  // variable instead of TDB, as Cesium does.
  const g = 6.239996 + 0.0172019696544 * daysSinceJ2000InTerrestrialTime;
  return 1.657e-3 * Math.sin(g + 1.671e-2 * Math.sin(g));
}

const TdtMinusTai = 32.184;
const J2000d = 2451545;
function taiToTdb(date) {
  // TAI to TT.
  const result = addSeconds(date, TdtMinusTai, {});
  // TT to TDB.
  const days = totalDays(result) - J2000d;
  return addSeconds(result, computeTdbMinusTtSpice(days), result);
}

const epoch = taiDate(2451545, 0); // Actually TDB (not TAI), as in Cesium.
const MetersPerKilometer = 1000.0;
const MetersPerAstronomicalUnit = 1.4959787e11; // IAU 1976 value

/** Days since J2000 TDB at a TAI date. */
function daysSinceEpochTdb(date) {
  const tdb = taiToTdb(date);
  return (
    tdb.dayNumber -
    epoch.dayNumber +
    (tdb.secondsOfDay - epoch.secondsOfDay) / SECONDS_PER_DAY
  );
}

function elementsToCartesian(
  semimajorAxis,
  eccentricity,
  inclination,
  longitudeOfPerigee,
  longitudeOfNode,
  meanLongitude,
) {
  if (inclination < 0.0) {
    inclination = -inclination;
    longitudeOfNode += PI;
  }
  // Reached in the far past (Date's earliest times), as Cesium's debug
  // check is.
  if (inclination > PI)
    throw new RangeError(
      'inclination out of range: the time is too far from J2000',
    );

  const radiusOfPeriapsis = semimajorAxis * (1.0 - eccentricity);
  const argumentOfPeriapsis = longitudeOfPerigee - longitudeOfNode;
  const rightAscensionOfAscendingNode = longitudeOfNode;
  const trueAnomaly = meanAnomalyToTrueAnomaly(
    meanLongitude - longitudeOfPerigee,
    eccentricity,
  );

  const perifocalToEquatorial = perifocalToCartesianMatrix(
    argumentOfPeriapsis,
    inclination,
    rightAscensionOfAscendingNode,
  );
  const semilatus = radiusOfPeriapsis * (1.0 + eccentricity);
  const costheta = Math.cos(trueAnomaly);
  const sintheta = Math.sin(trueAnomaly);

  const denom = 1.0 + eccentricity * costheta;
  const radius = semilatus / denom;
  return multiplyByVector(perifocalToEquatorial, {
    x: radius * costheta,
    y: radius * sintheta,
    z: 0.0,
  });
}

function meanAnomalyToTrueAnomaly(meanAnomaly, eccentricity) {
  if (!(eccentricity >= 0.0 && eccentricity < 1.0))
    throw new RangeError(
      'eccentricity out of range: the time is too far from J2000',
    );
  const eccentricAnomaly = meanAnomalyToEccentricAnomaly(
    meanAnomaly,
    eccentricity,
  );
  return eccentricAnomalyToTrueAnomaly(eccentricAnomaly, eccentricity);
}

const maxIterationCount = 50;
const keplerEqConvergence = 0.00000001; // CesiumMath.EPSILON8
function meanAnomalyToEccentricAnomaly(meanAnomaly, eccentricity) {
  const revs = Math.floor(meanAnomaly / TWO_PI);

  // Angle in the current revolution.
  meanAnomaly -= revs * TWO_PI;

  // Starting value for the iteration.
  let iterationValue =
    meanAnomaly +
    (eccentricity * Math.sin(meanAnomaly)) /
      (1.0 - Math.sin(meanAnomaly + eccentricity) + Math.sin(meanAnomaly));

  // Newton-Raphson on Kepler's equation.
  let eccentricAnomaly = Number.MAX_VALUE;
  let count = 0;
  for (
    ;
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

  // Not reached for an elliptic orbit; kept as Cesium's debug check.
  if (count >= maxIterationCount)
    throw new RangeError('Kepler equation did not converge');
  eccentricAnomaly = iterationValue + revs * TWO_PI;
  return eccentricAnomaly;
}

function eccentricAnomalyToTrueAnomaly(eccentricAnomaly, eccentricity) {
  const revs = Math.floor(eccentricAnomaly / TWO_PI);

  eccentricAnomaly -= revs * TWO_PI;

  const trueAnomalyX = Math.cos(eccentricAnomaly) - eccentricity;
  const trueAnomalyY =
    Math.sin(eccentricAnomaly) * Math.sqrt(1 - eccentricity * eccentricity);

  let trueAnomaly = Math.atan2(trueAnomalyY, trueAnomalyX);

  // Correct quadrant.
  trueAnomaly = zeroToTwoPi(trueAnomaly);
  if (eccentricAnomaly < 0) trueAnomaly -= TWO_PI;

  // Previous revolutions.
  trueAnomaly += revs * TWO_PI;

  return trueAnomaly;
}

/** Perifocal (PQW) to inertial axes, column-major. */
function perifocalToCartesianMatrix(
  argumentOfPeriapsis,
  inclination,
  rightAscension,
) {
  const cosap = Math.cos(argumentOfPeriapsis);
  const sinap = Math.sin(argumentOfPeriapsis);

  const cosi = Math.cos(inclination);
  const sini = Math.sin(inclination);

  const cosraan = Math.cos(rightAscension);
  const sinraan = Math.sin(rightAscension);

  const result = new Float64Array(9);
  result[0] = cosraan * cosap - sinraan * sinap * cosi;
  result[1] = sinraan * cosap + cosraan * sinap * cosi;
  result[2] = sinap * sini;
  result[3] = -cosraan * sinap - sinraan * cosap * cosi;
  result[4] = -sinraan * sinap + cosraan * cosap * cosi;
  result[5] = cosap * sini;
  result[6] = sinraan * sini;
  result[7] = -cosraan * sini;
  result[8] = cosi;
  return result;
}

// From section 5.8
const semiMajorAxis0 = 1.0000010178 * MetersPerAstronomicalUnit;
const meanLongitude0 = 100.46645683 * RADIANS_PER_DEGREE;
const meanLongitude1 = 1295977422.83429 * RADIANS_PER_ARCSECOND;

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

/** The Earth-Moon barycentre (section 6), at a TAI date. */
function computeSimonEarthMoonBarycenter(date) {
  // t is thousands of years from J2000 TDB.
  const x = daysSinceEpochTdb(date);
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

  // All constants in this part are from section 5.8.
  const eccentricity = 0.0167086342 - 0.0004203654 * t;
  const longitudeOfPerigee =
    102.93734808 * RADIANS_PER_DEGREE + 11612.3529 * RADIANS_PER_ARCSECOND * t;
  const inclination = 469.97289 * RADIANS_PER_ARCSECOND * t;
  const longitudeOfNode =
    174.87317577 * RADIANS_PER_DEGREE - 8679.27034 * RADIANS_PER_ARCSECOND * t;

  return elementsToCartesian(
    semimajorAxis,
    eccentricity,
    inclination,
    longitudeOfPerigee,
    longitudeOfNode,
    meanLongitude,
  );
}

/** The Moon relative to the Earth (section 4), at a TAI date. */
function computeSimonMoon(date) {
  const x = daysSinceEpochTdb(date);
  const t = x / DAYS_PER_JULIAN_CENTURY;
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;

  // Terms from section 3.4 (b.1)
  let semimajorAxis = 383397.7725 + 0.004 * t;
  let eccentricity = 0.055545526 - 0.000000016 * t;
  const inclinationConstant = 5.15668983 * RADIANS_PER_DEGREE;
  let inclinationSecPart =
    -0.00008 * t + 0.02966 * t2 - 0.000042 * t3 - 0.00000013 * t4;
  const longitudeOfPerigeeConstant = 83.35324312 * RADIANS_PER_DEGREE;
  let longitudeOfPerigeeSecPart =
    14643420.2669 * t - 38.2702 * t2 - 0.045047 * t3 + 0.00021301 * t4;
  const longitudeOfNodeConstant = 125.04455501 * RADIANS_PER_DEGREE;
  let longitudeOfNodeSecPart =
    -6967919.3631 * t + 6.3602 * t2 + 0.007625 * t3 - 0.00003586 * t4;
  const meanLongitudeConstant = 218.31664563 * RADIANS_PER_DEGREE;
  let meanLongitudeSecPart =
    1732559343.4847 * t - 6.391 * t2 + 0.006588 * t3 - 0.00003169 * t4;

  // Delaunay arguments from section 3.5 b
  const D =
    297.85019547 * RADIANS_PER_DEGREE +
    RADIANS_PER_ARCSECOND *
      (1602961601.209 * t - 6.3706 * t2 + 0.006593 * t3 - 0.00003169 * t4);
  const F =
    93.27209062 * RADIANS_PER_DEGREE +
    RADIANS_PER_ARCSECOND *
      (1739527262.8478 * t - 12.7512 * t2 - 0.001037 * t3 + 0.00000417 * t4);
  const l =
    134.96340251 * RADIANS_PER_DEGREE +
    RADIANS_PER_ARCSECOND *
      (1717915923.2178 * t + 31.8792 * t2 + 0.051635 * t3 - 0.0002447 * t4);
  const lprime =
    357.52910918 * RADIANS_PER_DEGREE +
    RADIANS_PER_ARCSECOND *
      (129596581.0481 * t - 0.5532 * t2 + 0.000136 * t3 - 0.00001149 * t4);
  const psi =
    310.17137918 * RADIANS_PER_DEGREE -
    RADIANS_PER_ARCSECOND *
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
    inclinationConstant + inclinationSecPart * RADIANS_PER_ARCSECOND;
  const longitudeOfPerigee =
    longitudeOfPerigeeConstant +
    longitudeOfPerigeeSecPart * RADIANS_PER_ARCSECOND;
  const meanLongitude =
    meanLongitudeConstant + meanLongitudeSecPart * RADIANS_PER_ARCSECOND;
  const longitudeOfNode =
    longitudeOfNodeConstant + longitudeOfNodeSecPart * RADIANS_PER_ARCSECOND;

  return elementsToCartesian(
    semimajorAxis,
    eccentricity,
    inclination,
    longitudeOfPerigee,
    longitudeOfNode,
    meanLongitude,
  );
}

// The Earth relative to the Earth-Moon barycentre, from the Moon and the
// 1992 mu value (Moon/Earth mass ratio) in Table 2.
const moonEarthMassRatio = 0.012300034;
const factor = (moonEarthMassRatio / (moonEarthMassRatio + 1.0)) * -1;
function computeSimonEarth(date) {
  const moon = computeSimonMoon(date);
  return { x: moon.x * factor, y: moon.y * factor, z: moon.z * factor };
}

// Ecliptic to Cesium's Earth inertial axes (STK Components'
// GeographicTransformer), column-major.
const axesTransformation = Float64Array.of(
  1.0000000000000002,
  -5.154129427414611e-16,
  -2.23970096136568e-16,
  5.619723173785822e-16,
  0.9174820620691819,
  0.39777715593191376,
  4.690511510146299e-19,
  -0.39777715593191376,
  0.9174820620691819,
);

/**
 * The Sun in Cesium's Earth-centred inertial frame, in metres
 * (`Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame`).
 * @param {number} ms UTC epoch milliseconds.
 * @returns {{x: number, y: number, z: number}}
 */
export function sunPositionInertial(ms) {
  const date = julianDateFromEpochMs(ms);
  const translation = computeSimonEarthMoonBarycenter(date);
  const earth = computeSimonEarth(date);
  return multiplyByVector(axesTransformation, {
    x: -translation.x - earth.x,
    y: -translation.y - earth.y,
    z: -translation.z - earth.z,
  });
}

/**
 * The Moon in Cesium's Earth-centred inertial frame, in metres
 * (`Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame`).
 * @param {number} ms UTC epoch milliseconds.
 * @returns {{x: number, y: number, z: number}}
 */
export function moonPositionInertial(ms) {
  return multiplyByVector(
    axesTransformation,
    computeSimonMoon(julianDateFromEpochMs(ms)),
  );
}

// ---------------------------------------------------------------------------
// TEME to pseudo-fixed (Core/Transforms.js)

const gmstConstant0 = 6 * 3600 + 41 * 60 + 50.54841;
const gmstConstant1 = 8640184.812866;
const gmstConstant2 = 0.093104;
const gmstConstant3 = -6.2e-6;
const rateCoef = 1.1772758384668e-19;
const wgs84WRPrecessing = 7.2921158553e-5;
const twoPiOverSecondsInDay = TWO_PI / 86400.0;

/**
 * The rotation from True Equator Mean Equinox axes to Cesium's pseudo-fixed
 * axes (`Transforms.computeTemeToPseudoFixedMatrix`), treating UT1 as UTC.
 * Epoch milliseconds cannot name an instant inside a leap second
 * (23:59:60), so none reaches it; the instants either side are Cesium's.
 * @param {number} ms UTC epoch milliseconds.
 * @returns {{x: object, y: object, z: object, origin: object}} A frame.
 */
export function temeToPseudoFixed(ms) {
  const date = julianDateFromEpochMs(ms);
  // GMST is computed from UT1; UTC stands in for it.
  const dateInUtc = addSeconds(date, -computeTaiMinusUtc(date), {});
  const utcDayNumber = dateInUtc.dayNumber;
  const utcSecondsIntoDay = dateInUtc.secondsOfDay;

  let t;
  const diffDays = utcDayNumber - 2451545;
  if (utcSecondsIntoDay >= 43200.0) {
    t = (diffDays + 0.5) / DAYS_PER_JULIAN_CENTURY;
  } else {
    t = (diffDays - 0.5) / DAYS_PER_JULIAN_CENTURY;
  }

  const gmst0 =
    gmstConstant0 +
    t * (gmstConstant1 + t * (gmstConstant2 + t * gmstConstant3));
  const angle = (gmst0 * twoPiOverSecondsInDay) % TWO_PI;
  const ratio = wgs84WRPrecessing + rateCoef * (utcDayNumber - 2451545.5);
  const secondsSinceMidnight =
    (utcSecondsIntoDay + SECONDS_PER_DAY * 0.5) % SECONDS_PER_DAY;
  const gha = angle + ratio * secondsSinceMidnight;
  const cosGha = Math.cos(gha);
  const sinGha = Math.sin(gha);

  return {
    x: vec(cosGha, -sinGha, 0.0),
    y: vec(sinGha, cosGha, 0.0),
    z: vec(0.0, 0.0, 1.0),
    origin: vec(0.0, 0.0, 0.0),
  };
}

/**
 * The Sun in Earth-fixed (ECEF) metres: `sunPositionInertial` rotated by
 * `temeToPseudoFixed`. This is the pseudo-fixed frame Core falls back to
 * while EOP data is missing, not the EOP-corrected ICRF-to-fixed one
 * (`Transforms.computeIcrfToFixedMatrix`); the two differ by precession,
 * nutation and polar motion.
 * @param {number} ms UTC epoch milliseconds.
 * @returns {{x: number, y: number, z: number}}
 */
export function sunPositionFixed(ms) {
  return frameVector(temeToPseudoFixed(ms), sunPositionInertial(ms));
}

/**
 * The Moon in Earth-fixed (ECEF) metres, in the same pseudo-fixed frame as
 * `sunPositionFixed`.
 * @param {number} ms UTC epoch milliseconds.
 * @returns {{x: number, y: number, z: number}}
 */
export function moonPositionFixed(ms) {
  return frameVector(temeToPseudoFixed(ms), moonPositionInertial(ms));
}

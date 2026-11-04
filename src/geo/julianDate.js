// Ported from CesiumJS 1.138 (Apache-2.0) — JulianDate.js
//
// The part of Cesium's JulianDate that the planetary positions need: a date
// as {dayNumber, secondsOfDay} in International Atomic Time (TAI), made from
// a JavaScript Date through Cesium's leap second table. The operation order
// matches Cesium so the values are bit-identical.

const SECONDS_PER_DAY = 86400.0;

// Cesium's JulianDate.leapSeconds: [TAI day, TAI seconds of day, TAI - UTC].
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
].map(([dayNumber, secondsOfDay, offset]) => ({
  julianDate: { dayNumber, secondsOfDay },
  offset,
}));

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

function compare(left, right) {
  const julianDayNumberDifference = left.dayNumber - right.dayNumber;
  if (julianDayNumberDifference !== 0) {
    return julianDayNumberDifference;
  }
  return left.secondsOfDay - right.secondsOfDay;
}

// Cesium's binarySearch over the leap second table.
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

function secondsDifference(left, right) {
  const dayDifference = (left.dayNumber - right.dayNumber) * SECONDS_PER_DAY;
  return dayDifference + (left.secondsOfDay - right.secondsOfDay);
}

function convertUtcToTai(julianDate) {
  let index = searchLeapSeconds(julianDate);
  if (index < 0) {
    index = ~index;
  }
  if (index >= LEAP_SECONDS.length) {
    index = LEAP_SECONDS.length - 1;
  }
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

/** A TAI date from its whole Julian day number and seconds into that day. */
export function fromTai(julianDayNumber, secondsOfDay) {
  const wholeDays = julianDayNumber | 0;
  secondsOfDay = secondsOfDay + (julianDayNumber - wholeDays) * SECONDS_PER_DAY;
  return setComponents(wholeDays, secondsOfDay, {
    dayNumber: 0,
    secondsOfDay: 0,
  });
}

/** Cesium's JulianDate.fromDate: a valid JavaScript Date as a TAI date. */
export function fromDate(date, result) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  let hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const second = date.getUTCSeconds();
  const millisecond = date.getUTCMilliseconds();

  // Algorithm from page 604 of the Explanatory Supplement to the
  // Astronomical Almanac (Seidelmann 1992).
  const a = ((month - 14) / 12) | 0;
  const b = year + 4800 + a;
  let dayNumber =
    (((1461 * b) / 4) | 0) +
    (((367 * (month - 2 - 12 * a)) / 12) | 0) -
    (((3 * (((b + 100) / 100) | 0)) / 4) | 0) +
    day -
    32075;

  // JulianDates are noon-based
  hour = hour - 12;
  if (hour < 0) {
    hour += 24;
  }

  const secondsOfDay =
    second + (hour * 3600.0 + minute * 60.0 + millisecond * 0.001);

  if (secondsOfDay >= 43200.0) {
    dayNumber -= 1;
  }

  result = setComponents(
    dayNumber,
    secondsOfDay,
    result ?? { dayNumber: 0, secondsOfDay: 0 },
  );
  convertUtcToTai(result);
  return result;
}

/** The date `seconds` later (earlier when negative); `result` is required. */
export function addSeconds(julianDate, seconds, result) {
  return setComponents(
    julianDate.dayNumber,
    julianDate.secondsOfDay + seconds,
    result,
  );
}

/** The date as a fractional Julian day number. */
export function totalDays(julianDate) {
  return julianDate.dayNumber + julianDate.secondsOfDay / SECONDS_PER_DAY;
}

/** How many seconds TAI is ahead of UTC at the date. */
export function computeTaiMinusUtc(julianDate) {
  let index = searchLeapSeconds(julianDate);
  if (index < 0) {
    index = ~index;
    --index;
    if (index < 0) {
      index = 0;
    }
  }
  return LEAP_SECONDS[index].offset;
}

/**
 * @module geo/julian
 * @description Julian dates as Cesium 1.138's `JulianDate` keeps them, on
 * plain `{dayNumber, secondsOfDay}` objects in TAI, so code that times
 * motion on them needs no engine. The arithmetic, the UTC to TAI shift
 * through the leap-second table and the conversion back to epoch
 * milliseconds follow `Core/JulianDate.js` step for step, so a date made
 * here and one made by `JulianDate` are the same numbers and either
 * module's functions take either. Do not "simplify" them.
 */

export const SECONDS_PER_DAY = 86400.0;
const SECONDS_PER_MILLISECOND = 0.001;
const SECONDS_PER_MINUTE = 60.0;
const SECONDS_PER_HOUR = 3600.0;

/** `setComponents`: normalise whole days and seconds into `julianDate`. */
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

/** A TAI date from its components, normalised. */
export const taiDate = (dayNumber, secondsOfDay) =>
  setComponents(dayNumber, secondsOfDay, {});

/** `JulianDate.clone`: undefined for none, as Cesium's. */
export function cloneJulian(julianDate, result) {
  if (julianDate === undefined || julianDate === null) return undefined;
  const out = result ?? {};
  out.dayNumber = julianDate.dayNumber;
  out.secondsOfDay = julianDate.secondsOfDay;
  return out;
}

/** `JulianDate.addSeconds`, into `result` (a new date when omitted). */
export const addSeconds = (julianDate, seconds, result) =>
  setComponents(
    julianDate.dayNumber,
    julianDate.secondsOfDay + seconds,
    result ?? {},
  );

/** `JulianDate.totalDays`. */
export const totalDays = (julianDate) =>
  julianDate.dayNumber + julianDate.secondsOfDay / SECONDS_PER_DAY;

/** `JulianDate.secondsDifference`: `left` minus `right`, seconds. */
export function secondsDifference(left, right) {
  const dayDifference = (left.dayNumber - right.dayNumber) * SECONDS_PER_DAY;
  return dayDifference + (left.secondsOfDay - right.secondsOfDay);
}

/** `JulianDate.compare`: negative when `left` is earlier. */
export function compareJulian(left, right) {
  const julianDayNumberDifference = left.dayNumber - right.dayNumber;
  if (julianDayNumberDifference !== 0) return julianDayNumberDifference;
  return left.secondsOfDay - right.secondsOfDay;
}

/** `JulianDate.lessThan`. */
export const julianLessThan = (left, right) => compareJulian(left, right) < 0;

/** `JulianDate.lessThanOrEquals`. */
export const julianLessThanOrEquals = (left, right) =>
  compareJulian(left, right) <= 0;

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
    const comparison = compareJulian(LEAP_SECONDS[i].julianDate, julianDate);
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

/**
 * `convertTaiToUtc`: the UTC date of a TAI one, into `result`; undefined
 * during a leap second, which UTC cannot name.
 */
function convertTaiToUtc(julianDate, result) {
  let index = searchLeapSeconds(julianDate);
  if (index < 0) index = ~index;

  // All times before our first leap second get the first offset.
  if (index === 0)
    return addSeconds(julianDate, -LEAP_SECONDS[0].offset, result);

  // All times after our leap second get the last offset.
  if (index >= LEAP_SECONDS.length)
    return addSeconds(julianDate, -LEAP_SECONDS[index - 1].offset, result);

  const difference = secondsDifference(
    LEAP_SECONDS[index].julianDate,
    julianDate,
  );

  // The date is in the leap-second table.
  if (difference === 0)
    return addSeconds(julianDate, -LEAP_SECONDS[index].offset, result);

  // During the moment of a leap second there is no UTC.
  if (difference <= 1.0) return undefined;

  return addSeconds(julianDate, -LEAP_SECONDS[--index].offset, result);
}

/** `JulianDate.computeTaiMinusUtc`. */
export function computeTaiMinusUtc(julianDate) {
  let index = searchLeapSeconds(julianDate);
  if (index < 0) {
    index = ~index;
    --index;
    if (index < 0) index = 0;
  }
  return LEAP_SECONDS[index].offset;
}

/**
 * `JulianDate.fromDate(new Date(ms), result)`: the TAI Julian date of a UTC
 * epoch millisecond (Seidelmann 1992, Explanatory Supplement p. 604).
 * @param {number} ms
 * @param {object} [result]
 */
export function julianFromEpochMs(ms, result) {
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

  const secondsOfDay =
    second +
    (hour * SECONDS_PER_HOUR +
      minute * SECONDS_PER_MINUTE +
      millisecond * SECONDS_PER_MILLISECOND);

  if (secondsOfDay >= 43200.0) dayNumber -= 1;

  const out = setComponents(dayNumber, secondsOfDay, result ?? {});
  convertUtcToTai(out);
  return out;
}

/** `JulianDate.now(result)`: the current system time. */
export const julianNow = (result) => julianFromEpochMs(Date.now(), result);

const scratchUtc = {};

/**
 * `JulianDate.toDate(julianDate).getTime()`: UTC epoch milliseconds, a
 * leap second read as the second before it, as Cesium's.
 * @param {{dayNumber: number, secondsOfDay: number}} julianDate
 * @returns {number}
 */
export function julianToEpochMs(julianDate) {
  let thisUtc = convertTaiToUtc(julianDate, scratchUtc);
  if (thisUtc === undefined) {
    // During a leap second: convert the second before it.
    addSeconds(julianDate, -1, scratchUtc);
    thisUtc = convertTaiToUtc(scratchUtc, scratchUtc);
  }

  let julianDayNumber = thisUtc.dayNumber;
  const secondsOfDay = thisUtc.secondsOfDay;

  if (secondsOfDay >= 43200.0) julianDayNumber += 1;

  // Algorithm from page 604 of the Explanatory Supplement to the
  // Astronomical Almanac (Seidelmann 1992).
  let L = (julianDayNumber + 68569) | 0;
  const N = ((4 * L) / 146097) | 0;
  L = (L - (((146097 * N + 3) / 4) | 0)) | 0;
  const I = ((4000 * (L + 1)) / 1461001) | 0;
  L = (L - (((1461 * I) / 4) | 0) + 31) | 0;
  const J = ((80 * L) / 2447) | 0;
  const day = (L - (((2447 * J) / 80) | 0)) | 0;
  L = (J / 11) | 0;
  const month = (J + 2 - 12 * L) | 0;
  const year = (100 * (N - 49) + I + L) | 0;

  let hour = (secondsOfDay / SECONDS_PER_HOUR) | 0;
  let remainingSeconds = secondsOfDay - hour * SECONDS_PER_HOUR;
  const minute = (remainingSeconds / SECONDS_PER_MINUTE) | 0;
  remainingSeconds = remainingSeconds - minute * SECONDS_PER_MINUTE;
  const second = remainingSeconds | 0;
  const millisecond = (remainingSeconds - second) / SECONDS_PER_MILLISECOND;

  // Julian dates are noon-based.
  hour += 12;
  if (hour > 23) hour -= 24;

  // `toGregorianDate` adds a leap second back and `toDate` takes it off
  // again, so the second before it stands for it.
  return Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
}

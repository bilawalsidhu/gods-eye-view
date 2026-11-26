import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOUR_MS,
  OZONE_NOWCAST_HOURS,
  eightHourMean,
  hourlySeries,
  ozoneNowCast,
  pmNowCast,
} from './nowcast.js';
import { aqiStations, stationIndex } from './usAqi.js';

test('the PM NowCast of the worked 12-hour example is 17.4 µg/m³', () => {
  // "Computing the NowCast" (Minnesota Pollution Control Agency), from
  // AirNow's NowCast sample data: oldest first, 13 µg/m³ the current hour.
  // The range 80 over the maximum 90 gives a weight factor of 0.11, raised
  // to 0.5.
  const hours = [50, 80, 75, 90, 82, 53, 64, 74, 21, 10, 16, 13];
  assert.equal(Math.round(pmNowCast(hours) * 10) / 10, 17.4);
  // Steady air weighs the hours almost evenly: near the 12-hour mean.
  assert.equal(pmNowCast(new Array(12).fill(20)), 20);
  const steady = [20, 21, 20, 22, 21, 20, 21, 22, 21, 20, 21, 22];
  const mean = steady.reduce((a, b) => a + b) / 12;
  assert.ok(Math.abs(pmNowCast(steady) - mean) < 0.2);
  // Only the last 12 hours count.
  assert.equal(pmNowCast([500, ...new Array(12).fill(20)]), 20);
  assert.equal(pmNowCast(new Array(12).fill(0)), 0);
});

test('a PM NowCast needs two of the last three hours', () => {
  const hours = new Array(12).fill(30);
  assert.equal(pmNowCast(hours), 30);
  // Missing hours are left out of both sums.
  assert.equal(pmNowCast([...hours.slice(0, 11), NaN]), 30);
  assert.equal(pmNowCast([...hours.slice(0, 9), 30, NaN, 30]), 30);
  assert.equal(pmNowCast([...hours.slice(0, 9), NaN, NaN, 30]), null);
  assert.equal(pmNowCast([...hours.slice(0, 10), NaN, NaN]), null);
  assert.equal(pmNowCast([30]), null);
});

test('an 8-hour mean needs six of its eight hours', () => {
  assert.equal(eightHourMean([9, 1, 2, 3, 4, 5, 6, 7, 8]), 4.5);
  assert.equal(eightHourMean([1, 2, NaN, 4, 5, 6, NaN, 8]), 26 / 6);
  assert.equal(eightHourMean([1, NaN, NaN, 4, 5, 6, NaN, 8]), null);
  assert.equal(eightHourMean([1, 2, 3, 4, 5]), null);
});

test('hours line up by their end time, half-hour zones included', () => {
  const end = Date.parse('2026-11-25T10:30:00Z');
  const series = hourlySeries(
    [
      { endMs: end, value: 3 },
      { endMs: end - 2 * HOUR_MS, value: 1 },
      { endMs: end - HOUR_MS, value: null },
      { endMs: end + HOUR_MS, value: 9 },
      { endMs: end - 5 * HOUR_MS, value: 7 },
    ],
    end,
    3,
  );
  assert.equal(series.length, 3);
  assert.deepEqual(series.map(String), ['1', 'NaN', '3']);
});

/** Hourly ozone (ppb) through `hours` hours: a daily cycle. */
const cycle = (hours, extra = (i) => 0) =>
  Array.from(
    { length: hours },
    (_, i) => 40 + 20 * Math.sin((2 * Math.PI * i) / 24) + extra(i),
  );

test("the ozone NowCast predicts the current hour's centred 8-hour mean", () => {
  // EPA's ozone method: a regression of each hour's centred 8-hour mean
  // (hours -4 to +3) on the 96 hours up to it, over two weeks. A pure daily
  // cycle is predicted exactly.
  const series = cycle(OZONE_NOWCAST_HOURS + 2);
  const last = series.length - 1;
  let expected = 0;
  for (let offset = -4; offset <= 3; offset++)
    expected += 40 + 20 * Math.sin((2 * Math.PI * (last + offset)) / 24);
  expected /= 8;
  assert.ok(Math.abs(ozoneNowCast(series) - expected) < 1e-6);
  // Steady air: the steady value.
  assert.ok(Math.abs(ozoneNowCast(new Array(336).fill(40)) - 40) < 1e-9);
  // All zeros: zero.
  assert.equal(ozoneNowCast(new Array(336).fill(0)), 0);
});

test('the ozone NowCast falls back to its surrogate without two weeks of data', () => {
  // 0.85 × the latest of the last three hours + 4.5 ppb.
  assert.equal(ozoneNowCast([30]), 30 * 0.85 + 4.5);
  assert.equal(ozoneNowCast([30, 50, NaN]), 50 * 0.85 + 4.5);
  assert.equal(ozoneNowCast([30, NaN, NaN, NaN]), null);
  assert.equal(ozoneNowCast([]), null);
  // Fewer than 252 of 336 hours.
  const sparse = cycle(336).map((v, i) => (i % 3 === 0 ? NaN : v));
  assert.equal(ozoneNowCast(sparse), sparse.at(-1) * 0.85 + 4.5);
  // A gap of more than seven hours.
  const gap = cycle(336).map((v, i) => (i >= 100 && i < 108 ? NaN : v));
  assert.equal(ozoneNowCast(gap), gap.at(-1) * 0.85 + 4.5);
  const short = cycle(336).map((v, i) => (i >= 100 && i < 107 ? NaN : v));
  assert.notEqual(ozoneNowCast(short), short.at(-1) * 0.85 + 4.5);
});

test('a missing current ozone hour takes the NowCast of one, then two, hours before', () => {
  const series = cycle(OZONE_NOWCAST_HOURS + 2);
  const previous = ozoneNowCast(series.slice(0, -1));
  assert.equal(ozoneNowCast([...series.slice(0, -1), NaN]), previous);
  const twoBefore = ozoneNowCast(series.slice(0, -2));
  assert.equal(ozoneNowCast([...series.slice(0, -2), NaN, NaN]), twoBefore);
  assert.equal(ozoneNowCast([...series.slice(0, -3), NaN, NaN, NaN]), null);
});

/** Hourly rows of one pollutant at one station, oldest first. */
function hourly(parameter, values, { units = 'µg/m³', end, extra } = {}) {
  return values.map((value, i) => ({
    id: `x:1:${parameter}`,
    provider: 'x',
    stationId: '1',
    parameter,
    units,
    value,
    averagingMinutes: 60,
    observedMs: end - (values.length - 1 - i) * HOUR_MS,
    ...(extra?.(i) ?? {}),
  }));
}

test('the AQI view rates PM on its NowCast, not its latest hour', () => {
  const end = Date.parse('2026-11-25T10:00:00Z');
  const hours = [50, 80, 75, 90, 82, 53, 64, 74, 21, 10, 16, 13];
  const [station] = aqiStations(hourly('PM2.5', hours, { end }));
  assert.ok(Math.abs(station.values.pm25 - 17.4139) < 1e-3);
  assert.equal(station.valueMethods.pm25, 'nowcast');
  assert.equal(station.valueTimes.pm25, end);
  // The latest hour (13 µg/m³) beside it, for the pollutant's own reading.
  assert.equal(station.hourValues.pm25, 13);
  // 17.4 µg/m³ is 66 on the PM2.5 rows; the latest hour alone would give 58.
  assert.deepEqual(stationIndex(station).aqi, { index: 66, leading: 'pm25' });
  // One hour alone is not a NowCast: said so, not guessed.
  const [single] = aqiStations(hourly('PM2.5', [13], { end }));
  assert.deepEqual(single.values, {});
  assert.deepEqual(single.excluded, { pm25: 'nowcast' });
  assert.equal(stationIndex(single).aqi, null);
  // Flagged and under-covered hours count as missing.
  const [flagged] = aqiStations(
    hourly('PM10', [40, 40, 40], {
      end,
      extra: (i) =>
        i === 1
          ? { qualityFlagged: true }
          : i === 2
            ? { coveragePercent: 50 }
            : {},
    }),
  );
  // The NowCast fails on a newest hour that is itself unusable: its reason.
  assert.deepEqual(flagged.excluded, { pm10: 'incomplete' });
  // A 24-hour average a host supplies is rated as it is.
  const [daily] = aqiStations([
    { ...hourly('PM2.5', [13], { end })[0], averagingMinutes: 1440 },
  ]);
  assert.equal(daily.values.pm25, 13);
  assert.equal(daily.valueAveraging.pm25, 1440);
  // A value without a stated period is not taken for one.
  const [unstated] = aqiStations([
    { ...hourly('PM2.5', [13], { end })[0], averagingMinutes: null },
  ]);
  assert.deepEqual(unstated.excluded, { pm25: 'averaging' });
});

test('the AQI view rates ozone on its NowCast and the current hour on the 1-hour rows', () => {
  const end = Date.parse('2026-11-25T10:00:00Z');
  const ppb = (value) => value * 1.963;
  // A day of hourly ozone: too short for the regression, so the surrogate.
  const values = new Array(24).fill(ppb(60));
  values[23] = ppb(170);
  const [station] = aqiStations(hourly('O3', values, { end }));
  assert.ok(Math.abs(station.values.o3 - ppb(170 * 0.85 + 4.5)) < 1e-9);
  assert.equal(station.valueMethods.o3, 'nowcast');
  assert.ok(Math.abs(station.hourValues.o3 - ppb(170)) < 1e-9);
  // NowCast 0.149 ppm gives 246 on the 8-hour rows; the hour's 0.170 ppm
  // gives 157 on the 1-hour rows; the higher is kept.
  assert.deepEqual(stationIndex(station).aqi, { index: 246, leading: 'o3' });
  // 8-hour and 1-hour values in ppm, as a host may send them.
  const [host] = aqiStations([
    {
      ...hourly('O3', [0.078], { end, units: 'ppm' })[0],
      averagingMinutes: 480,
    },
    ...hourly('O3', [0.162], { end: end - 1, units: 'ppm' }),
  ]);
  assert.equal(host.valueAveraging.o3, 480);
  assert.equal(stationIndex(host).aqi.index, 147);
});

test('CO rates its 8-hour mean, NO2 and SO2 their 1-hour values', () => {
  const end = Date.parse('2026-11-25T10:00:00Z');
  const [station] = aqiStations([
    ...hourly('CO', [9, 9, 9, 9, 9, 9, 9, 9], { end, units: 'ppm' }),
    ...hourly('NO2', [80, 120], { end, units: 'ppb' }),
    {
      ...hourly('SO2', [400], { end, units: 'ppb' })[0],
      averagingMinutes: null,
    },
    {
      ...hourly('SO2', [350], { end, units: 'ppb' })[0],
      averagingMinutes: 1440,
    },
  ]);
  assert.ok(Math.abs(station.values.co - 9 * 1.1456) < 1e-9);
  assert.equal(station.valueAveraging.co, 480);
  assert.equal(station.values.no2, 120 * 1.882);
  assert.equal(station.valueAveraging.no2, 60);
  assert.equal(station.valueAveraging.so2, null);
  assert.equal(station.dayValues.so2, 350 * 2.62);
  const { aqi } = stationIndex(station);
  // SO2 400 ppb in the hour and 350 ppb over 24 hours: the 24-hour rows,
  // 216.
  assert.deepEqual(aqi, { index: 216, leading: 'so2' });
  // Five of eight hours are not an 8-hour mean.
  const [short] = aqiStations(
    hourly('CO', [9, 9, 9, 9, 9], { end, units: 'ppm' }),
  );
  assert.deepEqual(short.excluded, { co: 'hours' });
  // An NO2 hour under 75 % covered is left out as incomplete.
  const [partial] = aqiStations(
    hourly('NO2', [80], { end, extra: () => ({ coveragePercent: 50 }) }),
  );
  assert.deepEqual(partial.excluded, { no2: 'incomplete' });
});

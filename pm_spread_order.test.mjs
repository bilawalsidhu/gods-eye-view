import assert from 'node:assert/strict';
import test from 'node:test';
import { stationIndex } from './src/layers/airQuality/usAqi.js';

test('a 4-hour-old PM10 does not knock out fresh PM2.5 before the spread check', () => {
  const now = Date.now();
  const r = stationIndex({
    values: { pm25: 60, pm10: 10 },
    valueTimes: { pm25: now, pm10: now - 4 * 3600_000 },
  });
  // Now: PM2.5 excluded as 'above-pm10', PM10 leads with AQI 9 (Good).
  assert.equal(r.aqi?.leading, 'pm25');
  assert.equal(r.aqi?.index, 154);
  assert.equal(r.excluded.pm10, 'too-old');
});

test('a PM2.5 left out as above PM10 does not set the three-hour cutoff', () => {
  const noon = Date.UTC(2026, 10, 25, 12);
  const r = stationIndex({
    values: { pm25: 250, pm10: 10, no2: 400 },
    valueTimes: {
      pm25: noon,
      pm10: noon - 3600_000,
      no2: noon - 3.5 * 3600_000,
    },
  });
  assert.equal(r.excluded.pm25, 'above-pm10');
  // NO2 is within three hours of PM10, the newest value kept.
  assert.deepEqual(r.used, { pm10: 10, no2: 400 });
  assert.deepEqual(r.aqi, { index: 122, leading: 'no2' });
});

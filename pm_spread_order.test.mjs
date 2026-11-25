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

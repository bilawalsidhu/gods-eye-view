import assert from 'node:assert/strict';
import test from 'node:test';
import { stationIndex } from './src/layers/airQuality/usAqi.js';
import { interpretHourly } from './src/layers/airQuality/interpretation.js';

test('a dust-storm PM10 hour (8000 µg/m³) rates Hazardous, not implausible', () => {
  const r = stationIndex({ values: { pm10: 8000, no2: 30 } });
  // Now: PM10 excluded as 'implausible', NO2 leads with AQI 14 (Good).
  assert.equal(r.aqi?.leading, 'pm10');
  assert.ok(r.aqi.index > 500);
  const hour = interpretHourly({
    parameter: 'PM10',
    value: 8000,
    units: 'µg/m³',
    averagingMinutes: 60,
  });
  assert.equal(hour.assessment.label, 'Extremely poor');
});

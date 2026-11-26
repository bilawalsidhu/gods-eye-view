import assert from 'node:assert/strict';
import test from 'node:test';
import { interpretHourly } from './src/layers/airQuality/interpretation.js';

const hour = (coveragePercent) =>
  interpretHourly({
    parameter: 'PM2.5',
    value: 20,
    units: 'µg/m³',
    averagingMinutes: 60,
    coveragePercent,
  });

test('an hour with 75 % or more coverage is rated; below stays unrated', () => {
  // Now: 83.3 and 75 give 'The hourly average is incomplete'.
  assert.equal(hour(83.3).assessment.label, 'Moderate');
  assert.equal(hour(75).assessment.label, 'Moderate');
  assert.equal(hour(74.9).assessment.label, undefined);
  assert.equal(hour(100).assessment.label, 'Moderate');
});

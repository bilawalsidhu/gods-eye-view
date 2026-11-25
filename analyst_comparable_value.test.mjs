import assert from 'node:assert/strict';
import test from 'node:test';
import { mapAnalystRecord } from './src/layers/airQuality/model.js';

test('an unverified CPCB average is not exported as a comparable analyst value', () => {
  const cpcb = mapAnalystRecord({
    kind: 'observation',
    provider: 'cpcb',
    parameter: 'PM2.5',
    value: 123,
    units: null,
    rated: false,
  });
  // Now: value 123 with units null, sorted and thresholded beside µg/m³ values.
  assert.equal(cpcb.value, null);
});

test('a flagged hourly value is not exported as a comparable analyst value', () => {
  const flagged = mapAnalystRecord({
    kind: 'observation',
    provider: 'openaq',
    parameter: 'PM2.5',
    value: 500,
    units: 'µg/m³',
    qualityFlagged: true,
    assessment: {
      reason:
        'The source flagged this measurement; no health category is assigned.',
    },
  });
  // Now: value 500 (µg/m³), so it wins an analyst maximum.
  assert.equal(flagged.value, null);
});

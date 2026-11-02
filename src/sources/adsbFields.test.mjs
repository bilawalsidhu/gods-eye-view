import assert from 'node:assert/strict';
import test from 'node:test';
import { readAdsbVerticalRateFpm } from './adsbFields.js';

test('the barometric rate wins, a barometric 0 included', () => {
  assert.equal(
    readAdsbVerticalRateFpm({ baro_rate: -640, geom_rate: -832 }),
    -640,
  );
  assert.equal(readAdsbVerticalRateFpm({ baro_rate: 0, geom_rate: 600 }), 0);
});

test('a GNSS rate stands in when no barometric rate is usable', () => {
  for (const baro_rate of [
    undefined,
    null,
    Number.NaN,
    Infinity,
    '300',
    false,
  ]) {
    assert.equal(readAdsbVerticalRateFpm({ baro_rate, geom_rate: -832 }), -832);
  }
});

test('no usable rate reads as null', () => {
  assert.equal(readAdsbVerticalRateFpm({}), null);
  assert.equal(readAdsbVerticalRateFpm(null), null);
  assert.equal(
    readAdsbVerticalRateFpm({ baro_rate: '300', geom_rate: true }),
    null,
  );
});

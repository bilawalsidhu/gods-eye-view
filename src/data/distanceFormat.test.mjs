import assert from 'node:assert/strict';
import test from 'node:test';
import {
  distanceParts,
  formatDistanceText,
  kilometreDigits,
} from './distanceFormat.js';

test('a distance switches to kilometres where its metres round to 1,000', () => {
  assert.equal(formatDistanceText(999.4), '999 m');
  assert.equal(formatDistanceText(999.5), '1.0 km');
  assert.equal(formatDistanceText(999.6), '1.0 km');
  assert.equal(formatDistanceText(994, { metreStep: 10 }), '990 m');
  assert.equal(formatDistanceText(995, { metreStep: 10 }), '1.0 km');
});

test('kilometres drop their decimal where the tenth rounds to 10.0', () => {
  assert.equal(kilometreDigits(9949), 1);
  assert.equal(kilometreDigits(9950), 0);
  assert.equal(formatDistanceText(9949), '9.9 km');
  assert.equal(formatDistanceText(9950), '10 km');
  assert.equal(formatDistanceText(9960), '10 km');
  assert.equal(formatDistanceText(99950), '100 km');
});

test('metres below exactBelowM stay whole while the rest round to the step', () => {
  const options = { metreStep: 10, exactBelowM: 100 };
  assert.equal(formatDistanceText(8, options), '8 m');
  assert.equal(formatDistanceText(99.4, options), '99 m');
  assert.equal(formatDistanceText(846, options), '850 m');
  assert.deepEqual(distanceParts(846, options), {
    value: 850,
    unit: 'm',
    digits: 0,
  });
});

test('a negative or non-finite distance has no parts', () => {
  for (const value of [-1, Number.NaN, Infinity, -Infinity, null, undefined]) {
    assert.equal(distanceParts(value), null);
    assert.equal(formatDistanceText(value), null);
  }
  assert.equal(formatDistanceText(0), '0 m');
});

test('kilometres come back rounded, so toFixed and Intl agree', () => {
  assert.deepEqual(distanceParts(1450), { value: 1.5, unit: 'km', digits: 1 });
  assert.equal(formatDistanceText(1450), '1.5 km');
  assert.equal(formatDistanceText(1150), '1.2 km');
});

test('the imperial system reads feet below 1,000 ft, then miles', () => {
  const imperial = { system: 'imperial' };
  assert.equal(formatDistanceText(0, imperial), '0 ft');
  assert.equal(formatDistanceText(100, imperial), '328 ft');
  assert.equal(
    formatDistanceText(304.7, imperial),
    '0.2 mi',
    '999.7 ft rounds to 1,000',
  );
  assert.equal(formatDistanceText(304.5, imperial), '999 ft');
  assert.equal(formatDistanceText(305, imperial), '0.2 mi');
  assert.equal(formatDistanceText(1609.344, imperial), '1.0 mi');
  assert.equal(formatDistanceText(16_000, imperial), '9.9 mi');
  assert.equal(formatDistanceText(16_090, imperial), '10 mi');
  assert.equal(formatDistanceText(160_934.4, imperial), '100 mi');
  assert.equal(
    formatDistanceText(100, { ...imperial, metreStep: 10 }),
    '330 ft',
  );
  assert.deepEqual(distanceParts(5000, imperial), {
    value: 3.1,
    unit: 'mi',
    digits: 1,
  });
});

test('largeOnly keeps kilometres or miles below one', () => {
  assert.equal(formatDistanceText(400, { largeOnly: true }), '0.4 km');
  assert.equal(
    formatDistanceText(400, { largeOnly: true, system: 'imperial' }),
    '0.2 mi',
  );
  assert.equal(formatDistanceText(25_000, { largeOnly: true }), '25 km');
  assert.equal(
    formatDistanceText(25_000, { largeOnly: true, system: 'imperial' }),
    '16 mi',
  );
});

test('metric output is unchanged by the system option', () => {
  for (const meters of [0, 12, 999.4, 999.6, 4600, 9950, 123_456])
    assert.equal(
      formatDistanceText(meters, { system: 'metric' }),
      formatDistanceText(meters),
    );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FIRE_FILTER,
  FIRMS_CONFIDENCE_MODES,
  FRP_RAMP,
  FRP_SLIDER_TICKS,
  filterFires,
  firePassesFilter,
  frpForSliderPosition,
  frpRampStop,
  hexToRgb,
  isDefaultFireFilter,
  normalizeConfidenceMode,
  normalizeFireFilter,
  normalizeMinFrp,
  rampTrackGradient,
  sliderPositionForFrp,
} from './firmsIntensity.js';

test('the ramp has six cold → hot stops at 0 · 5 · 20 · 50 · 100 · 300 MW in Portolan hue order', () => {
  assert.deepEqual(
    FRP_RAMP.map((stop) => [stop.name, stop.minFrp, stop.hex]),
    [
      ['blue', 0, '#4a5bd4'],
      ['teal', 5, '#39a0a8'],
      ['lime', 20, '#c9cf4a'],
      ['amber', 50, '#f2b134'],
      ['orange', 100, '#e8722c'],
      ['red', 300, '#d1382a'],
    ],
  );
  assert.deepEqual([...FRP_SLIDER_TICKS], [0, 5, 20, 50, 100, 300]);
  assert.ok(Object.isFrozen(FRP_RAMP));
});

test('a detection takes the last stop it reaches; garbage reads as 0 MW', () => {
  assert.equal(frpRampStop(0).name, 'blue');
  assert.equal(frpRampStop(4.99).name, 'blue');
  assert.equal(frpRampStop(5).name, 'teal');
  assert.equal(frpRampStop(19.9).name, 'teal');
  assert.equal(frpRampStop(20).name, 'lime');
  assert.equal(frpRampStop(50).name, 'amber');
  assert.equal(frpRampStop(100).name, 'orange');
  assert.equal(frpRampStop(299.9).name, 'orange');
  assert.equal(frpRampStop(300).name, 'red');
  assert.equal(frpRampStop(1246).name, 'red');
  assert.equal(frpRampStop(NaN).name, 'blue');
  assert.equal(frpRampStop(-3).name, 'blue');
  assert.equal(frpRampStop(undefined).name, 'blue');
});

test('hex stops convert to the "r, g, b" accents the cards paint', () => {
  assert.deepEqual(hexToRgb('#4a5bd4'), [74, 91, 212]);
  assert.deepEqual(hexToRgb('d1382a'), [209, 56, 42]);
});

test('the log slider pins 0 MW at the left and runs 1 → 1000 MW; values round-trip', () => {
  assert.equal(sliderPositionForFrp(0), 0);
  assert.equal(sliderPositionForFrp(0.5), 0);
  assert.equal(sliderPositionForFrp(1), 0);
  assert.ok(Math.abs(sliderPositionForFrp(10) - 1 / 3) < 1e-9);
  assert.ok(Math.abs(sliderPositionForFrp(100) - 2 / 3) < 1e-9);
  assert.equal(sliderPositionForFrp(1000), 1);
  assert.equal(sliderPositionForFrp(5000), 1, 'clamped past the axis end');
  assert.equal(frpForSliderPosition(0), 0);
  assert.equal(frpForSliderPosition(1), 1000);
  assert.equal(frpForSliderPosition(-1), 0);
  assert.equal(frpForSliderPosition(2), 1000);
  for (const frp of FRP_SLIDER_TICKS) {
    assert.equal(
      frpForSliderPosition(sliderPositionForFrp(frp)),
      frp,
      `tick ${frp} MW round-trips through the axis`,
    );
  }
  // Ticks spread along the track instead of bunching at one end.
  const positions = FRP_SLIDER_TICKS.map(sliderPositionForFrp);
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] - positions[i - 1] >= 0.09, `tick gap ${i}`);
  }
});

test('the track gradient is the stepped ramp on the log axis, so it doubles as the legend', () => {
  const gradient = rampTrackGradient();
  assert.match(gradient, /^linear-gradient\(90deg, /);
  assert.match(gradient, /#4a5bd4 0\.00% 23\.3\d%/);
  assert.match(gradient, /#39a0a8 23\.3\d% 43\.3\d%/);
  assert.match(gradient, /#d1382a 82\.5\d% 100\.00%\)$/);
  assert.equal(gradient.match(/#/g).length, FRP_RAMP.length);
});

test('minimum FRP normalizes to whole megawatts inside the codec bounds', () => {
  assert.equal(normalizeMinFrp(0), 0);
  assert.equal(normalizeMinFrp(19.6), 20);
  assert.equal(normalizeMinFrp('100'), 100);
  assert.equal(normalizeMinFrp(10000), 10000);
  assert.equal(normalizeMinFrp(10001), null);
  assert.equal(normalizeMinFrp(-1), null);
  assert.equal(normalizeMinFrp('abc'), null);
  assert.equal(normalizeMinFrp(''), null);
  assert.equal(normalizeMinFrp(null), null);
  assert.equal(normalizeMinFrp(NaN), null);
});

test('confidence modes are exactly all / nominal / high', () => {
  assert.deepEqual([...FIRMS_CONFIDENCE_MODES], ['all', 'nominal', 'high']);
  assert.equal(normalizeConfidenceMode(' High '), 'high');
  assert.equal(normalizeConfidenceMode('nominal'), 'nominal');
  assert.equal(normalizeConfidenceMode('low'), null);
  assert.equal(normalizeConfidenceMode(0.9), null);
  assert.equal(normalizeConfidenceMode(undefined), null);
});

test('a partial filter patches the current one and invalid fields keep their value', () => {
  assert.deepEqual(normalizeFireFilter(), DEFAULT_FIRE_FILTER);
  assert.deepEqual(normalizeFireFilter({ minFrp: 20 }), {
    minFrp: 20,
    confidence: 'all',
  });
  assert.deepEqual(
    normalizeFireFilter(
      { confidence: 'high' },
      { minFrp: 50, confidence: 'all' },
    ),
    { minFrp: 50, confidence: 'high' },
  );
  assert.deepEqual(
    normalizeFireFilter(
      { minFrp: 'nope', confidence: 'medium' },
      { minFrp: 50, confidence: 'nominal' },
    ),
    { minFrp: 50, confidence: 'nominal' },
  );
  assert.equal(isDefaultFireFilter(DEFAULT_FIRE_FILTER), true);
  assert.equal(isDefaultFireFilter({ minFrp: 0, confidence: 'all' }), true);
  assert.equal(isDefaultFireFilter({ minFrp: 1, confidence: 'all' }), false);
  assert.equal(isDefaultFireFilter({ minFrp: 0, confidence: 'high' }), false);
});

test('the filter keeps a fire at or above the floor and at or above the confidence mode', () => {
  const low = { frp: 864, confidence: 0.3 };
  const nominal = { frp: 20, confidence: 0.6 };
  const high = { frp: 2, confidence: 0.9 };
  assert.equal(firePassesFilter(low), true, 'default shows everything');
  assert.equal(
    firePassesFilter(nominal, { minFrp: 20, confidence: 'all' }),
    true,
  );
  assert.equal(
    firePassesFilter(nominal, { minFrp: 21, confidence: 'all' }),
    false,
  );
  assert.equal(
    firePassesFilter(low, { minFrp: 0, confidence: 'nominal' }),
    false,
  );
  assert.equal(
    firePassesFilter(nominal, { minFrp: 0, confidence: 'nominal' }),
    true,
  );
  assert.equal(
    firePassesFilter(high, { minFrp: 0, confidence: 'nominal' }),
    true,
  );
  assert.equal(
    firePassesFilter(nominal, { minFrp: 0, confidence: 'high' }),
    false,
  );
  assert.equal(firePassesFilter(high, { minFrp: 0, confidence: 'high' }), true);
  assert.equal(
    firePassesFilter(high, { minFrp: 5, confidence: 'high' }),
    false,
  );
  // Missing numbers read as 0, never as a pass-through.
  assert.equal(firePassesFilter({}, { minFrp: 1, confidence: 'all' }), false);
  assert.equal(
    firePassesFilter({ frp: 10 }, { minFrp: 0, confidence: 'nominal' }),
    false,
  );
});

test('filterFires returns the same array for the default filter and preserves order otherwise', () => {
  const fires = [
    { frp: 864, confidence: 0.3 },
    { frp: 20, confidence: 0.6 },
    { frp: 2, confidence: 0.9 },
    { frp: 120, confidence: 0.9 },
  ];
  assert.equal(filterFires(fires), fires);
  assert.equal(filterFires(fires, { minFrp: 0, confidence: 'all' }), fires);
  assert.deepEqual(
    filterFires(fires, { minFrp: 20, confidence: 'all' }).map((f) => f.frp),
    [864, 20, 120],
  );
  assert.deepEqual(
    filterFires(fires, { minFrp: 0, confidence: 'high' }).map((f) => f.frp),
    [2, 120],
  );
  assert.deepEqual(
    filterFires(fires, { minFrp: 100, confidence: 'nominal' }).map(
      (f) => f.frp,
    ),
    [120],
  );
  assert.deepEqual(filterFires(null, { minFrp: 1, confidence: 'all' }), []);
});

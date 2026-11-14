import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COVERAGE_FAR_RADIUS_KM,
  COVERAGE_HEAT_BUCKETS,
  COVERAGE_NEAR_RADIUS_KM,
  buildTransitCoveragePoints,
  coverageColorAt,
  coverageSpotStrength,
} from './transitCoverage.js';
import { TRANSIT_ENABLED_FEEDS } from './transitFeeds.js';
import {
  ACTIVATION_ENTER_ALTITUDE_M,
  ACTIVATION_EXIT_ALTITUDE_M,
  COVERAGE_OPACITY_STOPS,
  COVERAGE_PEAK_ALPHA,
  coverageOpacityAt,
} from '../layers/transit/policy.js';

const feed = (id, lat, lon) => ({ id, center: { lat, lon } });

test('an empty registry gives no points, and a feed without a centre is skipped', () => {
  assert.deepEqual(buildTransitCoveragePoints([]), []);
  assert.deepEqual(buildTransitCoveragePoints(null), []);
  const points = buildTransitCoveragePoints([
    feed('a', 10, 10),
    { id: 'no-centre' },
    { id: 'bad', center: { lat: NaN, lon: 3 } },
  ]);
  assert.deepEqual(
    points.map((p) => p.id),
    ['a'],
  );
});

test('a lone feed is the smallest, deepest spot', () => {
  const [point] = buildTransitCoveragePoints([feed('lone', 46.8, -100.8)]);
  assert.equal(point.neighbours, 0);
  assert.equal(point.heat, 0);
  assert.equal(point.bucket, 0);
  assert.equal(point.strength, 1);
  assert.equal(point.farRadiusKm, COVERAGE_FAR_RADIUS_KM.lone);
  assert.deepEqual(point.rgb, coverageColorAt(0));
});

test('a lone feed looks the same however dense the busiest region is', () => {
  const lone = feed('lone', 46.8, -100.8);
  const cluster = Array.from({ length: 40 }, (_, i) =>
    feed(`c${i}`, 48 + (i % 8) * 0.1, 2 + Math.floor(i / 8) * 0.1),
  );
  const alone = buildTransitCoveragePoints([lone])[0];
  const crowded = buildTransitCoveragePoints([lone, ...cluster]);
  assert.deepEqual(
    crowded.find((p) => p.id === 'lone'),
    alone,
  );
  const hottest = crowded.find((p) => p.id === 'c0');
  assert.equal(hottest.neighbours, 39);
  assert.equal(hottest.heat, 1);
  assert.equal(hottest.bucket, COVERAGE_HEAT_BUCKETS - 1);
  assert.equal(hottest.farRadiusKm, COVERAGE_FAR_RADIUS_KM.dense);
  assert.ok(hottest.strength < 1, 'a spot in a crowd is thinner');
});

test('a spot in a crowd is thinner, so a cluster sums smoothly instead of clipping', () => {
  assert.equal(coverageSpotStrength(0), 1);
  assert.equal(coverageSpotStrength(-3), 1);
  assert.equal(coverageSpotStrength(NaN), 1);
  let previous = 1;
  for (const crowd of [1, 3, 8, 15, 28, 100]) {
    const strength = coverageSpotStrength(crowd);
    assert.ok(strength < previous, `thinner with ${crowd} neighbours`);
    assert.ok(strength > 0.3, 'never invisible');
    // The crowd as a whole still outshines a lone feed.
    assert.ok(strength * (1 + crowd) > 1);
    previous = strength;
  }
  const [lone] = buildTransitCoveragePoints([feed('lone', 0, 0)]);
  assert.equal(lone.strength, 1);
});

test('neighbours are counted by distance, across the antimeridian too', () => {
  const points = buildTransitCoveragePoints([
    feed('west', 0, 179.8),
    feed('east', 0, -179.8),
    feed('far', 0, 170),
  ]);
  const by = Object.fromEntries(points.map((p) => [p.id, p.neighbours]));
  assert.deepEqual(by, { west: 1, east: 1, far: 0 });
});

test('the palette runs from the lone green to a pale core and clamps', () => {
  assert.deepEqual(coverageColorAt(-1), coverageColorAt(0));
  assert.deepEqual(coverageColorAt(2), coverageColorAt(1));
  assert.deepEqual(coverageColorAt(NaN), coverageColorAt(0));
  const brightness = (t) => coverageColorAt(t).reduce((a, b) => a + b, 0);
  let previous = 0;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    assert.ok(brightness(t) >= previous, `does not darken at ${t.toFixed(1)}`);
    previous = brightness(t);
  }
});

test('a feed whose live positions have not been seen gets no spot', () => {
  const points = buildTransitCoveragePoints([
    feed('seen', 10, 10),
    { ...feed('unseen', 10.1, 10.1), liveSeen: false },
  ]);
  assert.deepEqual(
    points.map((p) => p.id),
    ['seen'],
  );
  assert.equal(points[0].neighbours, 0, 'an unseen feed is not a neighbour');
  // The registry's own unconfirmed rows stay out; the confirmed ones are in.
  const unseen = TRANSIT_ENABLED_FEEDS.filter((f) => f.liveSeen === false);
  assert.ok(unseen.length > 0);
  const real = new Set(
    buildTransitCoveragePoints(TRANSIT_ENABLED_FEEDS).map((p) => p.id),
  );
  for (const row of unseen) assert.equal(real.has(row.id), false, row.id);
  assert.ok(real.has('kumamoto-toshi-bus'));
  assert.ok(real.has('sendai-city-bus'));
});

test('every feed seen live gets exactly one spot, and dense regions read hotter', () => {
  const points = buildTransitCoveragePoints(TRANSIT_ENABLED_FEEDS);
  assert.equal(
    points.length,
    TRANSIT_ENABLED_FEEDS.filter((f) => f.liveSeen !== false).length,
  );
  assert.equal(new Set(points.map((p) => p.id)).size, points.length);
  const heat = (id) => points.find((p) => p.id === id).heat;
  assert.ok(heat('axo-creil') > heat('mbta'), 'the Oise outranks Boston');
  for (const point of points) {
    assert.ok(point.heat >= 0 && point.heat <= 1);
    assert.ok(
      point.farRadiusKm >= COVERAGE_FAR_RADIUS_KM.lone &&
        point.farRadiusKm <= COVERAGE_FAR_RADIUS_KM.dense,
    );
    assert.ok(
      point.nearRadiusKm >= COVERAGE_NEAR_RADIUS_KM.min &&
        point.nearRadiusKm <= COVERAGE_NEAR_RADIUS_KM.max,
    );
    assert.ok(point.bucket >= 0 && point.bucket < COVERAGE_HEAT_BUCKETS);
  }
});

test('a regional patch is the feed’s own service area, within bounds', () => {
  const at = (loadRadiusKm) =>
    buildTransitCoveragePoints([{ ...feed('f', 0, 0), loadRadiusKm }])[0]
      .nearRadiusKm;
  assert.equal(at(30), 30);
  assert.equal(at(5), COVERAGE_NEAR_RADIUS_KM.min);
  assert.equal(at(210), COVERAGE_NEAR_RADIUS_KM.max);
  assert.equal(at(undefined), COVERAGE_NEAR_RADIUS_KM.min);
});

test('wide spots own the globe view, service-area patches the regional view, and they overlap', () => {
  const far = (h) => coverageOpacityAt(h, 'far');
  const near = (h) => coverageOpacityAt(h, 'near');
  assert.equal(far(20_000_000), 1);
  assert.equal(far(Infinity), 1);
  assert.equal(near(20_000_000), 0);
  assert.equal(far(500_000), 0);
  assert.ok(near(500_000) >= 0.5);
  assert.equal(far(0), 0);
  assert.equal(near(0), 0);
  assert.equal(near(60_000), 0, 'off close in, where vehicles are the picture');
  assert.equal(far(NaN), 0);
  assert.equal(near(NaN), 0);
  assert.equal(coverageOpacityAt(20_000_000), 1, 'the default set is far');
  // From 250 km up there is never a height with nothing drawn, and the
  // cross-fade has no dip: the two sets together stay well visible.
  for (let h = 250_000; h <= 6_000_000; h += 25_000) {
    assert.ok(far(h) + near(h) >= 0.45, `visible at ${h / 1000} km`);
  }
  // Both sides of the altitude gate are covered.
  assert.ok(
    far(ACTIVATION_ENTER_ALTITUDE_M) + near(ACTIVATION_ENTER_ALTITUDE_M) > 0.5,
  );
  assert.ok(far(ACTIVATION_EXIT_ALTITUDE_M) > 0.5);
  // The far set only grows with height.
  let previous = 0;
  for (let h = 0; h <= 4_000_000; h += 20_000) {
    assert.ok(far(h) >= previous, `far opacity does not fall at ${h} m`);
    previous = far(h);
  }
  assert.ok(COVERAGE_PEAK_ALPHA > 0.5 && COVERAGE_PEAK_ALPHA <= 1);
  assert.equal(COVERAGE_OPACITY_STOPS.far.at(-1)[1], 1);
});

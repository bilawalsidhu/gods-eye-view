import test from 'node:test';
import assert from 'node:assert/strict';
import {
  areaMetricScore,
  weightedAreaIndex,
  summarizeServices,
  finiteValue,
} from './areaAssessment.js';

test('unknown data, sentinel values and incomplete OSM never score as zero or good', () => {
  assert.equal(finiteValue(null), null);
  assert.equal(finiteValue(''), null);
  assert.equal(
    areaMetricScore('air', { status: 'available', aqi: null }),
    null,
  );
  assert.equal(
    areaMetricScore(
      'housing',
      { status: 'available', value: -666666666 },
      400000,
    ),
    null,
  );
  assert.equal(
    areaMetricScore('housing', { status: 'available', value: 200000 }, 0),
    null,
  );
  assert.equal(
    areaMetricScore('seismic', { status: 'unavailable', pga: 0 }),
    null,
  );
  assert.equal(
    areaMetricScore('services', {
      status: 'available',
      nearest: {},
      complete: true,
    }),
    null,
  );
});

test('composite excludes deselected/zero weights and reports missing selected weight', () => {
  const observations = {
    air: { status: 'available', aqi: 60 },
    seismic: { status: 'available', pga: 0.3 },
    housing: { status: 'unavailable' },
  };
  const selection = {
    air: { selected: true, weight: 1 },
    seismic: { selected: true, weight: 3 },
    housing: { selected: true, weight: 4 },
  };
  const result = weightedAreaIndex(observations, selection);
  assert.equal(result.score, 28.75);
  assert.equal(result.coverage, 0.5);
  assert.deepEqual(result.missing, ['housing']);
  selection.seismic.selected = false;
  selection.housing.weight = 0;
  assert.equal(weightedAreaIndex(observations, selection).score, 80);
  selection.air.weight = 0;
  assert.equal(weightedAreaIndex(observations, selection).score, null);
});

test('housing budget uses original units and monotonic preference, not resident wealth', () => {
  const observations = {
    housing: { status: 'available', value: 5000, unit: 'EUR/m²' },
  };
  const selection = { housing: { selected: true, weight: 1 } };
  assert.equal(
    weightedAreaIndex(observations, selection, { 'EUR/m²': 5000 }).score,
    50,
  );
  assert.equal(
    weightedAreaIndex(observations, selection, { 'USD/home': 5000 }).score,
    0,
  );
  assert.ok(
    Math.abs(
      areaMetricScore('housing', observations.housing, 10000) - 200 / 3,
    ) < 1e-9,
  );
  assert.ok(
    areaMetricScore('housing', { status: 'available', value: 8550 }, 4000) > 30,
  );
});

test('services deduplicate POIs, respect radius, use nearest of all four categories', () => {
  const point = { lat: 0, lon: 0 };
  const elements = [
    { type: 'node', id: 1, lat: 0, lon: 0, tags: { amenity: 'hospital' } },
    { type: 'node', id: 1, lat: 0, lon: 0, tags: { amenity: 'hospital' } },
    {
      type: 'way',
      id: 2,
      center: { lat: 0, lon: 0.001 },
      tags: { amenity: 'school' },
    },
    { type: 'node', id: 3, lat: 0, lon: 0.002, tags: { shop: 'supermarket' } },
    { type: 'node', id: 4, lat: 0, lon: 0.003, tags: { highway: 'bus_stop' } },
    { type: 'node', id: 5, lat: 1, lon: 1, tags: { shop: 'supermarket' } },
  ];
  const result = summarizeServices(elements, point);
  assert.equal(result.mappedCount, 4);
  assert.equal(result.nearest.health.distanceM, 0);
  const observation = { ...result, status: 'available', complete: true };
  assert.ok(areaMetricScore('services', observation) > 90);
  observation.complete = false;
  assert.equal(areaMetricScore('services', observation), null);
});

test('AQI and hazard preference scores are bounded and monotonic', () => {
  assert.equal(areaMetricScore('air', { status: 'available', aqi: 500 }), 0);
  assert.equal(
    areaMetricScore('seismic', { status: 'available', pga: 0 }),
    100,
  );
  assert.equal(
    areaMetricScore('seismic', { status: 'available', pga: 0.9 }),
    0,
  );
});

test('map result colors clamp endpoints and keep unavailable distinct from zero', async () => {
  const { areaScoreColor } = await import('./areaAssessment.js');
  assert.equal(areaScoreColor(0), '#f87171');
  assert.equal(areaScoreColor(50), '#facc15');
  assert.equal(areaScoreColor(100), '#4ade80');
  assert.equal(areaScoreColor(-1), areaScoreColor(0));
  assert.equal(areaScoreColor(120), areaScoreColor(100));
  assert.equal(areaScoreColor(null), '#94a3b8');
  assert.notEqual(areaScoreColor(25), areaScoreColor(75));
});

test('nearby ranking rejects incomplete high scores and favors nearest comparable result', async () => {
  const {
    rankNearbyAreas,
    nearbyAreaPoints,
    pointDistanceM,
    servicesAtCandidate,
  } = await import('./areaAssessment.js');
  const origin = { lat: 41.9, lon: 12.5 };
  const selection = {
    air: { selected: true, weight: 1 },
    housing: { selected: true, weight: 1 },
  };
  const candidate = (lon, aqi, housing = true) => ({
    point: { lat: 41.9, lon },
    observations: {
      air: { status: 'available', aqi },
      housing: housing
        ? { status: 'available', value: 4000, unit: 'EUR/m²' }
        : { status: 'unavailable' },
    },
  });
  const candidates = [
    candidate(12.5, 60),
    candidate(12.501, 51),
    candidate(12.52, 45),
    candidate(12.5001, 0, false),
  ];
  const ranked = rankNearbyAreas(
    candidates,
    origin,
    selection,
    { 'EUR/m²': 4000 },
    2,
  );
  assert.equal(ranked.best.point.lon, 12.501);
  assert.equal(ranked.eligible.length, 3);
  assert.equal(
    rankNearbyAreas(candidates, origin, selection, { 'EUR/m²': 4000 }, 0).best
      .point.lon,
    12.52,
  );
  const points = nearbyAreaPoints(origin, 1500);
  assert.equal(points.length, 9);
  assert.ok(points.every((p) => pointDistanceM(origin, p) <= 1500.001));
  const source = {
    status: 'available',
    complete: true,
    pois: [
      { lat: 41.9, lon: 12.5, category: 'health', name: 'Actual hospital' },
    ],
  };
  const rebased = servicesAtCandidate(source, { lat: 41.9, lon: 12.501 });
  assert.ok(rebased.nearest.health.distanceM > 80);
  assert.equal(rebased.sample, true);
  assert.equal(areaMetricScore('services', rebased), null);
});

test('missing housing and service data lower the judgment with their selected weights', () => {
  const selection = {
    air: { selected: true, weight: 1 },
    housing: { selected: true, weight: 2 },
    services: { selected: true, weight: 1 },
  };
  const observations = {
    air: { status: 'available', aqi: 0 },
    housing: { status: 'unavailable', reason: 'No quotation found' },
    services: { status: 'available', complete: true, nearest: {} },
  };
  const result = weightedAreaIndex(observations, selection);
  assert.equal(result.score, 25);
  assert.equal(result.coverage, 0.25);
  assert.deepEqual(result.missing, ['housing', 'services']);
  selection.housing.weight = 4;
  assert.ok(weightedAreaIndex(observations, selection).score < result.score);
  observations.air = { status: 'unavailable' };
  assert.equal(weightedAreaIndex(observations, selection).score, 0);
  selection.air.selected = false;
  selection.housing.selected = false;
  selection.services.selected = false;
  assert.equal(weightedAreaIndex(observations, selection).score, null);
});

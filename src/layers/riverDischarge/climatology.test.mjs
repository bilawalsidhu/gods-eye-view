import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dischargeClimatology,
  glofasCellCentre,
  glofasNeighbourhood,
  haversineKm,
  openMeteoCallWeight,
  percentileSorted,
  pickRiverCell,
  roundDischarge,
  sampleRiverPoints,
} from './climatology.js';

test('points snap to GloFAS 0.05° cell centres, boundaries included', () => {
  assert.equal(glofasCellCentre(51.05), 51.075);
  assert.equal(glofasCellCentre(51.0499), 51.025);
  assert.equal(glofasCellCentre(13.74), 13.725);
  assert.equal(glofasCellCentre(-0.01), -0.025);
  assert.equal(glofasCellCentre(-55.51), -55.525);
  assert.throws(() => glofasCellCentre(NaN), RangeError);
});

test('the neighbourhood is the 3×3 block of cell centres, centre first', () => {
  const cells = glofasNeighbourhood(51.05, 13.74);
  assert.equal(cells.length, 9);
  assert.deepEqual(cells[0], { latitude: 51.075, longitude: 13.725 });
  const lats = [...new Set(cells.map((c) => c.latitude))].sort();
  const lons = [...new Set(cells.map((c) => c.longitude))].sort();
  assert.deepEqual(lats, [51.025, 51.075, 51.125]);
  assert.deepEqual(lons, [13.675, 13.725, 13.775]);
  // Across the antimeridian longitudes wrap instead of leaving ±180.
  const east = glofasNeighbourhood(10, 179.99);
  assert.ok(east.every((c) => c.longitude >= -180 && c.longitude <= 180));
  assert.ok(east.some((c) => c.longitude === -179.975));
  assert.equal(glofasNeighbourhood(0, 0, 0).length, 1);
  assert.throws(() => glofasNeighbourhood(0, 0, 4), RangeError);
});

test('snapping keeps the largest mean flow and drops a neighbourhood with no river', () => {
  // Measured 140-day means around Dresden: the nearest cell is a 0.4 m³/s
  // side stream; the Elbe main stem is one cell away.
  const near = (latitude, longitude, mean) => ({
    latitude,
    longitude,
    values: [mean * 0.9, mean, mean * 1.1, null],
  });
  const picked = pickRiverCell([
    near(51.075, 13.725, 0.4),
    near(51.075, 13.675, 341),
    near(51.025, 13.775, 3),
    near(51.125, 13.725, 342.1),
    { latitude: 51.125, longitude: 13.775, values: [null, null] },
  ]);
  assert.equal(picked.latitude, 51.125);
  assert.equal(picked.longitude, 13.725);
  assert.ok(Math.abs(picked.mean - 342.1) < 1e-9);
  assert.equal('values' in picked, false);
  assert.equal(pickRiverCell([near(1.025, 1.025, 9.9)]), null);
  assert.equal(
    pickRiverCell([near(1.025, 1.025, 9.9)], { minMean: 5 }).latitude,
    1.025,
  );
  assert.equal(pickRiverCell([]), null);
});

test('percentiles interpolate linearly between ranks (NumPy default)', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentileSorted(sorted, 0), 1);
  assert.equal(percentileSorted(sorted, 100), 10);
  assert.equal(percentileSorted(sorted, 50), 5.5);
  assert.ok(Math.abs(percentileSorted(sorted, 90) - 9.1) < 1e-12);
  assert.ok(Math.abs(percentileSorted(sorted, 99) - 9.91) < 1e-12);
  assert.equal(percentileSorted([], 50), null);
  assert.throws(() => percentileSorted(sorted, 101), RangeError);
});

test('climatology needs 90% of days and reports rounded percentiles', () => {
  const days = Array.from({ length: 1000 }, (_, i) => i + 1);
  const climate = dischargeClimatology(days);
  assert.deepEqual(climate, {
    days: 1000,
    mean: 501,
    p50: 501,
    p90: 900,
    p99: 990,
    max: 1000,
  });
  const thin = days.map((v, i) => (i % 5 === 0 ? null : v));
  assert.equal(dischargeClimatology(thin), null);
  assert.ok(dischargeClimatology(thin, { minCoverage: 0.75 }));
  assert.equal(dischargeClimatology([]), null);
  assert.equal(dischargeClimatology([-1, -2]), null);
});

test('discharge rounding keeps three significant figures, and small flows readable', () => {
  assert.equal(roundDischarge(276003.6), 276004);
  assert.equal(roundDischarge(342.14), 342);
  assert.equal(roundDischarge(48.55), 48.6);
  assert.equal(roundDischarge(0.3249), 0.325);
  assert.equal(roundDischarge(0), 0);
  assert.equal(roundDischarge(Infinity), null);
});

test('call weight follows Open-Meteo’s published formula', () => {
  // The pricing page's worked examples: 15 variables over 2 and 4 weeks.
  assert.equal(
    openMeteoCallWeight({ locations: 1, days: 14, variables: 15 }),
    1.5,
  );
  assert.equal(
    openMeteoCallWeight({ locations: 1, days: 28, variables: 15 }),
    3,
  );
  // One daily variable: 140 days fit in one call; ten years cost 26.09.
  assert.equal(openMeteoCallWeight({ locations: 1, days: 140 }), 1);
  assert.equal(openMeteoCallWeight({ locations: 9, days: 140 }), 9);
  assert.equal(
    openMeteoCallWeight({ locations: 1, days: 3652 }).toFixed(2),
    '26.09',
  );
  // The live forecast: six variables over nine days is one call a location.
  assert.equal(
    openMeteoCallWeight({ locations: 50, days: 9, variables: 6 }),
    50,
  );
  assert.throws(
    () => openMeteoCallWeight({ locations: 0, days: 1 }),
    RangeError,
  );
});

test('river sampling spaces points, names rivers and lets prominent rivers claim first', () => {
  const line = (name, scalerank, coordinates, featurecla = 'River') => ({
    type: 'Feature',
    properties: { name, name_en: name, scalerank, featurecla },
    geometry: { type: 'LineString', coordinates },
  });
  // ~1,112 km of meridian; a 500 km spacing yields points at 250 and 750 km.
  const big = line('Big', 1, [
    [10, 0],
    [10, 10],
  ]);
  const minor = line('Minor', 4, [
    [10.5, 2],
    [10.5, 3],
  ]);
  const far = line('Far', 4, [
    [40, 0],
    [40, 0.5],
  ]);
  const lake = line(
    'Lake',
    1,
    [
      [60, 0],
      [60, 5],
    ],
    'Lake Centerline',
  );
  const unnamed = line('', 1, [
    [80, 0],
    [80, 5],
  ]);
  const coarse = line('Coarse', 8, [
    [100, 0],
    [100, 5],
  ]);
  const points = sampleRiverPoints([minor, far, big, lake, unnamed, coarse], {
    maxScalerank: 5,
    spacingKm: 500,
    minSeparationKm: 300,
    maxPoints: 10,
  });
  assert.deepEqual(
    points.map((p) => p.name),
    ['Big', 'Big', 'Far'],
  );
  assert.ok(Math.abs(haversineKm([10, 0], points[0].position) - 250) < 1);
  assert.ok(Math.abs(haversineKm([10, 0], points[1].position) - 750) < 1);
  // A river shorter than one spacing keeps its midpoint.
  assert.ok(Math.abs(points[2].position[1] - 0.25) < 1e-3);
  assert.equal(
    sampleRiverPoints([big, far], { spacingKm: 500, maxPoints: 1 }).length,
    1,
  );
});

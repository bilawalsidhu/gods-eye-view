import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.js';
import { VIEWPORT_PRIORITY_MARGIN, MIN_CENTER_SHIFT_KM } from './policy.js';

/**
 * The allocator needs only the density inputs of `computeDotCount`, so the
 * model is constructed against the smallest state that makes those inputs
 * explicit rather than against a whole layer.
 */
function allocator({ densityScale = 1, liveMode = false } = {}) {
  return createModel({
    state: {
      _liveMode: liveMode,
      _densityScale: densityScale,
      _uncoveredMode: 'sim',
    },
    services: {},
    parts: { style: { jamDensityOn: () => false } },
    source: {},
  });
}

/** A straight two-point road; length drives the ideal dot count. */
function road(type, from, to, extra) {
  return { type, coords: [from, to], ...extra };
}

/** Sum of an allocation, i.e. the dots the render pass will actually spawn. */
function total(budgets) {
  return budgets.reduce((sum, value) => sum + value, 0);
}

// `computeDotCount` is max(1, floor(lengthM / spacing * DENSITY_MULT *
// _densityScale * flowMult)), and `estimateRoadLengthDeg` measures a flat
// degree distance times 111 000 with no cos(lat) term. At 2 000 m the spacing
// is 80 m, `primary` carries a 2.0 multiplier, and these fixtures keep
// _densityScale at 1 with no flow, so a road of L degrees asks for
// floor(L * 111000 / 80 * 2) = floor(L * 2775) dots — above 1 in every fixture
// here, so the clamp never engages.
const ALTITUDE = 2000;
const VIEW = { south: 0, west: 0, north: 0.01, east: 0.01 };

test('no viewport allocates exactly as the demand-only algorithm did', () => {
  const { allocateRoadDotBudgets, computeDotCount } = allocator();
  const roads = [
    road('primary', [0.001, 0.001], [0.009, 0.001]),
    road('primary', [0.02, 0.001], [0.03, 0.001]),
  ];
  assert.deepEqual(
    roads.map((r) => computeDotCount(r, ALTITUDE)),
    [22, 27],
    'the fixture must pin the demand the rest of the file reasons about',
  );
  assert.deepEqual(
    allocateRoadDotBudgets(roads, ALTITUDE, 30),
    [14, 16],
    'without a rectangle the split is the demand-only one this replaced',
  );
});

test('a viewport containing every road changes nothing', () => {
  const { allocateRoadDotBudgets } = allocator();
  const roads = [
    road('primary', [0.001, 0.001], [0.009, 0.001]),
    road('primary', [0.002, 0.002], [0.008, 0.002]),
  ];
  assert.deepEqual(
    allocateRoadDotBudgets(roads, ALTITUDE, 30, VIEW),
    allocateRoadDotBudgets(roads, ALTITUDE, 30),
    'one uniform tier must allocate exactly as no tier does',
  );
});

test('a viewport containing no road changes nothing', () => {
  const { allocateRoadDotBudgets } = allocator();
  const roads = [
    road('primary', [5.001, 5.001], [5.009, 5.001]),
    road('primary', [5.02, 5.001], [5.03, 5.001]),
  ];
  assert.deepEqual(
    allocateRoadDotBudgets(roads, ALTITUDE, 30, VIEW),
    allocateRoadDotBudgets(roads, ALTITUDE, 30),
    'an empty visible tier must hand its whole budget to the rest',
  );
});

test('visible roads reach their ideal before an off-screen road grows', () => {
  const { allocateRoadDotBudgets } = allocator();
  const roads = [
    road('primary', [0.001, 0.001], [0.009, 0.001]), // inside the rectangle
    road('primary', [0.02, 0.001], [0.03, 0.001]), // beyond the margin ring
  ];
  const demandOnly = allocateRoadDotBudgets(roads, ALTITUDE, 30);
  const prioritized = allocateRoadDotBudgets(roads, ALTITUDE, 30, VIEW);
  assert.deepEqual(
    prioritized,
    [22, 8],
    'the visible road should reach its full 22 before the other grows',
  );
  assert.equal(
    total(prioritized),
    total(demandOnly),
    'prioritizing must move dots, never create or destroy them',
  );
});

test('a cap smaller than the road count seeds the visible roads', () => {
  const { allocateRoadDotBudgets } = allocator();
  const roads = [
    road('primary', [0.05, 0.05], [0.09, 0.05]), // off screen, high demand
    road('primary', [0.05, 0.06], [0.09, 0.06]), // off screen, high demand
    road('primary', [0.002, 0.002], [0.004, 0.002]), // on screen, low demand
    road('primary', [0.002, 0.003], [0.004, 0.003]), // on screen, low demand
  ];
  assert.deepEqual(
    allocateRoadDotBudgets(roads, ALTITUDE, 2),
    [1, 1, 0, 0],
    'demand order alone seeds whichever roads the response listed first',
  );
  assert.deepEqual(
    allocateRoadDotBudgets(roads, ALTITUDE, 2, VIEW),
    [0, 0, 1, 1],
    'a scarce cap must light up what the camera is pointing at, which means ' +
      'the off-screen roads lose the seed they used to get',
  );
});

test('a closed road in frame consumes no budget', () => {
  const { allocateRoadDotBudgets, computeDotCount } = allocator({
    liveMode: true,
  });
  const closed = road('primary', [0.002, 0.001], [0.004, 0.001], {
    flow: { closure: true, level: 0 },
  });
  const roads = [
    closed,
    road('primary', [0.001, 0.002], [0.009, 0.002]),
    road('primary', [0.002, 0.003], [0.005, 0.003]),
  ];
  assert.equal(
    computeDotCount(closed, ALTITUDE),
    0,
    'the fixture must actually exercise the zero-demand path',
  );
  const budgets = allocateRoadDotBudgets(roads, ALTITUDE, 10, VIEW);
  assert.equal(budgets[0], 0, 'a closed road must stay dark');
  assert.equal(
    total(budgets),
    10,
    'its share must go to the other visible roads, not be lost',
  );
});

test('the margin ring keeps roads a small pan will reveal', () => {
  const { allocateRoadDotBudgets } = allocator();
  // A rectangle wide enough that the proportional ring, not the distance
  // floor, decides — this test owns the proportional branch and the next one
  // owns the floor. The epsilon keeps both outside roads strictly beyond a
  // zero-width ring, where the rectangle edge itself would still count.
  const wide = { south: 0, west: 0, north: 0.1, east: 0.1 };
  const ring = (wide.east - wide.west) * VIEWPORT_PRIORITY_MARGIN;
  const from = (offset) =>
    road(
      'primary',
      [wide.east + offset + 1e-6, 0.001],
      [wide.east + offset + 0.002, 0.001],
    );
  const insideRing = from(ring * 0.5);
  const beyondRing = from(ring * 2);
  const onScreen = road('primary', [0.002, 0.001], [0.004, 0.001]);
  const budgets = allocateRoadDotBudgets(
    [beyondRing, insideRing, onScreen],
    ALTITUDE,
    12,
    wide,
  );
  assert.ok(
    budgets[1] > budgets[0],
    `a road inside the ring must outrank one beyond it, got ${JSON.stringify(budgets)}`,
  );
  assert.equal(
    budgets[1],
    budgets[2],
    'the ring shares the visible tier rather than forming a third rank',
  );
});

test('the ring is never narrower than the pan that skips re-allocation', () => {
  const { allocateRoadDotBudgets } = allocator();
  // A low near-nadir camera: the rectangle is small, so the proportional ring
  // is a few tens of metres while `onCameraChanged` skips re-allocating
  // entirely for a pan of up to MIN_CENTER_SHIFT_KM. Roads inside that
  // distance must already be budgeted when it arrives.
  const small = { south: 0, west: 0, north: 0.002, east: 0.002 };
  const proportional = (small.east - small.west) * VIEWPORT_PRIORITY_MARGIN;
  const floorDeg = (MIN_CENTER_SHIFT_KM * 1000) / 111000;
  assert.ok(
    proportional < floorDeg,
    'the fixture must put the proportional ring under the floor',
  );
  const onScreen = road('primary', [0.0005, 0.001], [0.0015, 0.001]);
  const withinPan = road('primary', [0.003, 0.001], [0.005, 0.001]);
  const beyondPan = road('primary', [0.008, 0.001], [0.01, 0.001]);
  const budgets = allocateRoadDotBudgets(
    [onScreen, withinPan, beyondPan],
    ALTITUDE,
    8,
    small,
  );
  assert.ok(
    budgets[1] > budgets[2],
    `a road one tolerated pan away must outrank one further out, got ${JSON.stringify(budgets)}`,
  );
});

test('a wrapped or degenerate rectangle falls back to demand-only order', () => {
  const { allocateRoadDotBudgets } = allocator();
  // The first road lies exactly on the degenerate latitude below, so an
  // unguarded rectangle would sort the two roads into different tiers. Without
  // that, every road lands in the same tier — and one uniform tier allocates
  // identically to no rectangle at all, which would leave this unable to fail.
  const roads = [
    road('primary', [0, 0.01], [0.008, 0.01]),
    road('primary', [0.02, 0.001], [0.03, 0.001]),
  ];
  const demandOnly = allocateRoadDotBudgets(roads, ALTITUDE, 30);
  assert.deepEqual(
    allocateRoadDotBudgets(roads, ALTITUDE, 30, {
      south: 0.01,
      west: 0,
      north: 0.01,
      east: 0.01,
    }),
    demandOnly,
    'a rectangle with no height must opt out rather than tier on a line',
  );
  // West of east is how Cesium reports a rectangle crossing the antimeridian.
  // The guard states that intent; the negative margin would already empty the
  // interval, so this pins the outcome, not the branch that produces it.
  assert.deepEqual(
    allocateRoadDotBudgets(roads, ALTITUDE, 30, {
      south: 0,
      west: 179.99,
      north: 0.01,
      east: -179.99,
    }),
    demandOnly,
    'a wrapped rectangle must not reorder the allocation',
  );
});

test('an uncapped budget still reaches every road', () => {
  const { allocateRoadDotBudgets, computeDotCount } = allocator();
  const roads = [
    road('primary', [0.001, 0.001], [0.009, 0.001]),
    road('primary', [0.02, 0.001], [0.03, 0.001]),
  ];
  assert.deepEqual(
    allocateRoadDotBudgets(roads, ALTITUDE, 10_000, VIEW),
    roads.map((r) => computeDotCount(r, ALTITUDE)),
    'with budget to spare every road must reach its ideal, tier or not',
  );
});

test('priority survives the real Overpass parse, not just hand-built roads', () => {
  // The fixtures above build `coords` directly. If `parseRoads` ever stopped
  // emitting it, `roadsWithinView` would flag every road false and the whole
  // feature would go quietly back to demand-only with the suite still green.
  const { parseRoads, allocateRoadDotBudgets } = allocator();
  const roads = parseRoads({
    roads: [
      {
        type: 'primary',
        coordinates: [
          [-73.98, 40.75],
          [-73.972, 40.75],
        ],
        oneway: false,
      },
      {
        type: 'primary',
        coordinates: [
          [-73.9, 40.75],
          [-73.89, 40.75],
        ],
        oneway: false,
      },
    ],
  });
  assert.deepEqual(
    roads.map((r) => r.coords[0]),
    [
      [-73.98, 40.75],
      [-73.9, 40.75],
    ],
    'parsed roads must carry [lon, lat] degree pairs',
  );
  assert.deepEqual(
    allocateRoadDotBudgets(roads, ALTITUDE, 30),
    [14, 16],
    'the parsed fixture must reproduce the demand-only split',
  );
  assert.deepEqual(
    allocateRoadDotBudgets(roads, ALTITUDE, 30, {
      south: 40.745,
      west: -73.985,
      north: 40.755,
      east: -73.975,
    }),
    [22, 8],
    'a rectangle over the first road must prioritize it',
  );
});

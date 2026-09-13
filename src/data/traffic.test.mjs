// src/data/traffic.test.mjs
// Feed-state honesty for the traffic layer (roadmap L7), plus the pure
// geometry/budget/query internals behind the simulated dots.
//
// A launch-day stranger runs a keyless build. The layer then simulates
// traffic, and every surface it drives — the toggle chip, the panel meta
// line, the traffic sync chip — has to say so. The two pure helpers below own
// that contract; the layer's getStats() is a thin caller. The `_internals`
// battery locks the deterministic math the dots are built from: Overpass
// query shape, road parsing (sub-sampling, one-way semantics), dot budgets
// (fairness + cap), and viewport geometry. All of it runs keyless and
// offline: parseRoads' terrain sample no-ops without a viewer.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import trafficLayer, {
  deriveTrafficFlowError,
  trafficFeedPresentation,
  _trafficInternalsForTest as _internals,
} from './traffic.js';
import { DataLayerManager, layerFeedState } from './manager.js';

/**
 * The app's live markers. Case-SENSITIVE on purpose: uppercase LIVE/GPS is
 * how this UI asserts a real feed ("LIVE · TomTom flow", the old "initiating
 * global GPS sync"), while lowercase "add TomTom key for live" names the
 * remedy without claiming one.
 */
const LIVE_CLAIM = /\bLIVE\b|\bGPS\b|\breal[- ]?time\b/;

test('a superseded flow fetch is not an outage', () => {
  assert.equal(deriveTrafficFlowError({ name: 'AbortError', message: 'aborted' }), null);
  assert.equal(deriveTrafficFlowError(null), null);
  assert.equal(deriveTrafficFlowError(undefined), null);
});

test('flow failures map onto short, specific reasons', () => {
  const reason = (message) => deriveTrafficFlowError(new Error(message));
  assert.equal(reason('flow tile 12/1/1: HTTP 503'), 'TomTom key unavailable');
  assert.equal(reason('flow tile 12/1/1: HTTP 429'), 'TomTom daily budget reached');
  assert.equal(reason('flow tile 12/1/1: HTTP 502'), 'TomTom upstream unreachable');
  assert.equal(reason('flow tile 12/1/1: HTTP 504'), 'TomTom upstream unreachable');
  assert.equal(reason('flow tile 12/1/1: HTTP 418'), 'TomTom flow error (HTTP 418)');
  assert.equal(reason('flow fetch failed'), 'TomTom flow unavailable');
});

test('keyless traffic names the mode and the remedy, loading or idle', () => {
  const idle = trafficFeedPresentation({ liveMode: false, fetching: false });
  const loading = trafficFeedPresentation({ liveMode: false, fetching: true });
  assert.equal(idle.mode, 'sim');
  assert.equal(loading.mode, 'sim');
  // Keyless is a designed fallback, not a fault — no error, or every keyless
  // build would boot with a red chip.
  assert.equal(idle.error, null);
  assert.equal(loading.error, null);
  // One terse line in both states; the chip's progress text carries "working".
  assert.equal(idle.loadingLabel, 'SIMULATED — add TomTom key for live');
  assert.equal(loading.loadingLabel, 'SIMULATED — add TomTom key for live');
});

test('no keyless label ever implies a live feed', () => {
  const labels = [
    trafficFeedPresentation({ liveMode: false, fetching: false }),
    trafficFeedPresentation({ liveMode: false, fetching: true }),
    trafficFeedPresentation({ statusUnavailable: true }),
    trafficFeedPresentation({ liveMode: true, flowError: 'TomTom flow unavailable' }),
    trafficFeedPresentation({ liveMode: true, fetching: true, flowError: 'TomTom flow unavailable' }),
  ].map((feed) => feed.loadingLabel);
  for (const label of labels) {
    assert.ok(!LIVE_CLAIM.test(label), `label implies live data: ${label}`);
    assert.ok(label.startsWith('SIMULATED'), `fallback label must lead with the mode: ${label}`);
  }
});

test('simulating because the status probe failed reads differently from keyless by design', () => {
  const probeDown = trafficFeedPresentation({ statusUnavailable: true });
  assert.equal(probeDown.mode, 'sim');
  assert.equal(probeDown.loadingLabel, 'SIMULATED — traffic service unreachable');
});

test('a healthy keyed layer reports live flow with its real coverage', () => {
  const idle = trafficFeedPresentation({ liveMode: true, coveragePct: 87 });
  assert.deepEqual(idle, {
    mode: 'live',
    error: null,
    loadingLabel: 'LIVE · TomTom flow · 87% cov',
  });
  assert.equal(
    trafficFeedPresentation({ liveMode: true, fetching: true }).loadingLabel,
    'syncing LIVE traffic flow',
  );
});

test('a mid-session flow outage degrades instead of reporting stale live coverage', () => {
  const down = trafficFeedPresentation({
    liveMode: true,
    flowError: 'TomTom daily budget reached',
    coveragePct: 87, // last-good number — must not be presented as current
  });
  // error and loadingLabel are ONE string: the manager's error branch renders
  // `error` and drops `loadingLabel`, so the copy has to live in both.
  assert.equal(down.error, 'SIMULATED — TomTom daily budget reached');
  assert.equal(down.loadingLabel, down.error);
  assert.ok(!down.loadingLabel.includes('87'));
  const busy = trafficFeedPresentation({
    liveMode: true,
    fetching: true,
    flowError: 'TomTom daily budget reached',
  });
  assert.deepEqual(busy, down, 'the degraded state reads the same whether or not a load is in flight');
});

test('the rendered steady-state meta line carries the SIMULATED copy', () => {
  const mgr = new DataLayerManager({});
  const stats = (feed) => ({ count: 544, lastUpdate: Date.now(), ...feed });
  assert.equal(
    mgr._buildMetaText({
      source: 'OpenStreetMap',
      stats: stats(trafficFeedPresentation({ liveMode: false })),
    }),
    'FALLBACK · OpenStreetMap · SIMULATED — add TomTom key for live',
  );
  assert.equal(
    mgr._buildMetaText({
      source: 'OpenStreetMap',
      stats: stats(trafficFeedPresentation({
        liveMode: true,
        flowError: 'TomTom daily budget reached',
      })),
    }),
    'DEGRADED · OpenStreetMap · SIMULATED — TomTom daily budget reached',
  );
});

test('the manager reads keyless as FALLBACK and an outage as DEGRADED', () => {
  const settled = { count: 4200, lastUpdate: Date.now() };
  assert.equal(
    layerFeedState({ ...settled, ...trafficFeedPresentation({ liveMode: false }) }),
    'fallback',
  );
  assert.equal(
    layerFeedState({ ...settled, ...trafficFeedPresentation({ liveMode: true }) }),
    'nominal',
  );
  assert.equal(
    layerFeedState({
      ...settled,
      ...trafficFeedPresentation({ liveMode: true, flowError: 'TomTom flow unavailable' }),
    }),
    'degraded',
  );
});

test('the shipped layer boots keyless-honest before any status check', () => {
  const stats = trafficLayer.getStats();
  assert.equal(stats.mode, 'sim');
  assert.equal(stats.error, null);
  assert.ok(!LIVE_CLAIM.test(stats.loadingLabel), `boot label implies live data: ${stats.loadingLabel}`);
  assert.equal(layerFeedState(stats), 'fallback');
});

// ─── Pure internals: Overpass query, parsing, budgets, geometry ────────────

test('buildOverpassQuery: bbox order, default timeout, and the full highway regex', () => {
  const query = _internals.buildOverpassQuery(-1.5, 2.5, 0.5, 3.5);
  assert.ok(query.startsWith('[out:json][timeout:25];'), 'JSON output + default 25 s server timeout');
  assert.ok(query.includes('(-1.5,2.5,0.5,3.5)'), 'bbox must be (south,west,north,east)');
  assert.ok(
    query.includes('^(motorway|trunk|primary|secondary|tertiary|residential|unclassified)$'),
    'the full pass includes residential classes',
  );
  assert.ok(query.endsWith(';out geom qt;'), 'geometry output, quadtile order');
});

test('buildOverpassQuery: majorOnly narrows the regex and timeoutSec passes through', () => {
  const query = _internals.buildOverpassQuery(0, 0, 1, 1, { majorOnly: true, timeoutSec: 8 });
  assert.ok(query.startsWith('[out:json][timeout:8];'));
  assert.ok(query.includes('^(motorway|trunk|primary|secondary)$'), 'major pass excludes residential classes');
  assert.ok(!query.includes('tertiary'), 'major pass must not leak the full regex');
});

test('parseRoads: skips junk, maps coords, defaults type, resolves one-way semantics', () => {
  const roads = _internals.parseRoads({
    elements: [
      { type: 'node', id: 1 },
      { type: 'way', id: 2, geometry: [{ lat: 1, lon: 2 }] }, // too few vertices
      { type: 'way', id: 3 }, // no geometry at all
      {
        type: 'way', id: 4,
        geometry: [{ lat: 0, lon: 0 }, { lat: 0.1, lon: 0 }, { lat: 0.2, lon: 0 }],
        tags: { highway: 'motorway', oneway: 'yes' },
      },
      {
        type: 'way', id: 5,
        geometry: [{ lat: 1, lon: 1 }, { lat: 1.1, lon: 1 }],
        tags: { highway: 'residential', oneway: '-1' },
      },
      {
        type: 'way', id: 6,
        geometry: [{ lat: 2, lon: 2 }, { lat: 2.1, lon: 2 }],
        tags: { junction: 'roundabout' }, // roundabouts are one-way by definition
      },
      {
        type: 'way', id: 7,
        geometry: [{ lat: 3, lon: 3 }, { lat: 3.1, lon: 3 }],
        tags: { highway: 'unclassified', oneway: '0' }, // explicit two-way
      },
      {
        type: 'way', id: 8, // missing tags entirely → default type + two-way
        geometry: [{ lat: 4, lon: 4 }, { lat: 4.1, lon: 4 }],
      },
    ],
  });
  assert.equal(roads.length, 5, 'ways with <2 vertices and non-ways are dropped');
  const byIdOrder = roads.map((r) => r.type);
  assert.deepEqual(byIdOrder, ['motorway', 'residential', 'unclassified', 'unclassified', 'unclassified']);
  assert.deepEqual(roads[0].coords, [[0, 0], [0, 0.1], [0, 0.2]], 'coords are [lon,lat] pairs');
  assert.deepEqual(roads.map((r) => r.oneway), [1, -1, 1, 0, 0], 'yes/-1/roundabout/0/two-way defaults');
  // Waypoints pre-computed for lerp animation: one Cartesian3 per vertex,
  // segment distances one shorter, all finite and positive.
  for (const road of roads) {
    assert.equal(road.waypoints.length, road.coords.length);
    assert.ok(road.waypoints.every((w) => w instanceof Cesium.Cartesian3));
    assert.equal(road.segmentDist.length, road.waypoints.length - 1);
    assert.ok(road.segmentDist.every((d) => Number.isFinite(d) && d > 0));
  }
});

test('parseRoads: polylines beyond the waypoint cap sub-sample but keep their endpoint', () => {
  const vertices = [];
  for (let i = 0; i < 200; i += 1) vertices.push({ lat: i * 0.001, lon: i * 0.001 });
  const [road] = _internals.parseRoads({ elements: [{ type: 'way', geometry: vertices }] });
  const step = Math.ceil(200 / _internals.constants.MAX_WAYPOINTS_PER_ROAD); // 3
  assert.equal(road.coords.length, Math.ceil(200 / step) + 1, 'every step-th vertex plus the preserved endpoint');
  assert.deepEqual(road.coords.at(-1), [199 * 0.001, 199 * 0.001], 'the original endpoint survives simplification');
  assert.deepEqual(road.coords[1], [step * 0.001, step * 0.001], 'sub-sampling stride');
});

test('parseRoads: empty and malformed payloads yield an empty road set', () => {
  assert.deepEqual(_internals.parseRoads(null), []);
  assert.deepEqual(_internals.parseRoads({}), []);
  assert.deepEqual(_internals.parseRoads({ elements: [] }), []);
});

test('estimateRoadLengthDeg: degree-space Euclidean length at 111 km per degree', () => {
  assert.equal(_internals.estimateRoadLengthDeg([[0, 0], [1, 0]]), 111000);
  assert.equal(_internals.estimateRoadLengthDeg([[0, 0], [0, 1], [1, 1]]), 222000, 'multi-segment sums');
  assert.equal(_internals.estimateRoadLengthDeg([[5, 5]]), 0, 'a single vertex has no length');
  assert.equal(_internals.estimateRoadLengthDeg([]), 0);
});

test('computeDotCount: altitude spacing bands, type density, and the one-dot floor', () => {
  const TENTH_DEG = [[0, 0], [0.1, 0]]; // 0.1° ≈ 11 100 m
  const count = (type, altitude) => _internals.computeDotCount({ coords: TENTH_DEG, type }, altitude);
  // 11 100 m / spacing × DENSITY_MULT[type], floor, min 1.
  assert.equal(count('motorway', 500), 1110, '11 100/30 × 3.0 below 1 000 m');
  assert.equal(count('residential', 500), 185, '11 100/30 × 0.5');
  assert.equal(count('motorway', 1000), 416, 'spacing band 80 begins at 1 000 m');
  assert.equal(count('motorway', 3000), 222, 'spacing band 150 begins at 3 000 m');
  assert.equal(count('motorway', 5000), 133, 'spacing band 250 begins at 5 000 m');
  assert.equal(count('motorway', 12000), 133, 'the top band holds above activation altitude');
  const tiny = _internals.computeDotCount({ coords: [[0, 0], [1e-7, 0]], type: 'unclassified' }, 500);
  assert.equal(tiny, 1, 'short roads still render a single dot');
});

test('allocateRoadDotBudgets: the cap is never exceeded and generous budgets match the ideal', () => {
  const roads = [
    { coords: [[0, 0], [0.1, 0]], type: 'motorway' },     // ideal 1110 @500 m
    { coords: [[0, 0], [0.1, 0]], type: 'residential' },  // ideal 185
    { coords: [[0, 0], [0.1, 0]], type: 'tertiary' },     // ideal 370
  ];
  const generous = _internals.allocateRoadDotBudgets(roads, 500, 10_000);
  assert.deepEqual(generous, [1110, 185, 370], 'with headroom every road gets exactly its ideal');
  assert.deepEqual(_internals.allocateRoadDotBudgets([], 500, 100), []);
  const zeroCap = _internals.allocateRoadDotBudgets(roads, 500, 0);
  assert.deepEqual(zeroCap, [0, 0, 0], 'no budget, no dots');
});

test('allocateRoadDotBudgets: a starved cap seeds every road first, then favors demand', () => {
  // Two roads, cap 3: both seed one dot (fairness), the single leftover goes
  // to the largest fractional residual — the motorway, whose proportional
  // share (1109/1293) beats the residential road's (184/1293).
  const roads = [
    { coords: [[0, 0], [0.1, 0]], type: 'motorway' },
    { coords: [[0, 0], [0.1, 0]], type: 'residential' },
  ];
  assert.deepEqual(_internals.allocateRoadDotBudgets(roads, 500, 3), [2, 1]);
  // Cap equal to the road count: the fairness seed consumes the whole budget.
  assert.deepEqual(_internals.allocateRoadDotBudgets(roads, 500, 2), [1, 1]);
  // A cap between seed and ideal: proportional distribution respects demand
  // order and never exceeds the cap.
  const tight = _internals.allocateRoadDotBudgets(roads, 500, 100);
  assert.equal(tight[0] + tight[1], 100, 'a starved cap is fully consumed');
  assert.ok(tight[0] > tight[1], 'the higher-demand road still wins the split');
  assert.ok(tight[0] <= 1110 && tight[1] <= 185, 'no road exceeds its own ideal');
});

test('visibleRoadsForAltitude: high altitude keeps only the major classes', () => {
  const roads = [
    { type: 'motorway' }, { type: 'trunk' }, { type: 'primary' },
    { type: 'secondary' }, { type: 'residential' }, { type: 'tertiary' },
  ];
  const high = _internals.visibleRoadsForAltitude(roads, 5001);
  assert.deepEqual(high.map((r) => r.type), ['motorway', 'trunk', 'primary']);
  assert.equal(_internals.visibleRoadsForAltitude(roads, 5000), roads, 'at the boundary nothing is filtered');
});

test('boundsOverlap: fraction-of-reference-area semantics with degenerate rejection', () => {
  const a = { south: 0, west: 0, north: 1, east: 1 };
  assert.equal(_internals.boundsOverlap(a, a, 0.99), true, 'a box fully overlaps itself');
  assert.equal(_internals.boundsOverlap(a, { south: 2, west: 2, north: 3, east: 3 }, 0), false, 'disjoint');
  const half = { south: 0, west: 0.5, north: 1, east: 1.5 };
  assert.equal(_internals.boundsOverlap(a, half, 0.6), false, '50 % overlap fails a 60 % threshold');
  assert.equal(_internals.boundsOverlap(a, half, 0.5), true, '50 % overlap meets a 50 % threshold');
  const touching = { south: 1, west: 0, north: 2, east: 1 };
  assert.equal(_internals.boundsOverlap(a, touching, 0), false, 'edge-touching rectangles do not overlap');
  const zeroArea = { south: 1, west: 0, north: 1, east: 1 };
  assert.equal(_internals.boundsOverlap(zeroArea, a, 0), false, 'a zero-area reference box never overlaps');
});

test('clampBounds: small boxes pass through; large boxes center on the midpoint at 0.05° span', () => {
  const small = { south: 10, west: 20, north: 10.02, east: 20.02 };
  const kept = _internals.clampBounds(small);
  for (const edge of ['south', 'west', 'north', 'east']) {
    assert.ok(Math.abs(kept[edge] - small[edge]) < 1e-9,
      `an in-limit box is idempotent (${edge}): ${kept[edge]} vs ${small[edge]}`);
  }
  const huge = _internals.clampBounds({ south: 0, west: 0, north: 1, east: 1 });
  assert.deepEqual(huge, { south: 0.475, north: 0.525, west: 0.475, east: 0.525 });
  const mixed = _internals.clampBounds({ south: 0, west: 0, north: 0.02, east: 0.5 });
  assert.deepEqual(mixed, { south: 0, north: 0.02, west: 0.225, east: 0.275 },
    'each axis is clamped independently around the same midpoint');
});

test('viewport geometry: centers, distance, and the longitude cosine correction', () => {
  assert.deepEqual(_internals.getBoundsCenter({ south: 1, west: 2, north: 3, east: 6 }), { lat: 2, lon: 4 });
  const oslo = { lat: 59.91, lon: 10.75 };
  const same = { lat: 59.91, lon: 10.75 };
  assert.equal(_internals.distanceKm(oslo, same), 0);
  assert.ok(Math.abs(_internals.distanceKm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) - 111) < 1e-9,
    'one degree of latitude is 111 km');
  assert.ok(Math.abs(_internals.distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111) < 1e-9,
    'one degree of longitude at the equator is 111 km');
  const at60 = _internals.distanceKm({ lat: 60, lon: 0 }, { lat: 60, lon: 1 });
  assert.ok(Math.abs(at60 - 111 * Math.cos(Math.PI / 3)) < 1e-9,
    'longitude shrinks by the cosine of the mean latitude');
  assert.ok(Math.abs(
    _internals.distanceKm(oslo, { lat: 59.90, lon: 10.76 })
    - _internals.distanceKm({ lat: 59.90, lon: 10.76 }, oslo),
  ) < 1e-9, 'distance is symmetric');
});

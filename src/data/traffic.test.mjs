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
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import trafficLayer, {
  deriveTrafficFlowError,
  getTrafficTimingDiagnostics,
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

// ═══ Lifecycle: the keyless session, end to end ════════════════════════════
//
// The pure internals above prove the math; this section proves the MACHINE:
// init → enable → debounced viewport loads → animated dots → camera gating →
// honest stats → disable → destroy, against stubbed viewer/window/fetch with
// real Cesium math underneath. Keyless end to end: `/api/tomtom/status`
// answers `hasKey:false`, and the module caches that verdict for its whole
// lifetime (`_flowStatusPromise`), so every test in this file is simulation
// mode by construction. The flip side — a live-key session and its honest
// degradation — needs a fresh module instance and lives in trafficLive.test.mjs.

const DEBOUNCE_MS = 320;
const SETTLE_MS = DEBOUNCE_MS + 180; // debounce + two sequential proxy round-trips
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An Overpass `out geom;` payload: three real-shaped roads plus a junk node. */
const overpassFixture = () => ({
  elements: [
    {
      type: 'way', id: 1,
      tags: { highway: 'motorway', oneway: 'yes', maxspeed: '65 mph' },
      geometry: [
        { lat: 30.2, lon: -97.8 }, { lat: 30.22, lon: -97.78 }, { lat: 30.24, lon: -97.76 },
      ],
    },
    {
      type: 'way', id: 2,
      tags: { highway: 'residential' },
      geometry: [
        { lat: 30.3, lon: -97.7 }, { lat: 30.302, lon: -97.698 }, { lat: 30.304, lon: -97.696 },
      ],
    },
    {
      type: 'way', id: 3,
      tags: { highway: 'primary', oneway: 'no' },
      geometry: [
        { lat: 30.1, lon: -97.6 }, { lat: 30.102, lon: -97.598 },
        { lat: 30.104, lon: -97.596 }, { lat: 30.106, lon: -97.594 },
      ],
    },
    { type: 'node', id: 9, lat: 30, lon: -97 }, // not a way — parseRoads skips it
  ],
});

/**
 * Minimal Cesium-shaped viewer: real `Cesium.Event`s (so listeners, removers,
 * and `numberOfListeners` behave), real Cartographic/Rectangle math, and fake
 * scene sinks that record what the layer adds and removes.
 */
function makeViewer({ height = 1000, view = [-97.9, 30.1, -97.6, 30.4] } = {}) {
  const added = [];
  const removed = [];
  const viewer = {
    scene: {
      primitives: {
        add: (p) => { added.push(p); return p; },
        remove: (p) => {
          const i = added.indexOf(p);
          if (i >= 0) added.splice(i, 1);
          removed.push(p);
        },
      },
      // Heat-lines are live-mode-only; a stray add here is a contract break.
      groundPrimitives: {
        add: () => { throw new Error('ground primitives are live-mode only'); },
        remove: () => {},
      },
      canvas: { clientWidth: 800, clientHeight: 600 },
      preRender: new Cesium.Event(),
      // Terrain sampling ON with a flat 12 m answer: parseRoads takes its
      // real height path instead of the no-viewer no-op.
      sampleHeightSupported: true,
      sampleHeight: () => 12,
    },
    camera: {
      percentageChanged: 0.5,
      changed: new Cesium.Event(),
      moveEnd: new Cesium.Event(),
      positionCartographic: null,
      positionWC: null,
      computeViewRectangle: null,
      pickEllipsoid: null, // setView installs a look-at on the view center
    },
    __added: added,
    __removed: removed,
    setView({ height: h = 1000, view: v = view } = {}) {
      // The look-at tracks the view center: a pan must move the fetch center
      // too, or clampBoundsAroundCenter clamps to the OLD box and the load
      // hits the same cache key forever.
      const lon = (v[0] + v[2]) / 2;
      const lat = (v[1] + v[3]) / 2;
      viewer.camera.positionCartographic = Cesium.Cartographic.fromDegrees(lon, lat, h);
      viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(lon, lat, h);
      viewer.camera.computeViewRectangle = () => Cesium.Rectangle.fromDegrees(v[0], v[1], v[2], v[3]);
      viewer.camera.pickEllipsoid = () => Cesium.Cartesian3.fromDegrees(lon, lat);
    },
  };
  viewer.setView({ height, view });
  return viewer;
}

/**
 * The per-process world: window/document stubs (the layer binds its
 * gev:style-change listener exactly once, on the first init) and a fetch
 * router answering the status probe, the Overpass proxy, and nothing else.
 * Installed lazily on first use and restored when the file ends.
 */
let WORLD = null;

function world() {
  if (WORLD) return WORLD;
  const calls = { status: 0, overpass: [] };
  let overpassStatus = 200;
  let overpassHold = null; // when set: hold responses until released

  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/api/tomtom/status')) {
      calls.status += 1;
      return new Response(JSON.stringify({ hasKey: false }),
        { headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('/api/overpass')) {
      const query = new URLSearchParams(opts.body || '').get('data') || '';
      calls.overpass.push(query);
      if (overpassHold) {
        return new Promise((resolve) => { overpassHold.resolvers.push(resolve); });
      }
      if (overpassStatus !== 200) {
        return new Response('overpass down', { status: overpassStatus });
      }
      return new Response(JSON.stringify(overpassFixture()),
        { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`lifecycle harness: unexpected fetch ${u}`);
  };

  const listeners = new Map();
  const windowStub = {
    location: { search: '' },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
      const fns = listeners.get(type);
      const i = fns ? fns.indexOf(fn) : -1;
      if (i >= 0) fns.splice(i, 1);
    },
    dispatchEvent: (event) => {
      for (const fn of listeners.get(event.type) || []) fn(event);
    },
  };
  const documentStub = { documentElement: { dataset: { gevStyle: 'normal' } } };
  const prev = {
    window: globalThis.window,
    hadWindow: Object.prototype.hasOwnProperty.call(globalThis, 'window'),
    document: globalThis.document,
    hadDocument: Object.prototype.hasOwnProperty.call(globalThis, 'document'),
    fetch: globalThis.fetch,
  };
  globalThis.window = windowStub;
  globalThis.document = documentStub;
  globalThis.fetch = fetchImpl;

  WORLD = {
    calls,
    listeners,
    dispatchStyle(style) {
      windowStub.dispatchEvent({ type: 'gev:style-change', detail: { style } });
    },
    setOverpassStatus(status) { overpassStatus = status; },
    // Hold every subsequent Overpass response until releaseOverpass(): lets a
    // test observe the layer mid-fetch (and disable it mid-flight).
    holdOverpass() { overpassHold = { resolvers: [] }; },
    releaseOverpass() {
      const hold = overpassHold;
      overpassHold = null;
      for (const resolve of hold?.resolvers || []) {
        resolve(new Response(JSON.stringify(overpassFixture()),
          { headers: { 'Content-Type': 'application/json' } }));
      }
    },
    // Per-test isolation: a healthy router and an empty call log, so a count
    // asserted in one test can only be produced by that test's own camera.
    resetForTest() {
      overpassStatus = 200;
      overpassHold = null;
      calls.overpass.length = 0;
    },
    restore() {
      if (prev.hadWindow) globalThis.window = prev.window; else delete globalThis.window;
      if (prev.hadDocument) globalThis.document = prev.document; else delete globalThis.document;
      globalThis.fetch = prev.fetch;
    },
  };
  return WORLD;
}

// File-scoped cleanup: registered at module scope because an `after()` inside
// world() would bind to the FIRST test that called it and restore the native
// globals mid-file.
after(() => {
  if (WORLD) WORLD.restore();
});

test('lifecycle: init binds the style listener once and adopts the persisted preset', () => {
  const w = world();
  const viewer = makeViewer();
  trafficLayer.init(viewer);

  assert.equal(w.listeners.get('gev:style-change')?.length, 1, 'exactly one style listener');
  assert.equal(viewer.__added.length, 1, 'init adds the point collection');
  assert.equal(viewer.__added[0].show, false, 'the collection ships hidden');
  assert.equal(trafficLayer.getStats().stylePreset, 'normal', 'dataset preset adopted at init');

  w.dispatchStyle('nvg');
  assert.equal(trafficLayer.getStats().stylePreset, 'nvg', 'the event switches presets');
  w.dispatchStyle(null);
  assert.equal(trafficLayer.getStats().stylePreset, 'normal', 'blank names fall back to normal');

  // Destroy/re-register must not stack a second listener; the dataset is
  // re-read so a preset restored before re-registration still lands.
  globalThis.document.documentElement.dataset.gevStyle = 'crt';
  trafficLayer.init(makeViewer());
  assert.equal(w.listeners.get('gev:style-change').length, 1, 'listener is bound once per page');
  assert.equal(trafficLayer.getStats().stylePreset, 'crt', 're-init re-reads the dataset');
  globalThis.document.documentElement.dataset.gevStyle = 'normal';
  w.dispatchStyle('normal');
});

test('lifecycle: enable loads the viewport and reports honest keyless stats', async (t) => {
  const w = world();
  w.resetForTest();
  const viewer = makeViewer();
  t.after(() => { try { trafficLayer.destroy(viewer); } catch { /* unwound */ } });
  trafficLayer.init(viewer);
  assert.equal(trafficLayer.getStats().count, 0, 'nothing rendered before enable');
  assert.equal(
    trafficLayer.getStats().loadingLabel,
    'SIMULATED — add TomTom key for live',
    'the boot-state label is already honest',
  );

  trafficLayer.enable(viewer);
  assert.equal(viewer.__added[0].show, true, 'enable shows the collection');
  assert.equal(viewer.camera.percentageChanged, 0.05, 'enable tightens the camera threshold');

  await sleep(SETTLE_MS);
  const stats = trafficLayer.getStats();
  assert.equal(w.calls.status, 1, 'exactly one status probe per session');
  assert.ok(stats.count > 0, 'dots rendered from the fixture roads');
  assert.equal(stats.mode, 'sim');
  assert.equal(stats.error, null);
  assert.ok(!LIVE_CLAIM.test(stats.loadingLabel), `label never claims live: ${stats.loadingLabel}`);
  assert.equal(stats.loadingLabel, 'SIMULATED — add TomTom key for live');
  assert.equal(stats.loading, false, 'the load settled');
  assert.ok(stats.lastUpdate !== null, 'the load committed its timestamp');
  assert.equal(stats.flowBuckets.sim, stats.count, 'every keyless dot is a simulated dot');
  assert.equal(stats.closedRoads, 0);
  assert.equal(stats.heatLines, 0, 'heat-lines are live-mode only');
  assert.equal(stats.tilesFetched, 0, 'keyless never touches flow tiles');
  assert.equal(stats.flowCoveragePct, 0);
  assert.equal(stats.styleProfile, 'normal');

  // The camera drive: one preRender tick advances every unpaused dot.
  const dot = trafficLayer.getDetectableObjects({ maxCount: 1 })[0];
  const before = Cesium.Cartesian3.clone(dot.position);
  viewer.scene.preRender.raiseEvent();
  assert.ok(!Cesium.Cartesian3.equals(before, dot.position), 'the animation tick moves dots');

  // Detection-overlay sampling: stride + seed, VEH ids, no congestion tier
  // keyless (tier colors are a live-mode signal).
  const objects = trafficLayer.getDetectableObjects({ maxCount: 2 });
  assert.equal(objects.length, 2);
  for (const o of objects) {
    assert.match(o.id, /^VEH-\d{4}$/);
    assert.equal(o.type, 'VEH');
    assert.equal(o.tier, undefined, 'keyless contacts carry no congestion tier');
    assert.ok(o.position);
  }
  const [seeded, offset] = [
    trafficLayer.getDetectableObjects({ maxCount: 1, seed: 0 })[0].id,
    trafficLayer.getDetectableObjects({ maxCount: 1, seed: 1 })[0].id,
  ];
  assert.notEqual(seeded, offset, 'the seed shifts the stride window');

  await trafficLayer.update(); // camera-driven layer: the poll tick is a no-op
  trafficLayer.disable(viewer);
});

test('lifecycle: stationary skips, distant moves refetch, high altitude clears', async (t) => {
  const w = world();
  w.resetForTest();
  const viewer = makeViewer();
  t.after(() => { try { trafficLayer.destroy(viewer); } catch { /* unwound */ } });
  trafficLayer.init(viewer);
  trafficLayer.enable(viewer);
  await sleep(SETTLE_MS);
  assert.ok(trafficLayer.getStats().count > 0);
  const loadsAfterBoot = w.calls.overpass.length; // major + full per load

  // Same view re-fired: overlap ≥ 0.6 and center shift ~0 → no new load.
  viewer.camera.changed.raiseEvent();
  await sleep(SETTLE_MS);
  assert.equal(w.calls.overpass.length, loadsAfterBoot, 'a stationary camera does not refetch');

  // Distant pan: zero overlap → debounced major+full reload.
  viewer.setView({ view: [-98.9, 29.1, -98.6, 29.4] });
  viewer.camera.changed.raiseEvent();
  await sleep(SETTLE_MS);
  assert.equal(w.calls.overpass.length, loadsAfterBoot + 2, 'a distant move loads major+full again');
  assert.ok(trafficLayer.getStats().count > 0);

  // Above activation altitude: dots cleared synchronously, nothing fetched.
  viewer.setView({ height: 9000 });
  viewer.camera.changed.raiseEvent();
  assert.equal(trafficLayer.getStats().count, 0, 'high altitude clears immediately');
  await sleep(SETTLE_MS);
  assert.equal(w.calls.overpass.length, loadsAfterBoot + 2, 'high altitude schedules no fetch');

  // Descending reloads: the H5 gate was nulled by the high-altitude clear,
  // so the SAME view cannot hit the overlap skip and strand the layer empty.
  viewer.setView({ height: 1000 });
  viewer.camera.changed.raiseEvent();
  await sleep(SETTLE_MS);
  assert.ok(trafficLayer.getStats().count > 0, 'descending reloads the viewport');
  trafficLayer.disable(viewer);
});

test('lifecycle: a failed Overpass fetch rolls back and lets the next look retry', async (t) => {
  const w = world();
  w.resetForTest();
  // A viewport no earlier test loaded: the session road cache must not mask
  // the dead feed with a hit from someone else's successful fetch.
  const viewer = makeViewer({ view: [-96.9, 31.1, -96.6, 31.4] });
  t.after(() => { try { trafficLayer.destroy(viewer); } catch { /* unwound */ } });
  w.setOverpassStatus(500);
  trafficLayer.init(viewer);
  trafficLayer.enable(viewer);
  await sleep(SETTLE_MS);
  assert.equal(trafficLayer.getStats().count, 0, 'nothing rendered from a dead feed');
  assert.equal(trafficLayer.getStats().loading, false, 'the failed load settled');
  assert.equal(trafficLayer.getStats().error, null, 'a keyless Overpass outage is not a flow error');
  const attempts = w.calls.overpass.length;

  // The failed load must NOT have committed its bounds (H3): the same
  // viewport, re-fired, retries instead of tripping the overlap skip forever.
  viewer.camera.changed.raiseEvent();
  await sleep(SETTLE_MS);
  assert.ok(w.calls.overpass.length > attempts, 'a failed load does not wedge the retry gate');

  // Feed recovers: the next look renders.
  w.setOverpassStatus(200);
  viewer.camera.changed.raiseEvent();
  await sleep(SETTLE_MS + 400);
  assert.ok(trafficLayer.getStats().count > 0, 'recovery renders after the feed returns');
  trafficLayer.disable(viewer);
});

test('lifecycle: disable aborts an in-flight fetch and no stale render lands', async (t) => {
  const w = world();
  w.resetForTest();
  // A viewport no earlier test loaded, with the router told to hold every
  // Overpass answer: the layer is provably mid-fetch when disable() lands.
  const viewer = makeViewer({ view: [-94.9, 33.1, -94.6, 33.4] });
  t.after(() => { try { trafficLayer.destroy(viewer); } catch { /* unwound */ } });
  w.holdOverpass();
  trafficLayer.init(viewer);
  trafficLayer.enable(viewer);
  await sleep(SETTLE_MS);
  assert.equal(w.calls.overpass.length, 1, 'the major pass is in flight');
  assert.equal(trafficLayer.getStats().loading, true, 'the load is honestly still open');

  trafficLayer.disable(viewer);
  assert.equal(trafficLayer.getStats().loading, false, 'disable closes the loading batch');
  assert.equal(trafficLayer.getStats().count, 0);

  // The held answer lands after disable: the aborted generation must not
  // resurrect dots on a hidden collection.
  w.releaseOverpass();
  await sleep(SETTLE_MS);
  assert.equal(trafficLayer.getStats().count, 0, 'the late answer is discarded');
});

test('lifecycle: setParams clamps and gates every knob', () => {
  world();
  const before = trafficLayer.getParams();
  trafficLayer.setParams({ densityScale: 99, speedScale: -1 });
  let params = trafficLayer.getParams();
  assert.equal(params.densityScale, 2.5, 'density clamps high');
  assert.equal(params.speedScale, 0.3, 'speed clamps low');
  trafficLayer.setParams({ densityScale: 0.01, speedScale: 42 });
  params = trafficLayer.getParams();
  assert.equal(params.densityScale, 0.2, 'density clamps low');
  assert.equal(params.speedScale, 3.0, 'speed clamps high');

  trafficLayer.setParams({ uncoveredRoads: 'hide' });
  assert.equal(trafficLayer.getParams().uncoveredRoads, 'hide', 'strict live treatment adopted');
  trafficLayer.setParams({ uncoveredRoads: 'bogus' });
  assert.equal(trafficLayer.getParams().uncoveredRoads, 'hide', 'junk values are ignored');

  trafficLayer.setParams({ jamViz: 'heatline' });
  assert.equal(trafficLayer.getParams().jamViz, 'heatline');
  assert.equal(trafficLayer.getStats().jamViz, 'heatline', 'stats mirror the toggle');
  trafficLayer.setParams({ jamViz: 'bogus' });
  assert.equal(trafficLayer.getParams().jamViz, 'heatline', 'junk jamViz is ignored');

  trafficLayer.setParams({ presetDots: 'off' });
  assert.equal(trafficLayer.getParams().presetDots, 'off');
  assert.equal(trafficLayer.getStats().styleProfile, 'normal', 'the kill switch pins the shipped profile');
  trafficLayer.setParams({ presetDots: 'on' });
  assert.equal(trafficLayer.getStats().styleProfile, 'normal', 'the normal preset stays normal with dots on');

  trafficLayer.setParams(before); // leave the shared module state as found
});

test('lifecycle: disable restores the camera and unwinds every subscription', async (t) => {
  const viewer = makeViewer();
  t.after(() => { try { trafficLayer.destroy(viewer); } catch { /* unwound */ } });
  viewer.camera.percentageChanged = 0.42;
  trafficLayer.init(viewer);
  trafficLayer.enable(viewer);
  assert.equal(viewer.camera.percentageChanged, 0.05);
  assert.ok(viewer.camera.changed.numberOfListeners > 0);
  assert.ok(viewer.scene.preRender.numberOfListeners > 0);

  trafficLayer.disable(viewer);
  assert.equal(viewer.camera.percentageChanged, 0.42, 'the shared camera threshold is restored');
  assert.equal(viewer.camera.changed.numberOfListeners, 0, 'camera subscription removed');
  assert.equal(viewer.scene.preRender.numberOfListeners, 0, 'animation loop removed');
  assert.equal(viewer.__added[0].show, false, 'the collection hides, not dies');
  assert.equal(trafficLayer.getStats().count, 0);
  assert.equal(trafficLayer.getStats().loading, false);
});

test('lifecycle: destroy removes the collection and the road cache forgets', async (t) => {
  const w = world();
  w.resetForTest();
  // Both registrations use the SAME fresh viewport: the second enable may
  // only render by refetching, which is exactly what a cleared cache forces.
  const view = [-95.9, 32.1, -95.6, 32.4];
  let viewer2 = null;
  t.after(() => {
    try { trafficLayer.destroy(viewer); } catch { /* unwound */ }
    if (viewer2) { try { trafficLayer.destroy(viewer2); } catch { /* unwound */ } }
  });
  const viewer = makeViewer({ view });
  trafficLayer.init(viewer);
  trafficLayer.enable(viewer);
  await sleep(SETTLE_MS);
  assert.ok(trafficLayer.getStats().count > 0);
  const loadsBeforeDestroy = w.calls.overpass.length;

  trafficLayer.destroy(viewer);
  assert.equal(viewer.__added.length, 0, 'the point collection left the scene');
  assert.equal(viewer.__removed.length, 1);
  assert.equal(trafficLayer.getStats().count, 0);

  // A fresh registration refetches both passes: the session road cache died
  // with the layer.
  viewer2 = makeViewer({ view });
  trafficLayer.init(viewer2);
  trafficLayer.enable(viewer2);
  await sleep(SETTLE_MS);
  assert.ok(w.calls.overpass.length > loadsBeforeDestroy, 'destroy cleared the tile cache');
  assert.ok(trafficLayer.getStats().count > 0);
  trafficLayer.destroy(viewer2);
  assert.equal(w.listeners.get('gev:style-change').length, 1, 're-registration did not stack listeners');
});

test('traffic timing diagnostics report the inert contract under bare Node', () => {
  // The TIMING pass is DEV-gated (import.meta.env?.DEV is undefined under
  // node:test), so its headless contract is exact inertness: zero marks
  // installed, nothing traced, nothing dropped. The ENABLED pass (marks,
  // measures, postRender schedule) is exercised by trafficTiming.test.mjs
  // through a vite dev server — that file is excluded from coverage runs
  // because ssrLoadModule re-compiles the traffic graph and corrupts c8's
  // merge (see COVERAGE_EXCLUDED_TEST_FILES in scripts/run-unit-tests.mjs).
  assert.deepEqual(getTrafficTimingDiagnostics(), {
    enabled: false,
    marksInstalled: 0,
    traceObjectsCreated: 0,
    uncorrelatedTracesDropped: 0,
  });
  assert.equal(
    performance.getEntriesByType('mark').filter((entry) => entry.name.startsWith('traffic:')).length,
    0,
    'no traffic timing marks leak into the global performance buffer',
  );
});

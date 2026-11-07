import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from 'cesium';
import { createState } from './state.js';
import { createStyle } from './style.js';
import { createModel } from './model.js';
import { createAnimation } from './animation.js';
import {
  createRetention,
  DOT_CHANGE_BUDGET,
  roadIdentity,
} from './retention.js';
import { createTrafficDisplay, TRAFFIC_SET_IDS } from './render/display.js';
import { observeTrafficSurface } from './surface.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';

/**
 * A fake engine with the camera `altitude` metres over (0, 0). A zero-size
 * canvas projects nothing, so screen-space limits stay out of a test unless
 * it sizes the canvas. One rendered frame of the still camera certifies its
 * surface, as a completed render does.
 */
function engineAt(altitude, { width = 0, height = 0 } = {}) {
  const engine = createFakeEngine({ width, height, altitude });
  observeTrafficSurface(engine);
  engine.fake.frame();
  return engine;
}
/**
 * A surface pass's engine: a sized canvas looking straight down, whose
 * rendered depth answers nothing (heights come from the scripted terrain).
 */
function flowEngineAt(altitude) {
  const engine = engineAt(altitude, { width: 400, height: 300 });
  engine.fake.script('pickPosition', undefined);
  return engine;
}
const fillCount = (engine) =>
  engine.fake.moverSet(TRAFFIC_SET_IDS.fill).store.count;

function setup(t) {
  const frames = [];
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const beforeRAF = globalThis.requestAnimationFrame;
  const beforeCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => (frames.push(fn), frames.length);
  globalThis.cancelAnimationFrame = () => {
    frames.length = 0;
  };
  t.after(() => {
    globalThis.requestAnimationFrame = beforeRAF;
    globalThis.cancelAnimationFrame = beforeCancel;
  });
  const state = createState({ services: {} });
  state._enabled = true;
  state._liveMode = true;
  const engine = engineAt(450);
  state._engine = engine;
  state._display = createTrafficDisplay(engine);
  const parts = {
    rendering: {
      removeHeatLines() {},
      rebuildHeatLines() {},
      visibleRoadsForAltitude: (roads) => roads,
    },
  };
  const ctx = {
    state,
    services: {
      render: { holdContinuousRender() {}, releaseContinuousRender() {} },
    },
    parts,
    source: {},
  };
  parts.style = createStyle(ctx);
  parts.model = createModel(ctx);
  parts.animation = createAnimation(ctx);
  parts.retention = createRetention(ctx);
  const roads = (offset = 0, height = 100) =>
    parts.model
      .parseRoads({
        roads: [
          {
            type: 'primary',
            oneway: 1,
            coordinates: [
              [offset, 0],
              [offset + 0.003, 0],
              [offset + 0.004, 0.001],
            ],
          },
        ],
      })
      .map((road) => {
        road.waypoints = road.coords.map(([lon, lat]) =>
          C.Cartesian3.fromDegrees(lon, lat, height),
        );
        road.segmentDist = road.waypoints
          .slice(1)
          .map((p, i) => C.Cartesian3.distance(road.waypoints[i], p));
        return road;
      });
  const frame = (ms = 16) => {
    now += ms;
    const fn = frames.shift();
    fn?.();
    parts.animation.animate();
    parts.animation.drawDots();
  };
  const settle = () => {
    for (let i = 0; i < 100 && frames.length; i++) frame();
  };
  t.after(() => {
    parts.animation.clearDots();
    state._display.destroy();
    engine.destroy();
  });
  return { state, parts, roads, frame, settle, frames, engine };
}

test('incremental tiles, reordered snapshots and flow changes retain existing dot identities and progress', (t) => {
  const h = setup(t),
    a = h.roads(),
    b = h.roads(0.01);
  h.parts.retention.reconcile(a, 450, true);
  h.settle();
  const before = h.state._dots.map((d) => ({
    dot: d,
    id: d.id,
    point: d.point,
    t: d.t,
    segIdx: d.segIdx,
    road: d.road,
  }));
  h.parts.retention.reconcile([...b, ...h.roads()], 450, true);
  for (const p of before) {
    assert.equal(p.dot.id, p.id);
    assert.equal(p.dot.point, p.point);
    assert.equal(p.dot.t, p.t);
    assert.equal(p.dot.segIdx, p.segIdx);
    assert.equal(p.dot.road, p.road);
  }
  const target = h.state._dots[0];
  const oldSpeed = target.mps;
  target.road.source.flow = { level: 0.2, closure: false };
  h.parts.model.recolorDotsInPlace('late flow');
  assert.equal(target.id, before[0].id);
  assert.ok(target.mps < oldSpeed);
  target.road.source.flow = { level: 0, closure: true };
  h.parts.model.recolorDotsInPlace('closure');
  assert.equal(target.mps, 0);
  assert.equal(target.point.show, false);
  target.road.source.flow = { level: 1, closure: false };
  h.parts.model.recolorDotsInPlace('reopened');
  assert.equal(target.point.show, true);
  assert.equal(target.id, before[0].id);
  assert.equal(h.state._motion.rebuilds, 0);
  h.frame();
  assert.ok(fillCount(h.engine) > 0);
  assert.equal(
    fillCount(h.engine),
    h.state._dots.filter((d) => d.point.show && d.point.pixelSize > 0).length,
    'the display draws every shown dot',
  );
});

test('height refinement eases retained waypoints vertically without changing road or dot progress', (t) => {
  const h = setup(t);
  h.parts.retention.reconcile(h.roads(), 450, true);
  h.settle();
  const d = h.state._dots[0],
    p = d.waypoints[0];
  const start = C.Cartographic.fromCartesian(p);
  const id = d.id,
    progress = d.t;
  h.parts.retention.reconcile(h.roads(0, 120), 450, true);
  assert.equal(Math.round(C.Cartographic.fromCartesian(p).height), 100);
  h.parts.retention.easeHeights(0.016);
  const mid = C.Cartographic.fromCartesian(p);
  assert.ok(mid.height > 100 && mid.height < 120);
  assert.ok(Math.abs(mid.latitude - start.latitude) < 1e-12);
  assert.ok(Math.abs(mid.longitude - start.longitude) < 1e-12);
  assert.equal(d.id, id);
  assert.equal(d.t, progress);
  for (let i = 0; i < 100; i++) h.parts.retention.easeHeights(0.016);
  assert.ok(Math.abs(C.Cartographic.fromCartesian(p).height - 120) < 0.01);
});

test('density and replacement changes are bounded; removed roads fade out and teardown cancels pending work', (t) => {
  const h = setup(t);
  h.parts.model.allocateRoadDotBudgets = (roads) => roads.map(() => 3000);
  h.parts.retention.reconcile(h.roads(), 450, true);
  assert.equal(h.state._dots.length, DOT_CHANGE_BUDGET);
  let previous = h.state._dots.length;
  for (let i = 0; i < 6; i++) {
    h.frame();
    assert.ok(h.state._dots.length - previous <= DOT_CHANGE_BUDGET);
    previous = h.state._dots.length;
  }
  assert.equal(h.state._dots.length, 3000);
  const oldIds = new Set(h.state._dots.map((d) => d.id));
  h.parts.retention.reconcile(h.roads(0.01), 450, true);
  h.frame();
  assert.ok(h.state._dots.some((d) => d.retiring));
  h.settle();
  assert.equal(h.state._dots.length, 3000);
  assert.ok(h.state._dots.every((d) => !oldIds.has(d.id)));
  assert.equal(new Set(h.state._dots.map((d) => d.id)).size, 3000);
  h.parts.animation.clearDots();
  assert.equal(fillCount(h.engine), 0, 'a clear is drawn without a frame');
  h.frame();
  assert.equal(fillCount(h.engine), 0);
  assert.equal(h.state._dots.length, 0);
  assert.equal(h.frames.length, 0);
});

test('identity distinguishes sources and opposing directions but ignores flow and height', () => {
  const road = {
    type: 'primary',
    oneway: 1,
    coords: [
      [1, 2],
      [1.001, 2.001],
    ],
  };
  assert.equal(
    roadIdentity(road),
    roadIdentity({ ...road, flow: { level: 0 }, waypoints: [1] }),
  );
  assert.notEqual(roadIdentity(road), roadIdentity({ ...road, oneway: -1 }));
  assert.notEqual(
    roadIdentity(road),
    roadIdentity({ ...road, directFlow: true }),
  );
});

test('one-way departures fade before a new identity enters; segment crossings preserve metre speed', (t) => {
  const h = setup(t);
  h.parts.retention.reconcile(h.roads(), 450, true);
  h.settle();
  const d = h.state._dots[0];
  d.mps = 10;
  d.stoppedUntil = 0;
  d.creep = null;
  d.segIdx = d.numSegments - 1;
  d.t = 0.99999;
  const old = d.id;
  h.frame(100);
  assert.equal(d.id, old);
  assert.equal(d.point.pixelSize, 0);
  assert.equal(d.recycle, true);
  h.frame(16);
  assert.notEqual(d.id, old);
  assert.equal(d.direction, 1);
  assert.equal(d.segIdx, 0);
  assert.equal(d.point.pixelSize, 0);
});

test('stopped vehicles still follow smooth height refinement without moving along the road', (t) => {
  const h = setup(t);
  h.parts.retention.reconcile(h.roads(), 450, true);
  h.settle();
  const d = h.state._dots[0];
  d.stoppedUntil = Date.now() + 100000;
  const before = C.Cartographic.fromCartesian(d.point.position).height;
  const progress = d.t;
  h.parts.retention.reconcile(h.roads(0, 120), 450, true);
  h.frame();
  assert.equal(d.t, progress);
  const after = C.Cartographic.fromCartesian(d.point.position).height;
  assert.ok(after > before && after - before <= 2.01);
});

test('flow closing a queued road cannot leave a population reconciliation loop', (t) => {
  const h = setup(t);
  h.parts.model.allocateRoadDotBudgets = (roads) => roads.map(() => 3000);
  h.parts.retention.reconcile(h.roads(), 450, true);
  h.state._roads[0].source.flow = { level: 0, closure: true };
  h.settle();
  assert.equal(h.state._dots.length, 0);
  assert.equal(h.frames.length, 0);
  assert.equal(h.state._populationPending, false);
});

test('street and city budgets are bounded and zoom changes do not increase the city population', async () => {
  const { roadDotBudget } = await import('./policy.js');
  assert.equal(roadDotBudget(450), 6000);
  assert.equal(roadDotBudget(1000), 6000);
  assert.equal(roadDotBudget(3000), 667);
  assert.ok(roadDotBudget(1500) > roadDotBudget(3000));
  assert.ok(roadDotBudget(8000) >= 400);
});

test('small previews merge without evicting other retained roads until a completed snapshot', (t) => {
  const h = setup(t);
  const a = h.roads(),
    b = h.roads(0.01);
  h.parts.retention.reconcile(a, 450, true);
  h.settle();
  const first = h.state._dots[0];
  h.parts.retention.reconcile(b, 450, false);
  h.settle();
  assert.ok(h.state._dots.includes(first));
  assert.equal(first.retiring, 0);
  h.parts.retention.reconcile(b, 450, true);
  h.settle();
  assert.ok(!h.state._dots.includes(first));
  assert.equal(h.state._motion.rebuilds, 0);
});

test('major previews merge and never retry missing mesh ahead of the detail pass', async () => {
  const { createFlow } = await import('./flow.js');
  for (const measured of [true, false]) {
    let samples = 0;
    const paints = [];
    const engine = flowEngineAt(450);
    engine.fake.script('terrainHeight', () => {
      samples++;
      return measured ? 100 : undefined;
    });
    const coords = [
      [0, 0],
      [0.001, 0],
    ];
    const road = {
      type: 'primary',
      oneway: 1,
      coords,
      waypoints: coords.map(([lon, lat]) => C.Cartesian3.fromDegrees(lon, lat)),
      segmentDist: [111],
    };
    const state = {
      _dots: [],
      _detailRoadsReady: true,
      _motion: { added: 0 },
      _engine: engine,
      _enabled: true,
      _loadGeneration: 1,
      _roadSource: 'OpenStreetMap',
      _flowPending: 0,
      _activeFetchAbort: new AbortController(),
    };
    const flow = createFlow({
      state,
      services: { credits: { registerDynamicCredit() {} } },
      source: {},
      parts: {
        model: {
          allocateRoadDotBudgets: (roads) => roads.map(() => 1),
          recolorDotsInPlace() {},
        },
        rendering: {
          visibleRoadsForAltitude: (roads) => roads,
          renderRoadsForAltitude: (...args) => paints.push(args),
        },
      },
    });
    await flow.applyFlowThenRender([road], {}, 1, 450, 'Loaded major');
    assert.equal(
      samples,
      2,
      'preview tries each station once, then lets detailed roads proceed',
    );
    assert.ok(
      paints.every((args) => args[4] === false),
      'provisional roads cannot retire a surviving road',
    );
    assert.equal(paints.length > 0, measured);
    assert.equal(state._flowPending, 0);
    state._dots = [{}];
    const before = paints.length;
    await flow.applyFlowThenRender([road], {}, 1, 450, 'Loaded major');
    await flow.applyFlowThenRender([road], {}, 1, 450, 'Loaded tile');
    assert.equal(
      samples,
      2,
      'retained traffic skips redundant preview sampling',
    );
    assert.equal(
      paints.length,
      before,
      'previews leave the retained population intact',
    );
    state._dots = [];
    state._detailRoadsReady = true;
    state._motion.added = 1;
    await flow.applyFlowThenRender([road], {}, 1, 450, 'Loaded major');
    assert.equal(
      samples,
      2,
      'decoded detail can supersede a cold coarse preview',
    );
    assert.equal(paints.length, before);
  }
});

test('unresolved major roads cannot prevent the detailed request', async () => {
  const { createIngestion } = await import('./ingestion.js');
  const requests = [],
    paints = [];
  const state = {
    _enabled: true,
    _roadMode: 'osm',
    _loadGeneration: 0,
    _tileCache: new Map(),
    _parseRoads: (data) => data.roads,
  };
  const ingestion = createIngestion({
    state,
    services: {},
    parts: {
      viewport: {
        clampBounds: (b) => b,
        getBoundsCenter: () => ({ lat: 0, lon: 0 }),
      },
      flow: {
        warmFlow: async () => [],
        applyFlowThenRender: async (
          _roads,
          _bounds,
          _generation,
          _altitude,
          label,
        ) => {
          paints.push(label);
          return label === 'Loaded full';
        },
      },
    },
    source: {
      requestRoads: async (_bounds, options) => {
        requests.push(options.majorOnly);
        return {
          ok: true,
          json: async () => ({ roads: [], roadSource: 'OpenStreetMap' }),
        };
      },
    },
  });
  await ingestion.loadRoadsForBounds(
    { west: 0, east: 0.01, south: 0, north: 0.01 },
    450,
  );
  assert.deepEqual(requests, [true, false]);
  assert.deepEqual(paints, ['Loaded major', 'Loaded full']);
  assert.equal(state._fetching, false);
  assert.equal(state._roadError, null);
});

test('measured preview heights select elevated detail roads before surface admission', async () => {
  const { createFlow } = await import('./flow.js');
  const selections = [];
  const road = (lon) => ({
    type: 'primary',
    oneway: 1,
    coords: [
      [lon, 0],
      [lon + 0.001, 0],
    ],
    waypoints: [
      C.Cartesian3.fromDegrees(lon, 0),
      C.Cartesian3.fromDegrees(lon + 0.001, 0),
    ],
    segmentDist: [111],
  });
  const engine = flowEngineAt(1250);
  engine.fake.script('terrainHeight', 750);
  const state = {
    _dots: [],
    _engine: engine,
    _enabled: true,
    _loadGeneration: 1,
    _roadSource: 'OpenStreetMap',
    _flowPending: 0,
    _viewHeightEstimate: 0,
    _activeFetchAbort: new AbortController(),
  };
  const flow = createFlow({
    state,
    services: {
      credits: { registerDynamicCredit() {} },
      ground: { cachedGroundFloor: () => 50 },
    },
    source: {},
    parts: {
      model: {
        allocateRoadDotBudgets: (roads) => roads.map(() => 1),
        recolorDotsInPlace() {},
      },
      rendering: {
        visibleRoadsForAltitude: (roads) => {
          selections.push(
            roads.map(
              (r) => C.Cartographic.fromCartesian(r.waypoints[0]).height,
            ),
          );
          return roads;
        },
        renderRoadsForAltitude() {},
      },
    },
  });
  await flow.applyFlowThenRender([road(0)], {}, 1, 1250, 'Loaded major');
  await flow.applyFlowThenRender(
    [road(0), road(0.002)],
    {},
    1,
    1250,
    'Loaded full',
  );
  assert.ok(Math.abs(state._viewHeightEstimate - 750) < 0.01);
  assert.ok(
    selections.at(-1).every((height) => Math.abs(height - 753) < 0.01),
    'both retained and new roads project at the measured local elevation',
  );
});

test('street spacing follows clearance above local ground in elevated cities', (t) => {
  const h = setup(t);
  const road = h.roads()[0];
  const high = h.parts.model.computeDotCount(road, 1250);
  h.state._viewHeightEstimate = 750;
  const street = h.parts.model.computeDotCount(road, 1250);
  assert.equal(street, h.parts.model.computeDotCount(road, 500));
  assert.ok(street > high);
});

test('provisional opposite-direction heights cannot overwrite a measured sibling during selection', async () => {
  const { createFlow } = await import('./flow.js');
  const road = () => ({
    type: 'primary',
    oneway: 1,
    coords: [
      [0, 0],
      [0.001, 0],
    ],
    waypoints: [
      C.Cartesian3.fromDegrees(0, 0),
      C.Cartesian3.fromDegrees(0.001, 0),
    ],
    segmentDist: [111],
  });
  const selections = [];
  const engine = flowEngineAt(1250);
  engine.fake.script(
    'terrainHeight',
    (c) => 750 + C.Math.toDegrees(c.longitude) * 10000,
  );
  const state = {
    _dots: [],
    _engine: engine,
    _enabled: true,
    _loadGeneration: 1,
    _roadSource: 'OpenStreetMap',
    _flowPending: 0,
    _activeFetchAbort: new AbortController(),
  };
  const flow = createFlow({
    state,
    services: { credits: { registerDynamicCredit() {} } },
    source: {},
    parts: {
      model: {
        allocateRoadDotBudgets: (roads) => roads.map(() => 1),
        recolorDotsInPlace() {},
      },
      rendering: {
        visibleRoadsForAltitude: (roads) => {
          selections.push(
            roads.map((r) =>
              r.waypoints.map((p) => C.Cartographic.fromCartesian(p).height),
            ),
          );
          return roads;
        },
        renderRoadsForAltitude() {},
      },
    },
  });
  await flow.applyFlowThenRender([road()], {}, 1, 1250, 'Loaded major');
  const forward = road(),
    reverse = { ...forward, oneway: -1 };
  await flow.applyFlowThenRender(
    [forward, reverse],
    {},
    1,
    1250,
    'Loaded full',
  );
  assert.ok(
    Math.abs(selections.at(-1)[0][1] - 763) < 0.01,
    'measured slope survives provisional sibling selection',
  );
  assert.notEqual(forward.waypoints, reverse.waypoints);
});

test('a closure that empties the population mid-correction settles heights and clears loading before release', (t) => {
  const h = setup(t);
  h.parts.retention.reconcile(h.roads(), 450, true);
  h.settle();
  assert.equal(h.state._renderHeld, true);
  const road = h.state._roads[0];
  // Republishing the sole road starts a height correction.
  const corrected = h.roads(0, 120);
  h.parts.retention.reconcile(corrected, 450, true);
  assert.equal(h.state._heightPending, true);
  assert.equal(road.heightMoving, true);
  // The closure arrives before the next population pass, which then removes
  // the final points after their fade, long before the correction finishes.
  corrected[0].flow = { level: 0, closure: true };
  for (let i = 0; i < 20 && h.state._dots.length; i++) h.frame();
  assert.equal(h.state._dots.length, 0);
  assert.equal(fillCount(h.engine), 0, 'the last removal is drawn');
  assert.equal(h.state._heatLineCount, 0);
  assert.equal(h.state._renderHeld, false);
  assert.equal(h.state._heightPending, false);
  assert.equal(h.state._populationPending, false);
  assert.equal(road.heightMoving, false);
  assert.ok(
    Math.abs(C.Cartographic.fromCartesian(road.waypoints[0]).height - 120) <
      0.01,
  );
  // Frames driven by other layers stay idle and cannot revive the work.
  h.frame();
  assert.equal(h.state._heightPending, false);
  assert.equal(h.state._renderHeld, false);
});

test('large height corrections obey a screen-pixel bound and reuse projection scratch objects', (t) => {
  const h = setup(t);
  h.engine.fake.setSize(1280, 2000);
  const scratch = new Set();
  h.engine.fake.script('worldToWindow', (point, result) => {
    scratch.add(result);
    result.x = 0;
    result.y = C.Cartographic.fromCartesian(point).height * 10;
    return result;
  });
  h.parts.retention.reconcile(h.roads(), 450, true);
  h.settle();
  const dot = h.state._dots[0],
    id = dot.id;
  h.parts.retention.reconcile(h.roads(0, 160), 450, true);
  for (let i = 0; i < 150; i++) {
    const before = C.Cartographic.fromCartesian(dot.waypoints[0]).height;
    h.parts.retention.easeHeights(1 / 60);
    const after = C.Cartographic.fromCartesian(dot.waypoints[0]).height;
    assert.ok((after - before) * 10 <= 12.01);
  }
  assert.ok(
    Math.abs(C.Cartographic.fromCartesian(dot.waypoints[0]).height - 160) <
      0.01,
  );
  assert.equal(dot.id, id);
  assert.equal(h.state._heightPending, false);
  assert.equal(scratch.size, 2);
});

test('grounded vehicles respect mesh occlusion even after live congestion changes', (t) => {
  const h = setup(t);
  const roads = h.roads();
  h.parts.retention.reconcile(roads, 450, true);
  h.settle();
  assert.ok(h.state._dots.length > 0);
  // The vehicle sets are depth-tested against the scene (Cesium's
  // disableDepthTestDistance 0); no dot carries an override of its own.
  const depthTests = () =>
    Object.values({
      outline: TRAFFIC_SET_IDS.outline,
      fill: TRAFFIC_SET_IDS.fill,
    }).map((id) => h.engine.fake.moverSet(id).options.depthTest);
  assert.deepEqual(depthTests(), ['normal', 'normal']);
  assert.ok(
    h.state._dots.every((d) => !('disableDepthTestDistance' in d.point)),
  );
  for (const road of roads) road.flow = { level: 0.01, closure: false };
  h.parts.model.recolorDotsInPlace('late jam');
  h.frame();
  assert.deepEqual(depthTests(), ['normal', 'normal']);
  assert.ok(
    h.state._dots.every((d) => !('disableDepthTestDistance' in d.point)),
  );
});

test('retained road density follows the settled view without requiring a toggle', (t) => {
  const h = setup(t),
    initial = h.roads();
  initial[0].densityWeight = 0.2;
  h.parts.retention.reconcile(initial, 450, true);
  h.settle();
  const ids = new Set(h.state._dots.map((d) => d.id)),
    before = h.state._dots.length;
  const settled = h.roads();
  settled[0].densityWeight = 1;
  h.parts.retention.reconcile(settled, 450, true);
  h.settle();
  assert.ok(h.state._dots.length > before);
  assert.equal(h.state._roads[0].densityWeight, 1);
  assert.ok([...ids].every((id) => h.state._dots.some((d) => d.id === id)));
  const count = h.state._dots.length;
  h.parts.animation.clearDots();
  h.parts.retention.reconcile(h.roads(), 450, true);
  h.settle();
  assert.equal(
    h.state._dots.length,
    count,
    'fresh toggle and retained view have the same budget',
  );
});

test('flow that lands after a publication re-allocates the retained population', (t) => {
  const h = setup(t);
  const [road] = h.roads();
  // A refresh clears the road's flow before it is published again.
  road.flow = null;
  h.parts.retention.reconcile([road], 450, true);
  h.settle();
  const uncongested = h.state._count;
  const ids = new Set(h.state._dots.map((dot) => dot.id));
  assert.ok(uncongested > 1);
  road.flow = { level: 0.4, closure: false };
  h.parts.model.recolorDotsInPlace('late flow');
  h.parts.retention.retarget();
  h.settle();
  assert.ok(
    h.state._count > 2 * uncongested,
    `slow flow carries more vehicles: ${uncongested} -> ${h.state._count}`,
  );
  assert.ok(
    [...ids].every((id) => h.state._dots.some((dot) => dot.id === id)),
    'the vehicles already on the road keep moving',
  );
  assert.equal(h.state._motion.rebuilds, 0);
});

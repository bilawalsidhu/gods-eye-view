// Traffic republished on the incoming globe after a switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createState } from './state.js';
import { createFlow } from './flow.js';
import { createLifecycle } from './lifecycle.js';
import { observeTrafficSurface } from './surface.js';
import { DOT_HEIGHT_OFFSET } from './policy.js';
import { nextTask } from '../../sources/vectorTiles.js';

const LON = -97.744;
const LAT = 30.267;
const GROUND = 150;
// Keyless Cesium's first coarse terrain tiles put Austin's streets about
// 2 200 m below sea level (Gulf of Mexico bathymetry in the level-0 mesh).
const COARSE = -2200;
const bounds = { west: -97.76, east: -97.73, south: 30.26, north: 30.28 };
const coverage = { rangeKm: 10 };

function road(offset, height) {
  const coords = [
    [LON + offset, LAT + offset],
    [LON + offset + 0.002, LAT + offset],
  ];
  return {
    type: 'primary',
    oneway: 1,
    coords,
    key: `road:${offset}`,
    surfaceReady: true,
    waypoints: coords.map(([lon, lat]) =>
      geo.cartesian3.fromDegrees(lon, lat, height + DOT_HEIGHT_OFFSET),
    ),
    segmentDist: [190],
  };
}

/**
 * An incoming globe (terrain, no photoreal tiles) whose finer tiles arrive
 * later: the camera 1 800 m over Austin, every road on screen, no rendered
 * depth, and the surface observed as the layer's bound scene observes it.
 */
function incomingGlobe(t) {
  const engine = createFakeEngine({ width: 1000, height: 800 });
  engine.fake.maps.imagery = { kind: 'osm' };
  engine.fake.setPose({
    longitude: geo.math.toRadians(LON),
    latitude: geo.math.toRadians(LAT),
    height: 1800,
  });
  const surface = { engine, ready: false, height: COARSE, samples: 0 };
  engine.fake.script('tilesLoaded', () => surface.ready);
  engine.fake.script('terrainHeight', () => {
    surface.samples++;
    return surface.height;
  });
  engine.fake.script('worldToWindow', () => ({ x: 500, y: 500 }));
  engine.fake.script('pickPosition', undefined);
  t.after(observeTrafficSurface(engine));
  surface.frame = () => engine.fake.frame();
  return surface;
}

function fixture(surface) {
  const state = createState({ services: {} });
  const weights = [];
  const paints = [];
  Object.assign(state, {
    _enabled: true,
    _loadGeneration: 1,
    _flowPending: 0,
    _roadSource: 'OpenStreetMap',
    _viewHeightEstimate: GROUND,
    _engine: surface.engine,
    _activeFetchAbort: new AbortController(),
  });
  const flow = createFlow({
    state,
    services: { credits: { registerDynamicCredit() {} } },
    source: {},
    parts: {
      model: {
        allocateRoadDotBudgets: (roads) => {
          weights.push(roads.map((r) => r.densityWeight));
          return roads.map(() => 4);
        },
        recolorDotsInPlace() {},
      },
      rendering: {
        visibleRoadsForAltitude: (roads) => roads,
        renderRoadsForAltitude: (roads, _altitude, label) =>
          paints.push({ label, roads: roads.length }),
      },
    },
  });
  return { state, flow, weights, paints };
}

const height = (point) => geo.cartographic.fromCartesian(point).height;
// The refinement runs in tasks the flow yields between (nextTask). Wait for
// its outcome task by task instead of for a fixed time, which a loaded test
// runner can outlast.
const settle = async (done) => {
  for (let task = 0; task < 500 && !done(); task++) await nextTask();
};

test('a republish weights roads by distance to the local ground, not by heights another globe sampled', async (t) => {
  const offsets = [0.004, 0.012, 0.02];
  const weightsFor = async (sampledHeight) => {
    const surface = incomingGlobe(t);
    surface.ready = true;
    surface.height = GROUND;
    surface.frame();
    const { flow, weights } = fixture(surface);
    const roads = offsets.map((offset) => road(offset, sampledHeight));
    await flow.applyFlowThenRender(
      roads,
      { ...bounds, coverage },
      1,
      1800,
      'Handoff',
    );
    return weights[0];
  };
  const fromGround = await weightsFor(GROUND);
  const fromCoarse = await weightsFor(COARSE);
  assert.equal(fromGround.length, offsets.length);
  for (let i = 0; i < offsets.length; i++)
    assert.ok(
      Math.abs(fromCoarse[i] - fromGround[i]) < 1e-9,
      `road ${i}: ${fromCoarse[i]} against ${fromGround[i]}`,
    );
  // A nearer road keeps more of its weight than a farther one.
  assert.ok(fromGround[0] > fromGround[2]);
});

test('the handoff pass on a loading globe refines once its surface is ready', async (t) => {
  const surface = incomingGlobe(t);
  surface.frame();
  const { flow, paints } = fixture(surface);
  const roads = [road(0.004, GROUND), road(0.008, GROUND)];
  await flow.applyFlowThenRender(
    roads,
    { ...bounds, coverage },
    1,
    1800,
    'Handoff',
  );
  assert.ok(
    roads.every((r) => Math.abs(height(r.waypoints[0]) - COARSE) < 4),
    'the coarse tiles are sampled provisionally',
  );
  surface.height = GROUND;
  surface.frame();
  assert.equal(paints.at(-1).label, 'Handoff', 'not ready: no refinement yet');
  surface.ready = true;
  surface.frame();
  await settle(() => paints.at(-1)?.label === 'Handoff refined');
  assert.equal(paints.at(-1).label, 'Handoff refined');
  for (const r of roads)
    assert.ok(
      Math.abs(height(r.waypoints[0]) - GROUND - DOT_HEIGHT_OFFSET) < 0.01,
      'vehicles follow the loaded surface',
    );
});

test('a still camera drains pending surface samples across bounded passes using requested frames', async (t) => {
  const surface = incomingGlobe(t);
  surface.ready = true;
  surface.frame();
  const { engine } = surface;
  const { state, flow } = fixture(surface);
  t.after(() => {
    state._activeFetchAbort.abort();
    state._surfaceRefineRemove?.();
  });
  const roads = Array.from({ length: 20 }, (_, i) => road(i * 0.0001, GROUND));
  let time = 0;
  let available = 8;
  let samples = 0;
  let samplesAtYield;
  let frames = 0;
  const measured = new Set();
  t.mock.method(performance, 'now', () => time);
  engine.fake.script('terrainHeight', (point) => {
    samples++;
    if (samples === 1) setTimeout(() => (samplesAtYield = samples), 0);
    time += 3;
    const key = `${point.longitude},${point.latitude}`;
    if (!measured.has(key)) {
      if (!available) return undefined;
      available--;
      measured.add(key);
    }
    return GROUND;
  });
  let cameraChanges = 0;
  t.after(engine.camera.changed.addEventListener(() => cameraChanges++));
  t.after(
    engine.frames.preRender.addEventListener(() => {
      available = 8;
      surface.ready = ++frames > 1;
    }),
  );
  const requests = engine.fake.renderRequests;
  await flow.applyFlowThenRender(
    roads,
    { ...bounds, coverage },
    1,
    1800,
    'Loaded full',
  );
  assert.ok(samples * 3 > 12, 'the samples exceed one surface slice');
  assert.equal(samplesAtYield, 4, 'sampling yields at the 12 ms budget');
  assert.ok(state._surfacePending > 0, 'some streets are not loaded yet');
  let rendered = requests;
  await settle(() => {
    if (engine.fake.renderRequests > rendered) {
      rendered = engine.fake.renderRequests;
      surface.frame();
    }
    return !state._surfacePending && !state._surfaceRefining;
  });
  assert.equal(state._surfacePending, 0);
  assert.equal(cameraChanges, 0, 'no camera trigger resumes the work');
  assert.ok(rendered - requests > 1, 'missing heights need further frames');
  assert.equal(state._surfaceRefineRemove, null);
  for (const r of roads) {
    assert.equal(r.surfaceReady, true);
    assert.ok(
      r.waypoints.every(
        (point) => Math.abs(height(point) - GROUND - DOT_HEIGHT_OFFSET) < 0.01,
      ),
    );
  }
  const finished = engine.fake.renderRequests;
  surface.frame();
  await nextTask();
  assert.equal(engine.fake.renderRequests, finished, 'settled work is idle');
});

test('a completed surface defers unavailable roads until the next view instead of refining forever', async (t) => {
  const surface = incomingGlobe(t);
  surface.ready = true;
  surface.frame();
  const { engine } = surface;
  const { state, flow } = fixture(surface);
  t.after(() => {
    state._activeFetchAbort.abort();
    state._surfaceRefineRemove?.();
  });
  const roads = [road(0, GROUND), road(0.008, GROUND)];
  let missing = true;
  engine.fake.script('terrainHeight', (point) =>
    missing && geo.math.toDegrees(point.latitude) > LAT + 0.004
      ? undefined
      : GROUND,
  );
  await flow.applyFlowThenRender(
    roads,
    { ...bounds, coverage },
    1,
    1800,
    'Loaded full',
  );
  let rendered = engine.fake.renderRequests;
  await settle(() => {
    if (engine.fake.renderRequests > rendered || state._surfaceRefineRemove) {
      rendered = engine.fake.renderRequests;
      surface.frame();
    }
    return !state._surfacePending && !state._surfaceRefining;
  });
  assert.equal(
    state._surfacePending,
    0,
    'unavailable roads are not outstanding work',
  );
  assert.equal(state._surfaceRefining, false);
  assert.equal(state._surfaceRefineRemove, null);
  assert.equal(roads[1].surfaceReady, false, 'no unmeasured road is displayed');
  const finished = engine.fake.renderRequests;
  surface.frame();
  await nextTask();
  assert.equal(
    engine.fake.renderRequests,
    finished,
    'the completed view is idle',
  );

  missing = false;
  await flow.applyFlowThenRender(
    roads,
    { ...bounds, coverage },
    1,
    1800,
    'Loaded full',
  );
  assert.equal(
    roads[1].surfaceReady,
    true,
    'another view retries the retained road',
  );
});

test('the surface wait deadline defers pending roads when the mesh never settles', async (t) => {
  const surface = incomingGlobe(t);
  surface.frame();
  const { state, flow } = fixture(surface);
  t.after(() => {
    state._activeFetchAbort.abort();
    state._surfaceRefineRemove?.();
  });
  const schedule = globalThis.setTimeout;
  let deadline;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 10000) deadline = callback;
    return schedule(callback, delay, ...args);
  });
  surface.engine.fake.script('terrainHeight', (point) =>
    geo.math.toDegrees(point.latitude) > LAT + 0.004 ? undefined : GROUND,
  );
  await flow.applyFlowThenRender(
    [road(0, GROUND), road(0.008, GROUND)],
    { ...bounds, coverage },
    1,
    1800,
    'Loaded full',
  );
  assert.equal(state._surfacePending, 1);
  assert.equal(typeof deadline, 'function');
  deadline();
  assert.equal(state._surfacePending, 0);
  assert.equal(state._surfaceRefineRemove, null);
});

test('resuming the viewport republishes the retained roads as a pass that can still refine', () => {
  const labels = [];
  const state = createState({ services: {} });
  const surfaceInput = { roads: [road(0.004, GROUND)], bounds };
  Object.assign(state, {
    _enabled: true,
    _fetching: false,
    _surfaceInput: surfaceInput,
    _lastBounds: bounds,
    _loadGeneration: 3,
  });
  const lifecycle = createLifecycle({
    state,
    services: {},
    source: { resetFlowTileCache() {} },
    parts: {
      retention: { resume() {} },
      viewport: { getCameraAltitude: () => 1800, onCameraChanged() {} },
      flow: {
        applyFlowThenRender: async (
          roads,
          clamped,
          generation,
          altitude,
          label,
        ) => {
          labels.push({ roads, clamped, generation, altitude, label });
          return true;
        },
      },
    },
  });
  lifecycle.methods.resumeViewport();
  assert.equal(labels.length, 1);
  assert.equal(labels[0].roads, surfaceInput.roads);
  assert.equal(labels[0].generation, 3);
  assert.doesNotMatch(labels[0].label, /refined/);
});

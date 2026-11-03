// Traffic republished on the incoming globe after a switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from 'cesium';
import { createState } from './state.js';
import { createFlow } from './flow.js';
import { createLifecycle } from './lifecycle.js';
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
      C.Cartesian3.fromDegrees(lon, lat, height + DOT_HEIGHT_OFFSET),
    ),
    segmentDist: [190],
  };
}

/** An incoming Navara-like surface whose finer tiles arrive later. */
function navaraSurface() {
  const listeners = new Set();
  const surface = {
    ready: false,
    height: COARSE,
    samples: 0,
    surfaceKey: 'terrain',
    canvas: { clientWidth: 1000, clientHeight: 800 },
    project: () => ({ x: 500, y: 500 }),
    sampleHeightSupported: true,
    sampleHeight: () => {
      surface.samples++;
      return surface.height;
    },
    postRender: {
      addEventListener(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    frame: () => [...listeners].forEach((listener) => listener()),
    engine: {
      camera: {
        pose: () => ({
          cartographic: C.Cartographic.fromDegrees(LON, LAT, 1800),
        }),
        livePosition: C.Cartesian3.fromDegrees(LON, LAT, 1800),
      },
    },
  };
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
    _trafficScene: () => surface,
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

const height = (point) => C.Cartographic.fromCartesian(point).height;
// The refinement runs in tasks the flow yields between (nextTask). Wait for
// its outcome task by task instead of for a fixed time, which a loaded test
// runner can outlast.
const settle = async (done) => {
  for (let task = 0; task < 500 && !done(); task++) await nextTask();
};

test('a republish weights roads by distance to the local ground, not by heights another globe sampled', async () => {
  const offsets = [0.004, 0.012, 0.02];
  const weightsFor = async (sampledHeight) => {
    const surface = navaraSurface();
    surface.ready = true;
    surface.height = GROUND;
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

test('the handoff pass on a loading globe refines once its surface is ready', async () => {
  const surface = navaraSurface();
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

test('resuming the viewport republishes the retained roads as a pass that can still refine', () => {
  const labels = [];
  const state = createState({ services: {} });
  const surfaceInput = { roads: [road(0.004, GROUND)], bounds };
  Object.assign(state, {
    _enabled: true,
    _restoringViewport: true,
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

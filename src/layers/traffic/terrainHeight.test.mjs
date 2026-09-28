import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createModel } from './model.js';
import { createTiming } from './timing.js';
import { DOT_HEIGHT_OFFSET } from './policy.js';

const roadData = {
  roads: [
    {
      type: 'primary',
      oneway: false,
      coordinates: [
        [-97.74, 30.27],
        [-97.75, 30.28],
      ],
    },
  ],
};

function waypointHeight(road) {
  return Cesium.Cartographic.fromCartesian(road.waypoints[0]).height;
}

function modelFor(viewer) {
  return createModel({
    state: { _viewer: viewer },
    services: {},
    parts: {},
    source: {},
  });
}

test('road parsing rejects bogus finite terrain and falls back to globe height', () => {
  const model = modelFor({
    scene: {
      sampleHeightSupported: true,
      sampleHeight: () => -16800,
      globe: { show: true, getHeight: () => 120 },
    },
  });
  const [road] = model.parseRoads(roadData);
  assert.ok(
    Math.abs(waypointHeight(road) - (120 + DOT_HEIGHT_OFFSET)) < 0.1,
  );
});

test('road parsing retains a sane scene sample', () => {
  const model = modelFor({
    scene: {
      sampleHeightSupported: true,
      sampleHeight: () => 45,
      globe: { show: true, getHeight: () => 120 },
    },
  });
  const [road] = model.parseRoads(roadData);
  assert.ok(
    Math.abs(waypointHeight(road) - (45 + DOT_HEIGHT_OFFSET)) < 0.1,
  );
});

test('road parsing falls back to ellipsoid when neither surface sample is usable', () => {
  const model = modelFor({
    scene: {
      sampleHeightSupported: true,
      sampleHeight: () => -16800,
      globe: { show: false },
    },
  });
  const [road] = model.parseRoads(roadData);
  assert.ok(Math.abs(waypointHeight(road) - DOT_HEIGHT_OFFSET) < 0.1);
});

test('timed road parser uses the same terrain fallback contract', () => {
  const viewer = {
    scene: {
      sampleHeightSupported: true,
      sampleHeight: () => -16800,
      globe: { show: true, getHeight: () => 120 },
    },
  };
  const timing = createTiming({
    state: {
      _viewer: viewer,
      _trafficTimingSampledCells: new Set(),
      _trafficTimingSampleHeightCalls: 0,
      _trafficTimingSampleHeightMs: 0,
      _trafficTimingWaypointMaterializationMs: 0,
    },
    services: {},
    parts: {},
    source: {},
  });
  const trace = { cameraChangeMark: null, passes: new Map() };
  const [road] = timing.parseRoadsTimed(roadData, trace);
  assert.ok(
    Math.abs(waypointHeight(road) - (120 + DOT_HEIGHT_OFFSET)) < 0.1,
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createMarker } from './marker.js';
import { GROUND_CAST_LIFT_M, MESH_LIFT_M } from './groundCast.js';

// The marker glyph draws on a canvas; Node has none, so drawing is a no-op.
const noop = () => {};
const context2d = new Proxy({}, { get: () => noop, set: () => true });
globalThis.document ??= {
  createElement: () => ({ getContext: () => context2d }),
};

/** A viewer whose camera is 20,000 km over `view`, and its pre-render listeners. */
function setup({ parts = {}, surface = 'draped' } = {}) {
  const view = { lon: -121.49, lat: 38.58, height: 20_000_000 };
  const preRender = new Set();
  const viewer = {
    camera: {
      get positionWC() {
        return Cesium.Cartesian3.fromDegrees(view.lon, view.lat, view.height);
      },
    },
    scene: {
      primitives: { add: (p) => p, remove() {} },
      preRender: {
        addEventListener(listener) {
          preRender.add(listener);
          return () => preRender.delete(listener);
        },
      },
    },
  };
  const state = {
    services: {},
    viewer,
    surface,
    marker: {
      // Stands in for the billboard collection; ensure() keeps it.
      collection: {
        show: true,
        add: (options) => ({ ...options }),
        removeAll() {},
      },
      billboard: null,
    },
  };
  const marker = createMarker({ state, parts });
  const frame = () => {
    for (const listener of [...preRender]) listener();
  };
  return { state, view, preRender, marker, frame };
}

test('the photo marker is hidden behind the globe, and shows from its side', () => {
  const { state, view, preRender, marker, frame } = setup();
  // Placed on the far side of the Earth from the camera.
  marker.set({ lon: 58.51, lat: -38.58 }, 90);
  const billboard = state.marker.billboard;
  assert.equal(billboard.show, false, 'not drawn through the globe');
  // Fly round to its side: it shows.
  view.lon = 58.51;
  view.lat = -38.58;
  frame();
  assert.equal(billboard.show, true);
  // Moved to the far side again, without the camera moving.
  marker.set({ lon: -121.49, lat: 38.58 }, 0);
  assert.equal(billboard.show, false, 'culled where it now stands');
  marker.clear();
  assert.equal(preRender.size, 0, 'the cull listener is gone');
});

test('destroying the marker stops the horizon cull', () => {
  const { marker, preRender } = setup();
  marker.set({ lon: -121.49, lat: 38.58 }, 0);
  assert.equal(preRender.size, 1);
  marker.destroy();
  assert.equal(preRender.size, 0);
});

/**
 * Bare earth from a ground caster (null until its cell is fetched) and the
 * sampled Google 3D surface from a mesh sampler (undefined until sampled).
 */
function terrainParts({ dem = null, mesh } = {}) {
  const ground = { dem, prepares: [] };
  const sampler = { mesh, requests: [], listeners: [] };
  return {
    ground,
    sampler,
    parts: {
      groundCaster: {
        groundAt: () => ground.dem,
        prepare(points) {
          let resolve;
          const promise = new Promise((done) => {
            resolve = done;
          });
          ground.prepares.push({ points, resolve });
          return promise;
        },
      },
      meshSampler: {
        meshAt: () => sampler.mesh,
        request: (points) => sampler.requests.push(points),
        onSampled: (listener) => sampler.listeners.push(listener),
      },
    },
  };
}

const heightOf = (billboard) =>
  Cesium.Cartographic.fromCartesian(billboard.position).height;
const SPOT = { lon: -121.49, lat: 38.58 };

test('in terrain mode the marker stands on the sampled road surface (mesh near bare earth)', () => {
  const { parts } = terrainParts({ dem: 10, mesh: 11.5 });
  const { state, marker } = setup({ parts, surface: 'terrain' });
  marker.set(SPOT, 45);
  const billboard = state.marker.billboard;
  assert.equal(billboard.heightReference, Cesium.HeightReference.NONE);
  assert.ok(
    Math.abs(heightOf(billboard) - (11.5 + MESH_LIFT_M)) < 1e-3,
    `height ${heightOf(billboard)}`,
  );
});

test('in terrain mode without a mesh sample the marker stands on bare earth and asks for one', () => {
  const { parts, sampler } = terrainParts({ dem: 10 });
  const { state, marker } = setup({ parts, surface: 'terrain' });
  marker.set(SPOT, 45);
  const billboard = state.marker.billboard;
  assert.equal(billboard.heightReference, Cesium.HeightReference.NONE);
  assert.ok(
    Math.abs(heightOf(billboard) - (10 + GROUND_CAST_LIFT_M)) < 1e-3,
    `height ${heightOf(billboard)}`,
  );
  assert.deepEqual(sampler.requests, [[[SPOT.lon, SPOT.lat]]]);
  // The sample lands: the marker moves onto the road surface.
  sampler.mesh = 10.5;
  for (const listener of sampler.listeners) listener();
  assert.ok(Math.abs(heightOf(billboard) - (10.5 + MESH_LIFT_M)) < 1e-3);
});

test('in terrain mode with no ground yet the marker clamps, then stands up once the ground arrives', async () => {
  const { parts, ground } = terrainParts({ mesh: 11 });
  const { state, marker } = setup({ parts, surface: 'terrain' });
  marker.set(SPOT, 45);
  const billboard = state.marker.billboard;
  assert.equal(
    billboard.heightReference,
    Cesium.HeightReference.CLAMP_TO_GROUND,
  );
  assert.deepEqual(ground.prepares[0].points, [[SPOT.lon, SPOT.lat]]);
  ground.dem = 10;
  ground.prepares[0].resolve(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(billboard.heightReference, Cesium.HeightReference.NONE);
  assert.ok(Math.abs(heightOf(billboard) - (11 + MESH_LIFT_M)) < 1e-3);
  assert.equal(billboard.rotation, -Cesium.Math.toRadians(45), 'bearing kept');
});

test('ground that arrives after the marker moved on does not move it back', async () => {
  const { parts, ground } = terrainParts();
  const { state, marker } = setup({ parts, surface: 'terrain' });
  marker.set(SPOT, 0);
  const elsewhere = { lon: -121.5, lat: 38.6 };
  marker.set(elsewhere, 0);
  ground.dem = 10;
  ground.prepares[0].resolve(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const placed = Cesium.Cartographic.fromCartesian(
    state.marker.billboard.position,
  );
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(placed.longitude) - elsewhere.lon) < 1e-9,
  );
});

test('draped mode clamps the marker to the globe whatever the ground says', () => {
  const { parts, ground } = terrainParts({ dem: 10, mesh: 11 });
  const { state, marker } = setup({ parts, surface: 'draped' });
  marker.set(SPOT, 0);
  assert.equal(
    state.marker.billboard.heightReference,
    Cesium.HeightReference.CLAMP_TO_GROUND,
  );
  assert.equal(ground.prepares.length, 0);
});

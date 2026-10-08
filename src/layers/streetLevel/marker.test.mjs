import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createMarker } from './marker.js';

/** A viewer whose camera is 20,000 km over `view`, and its pre-render listeners. */
function setup() {
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
  const marker = createMarker({ state });
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

const SPOT = { lon: -121.49, lat: 38.58 };

test('the marker is clamped to the ground and turned to the bearing', () => {
  const { state, marker } = setup();
  marker.set(SPOT, 45);
  const billboard = state.marker.billboard;
  assert.equal(
    billboard.heightReference,
    Cesium.HeightReference.CLAMP_TO_GROUND,
  );
  assert.equal(billboard.rotation, -Cesium.Math.toRadians(45));
  // Moving it keeps the same billboard.
  marker.set({ lon: -121.5, lat: 38.6 }, 90);
  assert.equal(state.marker.billboard, billboard);
  const placed = Cesium.Cartographic.fromCartesian(billboard.position);
  assert.ok(Math.abs(Cesium.Math.toDegrees(placed.longitude) + 121.5) < 1e-9);
  assert.equal(billboard.rotation, -Cesium.Math.toRadians(90));
});

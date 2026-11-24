import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createMarker } from './marker.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { streetPorts } from '../../testSupport/streetLevelFakes.mjs';
import { fakeDrawPort } from '../../testSupport/fakeDrawPort.mjs';

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
      preRender: {
        addEventListener(listener) {
          preRender.add(listener);
          return () => preRender.delete(listener);
        },
      },
    },
  };
  const draw = fakeDrawPort();
  bindRenderer(viewer, streetPorts(viewer, { camera: true, draw }));
  const state = {
    services: {},
    viewer,
    marker: { set: null, placed: null, look: null },
  };
  const marker = createMarker({ state });
  marker.ensure(viewer);
  const frame = () => {
    for (const listener of [...preRender]) listener();
  };
  /** The marker's drawn icon, or undefined. */
  const icon = () => draw.find('street-level:marker:')?.items.get('sl:pos');
  return { state, viewer, view, preRender, marker, frame, draw, icon };
}

test('the photo marker is hidden behind the globe, and shows from its side', () => {
  const { view, preRender, marker, frame, icon } = setup();
  // Placed on the far side of the Earth from the camera.
  marker.set({ lon: 58.51, lat: -38.58 }, 90);
  assert.equal(icon().show, false, 'not drawn through the globe');
  // Fly round to its side: it shows.
  view.lon = 58.51;
  view.lat = -38.58;
  frame();
  assert.equal(icon().show, true);
  // Moved to the far side again, without the camera moving.
  marker.set({ lon: -121.49, lat: 38.58 }, 0);
  assert.equal(icon().show, false, 'culled where it now stands');
  marker.clear();
  assert.equal(icon(), undefined, 'cleared');
  assert.equal(preRender.size, 0, 'the cull listener is gone');
});

test('destroying the marker stops the horizon cull and lets its set go', () => {
  const { marker, preRender, draw } = setup();
  marker.set({ lon: -121.49, lat: 38.58 }, 0);
  assert.equal(preRender.size, 1);
  marker.destroy();
  assert.equal(preRender.size, 0);
  assert.equal(draw.find('street-level:marker:'), undefined, 'disposed');
});

const SPOT = { lon: -121.49, lat: 38.58 };

test('the marker is clamped to the ground and turned to the bearing', () => {
  const { marker, icon, draw } = setup();
  marker.set(SPOT, 45);
  assert.equal(icon().height, 'clampGround');
  assert.equal(icon().rotationMode, 'course');
  assert.equal(icon().course, 45);
  assert.equal(icon().disableDepthTest, Number.POSITIVE_INFINITY);
  // Moving it keeps the one item, updated in place.
  marker.set({ lon: -121.5, lat: 38.6 }, 90);
  const set = draw.find('street-level:marker:');
  assert.equal(set.items.size, 1);
  assert.deepEqual(icon().pos, { lon: -121.5, lat: 38.6 });
  assert.equal(icon().course, 90);
});

test('a Street View photo gets a blue view cone; a Mapillary photo GEV\u2019s pin', () => {
  const { marker, icon, state } = setup();
  const streetView = { kind: 'view-cone', color: '#4285f4' };
  marker.set({ lon: -121.49, lat: 38.58 }, 45, streetView);
  const cone = icon().image;
  assert.equal(state.marker.look, 'view-cone:#4285f4');
  assert.deepEqual(icon().size, [48, 48]);
  assert.equal(icon().course, 45, 'it turns with the view');
  // Dragging the panorama keeps the look.
  marker.set({ lon: -121.49, lat: 38.58 }, 90, streetView);
  assert.equal(icon().image, cone);
  // A Mapillary photo next (its provider has no marker): the pin.
  marker.set({ lon: -121.49, lat: 38.58 }, 90, undefined);
  assert.equal(state.marker.look, 'pin');
  assert.notEqual(icon().image, cone);
  assert.deepEqual(icon().size, [40, 40]);
});

test('hiding the layer hides the marker set', () => {
  const { marker, draw } = setup();
  marker.set(SPOT, 0);
  marker.setVisible(false);
  assert.equal(draw.find('street-level:marker:').show, false);
  marker.setVisible(true);
  assert.equal(draw.find('street-level:marker:').show, true);
});

test('each placement is one write, culled before it is sent', () => {
  const { marker, draw, icon } = setup();
  const set = draw.find('street-level:marker:');
  const before = set.writes;
  // Past the horizon: culled, and still sent once.
  marker.set({ lon: 58.51, lat: -38.58 }, 0);
  assert.equal(set.writes, before + 1);
  assert.equal(icon().show, false);
  marker.set(SPOT, 0);
  assert.equal(set.writes, before + 2);
});

test('a marker destroyed and made again draws in a new set', () => {
  const { marker, viewer, draw, icon } = setup();
  const first = draw.find('street-level:marker:').spec.id;
  marker.destroy();
  assert.equal(draw.set(first), undefined, 'its set goes with it');
  marker.ensure(viewer);
  const second = draw.find('street-level:marker:').spec.id;
  assert.notEqual(second, first);
  marker.set(SPOT, 30);
  assert.equal(icon().course, 30);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createHorizonCull } from './horizonCull.js';
import { bindRenderer } from './rendererOf.js';

/**
 * A horizon cull over `items` for a camera the test moves, with the frame's
 * pre-render listeners and a count of the camera poses read.
 */
function cullHarness(t, items) {
  const preRender = new Set();
  let eye = Cesium.Cartesian3.fromDegrees(0, 0, 1e7);
  let poses = 0;
  const viewer = {};
  bindRenderer(viewer, {
    camera: {
      pose: () => {
        poses++;
        return { lon: 0, lat: 0, height: 1e7, position: { ...eye } };
      },
    },
    frame: {
      on(phase, listener) {
        assert.equal(phase, 'preRender');
        preRender.add(listener);
        return () => preRender.delete(listener);
      },
    },
  });
  // Items handed to a cull pass: what a still camera must not test again.
  const tested = { count: 0 };
  let changes = 0;
  const cull = createHorizonCull({
    getViewer: () => viewer,
    items: () => {
      tested.count += items.length;
      return items;
    },
    onChange: () => changes++,
  });
  return {
    cull,
    preRender,
    poses: () => poses,
    tested: () => tested.count,
    changes: () => changes,
    frame: () => {
      for (const listener of [...preRender]) listener();
    },
    moveTo: (lon, lat) => (eye = Cesium.Cartesian3.fromDegrees(lon, lat, 1e7)),
  };
}

const point = (lon, lat) => ({
  position: Cesium.Cartesian3.fromDegrees(lon, lat),
  show: true,
});

test('the horizon cull does no work while the camera stands still', (t) => {
  const near = point(0, 0);
  const far = point(180, 0);
  const h = cullHarness(t, [near, far]);
  h.cull.update();
  assert.equal(h.tested(), 2);
  assert.deepEqual([near.show, far.show], [true, false]);
  assert.equal(h.preRender.size, 1, 'listening for camera moves');
  for (let i = 0; i < 5; i++) h.frame();
  assert.equal(h.tested(), 2, 'a still camera re-culls nothing');
  h.moveTo(180, 0);
  h.frame();
  assert.equal(h.tested(), 4, 'a moved camera re-culls everything once');
  assert.deepEqual([near.show, far.show], [false, true]);
  h.frame();
  h.frame();
  assert.equal(h.tested(), 4, 'and then rests again');
  h.cull.stop();
  assert.equal(h.preRender.size, 0);
});

test('the horizon cull stops listening once nothing is left, and starts again for new items', (t) => {
  const items = [point(0, 0)];
  const h = cullHarness(t, items);
  h.cull.update();
  assert.equal(h.preRender.size, 1);
  // Every item goes (the tiles are dropped); the next camera move finds none.
  items.length = 0;
  h.moveTo(10, 0);
  h.frame();
  assert.equal(h.preRender.size, 0, 'the listener is removed');
  // New items arrive: they are culled now, and camera moves are watched again.
  const far = point(-170, 0);
  items.push(far);
  h.cull.update([far]);
  assert.equal(far.show, false, 'culled on arrival');
  assert.equal(h.preRender.size, 1, 'the listener is back');
  h.moveTo(-170, 0);
  h.frame();
  assert.equal(far.show, true, 're-culled when the camera moves');
  assert.equal(h.changes(), 2, 'a redraw for each change');
  h.cull.stop();
});

/** A cull over `points` ([lon, lat, height]) seen from a camera at `camera`. */
function cullFrom(camera, points) {
  const items = points.map(([lon, lat, height]) => ({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, height),
    show: true,
  }));
  const viewer = {};
  bindRenderer(viewer, {
    camera: {
      pose: () => ({
        lon: camera[0],
        lat: camera[1],
        height: camera[2],
        position: Cesium.Cartesian3.fromDegrees(...camera),
      }),
    },
    frame: { on: () => () => {} },
  });
  const horizon = createHorizonCull({
    getViewer: () => viewer,
    items: () => items,
  });
  horizon.update();
  horizon.stop();
  return items.map((item) => item.show);
}

test('cones and the marker stay visible on ground below the WGS84 ellipsoid', () => {
  // NYC at street level: eye 2.4 m above ground at -22 m, a cone 10 m away.
  assert.deepEqual(
    cullFrom([-74.006, 40.7128, -19.6], [[-74.006, 40.71289, -22]]),
    [true],
  );
  // Colombo framing view: camera at -21 m, cones at -95 m about 80 m away.
  assert.deepEqual(
    cullFrom(
      [79.8612, 6.9271, -21],
      [
        [79.8612, 6.92782, -95],
        [79.86192, 6.9271, -95],
      ],
    ),
    [true, true],
  );
  // Austin, ground well above the ellipsoid.
  assert.deepEqual(
    cullFrom([-97.7431, 30.2672, 132], [[-97.7431, 30.2681, 130]]),
    [true],
  );
});

test('the horizon cull still hides the far side of the Earth from orbit', () => {
  assert.deepEqual(
    cullFrom(
      [0, 0, 20_000_000],
      [
        [10, 10, 0],
        [180, 0, 0],
      ],
    ),
    [true, false],
  );
});

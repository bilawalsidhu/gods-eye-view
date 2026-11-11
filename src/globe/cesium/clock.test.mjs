import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createAppClock } from '../../time/clock.js';
import { createCesiumClock } from './clock.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

function manualAppClock(start = Date.UTC(2026, 9, 16)) {
  let wall = start;
  const appClock = createAppClock({ now: () => wall });
  return {
    appClock,
    advance(ms) {
      wall += ms;
    },
  };
}

// One turn of CesiumWidget's loop: the clock ticks, then scene.render
// raises preUpdate (and preRender/postRender when it draws).
function cesiumFrame(viewer, { draw = true } = {}) {
  const time = Cesium.JulianDate.now();
  viewer.clock.onTick.raiseEvent(viewer.clock);
  viewer.scene.preUpdate.raiseEvent(viewer.scene, time);
  if (!draw) return;
  viewer.scene.preRender.raiseEvent(viewer.scene, time);
  viewer.scene.postRender.raiseEvent(viewer.scene, time);
}

test('the clock reads the app clock and latches on the viewer clock from creation', () => {
  const viewer = createFakeViewer();
  const wall = manualAppClock();
  const { clock } = createCesiumClock(viewer, { appClock: wall.appClock });
  // Attached at creation, so it runs before onTick listeners added later.
  assert.equal(viewer.clock.onTick.numberOfListeners, 1);
  const order = [];
  viewer.clock.onTick.addEventListener(() => order.push(clock.frameTime()));
  wall.advance(9);
  viewer.clock.onTick.raiseEvent(viewer.clock);
  assert.deepEqual(order, [wall.appClock.now()]);
  assert.equal(clock.now(), wall.appClock.now());
  wall.advance(5);
  assert.equal(clock.now(), wall.appClock.now());
});

test('frameTime is latched on the viewer clock tick, before preUpdate', () => {
  const viewer = createFakeViewer();
  const wall = manualAppClock();
  const { clock } = createCesiumClock(viewer, { appClock: wall.appClock });
  const seen = [];
  viewer.clock.onTick.addEventListener(() =>
    seen.push(['tick', clock.frameTime()]),
  );
  // A preUpdate listener the app added before the engine existed still
  // reads this frame's time: the latch is on the tick, not on preUpdate.
  viewer.scene.preUpdate.addEventListener(() =>
    seen.push(['preUpdate', clock.frameTime()]),
  );
  viewer.scene.preRender.addEventListener(() => {
    wall.advance(3);
    seen.push(['preRender', clock.frameTime()]);
  });
  const t0 = wall.appClock.now();
  cesiumFrame(viewer);
  wall.advance(16);
  cesiumFrame(viewer, { draw: false });
  assert.deepEqual(seen, [
    ['tick', t0],
    ['preUpdate', t0],
    ['preRender', t0],
    ['tick', t0 + 19],
    ['preUpdate', t0 + 19],
  ]);
});

test('frameTime reads the latch; destroy removes it', () => {
  const viewer = createFakeViewer();
  const wall = manualAppClock();
  const { clock, destroy } = createCesiumClock(viewer, {
    appClock: wall.appClock,
  });
  const before = clock.frameTime();
  assert.equal(before, wall.appClock.now());
  assert.equal(viewer.clock.onTick.numberOfListeners, 1);
  wall.advance(40);
  cesiumFrame(viewer);
  assert.equal(clock.frameTime(), before + 40);
  wall.advance(10);
  assert.equal(clock.frameTime(), before + 40);
  destroy();
  assert.equal(viewer.clock.onTick.numberOfListeners, 0);
});


test('the viewer clock itself is left alone', () => {
  const viewer = createFakeViewer();
  viewer.clock.shouldAnimate = false;
  viewer.clock.multiplier = 1;
  const currentTime = viewer.clock.currentTime.clone();
  const { clock } = createCesiumClock(viewer, {
    appClock: manualAppClock().appClock,
  });
  clock.frameTime();
  cesiumFrame(viewer);
  assert.equal(viewer.clock.shouldAnimate, false);
  assert.equal(viewer.clock.multiplier, 1);
  assert.ok(viewer.clock.currentTime.equals(currentTime));
});

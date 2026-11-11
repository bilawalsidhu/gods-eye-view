import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createWorldClock } from '../../time/worldClock.js';
import { julianAt } from '../../time/julian.js';
import { followWorldTime } from './worldTime.js';

test('sky frames follow the world cursor while live feeds stay live, and detach cleanly', () => {
  let wall = Date.UTC(2026, 10, 1, 12);
  const world = createWorldClock({ now: () => wall, follow: ['sky'] });
  let renders = 0;
  const viewer = {
    clock: { currentTime: Cesium.JulianDate.fromDate(new Date(wall)) },
    scene: {
      preUpdate: new Cesium.Event(),
      requestRender: () => renders++,
    },
  };
  const stop = followWorldTime(viewer, world.timeFor('sky'), world);
  const frameTime = new Cesium.JulianDate();
  const frame = () => viewer.scene.preUpdate.raiseEvent(viewer.scene, frameTime);
  const past = wall - 6 * 3600_000;
  world.seek(past);
  assert.equal(renders, 1);
  frame();
  assert.equal(Cesium.JulianDate.toDate(frameTime).getTime(), past);
  assert.ok(Cesium.JulianDate.equals(viewer.clock.currentTime, julianAt(past)));
  assert.equal(world.timeFor('flights')(), wall);
  wall += 120_000;
  frame();
  assert.equal(Cesium.JulianDate.toDate(frameTime).getTime(), past);
  world.goLive();
  frame();
  assert.equal(Cesium.JulianDate.toDate(frameTime).getTime(), wall);
  stop();
  assert.equal(viewer.scene.preUpdate.numberOfListeners, 0);
  world.seek(past);
  assert.equal(renders, 2, 'detached clock no longer requests frames');
});

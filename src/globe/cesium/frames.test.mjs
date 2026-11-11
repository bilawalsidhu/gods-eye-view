import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { isEngineEvent } from '../contract.js';
import { createCesiumFrames } from './frames.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

test('frame events bridge the scene events and pass a millisecond timestamp', () => {
  const viewer = createFakeViewer();
  const { frames, destroy } = createCesiumFrames(viewer);
  const { scene } = viewer;
  const order = [];
  for (const name of ['preUpdate', 'preRender', 'postRender']) {
    assert.ok(isEngineEvent(frames[name]), name);
    assert.equal(scene[name].numberOfListeners, 0, `${name} subscribed early`);
    frames[name].addEventListener((time) => order.push([name, time]));
  }
  const date = new Date(Date.UTC(2026, 9, 15, 12, 0, 0, 250));
  const time = Cesium.JulianDate.fromDate(date);
  scene.preUpdate.raiseEvent(scene, time);
  scene.preRender.raiseEvent(scene, time);
  scene.postRender.raiseEvent(scene, time);
  assert.deepEqual(order, [
    ['preUpdate', date.getTime()],
    ['preRender', date.getTime()],
    ['postRender', date.getTime()],
  ]);
  destroy();
  for (const name of ['preUpdate', 'preRender', 'postRender'])
    assert.equal(scene[name].numberOfListeners, 0);
});

test('timestamps match JulianDate.toDate, and a raise without a time reads the clock', () => {
  const viewer = createFakeViewer();
  const { frames, destroy } = createCesiumFrames(viewer);
  const seen = [];
  frames.postRender.addEventListener((time) => seen.push(time));
  const times = [
    Cesium.JulianDate.fromDate(new Date(Date.UTC(1999, 0, 1, 0, 0, 0, 1))),
    Cesium.JulianDate.fromIso8601('2016-12-31T23:59:60.5Z'),
    Cesium.JulianDate.addSeconds(
      Cesium.JulianDate.fromDate(new Date(Date.UTC(2026, 9, 15))),
      0.1234,
      new Cesium.JulianDate(),
    ),
  ];
  for (const time of times)
    viewer.scene.postRender.raiseEvent(viewer.scene, time);
  assert.deepEqual(
    seen,
    times.map((time) => Cesium.JulianDate.toDate(time).getTime()),
  );
  const before = Date.now();
  viewer.scene.postRender.raiseEvent();
  assert.ok(seen.at(-1) >= before && seen.at(-1) <= Date.now());
  destroy();
});

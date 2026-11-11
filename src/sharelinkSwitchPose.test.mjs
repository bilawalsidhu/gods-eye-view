// An engine switch reopens the address the outgoing camera wrote; the
// incoming camera takes that camera's exact pose, as the address rounds it.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from './geo/index.js';
import { createFakeEngine } from './globe/testing/fakeEngine.js';
import { ShareLinkManager } from './sharelink.js';

function installTab(t) {
  const prior = { window: globalThis.window, history: globalThis.history };
  const location = new URL('http://localhost/?engine=cesium');
  globalThis.window = Object.assign(new EventTarget(), { location });
  globalThis.history = {
    replaceState(_state, _title, next) {
      location.href = new URL(next, location.href).href;
    },
  };
  t.after(() => Object.assign(globalThis, prior));
  return location;
}

const live = {
  position: geo.cartesian3.fromDegrees(-123.1, 48.38298, 1587.2),
  heading: 0.3,
  pitch: geo.math.toRadians(-40.017),
  roll: 0,
};

function poseError(engine) {
  const pose = engine.camera.pose();
  const angle = (key) =>
    Math.abs(
      Math.atan2(
        Math.sin(pose[key] - live[key]),
        Math.cos(pose[key] - live[key]),
      ),
    );
  return {
    metres: geo.cartesian3.distance(pose.position, live.position),
    radians: Math.max(angle('heading'), angle('pitch'), angle('roll')),
  };
}

test('an engine switch hands the live pose over, not the rounded address', async (t) => {
  installTab(t);
  const outgoing = createFakeEngine();
  outgoing.fake.setPose(live);
  const manager = new ShareLinkManager(outgoing);
  t.after(() => manager.destroy());
  manager.flush();
  manager.attachEngine(null);
  const incoming = createFakeEngine();
  manager.attachEngine(incoming);
  const state = manager.parseInitialHash();
  assert.equal(state.alt, 1587, 'the address rounds the view');
  await manager.applyState(state, { instant: true });
  const { metres, radians } = poseError(incoming);
  assert.ok(metres < 1e-6, `${metres} m`);
  assert.ok(radians < 1e-9, `${radians} rad`);
});

test('a visited entry restores its own address, not the live pose', async (t) => {
  const location = installTab(t);
  const outgoing = createFakeEngine();
  outgoing.fake.setPose(live);
  const manager = new ShareLinkManager(outgoing);
  t.after(() => manager.destroy());
  manager.flush();
  manager.attachEngine(null);
  location.hash = 'v=2&lat=10.0000&lon=20.0000&alt=800&heading=0&pitch=-90';
  const incoming = createFakeEngine();
  manager.attachEngine(incoming);
  await manager.applyState(manager.parseInitialHash(), { instant: true });
  const place = incoming.camera.pose().cartographic;
  assert.ok(Math.abs(geo.math.toDegrees(place.latitude) - 10) < 1e-9);
  assert.ok(Math.abs(place.height - 800) < 1e-6);
});

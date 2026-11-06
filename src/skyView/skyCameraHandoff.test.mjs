/**
 * Camera handoff while Sky view is up.
 *
 * Voice tilt turns the camera in place (zero displacement). The old handoff
 * only noticed a move of more than 100 m, so the overlay kept the entry az/el.
 * These tests drive Cesium's real camera signals, not a stand-in:
 *
 *  - `changed` is raised only from `Camera#_updateCameraChanged`, only past
 *    `percentageChanged` (default 0.5), and the first call after a listener
 *    appears stores a baseline and does not fire. One update can raise it
 *    twice (heading/roll, then direction).
 *  - `moveStart` fires once per gesture from the render loop. `moveEnd` waits
 *    `cameraEventWaitTime` (500 ms) of stillness, so a rapid tilt never ends
 *    the gesture while steps are still arriving.
 *  - Sky's own `setView` moves the same camera and will raise those signals
 *    on the next frame. That must not leave the sky.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { mountSkyView } from './skyView.js';
import { worldDirectionToAzEl } from './skyCamera.js';

const radians = Cesium.Math.toRadians;
const degrees = Cesium.Math.toDegrees;

class FakeElement extends EventTarget {
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    this.className = '';
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.width = 0;
    this.height = 0;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'value') this.value = String(value);
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }
  remove() {
    const siblings = this.parentNode?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  focus() {}
  setPointerCapture() {}
  getContext() {
    const noop = () => {};
    return new Proxy(
      {},
      {
        get(_target, key) {
          if (key === 'createLinearGradient')
            return () => ({ addColorStop: noop });
          return noop;
        },
        set(target, key, value) {
          target[key] = value;
          return true;
        },
      },
    );
  }
  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }
  find(name) {
    for (const node of this.descendants())
      if (node.getAttribute('data-sky') === name) return node;
    return null;
  }
}

function fakeDocument() {
  const doc = new EventTarget();
  doc.createElement = (tag) => new FakeElement(tag);
  doc.body = new FakeElement('body');
  const classes = new Set();
  doc.body.classList = {
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    contains: (c) => classes.has(c),
  };
  return doc;
}

function fakeTimers() {
  let id = 1;
  const pending = new Map();
  return {
    pending,
    setTimeout: (fn, ms) => {
      pending.set(id, { fn, ms, every: false });
      return id++;
    },
    clearTimeout: (handle) => pending.delete(handle),
    setInterval: (fn, ms) => {
      pending.set(id, { fn, ms, every: true });
      return id++;
    },
    clearInterval: (handle) => pending.delete(handle),
  };
}

function skyScene({ width = 1200, height = 800 } = {}) {
  const canvas = new FakeElement('canvas');
  canvas.clientWidth = width;
  canvas.clientHeight = height;
  const ellipsoid = Cesium.Ellipsoid.WGS84;
  const scene = {
    canvas,
    drawingBufferWidth: width,
    drawingBufferHeight: height,
    mapProjection: new Cesium.GeographicProjection(ellipsoid),
    globe: {
      ellipsoid,
      show: true,
      enableLighting: false,
      dynamicAtmosphereLighting: true,
      dynamicAtmosphereLightingFromSun: false,
    },
    ellipsoid,
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    pixelRatio: 1,
    requestRender() {},
    preRender: new Cesium.Event(),
    skyBox: { show: true },
    skyAtmosphere: { show: true },
    screenSpaceCameraController: {
      enableInputs: true,
      enableCollisionDetection: true,
    },
    primitives: { length: 0, get: () => undefined },
    pickPositionSupported: false,
    pickPosition: () => undefined,
  };
  const camera = new Cesium.Camera(scene);
  camera.frustum.aspectRatio = width / height;
  camera.frustum.fov = 1;
  scene.camera = camera;
  camera.pickEllipsoid = () => undefined;
  return {
    scene,
    camera,
    container: new FakeElement('div'),
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    clock: new Cesium.Clock({
      currentTime: Cesium.JulianDate.fromIso8601('2026-10-11T12:00:00Z'),
      shouldAnimate: false,
    }),
    trackedEntity: undefined,
    trackedEntityChanged: new Cesium.Event(),
  };
}

function mount() {
  const doc = fakeDocument();
  const viewer = skyScene();
  const timers = fakeTimers();
  const handle = mountSkyView({
    viewer,
    document: doc,
    timers,
    location: { href: 'https://gev.test/' },
    history: { state: null, replaceState() {} },
    now: () => Date.parse('2026-10-12T03:30:00Z'),
    showToast: () => {},
    runNavigation: (_noun, navigate) => navigate(),
    createSatWorker: () => null,
    fetchCelestrak: async () => {
      throw new Error('offline');
    },
    fetchRcs: async () => ({ rcs: {} }),
    requestFrame: () => null,
  });
  return { doc, viewer, timers, handle };
}

async function enter(env) {
  assert.equal(
    await env.handle.enterAt({
      latDeg: 29.7604,
      lonDeg: -95.3698,
      source: 'map',
      heightM: 20,
      heightKnown: true,
    }),
    true,
  );
  assert.equal(env.handle.active, true);
  return env;
}

function interval(timers) {
  return [...timers.pending.values()].find((timer) => timer.every);
}

function look(camera) {
  return worldDirectionToAzEl(Cesium, camera.positionWC, camera.directionWC);
}

function turn(camera, before) {
  return degrees(
    Cesium.Math.acosClamped(Cesium.Cartesian3.dot(camera.directionWC, before)),
  );
}

/** How many times Cesium's own `changed` event actually raises. */
function countChanged(camera) {
  let fires = 0;
  const remove = camera.changed.addEventListener(() => {
    fires += 1;
  });
  return {
    get fires() {
      return fires;
    },
    remove,
  };
}

test('in-place external rotation hands Sky back on the 1 Hz tick', async () => {
  const env = await enter(mount());
  const { viewer, timers, handle } = env;
  const before = Cesium.Cartesian3.clone(viewer.camera.directionWC);
  const position = Cesium.Cartesian3.clone(viewer.camera.positionWC);
  const overlayEl = handle.view.elDeg;
  viewer.camera.lookDown(radians(8));
  assert.ok(turn(viewer.camera, before) > 5, 'camera turned in place');
  assert.ok(
    Cesium.Cartesian3.distance(position, viewer.camera.positionWC) < 1,
    'voice-style tilt does not move the eye',
  );
  assert.ok(Math.abs(handle.view.elDeg - overlayEl) < 1e-6);
  interval(timers).fn();
  assert.equal(handle.active, false, 'Sky yielded the in-place turn');
  assert.equal(viewer.container.find('canvas').hidden, true);
  assert.equal(
    viewer.scene.screenSpaceCameraController.enableInputs,
    true,
    'map controls come back',
  );
  assert.ok(
    Cesium.Cartesian3.distance(position, viewer.camera.positionWC) < 1,
    'handoff must not fight the camera back to the eye pose',
  );
  assert.ok(
    Math.abs(look(viewer.camera).elDeg - overlayEl) > 5,
    'camera kept the external turn',
  );
  handle.destroy();
});

test('a turn below percentageChanged still hands Sky back on the next frame', async () => {
  const { viewer, handle } = await enter(mount());
  const camera = viewer.camera;
  assert.equal(camera.percentageChanged, 0.5);
  const probe = countChanged(camera);
  // Establish Cesium's baseline while the pose is still Sky's.
  camera._updateCameraChanged();
  const before = Cesium.Cartesian3.clone(camera.directionWC);
  camera.lookDown(radians(2));
  const turned = turn(camera, before);
  assert.ok(turned > 1 && turned < 3, turned);
  camera._updateCameraChanged();
  assert.equal(
    probe.fires,
    0,
    '2° is under percentageChanged, so changed must not fire',
  );
  // preRender is the per-frame signal. moveEnd would still be 500 ms away.
  viewer.scene.preRender.raiseEvent(viewer.scene);
  assert.equal(handle.active, false, 'sub-threshold turn still yields');
  assert.equal(camera.percentageChanged, 0.5, 'sensitivity was not rewritten');
  probe.remove();
  handle.destroy();
});

test('the first changed update after subscribe is a baseline and does not fire', async () => {
  const { viewer, timers, handle } = await enter(mount());
  const camera = viewer.camera;
  const probe = countChanged(camera);
  camera.lookDown(radians(25));
  camera._updateCameraChanged();
  assert.equal(
    probe.fires,
    0,
    'first _updateCameraChanged only stores the baseline',
  );
  assert.equal(handle.active, true, 'baseline swallow is not itself a handoff');
  interval(timers).fn();
  assert.equal(
    handle.active,
    false,
    'the no-render tick still notices the turn changed swallowed',
  );
  probe.remove();
  handle.destroy();
});

test('changed hands Sky back once, including a heading-and-direction double raise', async () => {
  const { viewer, handle } = await enter(mount());
  const camera = viewer.camera;
  const position = Cesium.Cartesian3.clone(camera.positionWC);
  // A listener has to be present for the baseline call to record anything.
  // With none, _updateCameraChanged returns before storing a pose.
  const probe = countChanged(camera);
  camera._updateCameraChanged();
  assert.equal(probe.fires, 0, 'baseline call does not fire');
  camera.lookRight(radians(120));
  camera._updateCameraChanged();
  assert.ok(
    probe.fires >= 2,
    `expected heading plus direction raises, got ${probe.fires}`,
  );
  assert.equal(handle.active, false);
  assert.equal(viewer.container.find('canvas').hidden, true);
  assert.ok(Cesium.Cartesian3.distance(position, camera.positionWC) < 1);
  camera.changed.raiseEvent(1);
  camera.moveStart.raiseEvent();
  viewer.scene.preRender.raiseEvent(viewer.scene);
  viewer.clock.onTick.raiseEvent(viewer.clock);
  assert.equal(
    handle.active,
    false,
    'a second raise must not throw or re-enter',
  );
  probe.remove();
  handle.destroy();
});

test('rapid sub-threshold steps hand Sky back before the gesture ends', async () => {
  const { viewer, timers, handle } = await enter(mount());
  const camera = viewer.camera;
  const position = Cesium.Cartesian3.clone(camera.positionWC);
  const waits = [...timers.pending.values()].map((timer) => timer.ms);
  let handedAt = null;
  for (let step = 1; step <= 20 && handle.active; step += 1) {
    camera.lookDown(radians(0.2));
    viewer.clock.onTick.raiseEvent(viewer.clock);
    if (!handle.active) handedAt = step;
  }
  assert.ok(
    handedAt != null && handedAt <= 3,
    `rapid tilt still active after ${handedAt ?? '20'} steps`,
  );
  assert.ok(Cesium.Cartesian3.distance(position, camera.positionWC) < 1);
  assert.ok(
    !waits.includes(500),
    'handoff must not wait out cameraEventWaitTime',
  );
  const changedAfter = camera.changed.numberOfListeners;
  const preAfter = viewer.scene.preRender.numberOfListeners;
  const tickAfter = viewer.clock.onTick.numberOfListeners;
  viewer.clock.onTick.raiseEvent(viewer.clock);
  assert.equal(camera.changed.numberOfListeners, changedAfter);
  assert.equal(viewer.scene.preRender.numberOfListeners, preAfter);
  assert.equal(viewer.clock.onTick.numberOfListeners, tickAfter);
  handle.destroy();
});

test("Sky's own camera updates do not hand the view back", async () => {
  const { viewer, handle } = await enter(mount());
  const camera = viewer.camera;
  const probe = countChanged(camera);
  camera._updateCameraChanged();
  for (let i = 0; i < 12; i += 1) {
    handle.setView({ azDeg: 15 * i, elDeg: 20 + (i % 4), rollDeg: i - 6 });
    viewer.clock.onTick.raiseEvent(viewer.clock);
    viewer.scene.preRender.raiseEvent(viewer.scene);
    viewer.camera.moveStart.raiseEvent();
    camera._updateCameraChanged();
    assert.equal(handle.active, true, `own update ${i} exited`);
  }
  handle.setView({ azDeg: 200, elDeg: 35, rollDeg: 12 });
  camera._updateCameraChanged();
  assert.ok(probe.fires >= 1, 'own turn was large enough for changed to fire');
  assert.equal(handle.active, true, 'own changed raise must not exit');
  viewer.scene.preRender.raiseEvent(viewer.scene);
  viewer.clock.onTick.raiseEvent(viewer.clock);
  assert.equal(handle.active, true);
  const seen = look(camera);
  assert.ok(Math.abs(seen.elDeg - handle.view.elDeg) < 0.05, seen.elDeg);
  assert.ok(
    Math.abs(((seen.azDeg - handle.view.azDeg + 540) % 360) - 180) < 0.05,
  );
  assert.equal(camera.percentageChanged, 0.5);
  probe.remove();
  handle.destroy();
});

test('exit and destroy drop the camera watch and leave percentageChanged', async () => {
  const env = await enter(mount());
  const { viewer, handle } = env;
  const camera = viewer.camera;
  assert.ok(camera.changed.numberOfListeners >= 1);
  assert.ok(viewer.scene.preRender.numberOfListeners >= 1);
  assert.ok(camera.moveStart.numberOfListeners >= 1);
  assert.ok(viewer.clock.onTick.numberOfListeners >= 1);
  assert.equal(camera.percentageChanged, 0.5);
  handle.exit();
  assert.equal(camera.changed.numberOfListeners, 0);
  assert.equal(viewer.scene.preRender.numberOfListeners, 0);
  assert.equal(camera.moveStart.numberOfListeners, 0);
  assert.equal(viewer.clock.onTick.numberOfListeners, 0);
  assert.equal(camera.percentageChanged, 0.5);
  camera.changed.raiseEvent(1);
  viewer.scene.preRender.raiseEvent(viewer.scene);
  viewer.clock.onTick.raiseEvent(viewer.clock);

  await enter(env);
  assert.ok(camera.changed.numberOfListeners >= 1);
  handle.destroy();
  assert.equal(handle.destroyed, true);
  assert.equal(camera.changed.numberOfListeners, 0);
  assert.equal(viewer.scene.preRender.numberOfListeners, 0);
  assert.equal(camera.moveStart.numberOfListeners, 0);
  assert.equal(viewer.clock.onTick.numberOfListeners, 0);
  assert.equal(camera.percentageChanged, 0.5);
});

test('a pure roll and a position move still hand Sky back without fighting the camera', async () => {
  const rolled = await enter(mount());
  const camera = rolled.viewer.camera;
  const position = Cesium.Cartesian3.clone(camera.positionWC);
  const direction = Cesium.Cartesian3.clone(camera.directionWC);
  const up = Cesium.Cartesian3.clone(camera.upWC);
  camera.twistRight(radians(5));
  const rolledUp = degrees(
    Cesium.Math.acosClamped(Cesium.Cartesian3.dot(camera.upWC, up)),
  );
  assert.ok(rolledUp > 4, `twist only moved up by ${rolledUp}°`);
  assert.ok(Cesium.Cartesian3.dot(camera.directionWC, direction) > 0.999);
  rolled.viewer.scene.preRender.raiseEvent(rolled.viewer.scene);
  assert.equal(rolled.handle.active, false, 'roll handed Sky back');
  assert.ok(Cesium.Cartesian3.distance(position, camera.positionWC) < 1);
  assert.ok(
    Cesium.Cartesian3.dot(camera.directionWC, direction) > 0.999,
    'handoff left the twisted look direction alone',
  );
  rolled.handle.destroy();

  const moved = await enter(mount());
  const away = Cesium.Cartesian3.fromDegrees(-74, 40.7, 5000);
  moved.viewer.camera.setView({ destination: away });
  interval(moved.timers).fn();
  assert.equal(moved.handle.active, false);
  assert.ok(
    Cesium.Cartesian3.distance(moved.viewer.camera.positionWC, away) < 1,
  );
  moved.handle.destroy();
});

test('applyView does not overwrite an in-place external tilt before the tick', async () => {
  const { viewer, handle } = await enter(mount());
  const camera = viewer.camera;
  handle.setView(handle.view);
  viewer.clock.onTick.raiseEvent(viewer.clock);
  assert.equal(
    handle.active,
    true,
    "reapplying Sky's own pose is not a handoff",
  );

  const position = Cesium.Cartesian3.clone(camera.positionWC);
  const overlayEl = handle.view.elDeg;
  camera.lookDown(radians(8));
  const tiltedEl = look(camera).elDeg;
  assert.ok(Math.abs(tiltedEl - overlayEl) > 5, tiltedEl);
  assert.ok(Cesium.Cartesian3.distance(position, camera.positionWC) < 1);

  // Identity setView is the race: Sky reapplies its stored view before
  // changed, preRender, onTick, or the 1 Hz interval can see the tilt.
  handle.setView(handle.view);
  viewer.clock.onTick.raiseEvent(viewer.clock);

  assert.equal(
    handle.active,
    false,
    'Sky must yield instead of staying up on the old orientation',
  );
  assert.ok(
    Cesium.Cartesian3.distance(position, camera.positionWC) < 1,
    'handoff must not move the eye',
  );
  assert.ok(
    Math.abs(look(camera).elDeg - tiltedEl) < 0.05,
    `camera returned to ${look(camera).elDeg}, tilt was ${tiltedEl}`,
  );
  handle.destroy();
});

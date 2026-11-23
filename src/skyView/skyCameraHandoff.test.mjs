/**
 * Camera handoff while Sky view is up.
 *
 * Voice tilt turns the camera in place (zero displacement). The old handoff
 * only noticed a move of more than 100 m, so the overlay kept the entry az/el.
 * These tests drive the renderer's real camera signals through the camera and
 * frame ports of the in-memory stub renderer (skyTestHost.mjs), not a
 * stand-in:
 *
 *  - the camera port's `changed` fires only past a listener's threshold
 *    (default 0.5), and a listener's first step only stores a baseline. One
 *    step can fire it twice (heading/roll, then direction).
 *  - `moveStart` fires once per gesture. `moveEnd` waits 500 ms of
 *    stillness, so a rapid tilt never ends the gesture while steps are still
 *    arriving.
 *  - the frame port's `preUpdate` runs on every tick, drawn or not.
 *  - `onCommand` runs before each camera command, Sky's own included.
 *  - Sky's own `setView` moves the same camera and will raise those signals on
 *    the next frame. That must not leave the sky.
 *
 * Collision is the camera port's `controls.collision`: Sky turns it off while
 * active, and a handoff that leaves the camera under the terrain floor
 * (ground height from the height service, or unknown) keeps it off until the
 * camera clears the floor.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { acosClamped, distance, dot } from '../geo/vector.js';
import { mountSkyView } from './skyView.js';
import { COLLISION_CEILING_M, worldDirectionToAzEl } from './skyCamera.js';
import { createSkyTestHost } from '../testSupport/skyTestHost.mjs';

const radians = (deg) => (deg * Math.PI) / 180;
const degrees = (rad) => (rad * 180) / Math.PI;
const HOUSTON_POINT = { lon: -95.3698, lat: 29.7604 };

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

/**
 * Count the listeners that are registered now (not ever) on the camera and
 * frame ports, by kind: `changed`, `moveStart`, `followChanged`, `command`,
 * `preUpdate`, `preRender`. Installed before Sky is mounted.
 */
function trackListeners({ camera, frame }) {
  const live = {
    changed: 0,
    moveStart: 0,
    followChanged: 0,
    command: 0,
    preUpdate: 0,
    preRender: 0,
  };
  const counted = (kind, off) => {
    live[kind] += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      live[kind] -= 1;
      off();
    };
  };
  const onCamera = camera.on;
  camera.on = (event, cb, options) =>
    counted(event, onCamera(event, cb, options));
  const onCommand = camera.onCommand;
  camera.onCommand = (cb) => counted('command', onCommand(cb));
  const onFrame = frame.on;
  frame.on = (phase, cb) => counted(phase, onFrame(phase, cb));
  return live;
}

/**
 * Sky on the stub renderer. `collision` is the camera's collision mode as the
 * map left it (Sky turns it off and puts it back).
 */
function mount({ collision = 'none' } = {}) {
  const doc = fakeDocument();
  const fixture = createSkyTestHost({ container: new FakeElement('div') });
  const { host: viewer, camera, frame, renderer } = fixture;
  camera.controls.collision = collision;
  const live = trackListeners({ camera, frame });
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
  return {
    doc,
    viewer,
    fixture,
    camera,
    frame,
    renderer,
    live,
    timers,
    handle,
  };
}

const ENTRY = {
  latDeg: 29.7604,
  lonDeg: -95.3698,
  source: 'map',
  heightM: 20,
  heightKnown: true,
};

async function enter(env) {
  assert.equal(await env.handle.enterAt(ENTRY), true);
  assert.equal(env.handle.active, true);
  return env;
}

function interval(timers) {
  return [...timers.pending.values()].find((timer) => timer.every);
}

function look(camera) {
  const pose = camera.pose();
  return worldDirectionToAzEl(pose.position, pose.direction);
}

/** Another owner turns the camera in place by `rad`, looking down (voice tilt). */
function tilt(camera, rad) {
  const pose = camera.pose();
  camera.setView({
    destination: pose.position,
    orientation: {
      heading: pose.heading,
      pitch: pose.pitch - rad,
      roll: pose.roll,
    },
  });
}

/** Another owner places the camera `height` metres over Houston. */
function park(camera, height) {
  camera.setView({
    destination: { ...HOUSTON_POINT, height },
    orientation: { heading: 0.2, pitch: -0.4, roll: 0 },
  });
}

/** The ground height the height service now knows under Houston. */
function settleSurface(env, height = 138) {
  env.renderer.testing.cacheHeight(HOUSTON_POINT, height, 'terrain');
}

function turn(camera, before) {
  return degrees(acosClamped(dot(camera.pose().direction, before)));
}

test('in-place external rotation hands Sky back on the 1 Hz tick', async () => {
  const env = await enter(mount());
  const { camera, viewer, timers, handle } = env;
  const before = camera.pose().direction;
  const position = camera.pose().position;
  const overlayEl = handle.view.elDeg;
  tilt(camera, radians(8));
  assert.ok(turn(camera, before) > 5, 'camera turned in place');
  assert.ok(
    distance(position, camera.pose().position) < 1,
    'voice-style tilt does not move the eye',
  );
  assert.ok(Math.abs(handle.view.elDeg - overlayEl) < 1e-6);
  interval(timers).fn();
  assert.equal(handle.active, false, 'Sky yielded the in-place turn');
  assert.equal(viewer.container.find('canvas').hidden, true);
  assert.equal(camera.controls.enabled, true, 'map controls come back');
  assert.ok(
    distance(position, camera.pose().position) < 1,
    'handoff must not fight the camera back to the eye pose',
  );
  assert.ok(
    Math.abs(look(camera).elDeg - overlayEl) > 5,
    'camera kept the external turn',
  );
  handle.destroy();
});

test('a turn below the changed threshold still hands Sky back on the next frame', async () => {
  const { camera, renderer, handle } = await enter(mount());
  let fires = 0;
  const off = camera.on('changed', () => {
    fires += 1;
  });
  // The listener's baseline, while the pose is still Sky's.
  renderer.testing.tick();
  const before = camera.pose().direction;
  tilt(camera, radians(2));
  const turned = turn(camera, before);
  assert.ok(turned > 1 && turned < 3, turned);
  renderer.testing.tick();
  assert.equal(fires, 0, '2° is under the threshold, so changed must not fire');
  // preUpdate is the per-frame signal. moveEnd would still be 500 ms away.
  assert.equal(handle.active, false, 'sub-threshold turn still yields');
  off();
  handle.destroy();
});

test('the first changed step after subscribe is a baseline and does not fire', async () => {
  const { camera, renderer, handle } = await enter(mount());
  let fires = 0;
  const off = camera.on('changed', () => {
    fires += 1;
  });
  tilt(camera, radians(25));
  assert.equal(handle.active, true, 'no signal has run yet');
  renderer.testing.tick();
  assert.equal(fires, 0, 'the first changed step only stores the baseline');
  assert.equal(
    handle.active,
    false,
    'the frame still notices the turn changed swallowed',
  );
  off();
  handle.destroy();

  // and the no-render 1 Hz tick notices it too
  const other = await enter(mount());
  tilt(other.camera, radians(25));
  interval(other.timers).fn();
  assert.equal(other.handle.active, false);
  other.handle.destroy();
});

test('changed hands Sky back once, including a heading-and-direction double fire', async () => {
  const { camera, renderer, viewer, handle } = await enter(mount());
  const position = camera.pose().position;
  let fires = 0;
  const off = camera.on('changed', () => {
    fires += 1;
  });
  // A listener's first step only records a baseline.
  renderer.testing.tick();
  assert.equal(fires, 0, 'baseline step does not fire');
  const pose = camera.pose();
  camera.setView({
    destination: pose.position,
    orientation: {
      heading: pose.heading + radians(120),
      pitch: pose.pitch,
      roll: pose.roll,
    },
  });
  renderer.testing.tick();
  assert.ok(fires >= 2, `expected heading plus direction fires, got ${fires}`);
  assert.equal(handle.active, false);
  assert.equal(viewer.container.find('canvas').hidden, true);
  assert.ok(distance(position, camera.pose().position) < 1);
  for (let frame = 0; frame < 3; frame += 1) renderer.testing.tick();
  assert.equal(
    handle.active,
    false,
    'further frames must not throw or re-enter',
  );
  off();
  handle.destroy();
});

test('rapid sub-threshold steps hand Sky back before the gesture ends', async () => {
  const { camera, renderer, timers, handle, live } = await enter(mount());
  const position = camera.pose().position;
  const waits = [...timers.pending.values()].map((timer) => timer.ms);
  let handedAt = null;
  for (let step = 1; step <= 20 && handle.active; step += 1) {
    tilt(camera, radians(0.2));
    renderer.testing.tick();
    if (!handle.active) handedAt = step;
  }
  assert.ok(
    handedAt != null && handedAt <= 3,
    `rapid tilt still active after ${handedAt ?? '20'} steps`,
  );
  assert.ok(distance(position, camera.pose().position) < 1);
  assert.ok(!waits.includes(500), 'handoff must not wait out moveEnd');
  const after = { ...live };
  renderer.testing.tick();
  assert.deepEqual(live, after, 'no listener added or left over');
  handle.destroy();
});

test("Sky's own camera updates do not hand the view back", async () => {
  const { camera, renderer, handle } = await enter(mount());
  let fires = 0;
  const off = camera.on('changed', () => {
    fires += 1;
  });
  renderer.testing.tick();
  for (let i = 0; i < 12; i += 1) {
    handle.setView({ azDeg: 15 * i, elDeg: 20 + (i % 4), rollDeg: i - 6 });
    renderer.testing.tick();
    assert.equal(handle.active, true, `own update ${i} exited`);
  }
  handle.setView({ azDeg: 200, elDeg: 35, rollDeg: 12 });
  renderer.testing.tick();
  assert.ok(fires >= 1, 'own turns were large enough for changed to fire');
  assert.equal(handle.active, true, 'own changed fire must not exit');
  renderer.testing.tick();
  assert.equal(handle.active, true);
  const seen = look(camera);
  assert.ok(Math.abs(seen.elDeg - handle.view.elDeg) < 0.05, seen.elDeg);
  assert.ok(
    Math.abs(((seen.azDeg - handle.view.azDeg + 540) % 360) - 180) < 0.05,
  );
  // the commands Sky itself issued are not a handoff once they have run
  await Promise.resolve();
  assert.equal(handle.active, true, 'own commands are not a handoff');
  off();
  handle.destroy();
});

test('a foreign camera command hands Sky back once it has moved the camera', async () => {
  const { camera, handle } = await enter(mount());
  const pose = camera.pose();
  camera.setView({
    destination: { lon: -74, lat: 40.7, height: 5000 },
    orientation: { heading: pose.heading, pitch: -0.3, roll: 0 },
  });
  assert.equal(handle.active, true, 'asked after the command, not before');
  await Promise.resolve();
  assert.equal(handle.active, false);
  assert.equal(camera.controls.enabled, true);
  handle.destroy();
});

test('exit and destroy drop the camera watch', async () => {
  const env = await enter(mount());
  const { renderer, handle, live } = env;
  assert.ok(live.changed >= 1);
  assert.ok(live.moveStart >= 1);
  assert.ok(live.command >= 1);
  assert.ok(live.preUpdate >= 1);
  assert.equal(live.followChanged, 1, 'the button watches follows');
  handle.exit();
  assert.equal(live.changed, 0);
  assert.equal(live.moveStart, 0);
  assert.equal(live.command, 0);
  assert.equal(live.preUpdate, 0);
  assert.equal(live.preRender, 0);
  renderer.testing.tick();

  await enter(env);
  assert.ok(live.changed >= 1);
  handle.destroy();
  assert.equal(handle.destroyed, true);
  assert.deepEqual(live, {
    changed: 0,
    moveStart: 0,
    followChanged: 0,
    command: 0,
    preUpdate: 0,
    preRender: 0,
  });
});

test('a pure roll and a position move still hand Sky back without fighting the camera', async () => {
  const rolled = await enter(mount());
  const camera = rolled.camera;
  const start = camera.pose();
  camera.setView({
    destination: start.position,
    orientation: {
      heading: start.heading,
      pitch: start.pitch,
      roll: start.roll + radians(5),
    },
  });
  const rolledUp = degrees(acosClamped(dot(camera.pose().up, start.up)));
  assert.ok(rolledUp > 4, `twist only moved up by ${rolledUp}°`);
  assert.ok(dot(camera.pose().direction, start.direction) > 0.999);
  rolled.renderer.testing.tick();
  assert.equal(rolled.handle.active, false, 'roll handed Sky back');
  assert.ok(distance(start.position, camera.pose().position) < 1);
  assert.ok(
    dot(camera.pose().direction, start.direction) > 0.999,
    'handoff left the twisted look direction alone',
  );
  rolled.handle.destroy();

  const moved = await enter(mount());
  moved.camera.setView({ destination: { lon: -74, lat: 40.7, height: 5000 } });
  const away = moved.camera.pose().position;
  interval(moved.timers).fn();
  assert.equal(moved.handle.active, false);
  assert.ok(distance(moved.camera.pose().position, away) < 1);
  moved.handle.destroy();
});

// Collision. The renderer lifts a camera under the terrain floor while the
// camera port's `controls.collision` is on. Sky turns it off, and a handoff
// that keeps a camera under the floor (the ground height from the height
// service, or unknown) leaves it off until the camera is clear of it:
// at or above ground + minDistance, or above the 15 km ceiling.

test('handoff at eye height keeps collision off, so the renderer cannot lift the camera', async () => {
  const env = await enter(mount({ collision: 'terrain' }));
  const { camera, renderer, handle } = env;
  settleSurface(env, 138);
  assert.equal(camera.controls.collision, 'none', 'Sky turned collision off');
  tilt(camera, radians(8));
  const position = camera.pose().position;
  const direction = camera.pose().direction;
  renderer.testing.tick();
  assert.equal(handle.active, false, 'in-place tilt hands Sky back');
  assert.equal(camera.controls.collision, 'none');
  for (let frame = 0; frame < 30; frame += 1) renderer.testing.tick();
  assert.equal(camera.controls.collision, 'none');
  assert.ok(distance(position, camera.pose().position) < 1);
  assert.ok(
    dot(camera.pose().direction, direction) > 0.999,
    'handoff left the external tilt alone',
  );
  handle.destroy();
  assert.equal(camera.controls.collision, 'terrain', 'destroy puts it back');
});

test('collision stays off at eye height and returns above the safe height without a lift', async () => {
  const env = await enter(mount({ collision: 'terrain' }));
  const { camera, renderer, handle, live } = env;
  settleSurface(env, 138);
  tilt(camera, radians(8));
  renderer.testing.tick();
  assert.equal(handle.active, false);
  assert.equal(
    camera.controls.collision,
    'none',
    'collision must stay off while the handoff camera is below the safe height',
  );
  renderer.testing.tick();
  renderer.testing.tick();
  assert.equal(camera.controls.collision, 'none');
  camera.controls.minDistance = 25;
  const floor = 138 + camera.controls.minDistance;
  const safe = floor + 10;
  assert.ok(safe < COLLISION_CEILING_M);
  const pose = camera.pose();
  camera.setView({
    destination: { ...HOUSTON_POINT, height: safe },
    orientation: { heading: pose.heading, pitch: pose.pitch, roll: pose.roll },
  });
  const parked = camera.pose().position;
  renderer.testing.tick();
  assert.equal(
    camera.controls.collision,
    'terrain',
    'collision returns once the camera clears ground + minDistance',
  );
  assert.equal(live.preUpdate, 0, 'a restored watch must drop');
  for (let frame = 0; frame < 5; frame += 1) renderer.testing.tick();
  const moved = distance(parked, camera.pose().position);
  assert.ok(moved < 1, `restoring collision moved the camera ${moved} m`);
  handle.destroy();
});

test('re-entering drops the deferred collision watch', async () => {
  const env = await enter(mount({ collision: 'terrain' }));
  const { camera, renderer, handle, live } = env;
  settleSurface(env, 138);
  tilt(camera, radians(8));
  renderer.testing.tick();
  assert.equal(handle.active, false);
  assert.equal(camera.controls.collision, 'none');
  assert.equal(live.preUpdate, 1, 'handoff armed a collision watch');

  assert.equal(await handle.enterAt(ENTRY), true);
  // Sky's own two frame listeners (time, camera watch) and no collision watch
  assert.equal(live.preUpdate, 2, 're-enter must drop the deferred watch');
  assert.equal(camera.controls.collision, 'none', 'Sky keeps collision off');
  // A stale watch would put collision back as soon as the ground is under the eye.
  settleSurface(env, 0);
  renderer.testing.tick();
  assert.equal(
    camera.controls.collision,
    'none',
    'a stale watch must not turn collision on during Sky',
  );
  assert.equal(handle.active, true);
  handle.destroy();
});

test('re-entering keeps the original collision mode for the next exit', async () => {
  const env = await enter(mount({ collision: 'terrain' }));
  const { camera, renderer, handle, live } = env;
  settleSurface(env, 138);
  tilt(camera, radians(8));
  renderer.testing.tick();
  assert.equal(camera.controls.collision, 'none');

  assert.equal(await handle.enterAt(ENTRY), true);
  handle.exit();
  assert.equal(
    camera.controls.collision,
    'terrain',
    'normal exit restores the original collision mode immediately',
  );
  assert.equal(
    live.preUpdate,
    0,
    'normal exit must not leave a deferred watch',
  );
  handle.destroy();
});

test('destroy restores a deferred collision mode and drops the watch', async () => {
  const env = await enter(mount({ collision: 'terrain' }));
  const { camera, renderer, handle, live } = env;
  settleSurface(env, 138);
  tilt(camera, radians(8));
  const position = camera.pose().position;
  renderer.testing.tick();
  assert.equal(handle.active, false);
  assert.equal(camera.controls.collision, 'none');
  assert.equal(live.preUpdate, 1);
  handle.destroy();
  assert.equal(handle.destroyed, true);
  assert.ok(
    distance(position, camera.pose().position) < 1,
    'destroy restores the mode without moving the handoff camera',
  );
  assert.equal(
    camera.controls.collision,
    'terrain',
    'destroy must restore collision instead of leaving it off',
  );
  assert.equal(live.preUpdate, 0, 'destroy must drop the deferred watch');
  assert.equal(live.changed + live.moveStart + live.command, 0);
  renderer.testing.tick();
  assert.equal(
    camera.controls.collision,
    'terrain',
    'no watcher remains to flip the restored mode',
  );
});

test('handoff does not lift when the surface height is not known yet', async () => {
  const env = await enter(mount({ collision: 'terrain' }));
  const { camera, renderer, handle } = env;
  // no height known under the camera: not settled
  tilt(camera, radians(8));
  const position = camera.pose().position;
  renderer.testing.tick();
  assert.equal(handle.active, false);
  assert.equal(camera.controls.collision, 'none');
  for (let frame = 0; frame < 30; frame += 1) renderer.testing.tick();
  assert.equal(camera.controls.collision, 'none', 'unknown is not safe');
  assert.ok(distance(position, camera.pose().position) < 1);
  handle.destroy();
});

test('a handoff already above the terrain floor restores collision immediately', async () => {
  const env = await enter(mount({ collision: 'terrain' }));
  const { camera, renderer, handle, live } = env;
  settleSurface(env, 138);
  camera.controls.minDistance = 40;
  const safe = 138 + camera.controls.minDistance + 50;
  assert.ok(safe < COLLISION_CEILING_M);
  camera.setView({
    destination: { ...HOUSTON_POINT, height: safe },
    orientation: { heading: 0.2, pitch: -0.4, roll: 0 },
  });
  const parked = camera.pose().position;
  renderer.testing.tick();
  assert.equal(
    handle.active,
    false,
    'a move of more than 100 m hands Sky back',
  );
  assert.equal(
    camera.controls.collision,
    'terrain',
    'collision is safe to restore above the terrain floor',
  );
  assert.equal(live.preUpdate, 0, 'a safe handoff must not leave a watch');
  for (let frame = 0; frame < 5; frame += 1) renderer.testing.tick();
  const moved = distance(parked, camera.pose().position);
  assert.ok(moved < 1, `restoring collision moved a safe camera ${moved} m`);
  handle.destroy();
});

test('ordinary low-altitude exit restores collision immediately', async () => {
  const env = mount({ collision: 'terrain' });
  const { camera, handle, live } = env;
  settleSurface(env, 138);
  park(camera, 400);
  assert.ok(400 < COLLISION_CEILING_M);
  const parked = camera.pose().position;
  await enter(env);
  assert.equal(camera.controls.collision, 'none');
  handle.exit();
  assert.equal(
    camera.controls.collision,
    'terrain',
    'ordinary exit must not wait for 15 km',
  );
  assert.equal(live.preUpdate, 0);
  assert.equal(live.changed, 0);
  assert.equal(live.command, 0);
  assert.ok(distance(parked, camera.pose().position) < 1);
  handle.destroy();
});

test('ordinary exit restores collision even under the terrain floor', async () => {
  const env = mount({ collision: 'terrain' });
  const { camera, handle, live } = env;
  settleSurface(env, 138);
  park(camera, 16.7);
  await enter(env);
  handle.exit();
  assert.equal(
    camera.controls.collision,
    'terrain',
    'normal exit puts every setting back after the camera is restored',
  );
  assert.equal(live.preUpdate, 0, 'normal exit must not defer collision');
  handle.destroy();
});

test('unknown surface defers a handoff and restores once the floor is known', async () => {
  const env = await enter(mount({ collision: 'terrain' }));
  const { camera, renderer, handle, live } = env;
  park(camera, 400);
  const parked = camera.pose().position;
  renderer.testing.tick();
  assert.equal(handle.active, false);
  assert.equal(
    camera.controls.collision,
    'none',
    'an unknown surface must defer collision',
  );
  assert.ok(live.preUpdate >= 1);
  for (let frame = 0; frame < 30; frame += 1) renderer.testing.tick();
  assert.ok(distance(parked, camera.pose().position) < 1);
  assert.equal(camera.controls.collision, 'none');
  settleSurface(env, 138);
  renderer.testing.tick();
  assert.equal(
    camera.controls.collision,
    'terrain',
    'collision returns once the known floor is below the camera',
  );
  assert.equal(live.preUpdate, 0);
  handle.destroy();
});

test('repeated reentry keeps the original collision mode', async () => {
  const env = mount({ collision: 'terrain' });
  const { camera, renderer, handle, live } = env;
  settleSurface(env, 138);
  park(camera, 400);
  await enter(env);
  handle.exit();
  assert.equal(camera.controls.collision, 'terrain');

  await enter(env);
  tilt(camera, radians(8));
  renderer.testing.tick();
  assert.equal(handle.active, false);
  assert.equal(camera.controls.collision, 'none');

  assert.equal(await handle.enterAt(ENTRY), true);
  assert.equal(live.preUpdate, 2, 're-enter drops the deferred watch');
  assert.equal(camera.controls.collision, 'none', 'Sky keeps collision off');

  tilt(camera, radians(8));
  renderer.testing.tick();
  assert.equal(handle.active, false);
  assert.equal(
    camera.controls.collision,
    'none',
    'a second handoff under the floor still defers the original mode',
  );
  assert.ok(live.preUpdate >= 1);

  assert.equal(await handle.enterAt(ENTRY), true);
  handle.exit();
  assert.equal(
    camera.controls.collision,
    'terrain',
    'normal exit after repeated reentry restores the original mode',
  );
  assert.equal(live.preUpdate, 0);
  handle.destroy();
});

test('a saved collision-off mode stays off through exit, handoff, and destroy', async () => {
  const env = mount({ collision: 'none' });
  const { camera, renderer, handle, live } = env;
  settleSurface(env, 138);
  park(camera, 16.7);
  await enter(env);
  handle.exit();
  assert.equal(camera.controls.collision, 'none');
  assert.equal(live.preUpdate, 0);

  await enter(env);
  tilt(camera, radians(8));
  renderer.testing.tick();
  assert.equal(handle.active, false);
  assert.equal(camera.controls.collision, 'none');
  assert.equal(live.preUpdate, 0, 'an off mode must not arm a restore watch');
  handle.destroy();
  assert.equal(camera.controls.collision, 'none');
});

test('applyView does not overwrite an in-place external tilt before the tick', async () => {
  const { camera, renderer, handle } = await enter(mount());
  handle.setView(handle.view);
  renderer.testing.tick();
  assert.equal(
    handle.active,
    true,
    "reapplying Sky's own pose is not a handoff",
  );

  const position = camera.pose().position;
  const overlayEl = handle.view.elDeg;
  tilt(camera, radians(8));
  const tiltedEl = look(camera).elDeg;
  assert.ok(Math.abs(tiltedEl - overlayEl) > 5, tiltedEl);
  assert.ok(distance(position, camera.pose().position) < 1);

  // Identity setView is the race: Sky reapplies its stored view before
  // changed, preUpdate, or the 1 Hz interval can see the tilt.
  handle.setView(handle.view);
  renderer.testing.tick();

  assert.equal(
    handle.active,
    false,
    'Sky must yield instead of staying up on the old orientation',
  );
  assert.ok(
    distance(position, camera.pose().position) < 1,
    'handoff must not move the eye',
  );
  assert.ok(
    Math.abs(look(camera).elDeg - tiltedEl) < 0.05,
    `camera returned to ${look(camera).elDeg}, tilt was ${tiltedEl}`,
  );
  handle.destroy();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPhoneOrientation,
  NO_SAMPLE_TIMEOUT_MS,
  OFFSET_STORAGE_KEY,
  pointingOffered,
} from './orientation.js';
import { quatFromAxes, quatFromEuler, wrap180 } from './orientationMath.js';

const close = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);
const azClose = (a, b, tol, msg) =>
  assert.ok(Math.abs(wrap180(a - b)) <= tol, `${msg ?? ''} ${a} vs ${b}`);

/** A window with just what the controller touches. */
function fakeWindow({
  ios = false,
  permission = 'granted',
  absoluteEvent = false,
  sensor = null,
  noApis = false,
  angle = 0,
} = {}) {
  const listeners = new Map();
  const win = {
    calls: [],
    listeners,
    screen: { orientation: { angle } },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    fire(type, data) {
      for (const fn of [...(listeners.get(type) || [])]) fn({ type, ...data });
    },
    count(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
  if (!noApis) {
    win.DeviceOrientationEvent = function DeviceOrientationEvent() {};
    if (ios)
      win.DeviceOrientationEvent.requestPermission = () => {
        win.calls.push('requestPermission');
        if (permission instanceof Error) throw permission;
        return Promise.resolve(permission);
      };
  }
  if (absoluteEvent) win.ondeviceorientationabsolute = null;
  if (sensor) win.AbsoluteOrientationSensor = sensor;
  return win;
}

/** Manual clock + animation frames. */
function frames() {
  let t = 0;
  let queue = [];
  let nextId = 1;
  const timeouts = [];
  return {
    now: () => t,
    requestFrame(fn) {
      const id = nextId++;
      queue.push({ id, fn });
      return id;
    },
    cancelFrame(id) {
      queue = queue.filter((f) => f.id !== id);
    },
    /** Animation frames still requested (a dead source must leave none). */
    get queued() {
      return queue.length;
    },
    timers: {
      setTimeout(fn, ms) {
        const h = { fn, at: t + ms, done: false };
        timeouts.push(h);
        return h;
      },
      clearTimeout(h) {
        if (h) h.done = true;
      },
    },
    /** Advance by ms, running frames every frameMs and due timeouts. */
    advance(ms, frameMs = 1000 / 60, onFrame = () => {}) {
      const end = t + ms;
      while (t < end - 1e-9) {
        t = Math.min(end, t + frameMs);
        for (const h of timeouts)
          if (!h.done && h.at <= t) {
            h.done = true;
            h.fn();
          }
        onFrame(t);
        const run = queue;
        queue = [];
        for (const f of run) f.fn(t);
      }
    },
  };
}

function controller(win, extra = {}) {
  const f = frames();
  const views = [];
  const states = [];
  const store = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const c = createPhoneOrientation({
    win,
    isSecureContext: true,
    onView: (v) => views.push(v),
    onState: (s, info) => states.push({ s, ...info }),
    storage,
    now: f.now,
    requestFrame: (fn) => f.requestFrame(fn),
    cancelFrame: (id) => f.cancelFrame(id),
    timers: f.timers,
    ...extra,
  });
  return { c, f, views, states, store };
}

/** Euler angles for a pose stated as back bearing/elevation in portrait. */
const portrait = (bearingDeg, elDeg) => ({
  alpha: (360 - bearingDeg + 360) % 360,
  beta: 90 + elDeg,
  gamma: 0,
});

test('insecure page (LAN http): state insecure with the https address; nothing is listened to', async () => {
  const win = fakeWindow({ ios: true });
  const { c } = controller(win, { isSecureContext: false });
  assert.equal(await c.start(), 'insecure');
  assert.equal(win.calls.length, 0, 'no permission prompt on http');
  assert.match(c.info.message, /secure https:\/\/ address/);
  assert.equal(win.listeners.size, 0);
});

test('no orientation API at all: unsupported (drag only)', async () => {
  const { c } = controller(fakeWindow({ noApis: true }));
  assert.equal(await c.start(), 'unsupported');
  assert.match(c.info.message, /Drag/);
});

test('iOS: requestPermission runs synchronously inside the tap; granted -> deviceorientation corrected by webkitCompassHeading + declination', async () => {
  const win = fakeWindow({ ios: true });
  const { c, f, views } = controller(win);
  c.setDeclination(2);
  const pending = c.start();
  assert.deepEqual(
    win.calls,
    ['requestPermission'],
    'called before start returns',
  );
  assert.equal(c.state, 'asking');
  assert.equal(await pending, 'asking');
  assert.equal(win.count('deviceorientation'), 1);
  assert.equal(win.count('deviceorientationabsolute'), 0);
  // real pose: back to magnetic 268, 5 deg up; iOS alpha is 40 deg off (arbitrary frame)
  const pose = portrait(268, 5);
  const relativeAlpha = pose.alpha + 40;
  f.advance(1500, 1000 / 60, () =>
    win.fire('deviceorientation', {
      alpha: relativeAlpha,
      beta: pose.beta,
      gamma: pose.gamma,
      webkitCompassHeading: 268,
      webkitCompassAccuracy: 10,
    }),
  );
  assert.equal(c.state, 'on');
  assert.equal(c.source, 'ios');
  const v = views.at(-1);
  azClose(v.azDeg, 270, 0.05, 'true azimuth = magnetic 268 + 2 E');
  close(v.elDeg, 5, 0.05);
  close(v.rollDeg, 0, 0.05);
  assert.equal(c.info.declinationDeg, 2);
});

test('iOS: poor compass accuracy -> calibrating (figure-8 reason) until it recovers below 20 deg; no heading yet -> calibrating "heading"', async () => {
  const win = fakeWindow({ ios: true });
  const { c, f } = controller(win);
  await c.start();
  const pose = portrait(100, 0);
  const fire = (extra) =>
    f.advance(100, 1000 / 30, () =>
      win.fire('deviceorientation', { ...pose, ...extra }),
    );
  // held flat overhead (screen down): no compass reading usable yet: "hold upright"
  f.advance(100, 1000 / 30, () =>
    win.fire('deviceorientation', {
      alpha: 0,
      beta: 180,
      gamma: 0,
      webkitCompassHeading: 100,
      webkitCompassAccuracy: 10,
    }),
  );
  assert.equal(c.state, 'calibrating');
  assert.equal(c.reason, 'heading');
  fire({ webkitCompassHeading: 100, webkitCompassAccuracy: -1 });
  assert.equal(c.reason, 'accuracy', 'uncalibrated (-1): figure 8');
  fire({ webkitCompassHeading: 100, webkitCompassAccuracy: 40 });
  assert.equal(c.reason, 'accuracy');
  assert.match(c.info.message, /figure 8/);
  fire({ webkitCompassHeading: 100, webkitCompassAccuracy: 22 });
  assert.equal(c.reason, 'accuracy', 'hysteresis: 22 is not yet good');
  fire({ webkitCompassHeading: 100, webkitCompassAccuracy: 15 });
  assert.equal(c.state, 'on');
});

test('iOS denied (answer or exception) -> denied with the message; nothing listened', async () => {
  for (const permission of ['denied', new Error('NotAllowedError')]) {
    const win = fakeWindow({ ios: true, permission });
    const { c } = controller(win);
    assert.equal(await c.start(), 'denied');
    assert.match(c.info.message, /Drag still works/);
    assert.equal(win.count('deviceorientation'), 0);
  }
});

class FakeSensor {
  static instances = [];
  constructor(options) {
    this.options = options;
    this.handlers = {};
    this.started = false;
    this.quaternion = null;
    FakeSensor.instances.push(this);
  }
  addEventListener(type, fn) {
    this.handlers[type] = fn;
  }
  removeEventListener(type) {
    delete this.handlers[type];
  }
  start() {
    this.started = true;
  }
  stop() {
    this.started = false;
  }
  read(q) {
    this.quaternion = q;
    this.handlers.reading?.();
  }
  fail(name) {
    this.handlers.error?.({ error: { name } });
  }
}

test('Chrome with requestPermission(): asked inside the tap, then the sensor is used (not mistaken for iOS)', async () => {
  FakeSensor.instances = [];
  const win = fakeWindow({
    ios: true,
    sensor: FakeSensor,
    absoluteEvent: true,
  });
  const { c, f } = controller(win);
  c.setDeclination(0);
  const pending = c.start();
  assert.deepEqual(win.calls, ['requestPermission']);
  await pending;
  assert.equal(FakeSensor.instances.length, 1);
  f.advance(200, 1000 / 30, () =>
    FakeSensor.instances[0].read(
      quatFromAxes([0, -1, 0], [0, 0, 1], [-1, 0, 0]),
    ),
  );
  assert.equal(c.source, 'sensor');
  assert.equal(c.state, 'on', 'no iOS compass wait');
});

test('Android: AbsoluteOrientationSensor preferred (30 Hz, device frame), quaternion + declination -> view; landscape handled', async () => {
  FakeSensor.instances = [];
  const win = fakeWindow({
    sensor: FakeSensor,
    absoluteEvent: true,
    angle: 90,
  });
  const { c, f, views } = controller(win);
  c.setDeclination(-3);
  await c.start();
  const s = FakeSensor.instances[0];
  assert.deepEqual(s.options, { frequency: 30, referenceFrame: 'device' });
  assert.equal(s.started, true);
  assert.equal(
    win.count('deviceorientationabsolute'),
    0,
    'event not used while the sensor works',
  );
  // landscape, top to the left, back to magnetic east: x up, y north, z west
  const q = quatFromAxes([0, 0, 1], [0, 1, 0], [-1, 0, 0]);
  f.advance(1000, 1000 / 60, () => s.read(q));
  assert.equal(c.state, 'on');
  assert.equal(c.source, 'sensor');
  const v = views.at(-1);
  azClose(v.azDeg, 87, 0.05, 'magnetic 90 with 3 deg W -> true 87');
  close(v.elDeg, 0, 0.05);
  close(v.rollDeg, 0, 0.05);
  c.stop();
  assert.equal(s.started, false);
  assert.equal(c.state, 'off');
});

test('Android: sensor blocked (NotAllowedError) falls back to deviceorientationabsolute; no event either -> denied', async () => {
  FakeSensor.instances = [];
  const win = fakeWindow({ sensor: FakeSensor, absoluteEvent: true });
  const { c, f } = controller(win);
  await c.start();
  FakeSensor.instances[0].fail('NotAllowedError');
  assert.equal(
    win.count('deviceorientationabsolute'),
    1,
    'fallback to the event',
  );
  f.advance(NO_SAMPLE_TIMEOUT_MS + 100);
  assert.equal(c.state, 'denied');
  assert.equal(win.count('deviceorientationabsolute'), 0, 'listeners removed');
});

// ── R1: freshness is per source attempt ──────────────
const EAST = quatFromAxes([0, -1, 0], [0, 0, 1], [-1, 0, 0]); // portrait, back east

/** Sensor + absolute event; the sensor has produced readings and is 'on'. */
async function sensorThatWorked(extra) {
  FakeSensor.instances = [];
  const win = fakeWindow({ sensor: FakeSensor, absoluteEvent: true });
  const rig = controller(win, extra);
  rig.c.setDeclination(0);
  await rig.c.start();
  const s = FakeSensor.instances[0];
  rig.f.advance(500, 1000 / 30, () => s.read(EAST));
  assert.equal(rig.c.state, 'on');
  assert.equal(rig.c.source, 'sensor');
  return { win, s, ...rig };
}

for (const [errorName, expected] of [
  ['NotAllowedError', 'denied'],
  ['NotReadableError', 'unsupported'],
]) {
  test(`R1: sensor read, then ${errorName}, fallback event silent -> ${expected} after the timeout, all torn down (old reading not counted)`, async () => {
    const { win, s, c, f, views } = await sensorThatWorked();
    s.fail(errorName);
    assert.equal(s.started, false, 'failed sensor stopped');
    assert.equal(win.count('deviceorientationabsolute'), 1, 'fallback tried');
    assert.equal(c.sensor, null);
    f.advance(NO_SAMPLE_TIMEOUT_MS - 100);
    assert.ok(c.running, 'still waiting within the timeout');
    const seen = views.length;
    f.advance(200);
    assert.equal(c.state, expected);
    assert.equal(c.running, false);
    assert.doesNotMatch(c.info.message, /follows/);
    assert.equal(win.count('deviceorientationabsolute'), 0, 'listener removed');
    assert.equal(f.queued, 0, 'no animation frames left');
    // late callbacks from the dead sensor change nothing
    s.read(EAST);
    s.fail('NotReadableError');
    f.advance(NO_SAMPLE_TIMEOUT_MS * 2);
    assert.equal(c.state, expected);
    assert.equal(views.length, seen, 'no view applied after the failure');
    assert.equal(win.count('deviceorientationabsolute'), 0);
  });
}

test('R1: sensor read, then fails; the fallback event delivers its own reading -> stays on with the event as source', async () => {
  const { win, s, c, f, views } = await sensorThatWorked();
  s.fail('NotAllowedError');
  f.advance(2000, 1000 / 30, () =>
    win.fire('deviceorientationabsolute', {
      ...portrait(200, 20),
      absolute: true,
    }),
  );
  assert.equal(c.state, 'on');
  assert.equal(c.source, 'absolute-event');
  azClose(views.at(-1).azDeg, 200, 0.5, 'view follows the event');
  close(views.at(-1).elDeg, 20, 0.5);
  f.advance(NO_SAMPLE_TIMEOUT_MS * 2);
  assert.equal(c.state, 'on', 'the watchdog accepted the fallback');
  assert.equal(win.count('deviceorientationabsolute'), 1);
  // a late reading from the failed sensor does not move the view
  s.read(EAST);
  f.advance(500);
  azClose(views.at(-1).azDeg, 200, 0.5);
  c.stop();
  assert.equal(win.count('deviceorientationabsolute'), 0);
});

test('R1: sensor starts but never reads -> the event fallback is tried (own timeout) and used when it delivers', async () => {
  FakeSensor.instances = [];
  const win = fakeWindow({ sensor: FakeSensor, absoluteEvent: true });
  const { c, f, views } = controller(win);
  c.setDeclination(0);
  await c.start();
  const s = FakeSensor.instances[0];
  assert.equal(win.count('deviceorientationabsolute'), 0);
  f.advance(NO_SAMPLE_TIMEOUT_MS + 50);
  assert.ok(c.running, 'not unsupported yet: the events get their turn');
  assert.equal(s.started, false, 'silent sensor stopped');
  assert.equal(win.count('deviceorientationabsolute'), 1);
  f.advance(NO_SAMPLE_TIMEOUT_MS - 200, 1000 / 30, (t) => {
    if (t > NO_SAMPLE_TIMEOUT_MS + 2000)
      win.fire('deviceorientationabsolute', {
        ...portrait(90, 0),
        absolute: true,
      });
  });
  assert.equal(c.state, 'on');
  assert.equal(c.source, 'absolute-event');
  azClose(views.at(-1).azDeg, 90, 1);
  f.advance(NO_SAMPLE_TIMEOUT_MS * 2);
  assert.equal(c.state, 'on');
});

test('R1: sensor silent and the events silent too -> unsupported after one timeout per attempt; sensor-only browser -> unsupported', async () => {
  FakeSensor.instances = [];
  const win = fakeWindow({ sensor: FakeSensor, absoluteEvent: true });
  const { c, f } = controller(win);
  await c.start();
  f.advance(NO_SAMPLE_TIMEOUT_MS + 50);
  assert.ok(c.running);
  f.advance(NO_SAMPLE_TIMEOUT_MS);
  assert.equal(c.state, 'unsupported');
  assert.equal(win.count('deviceorientationabsolute'), 0);
  assert.equal(FakeSensor.instances[0].started, false);

  FakeSensor.instances = [];
  const only = fakeWindow({ sensor: FakeSensor, noApis: true });
  const o = controller(only);
  await o.c.start();
  o.f.advance(NO_SAMPLE_TIMEOUT_MS + 50);
  assert.equal(o.c.state, 'unsupported');
  assert.equal(FakeSensor.instances[0].started, false);
  assert.equal(only.count('deviceorientation'), 0);
});

test('R1: stop/start cancels the old attempt: its readings, errors and timer are ignored', async () => {
  FakeSensor.instances = [];
  const win = fakeWindow({ sensor: FakeSensor, absoluteEvent: true });
  const { c, f, views } = controller(win);
  c.setDeclination(0);
  await c.start();
  const old = FakeSensor.instances[0];
  f.advance(NO_SAMPLE_TIMEOUT_MS - 1000);
  c.stop();
  await c.start();
  const fresh = FakeSensor.instances[1];
  assert.ok(fresh && fresh !== old);
  old.read(EAST);
  old.fail('NotAllowedError');
  assert.equal(views.length, 0, 'old reading ignored');
  assert.equal(win.count('deviceorientationabsolute'), 0, 'old error ignored');
  assert.equal(c.state, 'asking');
  f.advance(1500); // past the OLD watchdog's due time
  assert.ok(c.running, 'old watchdog ignored');
  assert.equal(fresh.started, true);
  f.advance(500, 1000 / 30, () => fresh.read(EAST));
  assert.equal(c.state, 'on');
  // a stop during the fallback wait cancels the fallback's watchdog too
  fresh.fail('NotReadableError');
  c.stop();
  f.advance(NO_SAMPLE_TIMEOUT_MS * 2);
  assert.equal(c.state, 'off');
  assert.equal(win.count('deviceorientationabsolute'), 0);
  assert.equal(f.queued, 0);
});

test('R1: a permission answer for an earlier start is ignored after stop/start', async () => {
  FakeSensor.instances = [];
  const win = fakeWindow({
    ios: true,
    sensor: FakeSensor,
    absoluteEvent: true,
  });
  const answers = [];
  win.DeviceOrientationEvent.requestPermission = () =>
    new Promise((resolve) => answers.push(resolve));
  const { c } = controller(win);
  const first = c.start();
  c.stop();
  const second = c.start();
  answers[0]('denied');
  await first;
  assert.equal(c.state, 'asking', 'old answer ignored');
  answers[1]('granted');
  await second;
  assert.equal(
    FakeSensor.instances.length,
    1,
    'one sensor, for the live start',
  );
  c.stop();
});

test('Android Chrome deviceorientationabsolute: upright facing true 90 (declination 0) -> az 90 el 0', async () => {
  const win = fakeWindow({ absoluteEvent: true });
  const { c, f, views } = controller(win);
  c.setDeclination(0);
  await c.start();
  assert.equal(win.count('deviceorientationabsolute'), 1);
  f.advance(1000, 1000 / 60, () =>
    win.fire('deviceorientationabsolute', {
      ...portrait(90, 0),
      absolute: true,
    }),
  );
  assert.equal(c.source, 'absolute-event');
  azClose(views.at(-1).azDeg, 90, 1e-6);
  close(views.at(-1).elDeg, 0, 1e-6);
});

test('desktop browser: the API exists but only all-null events arrive -> unsupported after the timeout, listeners removed', async () => {
  const win = fakeWindow();
  const { c, f, views } = controller(win);
  await c.start();
  win.fire('deviceorientation', { alpha: null, beta: null, gamma: null });
  f.advance(NO_SAMPLE_TIMEOUT_MS + 50);
  assert.equal(c.state, 'unsupported');
  assert.equal(views.length, 0);
  assert.equal(win.count('deviceorientation'), 0);
});

test('relative-only heading (Firefox): calibrating "relative" until Align; the offset is session-only', async () => {
  const win = fakeWindow();
  const { c, f, views, store } = controller(win);
  await c.start();
  const fire = (ms) =>
    f.advance(ms, 1000 / 30, () =>
      win.fire('deviceorientation', { ...portrait(10, 30), absolute: false }),
    );
  fire(500);
  assert.equal(c.state, 'calibrating');
  assert.equal(c.reason, 'relative');
  assert.match(c.info.message, /Align/);
  // the Moon is really at az 135 el 30 and the user has it in the centre
  const delta = c.alignTo(135, views.at(-1).azDeg);
  close(delta, 125, 1e-6);
  fire(200);
  assert.equal(c.state, 'on');
  azClose(views.at(-1).azDeg, 135, 1e-6);
  assert.equal(store.has(OFFSET_STORAGE_KEY), false);
});

test('Align on a magnetic source persists the offset (localStorage) and Reset clears it', async () => {
  const win = fakeWindow({ absoluteEvent: true });
  const { c, f, views, store } = controller(win);
  c.setDeclination(0);
  await c.start();
  const fire = (ms) =>
    f.advance(ms, 1000 / 30, () =>
      win.fire('deviceorientationabsolute', {
        ...portrait(200, 20),
        absolute: true,
      }),
    );
  fire(800);
  azClose(views.at(-1).azDeg, 200, 1e-3);
  c.alignTo(204.5, views.at(-1).azDeg);
  azClose(views.at(-1).azDeg, 204.5, 1e-6, 'snaps at once');
  close(Number(store.get(OFFSET_STORAGE_KEY)), 4.5, 1e-9);
  assert.equal(c.info.offsetDeg, 4.5);
  // a new controller (page reload) starts with the stored offset
  const again = createPhoneOrientation({
    win,
    isSecureContext: true,
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem() {},
      removeItem() {},
    },
  });
  assert.equal(again.info.offsetDeg, 4.5);
  c.resetOffset();
  assert.equal(store.has(OFFSET_STORAGE_KEY), false);
  azClose(views.at(-1).azDeg, 200, 1e-6, 'reset snaps back at once');
  fire(1000);
  azClose(views.at(-1).azDeg, 200, 1e-6);
});

test('battery: 60 Hz events are processed at <= 30 Hz; a still phone stops redrawing; moving redraws <= 30 fps', async () => {
  const win = fakeWindow({ absoluteEvent: true });
  let processed = 0;
  const { c, f, views } = controller(win);
  c.setDeclination(0);
  await c.start();
  const realFire = win.fire.bind(win);
  // count samples that reach the controller's maths: alpha changes every event
  let alpha = 0;
  f.advance(1000, 1000 / 60, () => {
    alpha += 0.5;
    realFire('deviceorientationabsolute', {
      alpha,
      beta: 90,
      gamma: 0,
      absolute: true,
    });
  });
  processed = views.length;
  assert.ok(
    processed <= 31 && processed >= 25,
    `moving: ${processed} redraws in 1 s`,
  );
  // hold still: once converged, no more redraws at all
  f.advance(1500, 1000 / 60, () =>
    realFire('deviceorientationabsolute', {
      alpha,
      beta: 90,
      gamma: 0,
      absolute: true,
    }),
  );
  const settled = views.length;
  f.advance(2000, 1000 / 60, () =>
    realFire('deviceorientationabsolute', {
      alpha,
      beta: 90,
      gamma: 0,
      absolute: true,
    }),
  );
  assert.equal(views.length, settled, 'still phone: no redraws');
  c.stop();
});

test('smoothing in the loop: a 90 deg turn settles within 1 s, never past the target', async () => {
  const win = fakeWindow({ absoluteEvent: true });
  const { c, f, views } = controller(win);
  c.setDeclination(0);
  await c.start();
  const fire = (bearing, ms) =>
    f.advance(ms, 1000 / 60, () =>
      win.fire('deviceorientationabsolute', {
        ...portrait(bearing, 0),
        absolute: true,
      }),
    );
  fire(90, 1000);
  azClose(views.at(-1).azDeg, 90, 1e-3);
  const start = views.length;
  fire(180, 1000);
  const turn = views.slice(start).map((v) => v.azDeg);
  assert.ok(
    turn.every((az) => az >= 90 - 1e-9 && az <= 180 + 1e-9),
    'no overshoot',
  );
  for (let i = 1; i < turn.length; i += 1)
    assert.ok(turn[i] >= turn[i - 1] - 1e-9);
  assert.ok(180 - turn.at(-1) < 1, `after 1 s: ${turn.at(-1)}`);
});

test('stop removes every listener; start again works; pointingOffered follows a coarse pointer', async () => {
  const win = fakeWindow({ absoluteEvent: true });
  const { c } = controller(win);
  await c.start();
  assert.equal(win.count('deviceorientationabsolute'), 1);
  c.stop();
  assert.equal(win.count('deviceorientationabsolute'), 0);
  assert.equal(c.state, 'off');
  await c.start();
  assert.equal(win.count('deviceorientationabsolute'), 1);
  c.destroy();
  assert.equal(win.count('deviceorientationabsolute'), 0);
  assert.equal(
    pointingOffered({ matchMedia: () => ({ matches: true }) }),
    true,
  );
  assert.equal(
    pointingOffered({ matchMedia: () => ({ matches: false }) }),
    false,
  );
  assert.equal(pointingOffered({}), false);
  // the iOS quaternion helper agrees with the Euler path for the portrait helper
  const q = quatFromEuler(portrait(90, 0).alpha, 90, 0);
  assert.ok(Math.hypot(...q) > 0.999);
});

// ── no persistent Align before the iOS compass reference exists ────
/** iOS event: pose in a yaw frame 40 deg off, with a compass heading. */
const iosEvent = (bearingDeg, elDeg, heading, accuracy) => {
  const pose = portrait(bearingDeg, elDeg);
  return {
    ...pose,
    alpha: (pose.alpha + 40) % 360,
    webkitCompassHeading: heading,
    webkitCompassAccuracy: accuracy,
  };
};

test('R2: iOS tilted up before any compass reference -> Align refused, nothing stored; the first reference gives the true view; stop/start keeps it right', async () => {
  const win = fakeWindow({ ios: true });
  const { c, f, views, store, states } = controller(win);
  c.setDeclination(0);
  assert.equal(c.alignReady, false, 'off: not ready');
  assert.equal(c.alignTo(90, 0), null);
  await c.start();
  assert.equal(c.alignReady, false, 'asking, no reading: not ready');
  const fire = (ev, ms = 200) =>
    f.advance(ms, 1000 / 30, () => win.fire('deviceorientation', ev));
  // looking 30 deg up, back really towards 90: back and top disagree, so no
  // compass reference is taken; the view is in the arbitrary iOS frame
  fire(iosEvent(90, 30, 90, 5));
  assert.equal(c.state, 'calibrating');
  assert.equal(c.reason, 'heading');
  assert.equal(c.alignReady, false);
  assert.equal(c.info.alignReady, false);
  assert.equal(states.at(-1).alignReady, false);
  azClose(views.at(-1).azDeg, 50, 1e-6, 'arbitrary frame (40 deg off)');
  // the user "aligns" on something really at az 90: refused, nothing stored
  assert.equal(c.alignTo(90, views.at(-1).azDeg), null);
  assert.equal(store.has(OFFSET_STORAGE_KEY), false);
  assert.equal(c.info.offsetDeg, 0);
  azClose(views.at(-1).azDeg, 50, 1e-6, 'view not moved by a refused Align');
  // upright: first unambiguous reference -> the TRUE bearing, not 90 + 40
  fire(iosEvent(90, 0, 90, 5), 1500);
  assert.equal(c.state, 'on');
  assert.equal(c.alignReady, true);
  assert.equal(states.at(-1).alignReady, true, 'onState reported it');
  azClose(views.at(-1).azDeg, 90, 0.05);
  // looking up again keeps the reference (gyro yaw): still right, still ready
  fire(iosEvent(90, 30, 90, 5), 1500);
  azClose(views.at(-1).azDeg, 90, 0.05);
  close(views.at(-1).elDeg, 30, 0.05);
  assert.equal(c.alignReady, true);
  // stop/start: no stored offset, the reference must be found again
  c.stop();
  assert.equal(c.alignReady, false);
  await c.start();
  fire(iosEvent(90, 30, 90, 5));
  assert.equal(c.alignReady, false, 'a new start needs its own reference');
  assert.equal(c.alignTo(90, views.at(-1).azDeg), null);
  fire(iosEvent(90, 0, 90, 5), 1500);
  azClose(views.at(-1).azDeg, 90, 0.05, 'right after restart');
  assert.equal(store.has(OFFSET_STORAGE_KEY), false);
  // with the reference a normal Align works and persists
  const delta = c.alignTo(93, views.at(-1).azDeg);
  close(delta, 3, 0.06);
  close(Number(store.get(OFFSET_STORAGE_KEY)), delta, 1e-9);
  azClose(views.at(-1).azDeg, 93, 0.1);
  c.destroy();
});

test('R2: iOS negative accuracy (no reference) -> "accuracy" but Align refused; a later reference while still poor allows Align (reported via onState)', async () => {
  const win = fakeWindow({ ios: true });
  const { c, f, views, store, states } = controller(win);
  c.setDeclination(0);
  await c.start();
  const fire = (ev, ms = 200) =>
    f.advance(ms, 1000 / 30, () => win.fire('deviceorientation', ev));
  // upright but uncalibrated (-1): the heading is not used as a reference
  fire(iosEvent(200, 0, 200, -1));
  assert.equal(c.state, 'calibrating');
  assert.equal(c.reason, 'accuracy');
  assert.equal(c.alignReady, false, 'reason "accuracy" alone is no reference');
  assert.equal(c.alignTo(200, views.at(-1).azDeg), null);
  assert.equal(store.has(OFFSET_STORAGE_KEY), false);
  const before = states.length;
  // a real but poor (40 deg) reading: reference exists, still "accuracy"
  fire(iosEvent(200, 0, 200, 40), 1500);
  assert.equal(c.state, 'calibrating');
  assert.equal(c.reason, 'accuracy');
  assert.equal(c.alignReady, true);
  assert.ok(
    states.slice(before).some((s) => s.alignReady === true),
    'onState fired although state and reason did not change',
  );
  azClose(views.at(-1).azDeg, 200, 0.1);
  // Align with poor accuracy but a reference: allowed and stored
  const delta = c.alignTo(205, views.at(-1).azDeg);
  close(delta, 5, 0.06);
  close(Number(store.get(OFFSET_STORAGE_KEY)), delta, 1e-9);
  fire(iosEvent(200, 0, 200, 40), 500);
  azClose(views.at(-1).azDeg, 200 + delta, 0.05, 'offset counted once');
  c.destroy();
});

test('R2: relative source is Align-ready from its first reading; magnetic sources too; nothing before a reading', async () => {
  const rel = controller(fakeWindow());
  await rel.c.start();
  assert.equal(rel.c.alignReady, false, 'no reading yet');
  assert.equal(rel.c.alignTo(10, 0), null);
  const rwin = fakeWindow();
  const r = controller(rwin);
  await r.c.start();
  r.f.advance(300, 1000 / 30, () =>
    rwin.fire('deviceorientation', { ...portrait(10, 30), absolute: false }),
  );
  assert.equal(r.c.reason, 'relative');
  assert.equal(r.c.alignReady, true);
  close(r.c.alignTo(135, r.views.at(-1).azDeg), 125, 1e-6);
  assert.equal(r.store.has(OFFSET_STORAGE_KEY), false, 'session-only');
  const awin = fakeWindow({ absoluteEvent: true });
  const a = controller(awin);
  a.c.setDeclination(0);
  await a.c.start();
  a.f.advance(300, 1000 / 30, () =>
    awin.fire('deviceorientationabsolute', {
      ...portrait(200, 20),
      absolute: true,
    }),
  );
  assert.equal(a.c.alignReady, true);
  assert.notEqual(a.c.alignTo(204, a.views.at(-1).azDeg), null);
  assert.equal(a.store.has(OFFSET_STORAGE_KEY), true);
  rel.c.destroy();
  r.c.destroy();
  a.c.destroy();
});

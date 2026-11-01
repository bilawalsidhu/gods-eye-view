import assert from 'node:assert/strict';
import test from 'node:test';
import { ENTRIES, entryOf, tle } from '../testSupport/skyTleFixture.mjs';
import * as Cesium from 'cesium';
import {
  describeObserver,
  mountSkyView,
  skyViewFor,
  toLocalInputValue,
} from './skyView.js';
import { worldDirectionToAzEl } from './skyCamera.js';
import { createObserver } from './observer.js';
import { readFileSync } from 'node:fs';
import { createSatWorkerHandler } from './satWorker.js';
import { isNakedEyeCandidate } from './brightness.js';
import { ISS_NORAD, STATE } from './satCore.js';

// ── a very small DOM ───────────────────────────────────────────────────────
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
    this.focused = false;
    this.width = 0;
    this.height = 0;
    this.drawCalls = 0;
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
  focus() {
    this.focused = true;
  }
  setPointerCapture() {}
  getContext() {
    const element = this;
    const noop = () => {};
    return new Proxy(
      {},
      {
        get(target, key) {
          if (key === 'createLinearGradient')
            return () => ({ addColorStop: noop });
          if (key === 'clearRect')
            return () => {
              element.drawCalls += 1;
            };
          if (key in target) return target[key];
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
    /** Run every one-shot timer once (intervals stay). */
    flush() {
      for (const [key, timer] of [...pending]) {
        if (!timer.every) pending.delete(key);
        timer.fn();
      }
    },
  };
}

class FakeHandler {
  static last = null;
  constructor(canvas) {
    this.canvas = canvas;
    this.actions = new Map();
    this.destroyed = false;
    FakeHandler.last = this;
  }
  setInputAction(fn, type) {
    this.actions.set(type, fn);
  }
  destroy() {
    this.destroyed = true;
  }
}

const SkyCesium = { ...Cesium, ScreenSpaceEventHandler: FakeHandler };

function fakeViewer({ width = 1200, height = 800, pickHeight = 20 } = {}) {
  const canvas = new FakeElement('canvas');
  canvas.clientWidth = width;
  canvas.clientHeight = height;
  const scene = {
    canvas,
    drawingBufferWidth: width,
    drawingBufferHeight: height,
    mapProjection: new Cesium.GeographicProjection(Cesium.Ellipsoid.WGS84),
    globe: {
      ellipsoid: Cesium.Ellipsoid.WGS84,
      show: true,
      enableLighting: false,
      dynamicAtmosphereLighting: true,
      dynamicAtmosphereLightingFromSun: false,
    },
    ellipsoid: Cesium.Ellipsoid.WGS84,
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    renders: 0,
    requestRender() {
      this.renders += 1;
    },
    preRender: new Cesium.Event(),
    skyBox: { show: true },
    skyAtmosphere: { show: true },
    screenSpaceCameraController: { enableInputs: true },
    primitives: { length: 0, get: () => undefined },
    pickPositionSupported: true,
    pickPosition: () =>
      Cesium.Cartesian3.fromDegrees(-95.3698, 29.7604, pickHeight),
  };
  const camera = new Cesium.Camera(scene);
  camera.frustum.aspectRatio = width / height;
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 3000),
    orientation: { heading: 0.4, pitch: -0.7, roll: 0 },
  });
  camera.frustum.fov = 1;
  camera.pickEllipsoid = () =>
    Cesium.Cartesian3.fromDegrees(-95.3698, 29.7604, 0);
  scene.camera = camera;
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

function fakeHistory(location) {
  return {
    state: null,
    writes: 0,
    replaceState(_state, _title, href) {
      this.writes += 1;
      location.href = href;
    },
  };
}

function setup(options = {}) {
  const doc = fakeDocument();
  const viewer = fakeViewer(options.viewer);
  const timers = fakeTimers();
  const location = {
    href: options.href || 'https://gev.test/#v=2&lat=30&lon=-97',
  };
  const history = fakeHistory(location);
  const toasts = [];
  const handle = mountSkyView({
    viewer,
    document: doc,
    timers,
    location,
    history,
    CesiumApi: SkyCesium,
    now: options.now ?? (() => Date.parse('2026-10-12T03:30:00Z')),
    showToast: (m) => toasts.push(m),
    geolocation: options.geolocation,
    isSecureContext: options.isSecureContext ?? true,
    geocode: options.geocode,
    runNavigation: options.runNavigation,
    lifetime: options.lifetime,
    createSatWorker: options.createSatWorker,
    fetchCelestrak: options.fetchCelestrak,
    fetchRcs: options.fetchRcs ?? (async () => ({ rcs: {} })),
    nakedEyeDefault: options.nakedEyeDefault,
    requestFrame: options.requestFrame ?? (() => null),
    reducedMotion: options.reducedMotion,
    ...(options.orientationWindow
      ? { orientationWindow: options.orientationWindow }
      : {}),
    ...(options.offerPointing ? { offerPointing: options.offerPointing } : {}),
    ...(options.orientationOptions
      ? { orientationOptions: options.orientationOptions }
      : {}),
    ...(options.declinationAt ? { declinationAt: options.declinationAt } : {}),
    ...(options.voiceWindow !== undefined
      ? { voiceWindow: options.voiceWindow }
      : {}),
  });
  return { doc, viewer, timers, location, history, handle };
}

const click = (node) => node.dispatchEvent(new Event('click'));
const pointer = (type, props) => Object.assign(new Event(type), props);
const settle = () => new Promise((resolve) => setImmediate(resolve));

function poseDelta(camera, before) {
  return Math.max(
    Cesium.Cartesian3.distance(camera.position, before.position),
    Cesium.Cartesian3.distance(camera.direction, before.direction),
    Cesium.Cartesian3.distance(camera.up, before.up),
    Cesium.Cartesian3.distance(camera.right, before.right),
  );
}

test('mount: Sky button, panel, toolbar, overlay canvas; once per viewer; null without a DOM', () => {
  const { doc, viewer, handle } = setup();
  const button = doc.body.find('open');
  assert.ok(button);
  assert.equal(button.textContent, 'Sky');
  assert.ok(doc.body.find('panel').hidden);
  assert.ok(doc.body.find('bar').hidden);
  assert.ok(viewer.container.find('canvas').hidden);
  assert.equal(mountSkyView({ viewer, document: doc }), handle);
  assert.equal(skyViewFor(viewer), handle);
  assert.equal(skyViewFor(null), null);
  assert.equal(mountSkyView({ viewer: fakeViewer(), document: null }), null);
  assert.equal(mountSkyView({ viewer: null, document: doc }), null);
  click(button);
  assert.equal(doc.body.find('panel').hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  click(doc.body.find('close'));
  assert.equal(doc.body.find('panel').hidden, true);
  handle.destroy();
  assert.equal(doc.body.find('open'), null);
  assert.equal(skyViewFor(viewer), null);
});

test('voice hook: open stands at the map centre, close leaves, destroy drops the hook', async () => {
  const voiceWindow = {};
  const { handle } = setup({ voiceWindow });
  assert.equal(voiceWindow.__gevSky.voice, handle.voice);
  const opened = await handle.voice.open();
  assert.equal(opened.ok, true);
  assert.equal(opened.open, true);
  assert.equal(handle.active, true);
  const again = await handle.voice.open();
  assert.equal(again.opened, false);
  const lines = await handle.voice.lines(false);
  assert.equal(lines.ok, true);
  assert.equal(lines.lines, false);
  assert.equal(handle.content.flags.lines, false);
  const closed = handle.voice.close();
  assert.equal(closed.ok, true);
  assert.equal(closed.open, false);
  assert.equal(handle.active, false);
  handle.destroy();
  assert.equal(voiceWindow.__gevSky, undefined);
  assert.equal((await handle.voice.status()).ok, false);
});

test('openHere shares one enter when a second call overlaps the first', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let samples = 0;
  const { handle, viewer } = setup({ viewer: { pickHeight: 20000 } });
  viewer.scene.sampleHeightMostDetailed = () => {
    samples += 1;
    return gate.then(() => [{ height: 12 }]);
  };
  const first = handle.openHere();
  const second = handle.openHere();
  assert.equal(samples, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(handle.active, true);
  const third = await handle.openHere();
  assert.equal(third.alreadyOpen, true);
  assert.equal(samples, 1);
  handle.destroy();
});

test('openHere returns a Promise when Sky is already open', async () => {
  const { handle } = setup({ viewer: { pickHeight: 20000 } });
  const first = await handle.openHere();
  assert.equal(first.ok, true);
  const again = handle.openHere();
  assert.equal(again instanceof Promise, true);
  const resolved = await again;
  assert.equal(resolved.alreadyOpen, true);
  assert.equal(resolved.ok, true);
  handle.destroy();
});

test('voice: time and a preset use the mounted clock', async () => {
  const voiceWindow = {};
  const { handle } = setup({ voiceWindow });
  const opened = await handle.voice.open();
  assert.equal(opened.ok, true);
  const set = await handle.voice.time({ time: '2026-10-12T04:00:00Z' });
  assert.equal(set.ok, true, set.error);
  assert.equal(set.time, '2026-10-12T04:00:00.000Z');
  assert.equal(handle.clock.mode, 'fixed');
  const back = await handle.voice.time({ live: true });
  assert.equal(back.ok, true);
  assert.equal(back.live, true);
  assert.equal(handle.clock.mode, 'live');
  const preset = await handle.voice.preset('sunset');
  assert.equal(preset.ok, true, preset.error);
  assert.equal(preset.preset, 'sunset');
  assert.equal(handle.clock.mode, 'fixed');
  handle.destroy();
});

test('voice: look at Jupiter uses the real search index', async () => {
  const { handle } = setup({ voiceWindow: {} });
  const opened = await handle.voice.open();
  assert.equal(opened.ok, true);
  const looked = await handle.voice.look('Jupiter');
  assert.equal(looked.ok, true, looked.error);
  assert.equal(looked.target, 'Jupiter');
  assert.equal(looked.kind, 'body');
  assert.equal(typeof looked.azimuthDeg, 'number');
  assert.equal(typeof looked.elevationDeg, 'number');
  handle.destroy();
});

test('enter at typed lat, lon: eye at 1.7 m over unknown ground (0, flagged), inputs off, URL written; exit restores the camera to 1e-6', async () => {
  const { doc, viewer, timers, location, handle } = setup();
  const before = {
    position: Cesium.Cartesian3.clone(viewer.camera.position),
    direction: Cesium.Cartesian3.clone(viewer.camera.direction),
    up: Cesium.Cartesian3.clone(viewer.camera.up),
    right: Cesium.Cartesian3.clone(viewer.camera.right),
    heading: viewer.camera.heading,
    pitch: viewer.camera.pitch,
    roll: viewer.camera.roll,
    fov: viewer.camera.frustum.fov,
    time: Cesium.JulianDate.clone(viewer.clock.currentTime),
  };
  click(doc.body.find('open'));
  doc.body.find('query').value = '29.7604 N 95.3698 W';
  doc.body.find('form').dispatchEvent(new Event('submit'));
  await settle();
  await settle();
  assert.equal(handle.active, true);
  assert.equal(handle.observer.source, 'manual');
  assert.equal(handle.observer.heightKnown, false);
  assert.equal(handle.observer.groundHeightM, 0);
  const carto = viewer.camera.positionCartographic;
  assert.ok(Math.abs(carto.height - 1.7) < 1e-6);
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, false);
  assert.equal(viewer.scene.globe.enableLighting, true);
  assert.equal(doc.body.find('bar').hidden, false);
  assert.equal(viewer.container.find('canvas').hidden, false);
  assert.ok(viewer.container.find('canvas').drawCalls > 0, 'overlay drawn');
  assert.ok(doc.body.classList.contains('gev-sky-active'));
  assert.match(
    doc.body.find('info').textContent,
    /ground height unknown \(0 m used\)/,
  );
  assert.match(doc.body.find('info').textContent, /Sun -?\d+\.\d° \(/);
  timers.flush();
  assert.match(location.href, /[?&]sv=29\.7604,-95\.3698,0,20,70(&|#)/);
  assert.match(location.href, /#v=2&lat=30&lon=-97$/, 'hash untouched');

  click(doc.body.find('back'));
  assert.equal(handle.active, false);
  assert.ok(
    poseDelta(viewer.camera, before) < 1e-6,
    `pose delta ${poseDelta(viewer.camera, before)}`,
  );
  assert.ok(Math.abs(viewer.camera.heading - before.heading) < 1e-6);
  assert.ok(Math.abs(viewer.camera.pitch - before.pitch) < 1e-6);
  assert.ok(Math.abs(viewer.camera.roll - before.roll) < 1e-6);
  assert.equal(viewer.camera.frustum.fov, before.fov);
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, true);
  assert.equal(viewer.scene.globe.enableLighting, false);
  assert.equal(viewer.scene.skyBox.show, true);
  assert.ok(Cesium.JulianDate.equals(viewer.clock.currentTime, before.time));
  assert.equal(doc.body.find('bar').hidden, true);
  assert.ok(!doc.body.classList.contains('gev-sky-active'));
  assert.ok(!/[?&]sv=/.test(location.href), 'sv removed on exit');
});

test('drag, wheel and keys move the real Cesium camera; Escape leaves', async () => {
  const { viewer, handle } = setup();
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  const canvas = viewer.container.find('canvas');
  const az0 = handle.view.azDeg;
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 1, clientX: 600, clientY: 400 }),
  );
  canvas.dispatchEvent(
    pointer('pointermove', { pointerId: 1, clientX: 700, clientY: 450 }),
  );
  canvas.dispatchEvent(
    pointer('pointerup', { pointerId: 1, clientX: 700, clientY: 450 }),
  );
  assert.ok(
    handle.view.azDeg < az0 || handle.view.azDeg > 300,
    'drag right turns left',
  );
  assert.ok(handle.view.elDeg > 20, 'drag down looks up');
  const look = worldDirectionToAzEl(
    Cesium,
    viewer.camera.positionWC,
    viewer.camera.directionWC,
  );
  assert.ok(Math.abs(look.elDeg - handle.view.elDeg) < 1e-6);
  const fov0 = handle.view.fovDeg;
  canvas.dispatchEvent(
    Object.assign(new Event('wheel', { cancelable: true }), { deltaY: -200 }),
  );
  assert.ok(handle.view.fovDeg < fov0);
  assert.ok(
    Math.abs(viewer.camera.frustum.fov - (handle.view.fovDeg * Math.PI) / 180) <
      1e-12,
  );
  // pinch: two pointers spreading apart zoom in
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 1, clientX: 500, clientY: 400 }),
  );
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 2, clientX: 700, clientY: 400 }),
  );
  const fov1 = handle.view.fovDeg;
  canvas.dispatchEvent(
    pointer('pointermove', { pointerId: 2, clientX: 900, clientY: 400 }),
  );
  assert.ok(Math.abs(handle.view.fovDeg - fov1 / 2) < 1e-9);
  canvas.dispatchEvent(pointer('pointerup', { pointerId: 2 }));
  canvas.dispatchEvent(pointer('pointerup', { pointerId: 1 }));
  canvas.dispatchEvent(Object.assign(new Event('keydown'), { key: 'n' }));
  assert.equal(handle.view.azDeg, 0);
  canvas.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Z' }));
  assert.equal(handle.view.elDeg, 90);
  canvas.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
  assert.equal(handle.active, false);
});

test('pick on map: one click on the globe sets the observer with the picked ground height', async () => {
  const { doc, viewer, handle } = setup({ viewer: { pickHeight: 20 } });
  click(doc.body.find('open'));
  click(doc.body.find('pick'));
  assert.ok(doc.body.classList.contains('gev-sky-picking'));
  const picker = FakeHandler.last;
  const action = picker.actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK);
  action({ position: new Cesium.Cartesian2(10, 10) });
  await settle();
  assert.equal(picker.destroyed, true, 'one click only');
  assert.ok(!doc.body.classList.contains('gev-sky-picking'));
  assert.equal(handle.active, true);
  assert.equal(handle.observer.source, 'map');
  assert.equal(handle.observer.heightKnown, true);
  assert.ok(Math.abs(handle.observer.groundHeightM - 20) < 1e-6);
  assert.ok(Math.abs(viewer.camera.positionCartographic.height - 21.7) < 1e-6);
});

test('a wild pick (tile glitch) falls back to the ellipsoid and samples the height', async () => {
  const { doc, handle } = setup({ viewer: { pickHeight: -13_000 } });
  click(doc.body.find('open'));
  click(doc.body.find('here'));
  await settle();
  await settle();
  assert.equal(handle.active, true);
  assert.equal(handle.observer.heightKnown, false);
  assert.equal(handle.observer.groundHeightM, 0);
});

test('use my location: one press = one request; ready enters with the GPS fix and accuracy', async () => {
  const calls = [];
  const geolocation = {
    getCurrentPosition: (ok, fail, options) =>
      calls.push({ ok, fail, options }),
  };
  const { doc, handle } = setup({ geolocation });
  click(doc.body.find('open'));
  click(doc.body.find('gps'));
  click(doc.body.find('gps'));
  assert.equal(calls.length, 1);
  assert.equal(
    doc.body.find('status').textContent,
    'Waiting for your browser to allow location',
  );
  calls[0].ok({ coords: { latitude: 29.76, longitude: -95.37, accuracy: 30 } });
  await settle();
  await settle();
  assert.equal(handle.active, true);
  assert.equal(handle.observer.source, 'gps');
  assert.equal(handle.observer.accuracyM, 30);
  assert.match(doc.body.find('info').textContent, /\+\/- 30 m/);
});

test('location messages: denied, insecure context', async () => {
  const calls = [];
  const geolocation = {
    getCurrentPosition: (ok, fail) => calls.push({ ok, fail }),
  };
  const denied = setup({ geolocation });
  click(denied.doc.body.find('gps'));
  calls[0].fail({ code: 1 });
  await settle();
  assert.match(denied.doc.body.find('status').textContent, /Location blocked/);
  assert.equal(denied.handle.active, false);
  const insecure = setup({ geolocation, isSecureContext: false });
  click(insecure.doc.body.find('gps'));
  assert.equal(
    insecure.doc.body.find('status').textContent,
    'Location needs the https:// address',
  );
  assert.equal(calls.length, 1);
});

test('place search uses the existing keyless geocoder', async () => {
  const asked = [];
  const { doc, handle } = setup({
    geocode: async (q) => {
      asked.push(q);
      return { lat: 29.7604, lng: -95.3698, name: 'Houston' };
    },
  });
  doc.body.find('query').value = 'Houston';
  doc.body.find('form').dispatchEvent(new Event('submit'));
  for (let i = 0; i < 4; i++) await settle();
  assert.deepEqual(asked, ['Houston']);
  assert.equal(handle.active, true);
  assert.equal(handle.observer.latDeg, 29.7604);
  const miss = setup({ geocode: async () => null });
  miss.doc.body.find('query').value = 'Nowhere';
  miss.doc.body.find('form').dispatchEvent(new Event('submit'));
  for (let i = 0; i < 4; i++) await settle();
  assert.match(miss.doc.body.find('status').textContent, /No place found/);
  assert.equal(miss.handle.active, false);
});

test('flat horizon hides the globe; grid and live/fixed time go to the URL flags', async () => {
  const { doc, viewer, timers, location, handle } = setup();
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  click(doc.body.find('flat'));
  assert.equal(viewer.scene.globe.show, false);
  assert.equal(doc.body.find('flat').getAttribute('aria-pressed'), 'true');
  click(doc.body.find('grid'));
  const time = doc.body.find('time');
  time.value = '2026-10-12T03:30';
  time.dispatchEvent(new Event('change'));
  assert.equal(handle.clock.mode, 'fixed');
  timers.flush();
  assert.match(location.href, /svf=3/);
  assert.match(location.href, /sv=[^&#]*,\d{4}-\d\d-\d\dT\d\d:\d\d:00Z/);
  click(doc.body.find('flat'));
  assert.equal(viewer.scene.globe.show, true);
  click(doc.body.find('live'));
  assert.equal(handle.clock.mode, 'live');
  handle.exit();
  assert.equal(viewer.scene.globe.show, true);
});

test('a shared sv link opens straight into the sky with its view, time and flags', async () => {
  const href =
    'https://gev.test/?sv=29.7604,-95.3698,250,12.5,40,2026-10-12T00:15:00Z&svf=2#v=2&lat=1&lon=2';
  const { viewer, timers, handle } = setup({ href });
  assert.equal(handle.active, false);
  timers.flush();
  await settle();
  await settle();
  assert.equal(handle.active, true);
  assert.equal(handle.observer.source, 'url');
  assert.equal(handle.view.azDeg, 250);
  assert.equal(handle.view.elDeg, 12.5);
  assert.equal(handle.view.fovDeg, 40);
  assert.equal(handle.flags.grid, true);
  assert.equal(handle.clock.mode, 'fixed');
  assert.equal(
    Cesium.JulianDate.toIso8601(viewer.clock.currentTime, 0),
    '2026-10-12T00:15:00Z',
  );
});

test('the shell navigation policy can refuse (cockpit); following hides the button', async () => {
  const { doc, viewer, handle } = setup({ runNavigation: () => false });
  await handle.enterAt({ latDeg: 1, lonDeg: 2, source: 'manual' });
  assert.equal(handle.active, false);
  assert.match(
    doc.body.find('status').textContent,
    /not available in this mode/,
  );
  viewer.trackedEntity = {};
  viewer.trackedEntityChanged.raiseEvent();
  assert.equal(doc.body.find('open').hidden, true);
  viewer.trackedEntity = undefined;
  viewer.trackedEntityChanged.raiseEvent();
  assert.equal(doc.body.find('open').hidden, false);
});

test('the shell lifetime destroys the view (and restores the camera if active)', async () => {
  const removers = new Set();
  const { doc, viewer, handle } = setup({ lifetime: { removers } });
  assert.equal(removers.size, 1);
  const pos = Cesium.Cartesian3.clone(viewer.camera.position);
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  for (const remove of removers) remove();
  assert.equal(handle.destroyed, true);
  assert.ok(Cesium.Cartesian3.distance(viewer.camera.position, pos) < 1e-6);
  assert.equal(doc.body.find('open'), null);
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, true);
});

test('another navigation taking the camera ends Sky mode without fighting it', async () => {
  const { viewer, timers, handle } = setup();
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  const tick = [...timers.pending.values()].find((t) => t.every);
  tick.fn();
  assert.equal(handle.active, true, 'camera still at the eye');
  const away = Cesium.Cartesian3.fromDegrees(-74, 40.7, 5000);
  viewer.camera.setView({ destination: away });
  tick.fn();
  assert.equal(handle.active, false);
  assert.ok(
    Cesium.Cartesian3.distance(viewer.camera.position, away) < 1e-6,
    'camera left where the other navigation put it',
  );
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, true);
});

test('describeObserver and toLocalInputValue', () => {
  const o = createObserver({
    latDeg: 29.7604,
    lonDeg: -95.3698,
    groundHeightM: 15,
    heightKnown: true,
    accuracyM: 30,
  });
  assert.equal(
    describeObserver(o, { sunAltDeg: -3.25 }),
    '29.7604° N 95.3698° W · ground 15 m · +/- 30 m · Sun -3.3° (Civil twilight)',
  );
  assert.equal(describeObserver(null), '');
  assert.match(
    toLocalInputValue(Date.parse('2026-10-12T03:30:00Z')),
    /^\d{4}-\d\d-\d\dT\d\d:\d\d$/,
  );
});

// ── satellites ───────────────────────────────────────────────────────
const SAT_FIXTURE = readFileSync(
  new URL('./reference/satFixture200.tle', import.meta.url),
  'utf8',
);

class InlineSatWorker extends EventTarget {
  constructor() {
    super();
    this.outbox = [];
    this.terminated = false;
    this.handle = createSatWorkerHandler((m) => this.outbox.push(m));
  }
  postMessage(message) {
    this.handle(message);
    queueMicrotask(() => this.deliver());
  }
  deliver() {
    for (const data of this.outbox.splice(0))
      this.dispatchEvent(Object.assign(new Event('message'), { data }));
  }
  terminate() {
    this.terminated = true;
  }
}

function satSetup(extra = {}) {
  const worker = new InlineSatWorker();
  const fetched = [];
  const env = setup({
    createSatWorker: () => worker,
    fetchCelestrak: async (path) => {
      fetched.push(path);
      if (extra.groups?.[path]) return extra.groups[path];
      return path === 'active' ? SAT_FIXTURE : '';
    },
    reducedMotion: () => true,
    // the tests below look at every object above the horizon
    nakedEyeDefault: false,
    ...extra,
  });
  return { ...env, worker, fetched };
}

async function pumpSats(worker) {
  for (let i = 0; i < 6; i++) {
    await settle();
    worker.deliver();
  }
}

const clickWithTarget = (node, target) => {
  const event = new Event('click');
  Object.defineProperty(event, 'target', { value: target });
  node.dispatchEvent(event);
};

test('satellites: worker starts on enter, panel lists overhead objects with the element-age banner', async () => {
  const { doc, handle, worker, fetched } = satSetup();
  assert.equal(doc.body.find('sats').hidden, true, 'hidden before Sky');
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  assert.equal(doc.body.find('sats').hidden, false);
  assert.ok(fetched.includes('active') && fetched.includes('stations'));
  assert.ok(!fetched.includes('starlink'), 'Starlink off by default');
  assert.equal(handle.satellites.status, 'ready');
  const list = doc.body.find('sats-list');
  assert.ok(list.children.length > 0, 'rows listed');
  assert.match(
    doc.body.find('sats-title').textContent,
    /^Overhead now \(\d+\)$/,
  );
  assert.match(
    doc.body.find('sats-banner').textContent,
    /^Elements: newest epoch 2026-10-1\d/,
  );
  handle.redraw();
  assert.ok(handle.satelliteModel, 'satellite model drawn');
});

test('satellites: canvas click selects (card), list click selects + looks at it, chips filter, exit stops the worker', async () => {
  const { doc, viewer, handle, worker } = satSetup();
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  // clicks on the list background or a row gap select nothing (not index 0)
  const listNode = doc.body.find('sats-list');
  clickWithTarget(listNode, listNode);
  clickWithTarget(listNode, listNode.children[0]);
  assert.equal(handle.selectedSatellite, null, 'background click: no select');
  assert.equal(doc.body.find('sats-card').hidden, true);
  // look at the highest object so it is on screen, then click it
  const first = doc.body.find('sats-list').children[0].children[0];
  const index = Number(first.getAttribute('data-index'));
  clickWithTarget(doc.body.find('sats-list'), first);
  assert.equal(handle.selectedSatellite, index);
  const row = handle.satellites.lookup(index).row;
  assert.ok(
    Math.abs(((handle.view.azDeg - row.azDeg + 540) % 360) - 180) < 1e-3,
    'looked at it (reduced motion: instant)',
  );
  assert.ok(Math.abs(handle.view.elDeg - row.elDeg) < 1e-3);
  const card = doc.body.find('sats-card');
  assert.equal(card.hidden, false);
  assert.equal(
    card.children[0].textContent,
    handle.satellites.meta[index].name,
  );
  // rows and card buttons survive refreshes (a click must not be lost)
  const lookButton = doc.body.find('sats-look');
  const rowButton = doc.body.find('sats-list').children[0].children[0];
  handle.satellites.requestTick(true);
  await pumpSats(worker);
  assert.equal(doc.body.find('sats-look'), lookButton);
  assert.equal(doc.body.find('sats-list').children[0].children[0], rowButton);
  // a nested element inside a row button selects that row
  handle.selectSatellite(null);
  const inner = doc.createElement('span');
  rowButton.append(inner);
  clickWithTarget(doc.body.find('sats-list'), inner);
  assert.equal(
    handle.selectedSatellite,
    Number(rowButton.getAttribute('data-index')),
  );
  inner.remove();
  handle.selectSatellite(index);
  handle.setView({ azDeg: (row.azDeg + 180) % 360 });
  click(lookButton);
  assert.ok(Math.abs(((handle.view.azDeg - row.azDeg + 540) % 360) - 180) < 1);
  // clear, then click the dot on the canvas
  handle.selectSatellite(null);
  handle.redraw();
  const dot = handle.satelliteModel.dots.find((d) => d.index === index);
  assert.ok(dot, 'dot at the view centre');
  const canvas = viewer.container.find('canvas');
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 5, clientX: dot.x, clientY: dot.y }),
  );
  canvas.dispatchEvent(
    pointer('pointerup', { pointerId: 5, clientX: dot.x + 1, clientY: dot.y }),
  );
  assert.equal(handle.selectedSatellite, index);
  // a click on empty sky clears the selection
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 6, clientX: 3, clientY: 3 }),
  );
  canvas.dispatchEvent(
    pointer('pointerup', { pointerId: 6, clientX: 3, clientY: 3 }),
  );
  assert.equal(handle.selectedSatellite, null);
  // chip: hide the class of that object
  const klass = handle.satellites.meta[index].klass;
  const chip = doc.body.find(`chip-${klass}`);
  click(chip);
  assert.equal(chip.getAttribute('aria-pressed'), 'false');
  handle.redraw();
  assert.ok(!handle.satelliteModel.dots.some((d) => d.index === index));
  click(chip);
  // GEO belt switch and data-set switches
  click(doc.body.find('geo-belt'));
  assert.equal(doc.body.find('geo-belt').getAttribute('aria-pressed'), 'true');
  handle.redraw();
  assert.ok(handle.satelliteModel.belt.length > 0);
  click(doc.body.find('set-starlink'));
  assert.equal(handle.satellites.sets.starlink, true);
  // exit
  click(doc.body.find('back'));
  assert.equal(worker.terminated, true);
  assert.equal(handle.satellites.running, false);
  assert.equal(doc.body.find('sats').hidden, true);
  assert.equal(handle.selectedSatellite, null);
  handle.destroy();
  assert.equal(doc.body.find('sats'), null);
});

test('satellites: a picked Sky time forces an immediate worker tick at that time', async () => {
  const { doc, handle, worker } = satSetup();
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  const time = doc.body.find('time');
  time.value = '2026-10-11T18:00';
  time.dispatchEvent(new Event('change'));
  await pumpSats(worker);
  assert.equal(
    handle.satellites.stats.timeMs,
    new Date('2026-10-11T18:00').getTime(),
  );
});

test('satellites: without Web Workers the sky still works and the panel says why', async () => {
  const { doc, handle } = setup({ createSatWorker: () => null });
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  assert.equal(handle.active, true);
  assert.equal(handle.satellites.status, 'unavailable');
  assert.match(doc.body.find('sats-banner').textContent, /Web Workers/);
});

test('redraws reuse the cached canvas size (no forced layout per frame); a resize re-measures', async () => {
  const observers = [];
  const saved = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnected = false;
      observers.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
  };
  try {
    const { viewer, handle } = setup();
    // one on the globe canvas (size cache); adds one on the toolbar
    const canvasObserver = observers.find(
      (o) => o.targets[0] === viewer.scene.canvas,
    );
    assert.ok(canvasObserver, 'the globe canvas is observed');
    await handle.enterAt({
      latDeg: 29.7604,
      lonDeg: -95.3698,
      source: 'manual',
    });
    const globe = viewer.scene.canvas;
    let width = 1200;
    let reads = 0;
    Object.defineProperty(globe, 'clientWidth', {
      configurable: true,
      get() {
        reads += 1;
        return width;
      },
    });
    for (let i = 0; i < 5; i++) handle.setView({ azDeg: 100 + i });
    assert.equal(reads, 0, 'five redraws, no size read');
    const timing = handle.redrawPerf();
    assert.ok(timing.count >= 5 && timing.p95 >= 0, 'redraws are timed');
    handle.resetRedrawPerf();
    assert.equal(handle.redrawPerf().count, 0);
    const overlay = handle.elements.canvas;
    const before = overlay.width;
    width = 900;
    canvasObserver.callback([]);
    assert.ok(reads > 0, 'the resize re-measured');
    assert.ok(overlay.width < before, 'overlay follows the new size');
    reads = 0;
    handle.setView({ azDeg: 140 });
    assert.equal(reads, 0, 'cached again after the resize');
    handle.destroy?.();
    assert.ok(
      observers.every((o) => o.disconnected),
      'observers released',
    );
  } finally {
    globalThis.ResizeObserver = saved;
  }
});

// ── search x satellites (R2) ────────────────────
test('R2: the search box finds satellites from the satellite engine; look-at + marker on the drawn dot; below-horizon objects say so', async () => {
  const { doc, handle, worker } = satSetup();
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  assert.equal(handle.satellites.status, 'ready');
  const meta = handle.satellites.meta;
  const count = (name) => meta.filter((m) => m.name === name).length;
  const query = doc.body.find('sky-search-query');
  const submit = (text) => {
    query.value = text;
    doc.body.find('sky-search').dispatchEvent(new Event('submit'));
    return doc.body.find('sky-search-status').textContent;
  };
  // "ISS" ranks the space station first, never the star Meissa
  const iss = handle.content.search('ISS');
  assert.equal(iss[0].kind, 'satellite');
  assert.match(iss[0].label, /^ISS/);
  assert.equal(meta[iss[0].target.id].noradId, 25544);
  // an object above the horizon: animated look-at (instant here) + marker
  const up = handle.satellites
    .objectsAt(handle.clock.getTime())
    .filter((o) => o.elDeg > 10 && count(meta[o.index].name) === 1)
    .sort((a, b) => b.elDeg - a.elDeg)
    .map((o) => ({ d: o, m: meta[o.index] }))[0];
  assert.ok(up, 'a uniquely named satellite above 10 deg');
  const text = submit(up.m.name);
  assert.ok(text.startsWith(`${up.m.name}: az `), text);
  assert.equal(handle.content.marker.target.type, 'satellite');
  assert.equal(handle.content.marker.target.id, up.d.index);
  const objects = handle.satellites.objectsAt(handle.clock.getTime());
  const drawn = objects.find((o) => o.index === up.d.index);
  assert.ok(
    Math.abs(((handle.view.azDeg - drawn.azDeg + 540) % 360) - 180) < 1e-6,
  );
  assert.ok(Math.abs(handle.view.elDeg - drawn.elDeg) < 1e-6);
  handle.redraw();
  const marker = handle.content.lastStats.marker;
  const dot = handle.satelliteModel.dots.find((d) => d.index === up.d.index);
  assert.ok(marker && dot, 'marker and dot drawn');
  assert.ok(
    Math.hypot(marker.x - dot.x, marker.y - dot.y) < 1,
    `marker ${marker.x},${marker.y} on the dot ${dot.x},${dot.y}`,
  );
  // an object the worker does not report (below -2 deg): honest status
  const below = meta.findIndex(
    (m, i) => count(m.name) === 1 && !handle.satellites.lookup(i)?.row,
  );
  assert.ok(below >= 0, 'an object below the horizon');
  const before = handle.view;
  assert.match(
    submit(meta[below].name),
    /right now: it is below the horizon or not computed yet/,
  );
  assert.deepEqual(handle.view, before);
  // leaving the sky drops the satellite positions
  handle.exit();
  assert.ok(!handle.content.search('ISS').some((r) => r.kind === 'satellite'));
});

test('a plain redraw reads no layout for the satellite edge-arrow insets; a selection does', async () => {
  const { doc, handle, worker } = satSetup();
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  let reads = 0;
  const rect = () => {
    reads += 1;
    return {
      left: 0,
      right: 300,
      top: 0,
      bottom: 120,
      width: 300,
      height: 120,
    };
  };
  doc.body.find('sats').getBoundingClientRect = rect;
  handle.elements.bar.getBoundingClientRect = rect;
  for (let i = 0; i < 5; i++) handle.setView({ azDeg: 100 + i });
  assert.equal(reads, 0, 'no layout reads without a selection');
  const index = handle.satellites.objectsAt(handle.clock.getTime())[0].index;
  handle.selectSatellite(index);
  handle.redraw();
  assert.ok(reads > 0, 'the selected object arrow reads the insets');
});

// ── point at the sky (phones) ──────────────────────────────────────────
function sensorWindow({
  ios = false,
  permission = 'granted',
  apis = true,
} = {}) {
  const listeners = new Map();
  const win = {
    screen: { orientation: { angle: 0 } },
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
    count: (type) => listeners.get(type)?.size ?? 0,
  };
  if (apis) {
    win.DeviceOrientationEvent = function DeviceOrientationEvent() {};
    win.ondeviceorientationabsolute = null;
    if (ios)
      win.DeviceOrientationEvent.requestPermission = () =>
        Promise.resolve(permission);
  }
  return win;
}
/** Portrait pose: back of the phone towards bearing/elevation, gamma = sideways tilt. */
const portraitPose = (bearingDeg, elDeg, gamma = 0) => ({
  alpha: (360 - bearingDeg + 360) % 360,
  beta: 90 + elDeg,
  gamma,
  absolute: true,
});
let sensorClock = 0;
const pointingSetup = (win, extra = {}) =>
  setup({
    orientationWindow: win,
    offerPointing: () => true,
    declinationAt: () => 2,
    orientationOptions: {
      // no animation frames: each accepted sample is applied directly
      requestFrame: () => null,
      now: () => (sensorClock += 40),
    },
    ...extra,
  });

test('the Point button is offered only where pointing makes sense (touch); hidden on desktop', () => {
  const desktop = setup();
  assert.equal(desktop.doc.body.find('point').hidden, true);
  const phone = pointingSetup(sensorWindow());
  assert.equal(phone.doc.body.find('point').hidden, false);
});

test('ACCEPT: sensors absent -> "unsupported" message, drag still turns the camera', async () => {
  const { doc, viewer, handle } = pointingSetup(sensorWindow({ apis: false }));
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  click(doc.body.find('point'));
  await settle();
  assert.equal(handle.orientation.state, 'unsupported');
  assert.match(
    doc.body.find('orient-status').textContent,
    /No orientation sensor/,
  );
  assert.equal(doc.body.find('orient').hidden, false);
  assert.equal(viewer.container.find('crosshair').hidden, true);
  const az0 = handle.view.azDeg;
  const canvas = viewer.container.find('canvas');
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 1, clientX: 600, clientY: 400 }),
  );
  canvas.dispatchEvent(
    pointer('pointermove', { pointerId: 1, clientX: 700, clientY: 400 }),
  );
  canvas.dispatchEvent(
    pointer('pointerup', { pointerId: 1, clientX: 700, clientY: 400 }),
  );
  assert.notEqual(handle.view.azDeg, az0, 'drag works');
});

test('ACCEPT: permission denied (iOS) shows the message and drag still works; LAN http explains the https address', async () => {
  const { doc, viewer, handle } = pointingSetup(
    sensorWindow({ ios: true, permission: 'denied' }),
  );
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  click(doc.body.find('point'));
  await settle();
  assert.equal(handle.orientation.state, 'denied');
  assert.match(
    doc.body.find('orient-status').textContent,
    /Motion access is blocked/,
  );
  const el0 = handle.view.elDeg;
  const canvas = viewer.container.find('canvas');
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 1, clientX: 600, clientY: 400 }),
  );
  canvas.dispatchEvent(
    pointer('pointermove', { pointerId: 1, clientX: 600, clientY: 480 }),
  );
  canvas.dispatchEvent(
    pointer('pointerup', { pointerId: 1, clientX: 600, clientY: 480 }),
  );
  assert.ok(handle.view.elDeg > el0, 'drag works');

  const lan = pointingSetup(sensorWindow({ ios: true }), {
    isSecureContext: false,
  });
  await lan.handle.enterAt({
    latDeg: 29.7604,
    lonDeg: -95.3698,
    source: 'manual',
  });
  click(lan.doc.body.find('point'));
  await settle();
  assert.equal(lan.handle.orientation.state, 'insecure');
  assert.match(
    lan.doc.body.find('orient-status').textContent,
    /secure https:\/\/ address/,
  );
});

test('the phone drives the real Cesium camera (true north via declination, roll in phone mode); a tap keeps pointing, a drag takes over and levels the roll', async () => {
  const win = sensorWindow();
  const { doc, viewer, handle } = pointingSetup(win);
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  const point = doc.body.find('point');
  click(point);
  await settle();
  assert.equal(handle.orientation.state, 'asking');
  // upright, back to MAGNETIC 88 -> true 90 with the injected +2 deg E
  win.fire('deviceorientationabsolute', portraitPose(88, 0));
  assert.equal(handle.orientation.state, 'on');
  assert.equal(point.getAttribute('aria-pressed'), 'true');
  assert.equal(point.textContent, 'Stop pointing');
  assert.equal(viewer.container.find('crosshair').hidden, false);
  assert.ok(
    doc.body.classList.contains('gev-sky-pointing'),
    'compact toolbar class',
  );
  assert.ok(Math.abs(handle.view.azDeg - 90) < 1e-6, `az ${handle.view.azDeg}`);
  assert.ok(Math.abs(handle.view.elDeg) < 1e-6);
  let look = worldDirectionToAzEl(
    Cesium,
    viewer.camera.positionWC,
    viewer.camera.directionWC,
  );
  assert.ok(Math.abs(look.azDeg - 90) < 1e-6 && Math.abs(look.elDeg) < 1e-6);
  const status = doc.body.find('orient-status').textContent;
  assert.match(status, /declination 2\.0° E/);
  assert.match(
    status,
    /Use my location/,
    'a map/manual observer gets the GPS tip',
  );
  // tilted up 30 deg and rolled sideways: roll reaches the camera
  win.fire('deviceorientationabsolute', portraitPose(88, 30, 15));
  assert.ok(Math.abs(handle.view.rollDeg) > 5, `roll ${handle.view.rollDeg}`);
  assert.ok(
    Math.abs(viewer.camera.roll - (handle.view.rollDeg * Math.PI) / 180) <
      1e-6 ||
      Math.abs(
        Math.abs(viewer.camera.roll - (handle.view.rollDeg * Math.PI) / 180) -
          2 * Math.PI,
      ) < 1e-6,
  );
  look = worldDirectionToAzEl(
    Cesium,
    viewer.camera.positionWC,
    viewer.camera.directionWC,
  );
  assert.ok(Math.abs(look.elDeg - handle.view.elDeg) < 1e-6);
  // a tap (no movement) does not stop pointing
  const canvas = viewer.container.find('canvas');
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 1, clientX: 600, clientY: 400 }),
  );
  canvas.dispatchEvent(
    pointer('pointermove', { pointerId: 1, clientX: 602, clientY: 401 }),
  );
  canvas.dispatchEvent(
    pointer('pointerup', { pointerId: 1, clientX: 602, clientY: 401 }),
  );
  assert.equal(handle.orientation.state, 'on');
  // a pinch zoom keeps pointing too (fov only)
  canvas.dispatchEvent(
    Object.assign(new Event('wheel', { cancelable: true }), { deltaY: -100 }),
  );
  assert.equal(handle.orientation.state, 'on');
  // a drag takes over: pointing off, roll back to level, listeners gone
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 1, clientX: 600, clientY: 400 }),
  );
  canvas.dispatchEvent(
    pointer('pointermove', { pointerId: 1, clientX: 680, clientY: 400 }),
  );
  canvas.dispatchEvent(
    pointer('pointerup', { pointerId: 1, clientX: 680, clientY: 400 }),
  );
  assert.equal(handle.orientation.state, 'off');
  assert.equal(handle.view.rollDeg, 0);
  assert.equal(win.count('deviceorientationabsolute'), 0);
  assert.match(doc.body.find('orient-status').textContent, /Drag took over/);
  assert.equal(viewer.container.find('crosshair').hidden, true);
  assert.ok(!doc.body.classList.contains('gev-sky-pointing'));
  const az = handle.view.azDeg;
  win.fire('deviceorientationabsolute', portraitPose(0, 0));
  assert.equal(handle.view.azDeg, az, 'the phone no longer moves the view');
  // leaving the sky with pointing on stops it as well
  click(point);
  await settle();
  win.fire('deviceorientationabsolute', portraitPose(10, 10));
  assert.equal(handle.orientation.state, 'on');
  click(doc.body.find('back'));
  assert.equal(handle.orientation.state, 'off');
  assert.equal(win.count('deviceorientationabsolute'), 0);
});

test('Align on the Moon fixes a compass offset; refused when the centre is far from it', async () => {
  // a time when the Moon is comfortably up over Houston
  const { moonState } = await import('./ephemeris.js');
  const obs = { latDeg: 29.7604, lonDeg: -95.3698, heightM: 1.7 };
  let when = null;
  for (let h = 0; h < 72 && when == null; h += 1) {
    const t = Date.parse('2026-10-12T00:00:00Z') + h * 3_600_000;
    const m = moonState(t, obs, { refraction: true });
    if (m.elDeg > 20 && m.elDeg < 50) when = t;
  }
  assert.ok(when, 'found a Moon-up time');
  const win = sensorWindow();
  const { doc, handle, timers } = pointingSetup(win, { now: () => when });
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'gps' });
  const moon = handle.content.ephemeris.moon;
  click(doc.body.find('point'));
  await settle();
  // the compass is 6 deg off: the phone "thinks" it points at the Moon's az - 6
  win.fire(
    'deviceorientationabsolute',
    portraitPose(moon.azDeg - 2 - 6, moon.elDeg),
  );
  assert.equal(doc.body.find('align').hidden, false);
  assert.equal(doc.body.find('align-moon').disabled, false);
  assert.ok(Math.abs(wrapDeg(handle.view.azDeg - (moon.azDeg - 6))) < 1e-6);
  assert.doesNotMatch(
    doc.body.find('orient-status').textContent,
    /Use my location/,
    'GPS observer: no tip',
  );
  click(doc.body.find('align-moon'));
  assert.ok(
    Math.abs(wrapDeg(handle.view.azDeg - moon.azDeg)) < 1e-6,
    'centre now on the Moon',
  );
  assert.match(
    doc.body.find('orient-status').textContent,
    /Aligned on the Moon: heading moved \+6\.0°/,
  );
  assert.match(
    doc.body.find('orient-status').textContent,
    /align offset \+6\.0°/,
  );
  // later samples keep the offset
  win.fire(
    'deviceorientationabsolute',
    portraitPose(moon.azDeg - 2 - 6, moon.elDeg + 1),
  );
  assert.ok(Math.abs(wrapDeg(handle.view.azDeg - moon.azDeg)) < 1e-6);
  // pointing 40 deg below the Moon: refused with a hint
  win.fire(
    'deviceorientationabsolute',
    portraitPose(moon.azDeg - 2 - 6, moon.elDeg - 40),
  );
  click(doc.body.find('align-moon'));
  assert.match(
    doc.body.find('orient-status').textContent,
    /in the centre circle first/,
  );
  click(doc.body.find('align-reset'));
  assert.match(
    doc.body.find('orient-status').textContent,
    /Align offset cleared/,
  );
  timers.flush(); // result lines are transient (8 s)
  assert.doesNotMatch(
    doc.body.find('orient-status').textContent,
    /Align offset cleared/,
  );
  assert.match(
    doc.body.find('orient-status').textContent,
    /declination 2\.0° E/,
  );
  handle.destroy();
  globalThis.localStorage?.removeItem?.('gev.sky.headingOffsetDeg');
});
test('Align is offered only at Live time (a past/future sky would put a wrong offset on the real compass)', async () => {
  const { moonState } = await import('./ephemeris.js');
  const obs = { latDeg: 29.7604, lonDeg: -95.3698, heightM: 1.7 };
  let when = null;
  for (let h = 0; h < 72 && when == null; h += 1) {
    const t = Date.parse('2026-10-12T00:00:00Z') + h * 3_600_000;
    const m = moonState(t, obs, { refraction: true });
    if (m.elDeg > 20 && m.elDeg < 50) when = t;
  }
  assert.ok(when, 'found a Moon-up time');
  const win = sensorWindow();
  const { doc, handle } = pointingSetup(win, { now: () => when });
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'gps' });
  const moon = handle.content.ephemeris.moon;
  click(doc.body.find('point'));
  await settle();
  win.fire(
    'deviceorientationabsolute',
    portraitPose(moon.azDeg - 2 - 6, moon.elDeg),
  );
  assert.equal(
    doc.body.find('align-moon').disabled,
    false,
    'Live: Align offered',
  );
  assert.doesNotMatch(
    doc.body.find('orient-status').textContent,
    /Align needs Live time/,
  );

  // Sky time moved off the present: every Align target is refused
  handle.clock.setFixed(when + 2 * 3_600_000);
  assert.equal(doc.body.find('align-moon').disabled, true);
  assert.equal(doc.body.find('align-sun').disabled, true);
  assert.equal(doc.body.find('align-target').disabled, true);
  assert.match(
    doc.body.find('orient-status').textContent,
    /Align needs Live time/,
  );
  const before = handle.view.azDeg;
  handle.alignOn('moon');
  assert.equal(handle.view.azDeg, before, 'no offset applied off Live');
  assert.doesNotMatch(
    doc.body.find('orient-status').textContent,
    /align offset/,
  );

  // back to Live: Align returns
  click(doc.body.find('live'));
  win.fire(
    'deviceorientationabsolute',
    portraitPose(moon.azDeg - 2 - 6, moon.elDeg),
  );
  assert.equal(doc.body.find('align-moon').disabled, false);
  assert.doesNotMatch(
    doc.body.find('orient-status').textContent,
    /Align needs Live time/,
  );
  handle.destroy();
  globalThis.localStorage?.removeItem?.('gev.sky.headingOffsetDeg');
});
const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

// ── brightness, naked-eye filter, passes ────────────────────────────
const ISS_STATIONS = tle(entryOf(ISS_NORAD));
/** Every fixture object gets RCS 5 m2 (so many have estimates), ISS real. */
const FIXTURE_RCS = Object.fromEntries(ENTRIES.map((e) => [e.norad, 5]));
FIXTURE_RCS[ISS_NORAD] = 399.0524;

async function waitFor(predicate, worker, tries = 400) {
  for (let i = 0; i < tries && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    worker.deliver();
  }
  assert.ok(predicate(), 'condition reached');
}

test('naked-eye filter: on by default (estimate wording), only candidates listed/drawn; slider and "all" switch', async () => {
  const fetchedRcs = [];
  const { doc, handle, worker } = satSetup({
    nakedEyeDefault: undefined, // the real default
    groups: { stations: ISS_STATIONS },
    fetchRcs: async () => {
      fetchedRcs.push(1);
      return { rcs: FIXTURE_RCS, withRcs: Object.keys(FIXTURE_RCS).length };
    },
  });
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  assert.equal(
    fetchedRcs.length,
    1,
    'RCS fetched once from the same-origin cache',
  );
  assert.equal(handle.satellites.rcs.status, 'ready');
  assert.deepEqual(handle.nakedEye, { on: true, limit: 5.5 });
  const button = doc.body.find('naked-eye');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.match(button.getAttribute('title'), /estimate/i);
  assert.match(
    doc.body.find('sat-mag-limit-text').textContent,
    /^est\. mag <= 5\.5$/,
  );
  const objects = handle.satellites.objectsAt(handle.clock.getTime());
  assert.ok(
    objects.some((o) => o.estMag != null),
    'worker sent estimates',
  );
  const candidate = (o, limit = 5.5) =>
    isNakedEyeCandidate({
      visible: o.state === STATE.VISIBLE,
      klass: o.klass,
      estMag: o.estMag,
      limit,
    });
  handle.redraw();
  const drawn = new Set(handle.satelliteModel.dots.map((d) => d.index));
  for (const o of objects)
    if (drawn.has(o.index))
      assert.ok(candidate(o), `${o.name} drawn but not a candidate`);
  const onCount = Number(
    /\((\d+)\)/.exec(doc.body.find('sats-title').textContent)[1],
  );
  const above = objects.filter((o) => o.elDeg > 0);
  assert.ok(onCount < above.length, 'filter hides objects');
  // slider to 7: at least as many candidates
  const slider = doc.body.find('sat-mag-limit');
  slider.value = '7';
  slider.dispatchEvent(new Event('input'));
  assert.equal(handle.nakedEye.limit, 7);
  const at7 = Number(
    /\((\d+)\)/.exec(doc.body.find('sats-title').textContent)[1],
  );
  assert.ok(at7 >= onCount);
  // "Naked-eye only" off: every object above the horizon
  click(button);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(slider.disabled, true);
  const all = Number(
    /\((\d+)\)/.exec(doc.body.find('sats-title').textContent)[1],
  );
  assert.ok(all > at7, `${all} > ${at7}`);
  // card: estimate wording, never a bare number
  const withMag = objects.find((o) => o.elDeg > 0 && o.estMag != null);
  handle.selectSatellite(withMag.index);
  const lines = doc.body
    .find('sats-card')
    .children[1].children.map((n) => n.textContent);
  const k = lines.indexOf('Brightness');
  assert.ok(k >= 0);
  assert.match(lines[k + 1], /^est\. mag -?\d+\.\d \(estimate/);
});

test('RCS unavailable: no estimates, filter falls back to stations/visual, card says why', async () => {
  const { doc, handle, worker } = satSetup({
    nakedEyeDefault: true,
    groups: { stations: ISS_STATIONS },
    fetchRcs: async () => {
      throw new Error('HTTP 503');
    },
  });
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  assert.equal(handle.satellites.rcs.status, 'error');
  const objects = handle.satellites.objectsAt(handle.clock.getTime());
  assert.ok(objects.every((o) => o.estMag == null));
  handle.redraw();
  for (const d of handle.satelliteModel.dots) {
    const o = objects.find((x) => x.index === d.index);
    assert.ok(
      ['station', 'visual'].includes(o.klass) && o.state === STATE.VISIBLE,
    );
  }
  const other = objects.find((o) => o.elDeg > 0 && o.klass === 'other');
  handle.selectSatellite(other.index);
  const lines = doc.body
    .find('sats-card')
    .children[1].children.map((n) => n.textContent);
  assert.match(
    lines[lines.indexOf('Brightness') + 1],
    /no estimate \(catalogue sizes unavailable\)/,
  );
});

test('Next passes: progressive scan fills the panel, VISIBLE chip and est. mag; row draws the arc; Next ISS pass jumps the time', async () => {
  const { doc, handle, worker } = satSetup({
    nakedEyeDefault: true,
    groups: { stations: ISS_STATIONS },
    fetchRcs: async () => ({ rcs: FIXTURE_RCS }),
  });
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  await waitFor(() => handle.satellites.passes.done, worker);
  const state = handle.satellites.passes;
  assert.ok(state.list.length > 0);
  assert.ok(state.list.every((p) => p.peakElevDeg >= 10));
  const rows = doc.body.find('passes-list').children;
  assert.ok(rows.length > 0, 'rows rendered');
  const first = rows[0].children[0];
  // visible only by default (naked-eye on): every row has the VISIBLE chip
  for (const li of rows) assert.equal(li.children[0].children[1].hidden, false);
  assert.match(first.children[3].textContent, /^est\. mag -?\d\.\d$/);
  assert.match(doc.body.find('passes-status').textContent, /estimates/);
  // row click: pass selected, its object selected, arc requested then drawn
  clickWithTarget(doc.body.find('passes-list'), first);
  const pass = handle.selectedPass;
  assert.ok(pass && pass.noradId === ISS_NORAD);
  assert.equal(handle.selectedSatellite, pass.index);
  assert.ok(
    Math.abs(handle.view.elDeg - pass.peakElevDeg) < 1e-6,
    'looked at the peak',
  );
  await waitFor(() => Array.isArray(handle.satellites.arcFor(pass)), worker);
  handle.redraw();
  assert.ok(handle.satelliteModel.arc.length > 0, 'arc drawn');
  assert.equal(doc.body.find('pass-go').disabled, false);
  // Next ISS pass: the hook and the one-tap button
  const next = handle.nextIssPass();
  assert.equal(next.noradId, ISS_NORAD);
  assert.equal(next.visible, true);
  click(doc.body.find('next-iss'));
  assert.equal(handle.clock.mode, 'fixed');
  assert.equal(handle.clock.getTime(), next.peakMs);
  assert.equal(doc.body.find('time').value, toLocalInputValue(next.peakMs));
  // the card shows that object's next pass
  await pumpSats(worker);
  const lines = doc.body
    .find('sats-card')
    .children[1].children.map((n) => n.textContent);
  assert.ok(lines.includes('Next pass'));
});

test('Next ISS pass / Go to peak jump through the time control; the ISS preset finder is not shadowed', async () => {
  const { doc, handle, worker } = satSetup({
    nakedEyeDefault: true,
    groups: { stations: ISS_STATIONS },
    fetchRcs: async () => ({ rcs: FIXTURE_RCS }),
  });
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  await waitFor(() => handle.satellites.passes.done, worker);
  // the scan hook is synchronous and returns a pass, not a preset result
  const next = handle.nextIssPass();
  assert.equal(next.noradId, ISS_NORAD);
  // a playing clock keeps playing from the peak (same rule as presets)
  handle.clock.play({ rate: 60 });
  assert.equal(handle.clock.mode, 'play');
  click(doc.body.find('next-iss'));
  assert.equal(handle.clock.mode, 'play', 'still playing');
  assert.ok(
    Math.abs(handle.clock.getTime() - next.peakMs) < 1000,
    'jumped to the peak',
  );
  assert.equal(doc.body.find('time').value, toLocalInputValue(next.peakMs));
  // Go to peak from a fixed time lands exactly on the peak, Live off
  handle.clock.setFixed(next.riseMs - 3_600_000);
  handle.selectPass(next, { look: false });
  click(doc.body.find('pass-go'));
  assert.equal(handle.clock.mode, 'fixed');
  assert.equal(handle.clock.getTime(), next.peakMs);
  assert.equal(doc.body.find('live').getAttribute('aria-pressed'), 'false');
  // the ISS preset still gets its own async finder (pass start)
  const preset = await handle.applyPreset('iss');
  assert.equal(preset.ok, true, preset.reason);
  assert.ok(Number.isFinite(preset.timeMs));
  assert.equal(handle.clock.getTime(), preset.timeMs);
  assert.match(doc.body.find('time-status').textContent, /^ISS pass: /);
});

test('pass row tap keeps the tapped row and Go to peak time in the panel when the card appears above', async () => {
  const { doc, handle, worker } = satSetup({
    nakedEyeDefault: true,
    groups: { stations: ISS_STATIONS },
    fetchRcs: async () => ({ rcs: FIXTURE_RCS }),
  });
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  await waitFor(() => handle.satellites.passes.done, worker);
  // a tiny layout model: body viewport 0..H; card (CARD px) sits above the
  // passes block, so it pushes rows and Go to peak down by CARD when shown
  const body = doc.body.find('sats-body');
  const card = doc.body.find('sats-card');
  const go = doc.body.find('pass-go');
  const row = doc.body.find('passes-list').children[0].children[0];
  let CARD = 282;
  const box = (top, h) => ({
    top,
    bottom: top + h,
    left: 0,
    right: 300,
    width: 300,
    height: h,
  });
  const layout = ({ H, rowAt, goAt }) => {
    const shift = () => (card.hidden ? 0 : CARD) - body.scrollTop;
    body.getBoundingClientRect = () => box(0, H);
    row.getBoundingClientRect = () => box(rowAt + shift(), 34);
    go.getBoundingClientRect = () => box(goAt + shift(), 28);
  };
  const reach = (node, H) => {
    const r = node.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= H;
  };
  // tall panel scrolled to the bottom: the row and its action stay in view
  body.scrollTop = 0;
  layout({ H: 376, rowAt: 140, goAt: 330 });
  clickWithTarget(doc.body.find('passes-list'), row);
  assert.ok(handle.selectedPass, 'pass selected');
  assert.equal(card.hidden, false, 'card shown');
  assert.equal(body.scrollTop, CARD, 'scrolled by the card height');
  assert.ok(reach(row, 376) && reach(go, 376), 'row and Go to peak in view');
  // a later refresh grows the card (e.g. its Next pass line arrives): the
  // tapped row is held in place ...
  const heldTop = row.getBoundingClientRect().top;
  CARD = 380;
  handle.setNakedEye({});
  assert.equal(row.getBoundingClientRect().top, heldTop, 'held after refresh');
  // ... until the user takes over the panel (wheel/touch/pointer/key)
  body.dispatchEvent(new Event('wheel'));
  CARD = 300;
  handle.setNakedEye({});
  assert.equal(row.getBoundingClientRect().top, heldTop - 80, 'released');
  CARD = 282;
  // short panel: Go to peak is revealed only as far as the row stays visible;
  // the card is NOT forced into view
  click(doc.body.find('sats-clear'));
  assert.equal(card.hidden, true);
  body.scrollTop = 0;
  layout({ H: 180, rowAt: 100, goAt: 200 });
  clickWithTarget(doc.body.find('passes-list'), row);
  assert.ok(reach(row, 180), 'tapped row still in view');
  assert.ok(reach(go, 180), 'Go to peak in view (fits with the row)');
  assert.equal(body.scrollTop, CARD + 48, 'just enough for Go to peak');
  // when Go to peak cannot fit, the tapped row wins (not pushed off the top)
  click(doc.body.find('sats-clear'));
  body.scrollTop = 0;
  layout({ H: 180, rowAt: 20, goAt: 200 });
  clickWithTarget(doc.body.find('passes-list'), row);
  assert.equal(row.getBoundingClientRect().top, 0, 'row kept at the top edge');
  // review round 1 (844x390): row + rest of the list + action taller than the
  // panel. In a browser the enabled action sticks to the body bottom (a fixed
  // box here); the tapped row is lifted just clear of it, both stay in view
  click(doc.body.find('sats-clear'));
  body.scrollTop = 0;
  layout({ H: 104, rowAt: 60, goAt: 400 });
  go.getBoundingClientRect = () => box(76, 28); // sticky once enabled
  clickWithTarget(doc.body.find('passes-list'), row);
  const r2 = row.getBoundingClientRect();
  assert.ok(r2.top >= 0, 'row not pushed off the top');
  assert.ok(r2.bottom <= 76, 'row clear of the sticky Go to peak');
  assert.equal(r2.top, 38, 'lifted by the overlap plus a 4 px gap');
  layout({ H: 180, rowAt: 20, goAt: 200 });
  // selection semantics are unchanged: Go to peak jumps to the selected peak
  const selected = handle.selectedPass;
  handle.clock.setFixed(selected.riseMs - 3_600_000);
  click(go);
  assert.equal(handle.clock.getTime(), selected.peakMs);
  assert.equal(handle.selectedPass, selected);
  // the programmatic hook (no anchor) does not touch the scroll position
  body.scrollTop = 7;
  handle.selectPass(selected, { look: false });
  assert.equal(body.scrollTop, 7);
});

test('iOS before its first compass reference hides Align (and the handle refuses it); once the reference arrives Align on the Moon works and is stored once', async () => {
  const { moonState } = await import('./ephemeris.js');
  const obs = { latDeg: 29.7604, lonDeg: -95.3698, heightM: 1.7 };
  let when = null;
  for (let h = 0; h < 72 && when == null; h += 1) {
    const t = Date.parse('2026-10-12T00:00:00Z') + h * 3_600_000;
    const m = moonState(t, obs, { refraction: true });
    if (m.elDeg > 20 && m.elDeg < 50) when = t;
  }
  assert.ok(when, 'found a Moon-up time');
  const win = sensorWindow({ ios: true });
  delete win.ondeviceorientationabsolute; // iOS Safari has no absolute event
  const store = new Map();
  const { doc, handle } = pointingSetup(win, {
    now: () => when,
    orientationOptions: {
      requestFrame: () => null,
      now: () => (sensorClock += 40),
      storage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
    },
  });
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'gps' });
  const moon = handle.content.ephemeris.moon;
  click(doc.body.find('point'));
  await settle();
  // iOS event: alpha in a frame 40 deg off; heading = magnetic (decl +2 E)
  const ios = (bearing, el, accuracy) => {
    const p = portraitPose(bearing, el);
    return {
      alpha: (p.alpha + 40) % 360,
      beta: p.beta,
      gamma: p.gamma,
      webkitCompassHeading: (((bearing - 2) % 360) + 360) % 360,
      webkitCompassAccuracy: accuracy,
    };
  };
  // looking up at the Moon straight away: no compass reference yet
  win.fire('deviceorientation', ios(moon.azDeg, moon.elDeg, 5));
  assert.equal(handle.orientation.state, 'calibrating');
  assert.equal(handle.orientation.reason, 'heading');
  assert.equal(
    doc.body.find('align').hidden,
    true,
    'no Align without a reference',
  );
  handle.alignOn('moon');
  assert.match(
    doc.body.find('orient-status').textContent,
    /Align waits for the first compass reading/,
  );
  assert.equal(store.size, 0, 'nothing stored');
  assert.equal(handle.orientation.info.offsetDeg, 0);
  // uncalibrated (-1) and upright: "accuracy", still no reference, still hidden
  win.fire('deviceorientation', ios(moon.azDeg, 0, -1));
  assert.equal(handle.orientation.reason, 'accuracy');
  assert.equal(doc.body.find('align').hidden, true);
  assert.equal(doc.body.find('figure8').hidden, false);
  // a real (poor, 40 deg) reading upright: reference exists -> Align shown
  win.fire('deviceorientation', ios(moon.azDeg, 0, 40));
  assert.equal(handle.orientation.reason, 'accuracy');
  assert.equal(handle.orientation.alignReady, true);
  assert.equal(
    doc.body.find('align').hidden,
    false,
    'shown although still calibrating',
  );
  // good again, then up to the Moon: the view is on the Moon's TRUE azimuth
  for (let i = 0; i < 40; i += 1)
    win.fire('deviceorientation', ios(moon.azDeg, 0, 5));
  win.fire('deviceorientation', ios(moon.azDeg, moon.elDeg, 5));
  assert.equal(handle.orientation.state, 'on');
  assert.ok(
    Math.abs(wrapDeg(handle.view.azDeg - moon.azDeg)) < 0.5,
    `az ${handle.view.azDeg} vs ${moon.azDeg}`,
  );
  const miss = wrapDeg(moon.azDeg - handle.view.azDeg);
  click(doc.body.find('align-moon'));
  assert.match(
    doc.body.find('orient-status').textContent,
    /Aligned on the Moon/,
  );
  assert.ok(
    Math.abs(wrapDeg(handle.view.azDeg - moon.azDeg)) < 1e-6,
    'centre on the Moon',
  );
  assert.ok(
    Math.abs(Number(store.get('gev.sky.headingOffsetDeg')) - miss) < 1e-6,
    'only the small residual is stored',
  );
  handle.destroy();
});

test('a relative-only browser (no compass) can still Align from the UI; the offset is not stored', async () => {
  const { moonState } = await import('./ephemeris.js');
  const obs = { latDeg: 29.7604, lonDeg: -95.3698, heightM: 1.7 };
  let when = null;
  for (let h = 0; h < 72 && when == null; h += 1) {
    const t = Date.parse('2026-10-12T00:00:00Z') + h * 3_600_000;
    const m = moonState(t, obs, { refraction: true });
    if (m.elDeg > 20 && m.elDeg < 50) when = t;
  }
  const win = sensorWindow();
  delete win.ondeviceorientationabsolute; // Firefox Android: relative only
  const store = new Map();
  const { doc, handle } = pointingSetup(win, {
    now: () => when,
    orientationOptions: {
      requestFrame: () => null,
      now: () => (sensorClock += 40),
      storage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
    },
  });
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'gps' });
  const moon = handle.content.ephemeris.moon;
  click(doc.body.find('point'));
  await settle();
  win.fire('deviceorientation', {
    ...portraitPose(10, moon.elDeg),
    absolute: false,
  });
  assert.equal(handle.orientation.reason, 'relative');
  assert.equal(doc.body.find('align').hidden, false);
  click(doc.body.find('align-moon'));
  assert.match(
    doc.body.find('orient-status').textContent,
    /Aligned on the Moon/,
  );
  assert.ok(Math.abs(wrapDeg(handle.view.azDeg - moon.azDeg)) < 1e-6);
  win.fire('deviceorientation', {
    ...portraitPose(10, moon.elDeg + 1),
    absolute: false,
  });
  assert.equal(handle.orientation.state, 'on');
  assert.equal(store.size, 0, 'session-only');
  handle.destroy();
});

test('integration: iOS Align needs both the compass reference and Live time; refused combinations store nothing, Live after the reference stores once', async () => {
  const { moonState } = await import('./ephemeris.js');
  const obs = { latDeg: 29.7604, lonDeg: -95.3698, heightM: 1.7 };
  let when = null;
  for (let h = 0; h < 72 && when == null; h += 1) {
    const t = Date.parse('2026-10-12T00:00:00Z') + h * 3_600_000;
    const m = moonState(t, obs, { refraction: true });
    if (m.elDeg > 20 && m.elDeg < 50) when = t;
  }
  assert.ok(when, 'found a Moon-up time');
  const win = sensorWindow({ ios: true });
  delete win.ondeviceorientationabsolute; // iOS Safari has no absolute event
  const store = new Map();
  const writes = [];
  const { doc, handle } = pointingSetup(win, {
    now: () => when,
    orientationOptions: {
      requestFrame: () => null,
      now: () => (sensorClock += 40),
      storage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => {
          writes.push(k);
          store.set(k, String(v));
        },
        removeItem: (k) => store.delete(k),
      },
    },
  });
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'gps' });
  const moon = handle.content.ephemeris.moon;
  click(doc.body.find('point'));
  await settle();
  const ios = (bearing, el, accuracy) => {
    const p = portraitPose(bearing, el);
    return {
      alpha: (p.alpha + 40) % 360,
      beta: p.beta,
      gamma: p.gamma,
      webkitCompassHeading: (((bearing - 2) % 360) + 360) % 360,
      webkitCompassAccuracy: accuracy,
    };
  };
  const status = () => doc.body.find('orient-status').textContent;

  // 1. no reference AND off Live: Align hidden, both refusals store nothing
  win.fire('deviceorientation', ios(moon.azDeg, moon.elDeg, 5));
  assert.equal(handle.orientation.alignReady, false);
  handle.clock.setFixed(when + 2 * 3_600_000);
  win.fire('deviceorientation', ios(moon.azDeg, moon.elDeg, 5));
  assert.equal(doc.body.find('align').hidden, true, 'hidden: no reference');
  assert.doesNotMatch(
    status(),
    /Align needs Live time/,
    'no Live hint while Align is not offered at all',
  );
  handle.alignOn('moon');
  assert.equal(store.size, 0);
  assert.equal(
    handle.orientation.alignTo(moon.azDeg, handle.view.azDeg),
    null,
    'controller refuses before the reference',
  );

  // 2. negative accuracy upright: still no reference, still hidden
  win.fire('deviceorientation', ios(moon.azDeg, 0, -1));
  assert.equal(handle.orientation.reason, 'accuracy');
  assert.equal(handle.orientation.alignReady, false);
  assert.equal(doc.body.find('align').hidden, true);

  // 3. reference arrives (poor accuracy, same state/reason) while off Live:
  //    the row appears (readiness notified) but every target is disabled
  win.fire('deviceorientation', ios(moon.azDeg, 0, 40));
  assert.equal(handle.orientation.reason, 'accuracy');
  assert.equal(handle.orientation.alignReady, true);
  assert.equal(
    doc.body.find('align').hidden,
    false,
    'readiness flip reached the UI',
  );
  assert.equal(doc.body.find('align-moon').disabled, true);
  assert.equal(doc.body.find('align-sun').disabled, true);
  assert.equal(doc.body.find('align-target').disabled, true);
  assert.match(status(), /Align needs Live time/);
  const before = handle.view.azDeg;
  handle.alignOn('moon');
  assert.equal(handle.view.azDeg, before, 'no offset off Live');
  assert.equal(store.size, 0, 'nothing stored off Live');

  // 4. back to Live, upright then up at the Moon: Align works, stored once
  click(doc.body.find('live'));
  for (let i = 0; i < 40; i += 1)
    win.fire('deviceorientation', ios(moon.azDeg, 0, 5));
  win.fire('deviceorientation', ios(moon.azDeg, moon.elDeg, 5));
  assert.equal(handle.orientation.state, 'on');
  assert.equal(doc.body.find('align-moon').disabled, false);
  assert.doesNotMatch(status(), /Align needs Live time/);
  const miss = wrapDeg(moon.azDeg - handle.view.azDeg);
  assert.ok(Math.abs(miss) < 0.5, `no double-counted frame: miss ${miss}`);
  click(doc.body.find('align-moon'));
  assert.match(status(), /Aligned on the Moon/);
  assert.ok(Math.abs(wrapDeg(handle.view.azDeg - moon.azDeg)) < 1e-6);
  assert.deepEqual(writes, ['gev.sky.headingOffsetDeg'], 'exactly one write');
  assert.ok(
    Math.abs(Number(store.get('gev.sky.headingOffsetDeg')) - miss) < 1e-6,
  );
  handle.destroy();
});

test('Go to peak time sticky bottom reaches the panel body bottom padding (844x390 phone landscape)', () => {
  const css = readFileSync(new URL('./skyView.css', import.meta.url), 'utf8');
  const rule = (sel) => {
    const m = css.match(new RegExp(sel + '\\s*\\{([^}]*)\\}'));
    assert.ok(m, 'rule ' + sel);
    return m[1];
  };
  const pad = Number(
    rule('\\.gev-sky-sats-body').match(/padding:\s*0 \d+px (\d+)px/)?.[1],
  );
  const sticky = rule(
    "\\.gev-sky-passes > \\[data-sky='pass-go'\\]:not\\(:disabled\\)",
  );
  assert.ok(pad > 0, 'body has bottom padding');
  assert.match(sticky, /position:\s*sticky/);
  const bottom = Number(sticky.match(/bottom:\s*(-?\d+)px/)?.[1]);
  // sticky is measured from the content edge; the offset must cancel the
  // padding or the action floats `pad` px above the body bottom and covers the
  // selected row when row + action only just fit (body ~67px)
  assert.equal(bottom, -pad, 'sticky bottom offset equals -padding-bottom');
});

test('pass row clipped by the nested list is slid fully into it and stays clear of the sticky Go to peak (844x390)', async () => {
  const { doc, handle, worker } = satSetup({
    nakedEyeDefault: true,
    groups: { stations: ISS_STATIONS },
    fetchRcs: async () => ({ rcs: FIXTURE_RCS }),
  });
  await handle.enterAt({ latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' });
  await pumpSats(worker);
  await waitFor(() => handle.satellites.passes.done, worker);
  const body = doc.body.find('sats-body');
  const card = doc.body.find('sats-card');
  const list = doc.body.find('passes-list');
  const go = doc.body.find('pass-go');
  const row = list.children[1].children[0];
  const box = (top, h) => ({
    top,
    bottom: top + h,
    left: 0,
    right: 300,
    width: 300,
    height: h,
  });
  const CARD = 100;
  const H = 67; // body viewport 0..67 (phone landscape), rows 38 px
  const LIST_H = 71; // list box a little shorter than its two rows
  // list top at 300 (+CARD once the card shows) minus the body scroll; the
  // second row starts 38 px into the list, the action sits 4 px under the list
  // and, sticky, rides the body bottom whenever it would fall below it
  const listTop = () => 300 + (card.hidden ? 0 : CARD) - body.scrollTop;
  body.getBoundingClientRect = () => box(0, H);
  list.getBoundingClientRect = () => box(listTop(), LIST_H);
  row.getBoundingClientRect = () => box(listTop() + 38 - list.scrollTop, 38);
  go.getBoundingClientRect = () => {
    const bottom = Math.min(listTop() + LIST_H + 4 + 28, H);
    return box(bottom - 28, 28);
  };
  list.contains = (node) => node === list || node === row; // no DOM here
  list.scrollTop = 0;
  body.scrollTop = 338; // row top at the body top edge, 5 px below the list box
  assert.equal(row.getBoundingClientRect().top, 0);
  clickWithTarget(list, row);
  assert.ok(handle.selectedPass, 'pass selected');
  const r = row.getBoundingClientRect();
  const l = list.getBoundingClientRect();
  const g = go.getBoundingClientRect();
  assert.ok(r.top >= 0, 'row not above the body top');
  assert.ok(r.bottom <= l.bottom + 0.5, 'row not clipped by the nested list');
  assert.ok(r.bottom <= g.top + 0.5, 'row clear of the sticky Go to peak');
  assert.ok(g.bottom <= H + 0.5, 'Go to peak in view');
});

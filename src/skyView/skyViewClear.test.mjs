import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { readFileSync } from 'node:fs';
import { mountSkyView } from './skyView.js';
import { bindApplicationShortcuts } from '../ui/applicationShortcuts.js';
import { createSatWorkerHandler } from './satWorker.js';
import {
  CLEAR_HINT_KEY,
  CLEAR_KEY,
  DIM_MS,
  DOUBLE_TAP_MS,
  clearKeyAction,
  clearNoteText,
  isDoubleTap,
  sessionStore,
} from './clearView.js';

// Clear view: only the sky. Same small fakes as skyView.test.mjs.

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

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const SAT_FIXTURE = readFileSync(
  new URL('./reference/satFixture200.tle', import.meta.url),
  'utf8',
);
class InlineSatWorker extends EventTarget {
  constructor() {
    super();
    this.outbox = [];
    this.posted = [];
    this.terminated = false;
    this.handle = createSatWorkerHandler((m) => this.outbox.push(m));
  }
  postMessage(message) {
    this.posted.push(message?.type);
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

function setup(options = {}) {
  const doc = options.document ?? fakeDocument();
  const viewer = fakeViewer(options.viewer);
  const timers = fakeTimers();
  const location = { href: 'https://gev.test/#v=2&lat=30&lon=-97' };
  const history = fakeHistory(location);
  const storage = options.storage ?? memoryStorage();
  const clock = { t: Date.parse('2026-10-12T03:30:00Z') };
  const worker = new InlineSatWorker();
  const fetched = [];
  const handle = mountSkyView({
    viewer,
    document: doc,
    timers,
    location,
    history,
    CesiumApi: SkyCesium,
    now: () => clock.t,
    showToast: () => {},
    isSecureContext: options.isSecureContext ?? true,
    createSatWorker: () => worker,
    fetchCelestrak: async (path) => {
      fetched.push(path);
      return path === 'active' ? SAT_FIXTURE : '';
    },
    fetchRcs: async () => {
      fetched.push('rcs');
      return { rcs: {} };
    },
    nakedEyeDefault: false,
    reducedMotion: () => true,
    requestFrame: () => null,
    clearStorage: storage,
    ...(options.orientationWindow
      ? {
          orientationWindow: options.orientationWindow,
          offerPointing: () => true,
          declinationAt: () => 2,
          orientationOptions: {
            requestFrame: () => null,
            now: () => (sensorClock += 40),
          },
        }
      : {}),
  });
  return {
    doc,
    viewer,
    timers,
    history,
    handle,
    storage,
    clock,
    worker,
    fetched,
  };
}

const click = (node) => node.dispatchEvent(new Event('click'));
const pointer = (type, props) => Object.assign(new Event(type), props);
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function pumpSats(worker) {
  for (let i = 0; i < 6; i++) {
    await settle();
    worker.deliver();
  }
}
const HOUSTON = { latDeg: 29.7604, lonDeg: -95.3698, source: 'manual' };

/** A key event as it reaches the document capture listener. */
function keyEvent(key, extra = {}) {
  const event = new Event('keydown', { cancelable: true });
  for (const [name, value] of Object.entries({ key, ...extra }))
    Object.defineProperty(event, name, { value });
  event.stopped = 0;
  const stop = event.stopPropagation.bind(event);
  event.stopPropagation = () => {
    event.stopped += 1;
    stop();
  };
  return event;
}

/** One tap on the sky canvas at (x, y) at clock time t. */
function tap(env, x, y, id = 1) {
  const canvas = env.viewer.container.find('canvas');
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: id, clientX: x, clientY: y }),
  );
  canvas.dispatchEvent(
    pointer('pointerup', { pointerId: id, clientX: x, clientY: y }),
  );
}

/** Everything a Clear view toggle must leave alone. */
function skyState(env) {
  const { viewer, handle, worker, fetched, history } = env;
  const cam = viewer.camera;
  return {
    view: handle.view,
    flags: JSON.stringify(handle.flags),
    position: Cesium.Cartesian3.clone(cam.position),
    direction: Cesium.Cartesian3.clone(cam.direction),
    up: Cesium.Cartesian3.clone(cam.up),
    fov: cam.frustum.fov,
    renders: viewer.scene.renders,
    drawCalls: viewer.container.find('canvas').drawCalls,
    canvasHidden: viewer.container.find('canvas').hidden,
    worker: worker.posted.length,
    fetched: fetched.length,
    urlWrites: history.writes,
    selected: handle.selectedSatellite,
  };
}
function assertSkyUnchanged(env, before, what) {
  const after = skyState(env);
  assert.equal(after.view, before.view, `${what}: same view object`);
  assert.equal(after.flags, before.flags, `${what}: flags`);
  for (const k of ['position', 'direction', 'up'])
    assert.ok(
      Cesium.Cartesian3.equals(after[k], before[k]),
      `${what}: camera ${k} unchanged`,
    );
  assert.equal(after.fov, before.fov, `${what}: fov`);
  assert.equal(
    after.renders,
    before.renders,
    `${what}: no Cesium render request`,
  );
  assert.equal(after.drawCalls, before.drawCalls, `${what}: no overlay redraw`);
  assert.equal(after.canvasHidden, false, `${what}: sky canvas shown`);
  assert.equal(after.worker, before.worker, `${what}: no worker message`);
  assert.equal(after.fetched, before.fetched, `${what}: no fetch`);
  assert.equal(after.urlWrites, before.urlWrites, `${what}: URL untouched`);
  assert.equal(after.selected, before.selected, `${what}: selection kept`);
}

/**
 * A fake document with the DOM's capture/target/bubble order for an event
 * whose target is a node inside it (node's EventTarget has no propagation, so
 * stopPropagation there would not keep the app's bubbling shortcut away):
 * document capture listeners, then the target's own listeners, then document
 * bubble listeners, each later phase skipped once propagation is stopped.
 */
function phasedDocument() {
  const doc = fakeDocument();
  const listeners = [];
  const capture = (options) =>
    options === true || Boolean(options && options.capture);
  doc.addEventListener = (type, fn, options) => {
    const entry = { type, fn, capture: capture(options) };
    if (
      !listeners.some(
        (l) => l.type === type && l.fn === fn && l.capture === entry.capture,
      )
    )
      listeners.push(entry);
  };
  doc.removeEventListener = (type, fn, options) => {
    const at = listeners.findIndex(
      (l) => l.type === type && l.fn === fn && l.capture === capture(options),
    );
    if (at >= 0) listeners.splice(at, 1);
  };
  const run = (event, phase) => {
    for (const l of listeners.filter(
      (x) => x.type === event.type && x.capture === phase,
    )) {
      l.fn(event);
      if (event.immediate) return;
    }
  };
  doc.dispatchEvent = (event) => {
    // at target on the document itself: capture listeners run first
    run(event, true);
    if (!event.stopped) run(event, false);
    return !event.defaultPrevented;
  };
  /** A key event fired at `target` (a node inside the document). */
  doc.dispatchKeyAt = (target, event) => {
    run(event, true);
    if (!event.stopped && target?.dispatchEvent) target.dispatchEvent(event);
    if (!event.stopped) run(event, false);
    return !event.defaultPrevented;
  };
  doc.keydownListeners = () =>
    listeners.filter((l) => l.type === 'keydown').length;
  return doc;
}

/** A keyboard event that counts stopPropagation/stopImmediatePropagation. */
function phasedKey(key, extra = {}) {
  const event = keyEvent(key, extra);
  const immediate = event.stopImmediatePropagation.bind(event);
  event.immediate = false;
  event.stopImmediatePropagation = () => {
    event.immediate = true;
    event.stopped += 1;
    immediate();
  };
  return event;
}

// ── pure helpers ───────────────────────────────────────────────────────────
test('clear view: double-tap, key and message helpers', () => {
  assert.equal(isDoubleTap(null, { t: 0, x: 0, y: 0 }), false);
  assert.equal(
    isDoubleTap({ t: 0, x: 10, y: 10 }, { t: 200, x: 30, y: 25 }),
    true,
  );
  assert.equal(
    isDoubleTap({ t: 0, x: 10, y: 10 }, { t: DOUBLE_TAP_MS + 1, x: 10, y: 10 }),
    false,
    'too slow',
  );
  assert.equal(
    isDoubleTap({ t: 0, x: 0, y: 0 }, { t: 100, x: 40, y: 0 }),
    false,
    'too far',
  );
  assert.equal(
    isDoubleTap({ t: 100, x: 0, y: 0 }, { t: 50, x: 0, y: 0 }),
    false,
    'clock back',
  );

  const target = { matches: () => false };
  assert.equal(clearKeyAction({ key: 'h', target }), 'toggle');
  assert.equal(clearKeyAction({ key: 'H', target }), 'toggle');
  assert.equal(clearKeyAction({ key: 'h', target, ctrlKey: true }), null);
  assert.equal(clearKeyAction({ key: 'h', target, metaKey: true }), null);
  assert.equal(
    clearKeyAction({ key: 'h', target, repeat: true }),
    'consume',
    'a held-down H repeat is ours (kept from the HUD) but does not toggle',
  );
  assert.equal(
    clearKeyAction({ key: 'H', target, repeat: true }, { clear: true }),
    'consume',
  );
  assert.equal(
    clearKeyAction({ key: 'h', target, repeat: true, ctrlKey: true }),
    null,
    'a modifier repeat is not ours',
  );
  assert.equal(
    clearKeyAction({
      key: 'h',
      repeat: true,
      target: { matches: (s) => /textarea/.test(s) },
    }),
    null,
    'a held H while typing is typing',
  );
  assert.equal(
    clearKeyAction({ key: 'ArrowLeft', target, repeat: true }),
    null,
    'other held sky keys are not Clear view keys',
  );
  assert.equal(
    clearKeyAction({ key: 'Escape', target, repeat: true }, { clear: true }),
    'restore',
  );
  assert.equal(
    clearKeyAction({ key: 'h', target, defaultPrevented: true }),
    null,
  );
  assert.equal(
    clearKeyAction({ key: 'h', target: { matches: (s) => /input/.test(s) } }),
    null,
    'typing h in a field',
  );
  assert.equal(
    clearKeyAction({ key: 'Escape', target }, { clear: true }),
    'restore',
  );
  assert.equal(
    clearKeyAction({ key: 'Escape', target }, { clear: false }),
    null,
    'Escape with controls shown still leaves the sky',
  );
  assert.equal(clearKeyAction({ key: 'n', target }), null);

  assert.equal(clearNoteText({}), '');
  assert.equal(
    clearNoteText({ hint: 'Double-tap to show controls' }),
    'Double-tap to show controls',
  );
  assert.equal(
    clearNoteText({
      note: 'Drag took over. Tap Point at the sky to follow the phone again.',
    }),
    'Drag took over. Tap Point at the sky to follow the phone again. Double-tap to show controls.',
  );
  assert.equal(clearNoteText({ note: 'a', message: 'b' }), 'a · b');

  // blocked sessionStorage falls back to memory
  const store = sessionStore({
    get sessionStorage() {
      throw new Error('SecurityError');
    },
  });
  store.setItem('k', 'v');
  assert.equal(store.getItem('k'), 'v');
});

// ── mounted ────────────────────────────────────────────────────────────────
test('clear view ACCEPT: the eye hides every control and leaves only the sky; nothing in the sky changes; the eye restores', async () => {
  const env = setup();
  const { doc, viewer, handle, storage } = env;
  const eye = doc.body.find('clear');
  assert.ok(eye, 'eye button mounted');
  assert.equal(eye.hidden, true, 'no eye on the map');
  await handle.enterAt(HOUSTON);
  await pumpSats(env.worker);
  assert.equal(eye.hidden, false, 'eye shown in the sky');
  assert.equal(eye.getAttribute('aria-pressed'), 'false');
  assert.ok(!doc.body.classList.contains('gev-sky-clear'));
  const before = skyState(env);

  click(eye);
  assert.ok(
    doc.body.classList.contains('gev-sky-clear'),
    'body.gev-sky-clear (CSS hides all chrome)',
  );
  assert.ok(doc.body.classList.contains('gev-sky-active'));
  assert.equal(eye.getAttribute('aria-pressed'), 'true');
  assert.match(eye.getAttribute('aria-label'), /Show the Sky controls/);
  assert.equal(eye.hidden, false, 'eye stays as the restore handle');
  assert.equal(handle.clearView.on, true);
  assert.equal(storage.getItem(CLEAR_KEY), '1', 'remembered for the session');
  assert.equal(
    viewer.container.find('canvas').focused,
    true,
    'keys go to the sky',
  );
  // the one-off hint is shown in the message line
  const note = doc.body.find('clear-note');
  assert.equal(note.hidden, false);
  assert.match(doc.body.find('clear-text').textContent, /show controls/);
  assertSkyUnchanged(env, before, 'enter Clear view');

  click(eye);
  assert.ok(!doc.body.classList.contains('gev-sky-clear'), 'controls back');
  assert.equal(eye.getAttribute('aria-pressed'), 'false');
  assert.equal(note.hidden, true, 'no message line with controls shown');
  assert.equal(storage.getItem(CLEAR_KEY), '0');
  assertSkyUnchanged(env, before, 'leave Clear view');
  handle.destroy();
  assert.equal(doc.body.find('clear'), null, 'destroy removes the eye');
  assert.equal(doc.body.find('clear-note'), null);
  assert.ok(!doc.body.classList.contains('gev-sky-clear'));
});

test('clear view: the restore handle fades after 3 s and any touch or key brings it back', async () => {
  const env = setup();
  const { doc, handle, timers } = env;
  await handle.enterAt(HOUSTON);
  const eye = doc.body.find('clear');
  click(eye);
  assert.equal(handle.clearView.dimmed, false);
  const dim = [...timers.pending.values()].find((t) => t.ms === DIM_MS);
  assert.ok(dim, 'a 3 s fade timer');
  dim.fn();
  assert.equal(eye.getAttribute('data-dim'), 'true', 'faded');
  doc.dispatchEvent(
    pointer('pointerdown', { pointerId: 9, clientX: 5, clientY: 5 }),
  );
  assert.equal(
    eye.getAttribute('data-dim'),
    'false',
    'a touch anywhere wakes it',
  );
  [...timers.pending.values()]
    .filter((t) => t.ms === DIM_MS)
    .at(-1)
    .fn();
  assert.equal(eye.getAttribute('data-dim'), 'true');
  doc.dispatchEvent(
    keyEvent('ArrowLeft', { target: { matches: () => false } }),
  );
  assert.equal(eye.getAttribute('data-dim'), 'false', 'a key wakes it');
  // with the controls shown it never fades
  click(eye);
  for (const t of [...timers.pending.values()].filter((x) => x.ms === DIM_MS))
    t.fn();
  assert.equal(eye.getAttribute('data-dim'), 'false');
});

test('clear view: H toggles and Escape restores (capture phase, the app H = HUD shortcut does not also fire); Escape with controls still leaves', async () => {
  const env = setup();
  const { doc, handle } = env;
  await handle.enterAt(HOUSTON);
  const before = skyState(env);
  const sky = { matches: () => false };
  let h = keyEvent('h', { target: sky });
  doc.dispatchEvent(h);
  assert.equal(handle.clearView.on, true, 'H: clear');
  assert.equal(h.defaultPrevented, true);
  assert.ok(
    h.stopped > 0,
    'propagation stopped: the shell shortcut never sees H',
  );
  h = keyEvent('H', { target: sky });
  doc.dispatchEvent(h);
  assert.equal(handle.clearView.on, false, 'H again: controls back');
  doc.dispatchEvent(keyEvent('h', { target: sky }));
  assert.equal(handle.clearView.on, true);
  const esc = keyEvent('Escape', { target: sky });
  doc.dispatchEvent(esc);
  assert.equal(handle.clearView.on, false, 'Escape restores');
  assert.equal(handle.active, true, '...and stays in the sky');
  assert.ok(esc.stopped > 0, 'the canvas Escape (leave the sky) does not run');
  assertSkyUnchanged(env, before, 'keys');
  // typing H in the search box is just typing
  const typed = keyEvent('h', { target: { matches: (s) => /input/.test(s) } });
  doc.dispatchEvent(typed);
  assert.equal(handle.clearView.on, false);
  assert.equal(typed.stopped, 0);
  // Escape with the controls shown is not ours (the canvas key leaves the sky)
  const leave = keyEvent('Escape', { target: sky });
  doc.dispatchEvent(leave);
  assert.equal(leave.stopped, 0);
  // off the sky, H is the app's again
  handle.exit();
  const map = keyEvent('h', { target: sky });
  doc.dispatchEvent(map);
  assert.equal(map.stopped, 0);
  assert.equal(handle.clearView.on, false);
});

test('clear view R1: holding H in the sky toggles Clear view once and never reaches the real app H = HUD shortcut; HUD state is unchanged; off the sky H is the HUD again', async () => {
  const doc = phasedDocument();
  const env = setup({ document: doc });
  const { handle, viewer } = env;
  // the real shell shortcut handler, bound after the Sky view like the app
  // (both on the document: the Sky view in capture, the shell bubbling)
  let hudVisible = true;
  let hudToggles = 0;
  const shellCalls = [];
  const search = new FakeElement('input');
  search.matches = (sel) => /input/.test(sel);
  const shortcuts = bindApplicationShortcuts({
    documentRef: doc,
    searchInput: search,
    actions: {
      setStyle: (style) => shellCalls.push(`style:${style}`),
      dismissSearch: () => shellCalls.push('dismissSearch'),
      toggleHud: () => {
        hudToggles += 1;
        hudVisible = !hudVisible;
      },
      toggleOrbit: () => shellCalls.push('orbit'),
      toggleCleanView: () => shellCalls.push('cleanView'),
      toggleLayers: () => shellCalls.push('layers'),
      cycleDetection: () => shellCalls.push('detection'),
      toggleCctv: () => shellCalls.push('cctv'),
    },
  });
  await handle.enterAt(HOUSTON);
  const canvas = viewer.container.find('canvas'); // the Sky key surface
  canvas.matches = () => false;
  const hud0 = hudVisible;
  const before = skyState(env);
  const press = (key, extra = {}) => {
    const event = phasedKey(key, { target: canvas, ...extra });
    doc.dispatchKeyAt(canvas, event);
    return event;
  };

  // hold H: one initial keydown, then autorepeat keydowns
  const first = press('h');
  assert.equal(handle.clearView.on, true, 'initial H: clear');
  assert.ok(first.stopped > 0 && first.defaultPrevented);
  assert.equal(hudToggles, 0, 'initial H: HUD untouched');
  for (let i = 1; i <= 5; i++) {
    const repeat = press('h', { repeat: true });
    assert.equal(handle.clearView.on, true, `repeat ${i}: still clear`);
    assert.ok(repeat.stopped > 0, `repeat ${i}: stopped in the Sky view`);
    assert.equal(repeat.defaultPrevented, true, `repeat ${i}: consumed`);
    assert.equal(hudToggles, 0, `repeat ${i}: HUD untouched`);
  }
  assert.equal(hudVisible, hud0, 'HUD state is where it was');
  // release, then hold H again: controls back once, HUD still untouched
  press('H');
  for (let i = 0; i < 3; i++) press('H', { repeat: true });
  assert.equal(handle.clearView.on, false, 'second hold: controls back');
  assert.equal(hudToggles, 0, 'second hold: HUD untouched');
  assert.equal(hudVisible, hud0);
  assertSkyUnchanged(env, before, 'held H');
  // a held arrow (a Sky key) is not taken by Clear view and still turns
  const az0 = handle.view.azDeg;
  const arrow = press('ArrowRight', { repeat: true });
  assert.equal(arrow.defaultPrevented, true, 'Sky arrow key handled');
  assert.notEqual(handle.view.azDeg, az0, 'held arrow still turns the sky');
  // Escape while clear restores and stays in the sky
  press('h');
  const esc = press('Escape');
  assert.equal(handle.clearView.on, false, 'Escape restores');
  assert.equal(handle.active, true, '...and stays in the sky');
  assert.ok(esc.stopped > 0);
  assert.deepEqual(shellCalls, [], 'no shell shortcut ran inside the sky');
  assert.equal(hudToggles, 0);
  // Ctrl+H is not a Clear view key (modifier handling is the shell's)
  const ctrl = press('h', { ctrlKey: true });
  assert.equal(ctrl.stopped, 0, 'Ctrl+H not taken by the Sky view');
  assert.equal(handle.clearView.on, false);
  assert.equal(hudToggles, 1, 'Ctrl+H reaches the shell as before');
  press('h', { ctrlKey: true });
  assert.equal(hudVisible, hud0);
  hudToggles = 0;
  // holding H while typing in the search box is just typing
  const typedFirst = phasedKey('h', { target: search });
  doc.dispatchKeyAt(search, typedFirst);
  const typedRepeat = phasedKey('h', { target: search, repeat: true });
  doc.dispatchKeyAt(search, typedRepeat);
  assert.equal(typedFirst.stopped + typedRepeat.stopped, 0);
  assert.equal(typedRepeat.defaultPrevented, false, 'the field gets the key');
  assert.equal(handle.clearView.on, false);
  assert.equal(hudToggles, 0, 'the shell ignores typing too');

  // off the sky, H is the app HUD key again, repeats included (unchanged)
  handle.exit();
  const map = press('h');
  assert.equal(map.stopped, 0);
  assert.equal(hudToggles, 1, 'H toggles the HUD outside the sky');
  press('h', { repeat: true });
  assert.equal(hudToggles, 2, "outside the sky a repeat is the shell's");
  assert.equal(hudVisible, hud0, 'HUD restored after two toggles');
  assert.equal(handle.clearView.on, false);

  shortcuts.destroy();
  handle.destroy?.();
});

test('clear view: double-tap on the sky toggles; single taps, slow taps, drags and pinches do not; the first tap selection is undone', async () => {
  const env = setup();
  const { doc, handle, clock, worker } = env;
  await handle.enterAt(HOUSTON);
  await pumpSats(worker);
  const before = skyState(env);
  tap(env, 600, 400);
  assert.equal(handle.clearView.on, false, 'one tap: nothing');
  clock.t += 200;
  tap(env, 610, 405);
  assert.equal(handle.clearView.on, true, 'double-tap: clear');
  assertSkyUnchanged(env, before, 'double-tap on');
  clock.t += 1000;
  tap(env, 600, 400);
  clock.t += 200;
  tap(env, 600, 400);
  assert.equal(handle.clearView.on, false, 'double-tap again: controls back');
  // slow second tap
  clock.t += 1000;
  tap(env, 600, 400);
  clock.t += DOUBLE_TAP_MS + 50;
  tap(env, 600, 400);
  assert.equal(handle.clearView.on, false, 'slow taps are two taps');
  // tap, drag, tap: no toggle (and the drag moved the view)
  clock.t += 1000;
  tap(env, 600, 400);
  const canvas = env.viewer.container.find('canvas');
  clock.t += 50;
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 2, clientX: 600, clientY: 400 }),
  );
  canvas.dispatchEvent(
    pointer('pointermove', { pointerId: 2, clientX: 680, clientY: 400 }),
  );
  canvas.dispatchEvent(
    pointer('pointerup', { pointerId: 2, clientX: 680, clientY: 400 }),
  );
  clock.t += 50;
  tap(env, 600, 400);
  assert.equal(handle.clearView.on, false, 'a drag in between: no double-tap');
  // pinch: two pointers then lift both
  clock.t += 1000;
  tap(env, 600, 400);
  clock.t += 50;
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 3, clientX: 600, clientY: 400 }),
  );
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 4, clientX: 700, clientY: 400 }),
  );
  canvas.dispatchEvent(
    pointer('pointerup', { pointerId: 3, clientX: 600, clientY: 400 }),
  );
  canvas.dispatchEvent(
    pointer('pointerup', { pointerId: 4, clientX: 700, clientY: 400 }),
  );
  clock.t += 50;
  tap(env, 600, 400);
  assert.equal(handle.clearView.on, false, 'a pinch is no double-tap');

  // a double-tap on a satellite toggles and leaves the selection as it was
  handle.selectSatellite(null);
  handle.redraw();
  const dot = handle.satelliteModel?.dots?.[0];
  assert.ok(dot, 'a satellite dot on screen');
  clock.t += 1000;
  tap(env, dot.x, dot.y);
  assert.equal(
    handle.selectedSatellite,
    dot.index,
    'single tap selects (unchanged)',
  );
  clock.t += 150;
  tap(env, dot.x, dot.y);
  assert.equal(handle.clearView.on, true);
  assert.equal(handle.selectedSatellite, null, 'first tap undone');
  assert.equal(doc.body.find('sats-card').hidden, true);
});

test('clear view: remembered for the session; leaving the sky brings the controls back; the next entry is clear again', async () => {
  const storage = memoryStorage();
  const env = setup({ storage });
  const { doc, handle } = env;
  await handle.enterAt(HOUSTON);
  click(doc.body.find('clear'));
  handle.exit();
  assert.ok(!doc.body.classList.contains('gev-sky-clear'), 'map: chrome back');
  assert.equal(doc.body.find('clear').hidden, true, 'no eye on the map');
  assert.equal(handle.clearView.on, false);
  await handle.enterAt(HOUSTON);
  assert.ok(
    doc.body.classList.contains('gev-sky-clear'),
    're-entry: clear again',
  );
  handle.destroy();
  // a new mount in the same session (reload) starts clear in the sky
  const again = setup({ storage });
  assert.ok(!again.doc.body.classList.contains('gev-sky-clear'));
  await again.handle.enterAt(HOUSTON);
  assert.equal(again.handle.clearView.on, true);
  assert.equal(
    again.doc.body.find('clear-note').hidden,
    true,
    'the hint was already shown once this session',
  );
  // a fresh session starts with controls
  const fresh = setup();
  await fresh.handle.enterAt(HOUSTON);
  assert.equal(fresh.handle.clearView.on, false);
});

// ── pointing ────────────────────────────────────────────────────────────
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
const portraitPose = (bearingDeg, elDeg, gamma = 0) => ({
  alpha: (360 - bearingDeg + 360) % 360,
  beta: 90 + elDeg,
  gamma,
  absolute: true,
});
let sensorClock = 0;

test('clear view: pointing on a phone enters Clear view once the phone leads, with the hint once; the view still follows the phone', async () => {
  const win = sensorWindow();
  const env = setup({ orientationWindow: win });
  const { doc, handle, storage, timers } = env;
  await handle.enterAt(HOUSTON);
  click(doc.body.find('point'));
  await settle();
  assert.equal(handle.orientation.state, 'asking');
  assert.equal(handle.clearView.on, false, 'not before the phone leads');
  assert.equal(handle.clearView.autoArmed, true);
  win.fire('deviceorientationabsolute', portraitPose(88, 20));
  assert.equal(handle.orientation.state, 'on');
  assert.equal(handle.clearView.on, true, 'auto Clear view');
  assert.equal(
    doc.body.find('clear-text').textContent,
    'Double-tap to show controls',
  );
  assert.equal(storage.getItem(CLEAR_HINT_KEY), '1');
  assert.equal(
    env.viewer.container.find('crosshair').hidden,
    false,
    'centre circle kept',
  );
  // the phone still drives the view in Clear view
  win.fire('deviceorientationabsolute', portraitPose(178, 30));
  assert.ok(
    Math.abs(handle.view.azDeg - 180) < 1e-6,
    `az ${handle.view.azDeg}`,
  );
  // the hint goes away; the 'on' guidance is not shown over the sky
  [...timers.pending.values()].find((t) => t.ms === 5000).fn();
  assert.equal(doc.body.find('clear-note').hidden, true);
  // the user brings the controls back: no auto Clear view for the rest of the session
  click(doc.body.find('clear'));
  assert.equal(storage.getItem(CLEAR_KEY), '0');
  click(doc.body.find('point')); // stop
  click(doc.body.find('point')); // start again
  await settle();
  win.fire('deviceorientationabsolute', portraitPose(88, 20));
  assert.equal(handle.orientation.state, 'on');
  assert.equal(handle.clearView.on, false, 'user choice wins over auto');
});

test('clear view ACCEPT: denied, insecure and unsupported messages stay visible over the clear sky; a drag note says how to get the controls', async () => {
  const denied = setup({
    orientationWindow: sensorWindow({ ios: true, permission: 'denied' }),
  });
  await denied.handle.enterAt(HOUSTON);
  click(denied.doc.body.find('clear'));
  click(denied.doc.body.find('point'));
  await settle();
  assert.equal(denied.handle.orientation.state, 'denied');
  assert.equal(denied.handle.clearView.on, true, 'no auto change; still clear');
  // the hint has gone
  [...denied.timers.pending.values()]
    .filter((t) => t.ms === 5000)
    .forEach((t) => t.fn());
  assert.equal(denied.doc.body.find('clear-note').hidden, false);
  assert.match(
    denied.doc.body.find('clear-text').textContent,
    /Motion access is blocked/,
  );

  const lan = setup({
    orientationWindow: sensorWindow({ ios: true }),
    isSecureContext: false,
  });
  await lan.handle.enterAt(HOUSTON);
  click(lan.doc.body.find('point'));
  await settle();
  assert.equal(lan.handle.orientation.state, 'insecure');
  assert.equal(
    lan.handle.clearView.on,
    false,
    'no auto Clear view when pointing failed',
  );
  assert.equal(lan.handle.clearView.autoArmed, false);
  click(lan.doc.body.find('clear'));
  assert.match(
    lan.doc.body.find('clear-text').textContent,
    /secure https:\/\/ address/,
  );

  const none = setup({ orientationWindow: sensorWindow({ apis: false }) });
  await none.handle.enterAt(HOUSTON);
  click(none.doc.body.find('clear'));
  click(none.doc.body.find('point'));
  await settle();
  assert.equal(none.handle.orientation.state, 'unsupported');
  assert.match(
    none.doc.body.find('clear-text').textContent,
    /No orientation sensor/,
  );

  // pointing on in Clear view, then a drag takes over: the note says double-tap
  const win = sensorWindow();
  const env = setup({ orientationWindow: win });
  await env.handle.enterAt(HOUSTON);
  click(env.doc.body.find('point'));
  await settle();
  win.fire('deviceorientationabsolute', portraitPose(88, 20));
  assert.equal(env.handle.clearView.on, true);
  [...env.timers.pending.values()]
    .filter((t) => t.ms === 5000)
    .forEach((t) => t.fn()); // the one-off hint is over
  const canvas = env.viewer.container.find('canvas');
  canvas.dispatchEvent(
    pointer('pointerdown', { pointerId: 1, clientX: 600, clientY: 400 }),
  );
  canvas.dispatchEvent(
    pointer('pointermove', { pointerId: 1, clientX: 680, clientY: 400 }),
  );
  canvas.dispatchEvent(
    pointer('pointerup', { pointerId: 1, clientX: 680, clientY: 400 }),
  );
  assert.equal(env.handle.orientation.state, 'off');
  assert.equal(env.handle.clearView.on, true, 'a drag keeps Clear view');
  assert.match(
    env.doc.body.find('clear-text').textContent,
    /Drag took over.*Double-tap to show controls/,
  );
});

test('clear view: calibration figure 8 is shown over the clear sky while the compass needs it', async () => {
  const win = sensorWindow({ ios: true });
  delete win.ondeviceorientationabsolute; // Safari: plain deviceorientation
  const env = setup({ orientationWindow: win });
  await env.handle.enterAt(HOUSTON);
  click(env.doc.body.find('clear'));
  click(env.doc.body.find('point'));
  await settle();
  // iOS: upright portrait gives the compass reference; poor accuracy -> figure 8
  for (let i = 0; i < 5; i += 1) {
    win.fire('deviceorientation', {
      ...portraitPose(90, 0),
      absolute: false,
      webkitCompassHeading: 90,
      webkitCompassAccuracy: 60,
    });
    await settle();
  }
  assert.equal(env.handle.orientation.state, 'calibrating');
  assert.equal(env.handle.orientation.reason, 'accuracy');
  assert.equal(env.doc.body.find('clear-figure8').hidden, false);
  assert.match(env.doc.body.find('clear-text').textContent, /figure 8/);
});

test('clear view attribution: body.gev-sky-tiles while map tiles are drawn (real horizon), off with the flat horizon and when leaving the sky; the view does not move', async () => {
  const env = setup();
  const { doc, handle } = env;
  const tiles = () => doc.body.classList.contains('gev-sky-tiles');
  assert.equal(tiles(), false, 'not on the map');
  await handle.enterAt(HOUSTON);
  await pumpSats(env.worker);
  assert.equal(tiles(), true, 'real horizon: the globe (tiles) is drawn');
  click(doc.body.find('clear'));
  assert.ok(doc.body.classList.contains('gev-sky-clear'));
  const before = skyState(env);
  assert.equal(tiles(), true, 'still drawn in Clear view');
  click(doc.body.find('flat'));
  assert.equal(env.viewer.scene.globe.show, false);
  assert.equal(tiles(), false, 'flat horizon: only the sky is drawn');
  click(doc.body.find('flat'));
  assert.equal(env.viewer.scene.globe.show, true);
  assert.equal(tiles(), true);
  // the flag follows the scene; the camera and the view do not move
  const after = skyState(env);
  assert.equal(after.view, before.view, 'same view');
  for (const k of ['position', 'direction', 'up'])
    assert.ok(Cesium.Cartesian3.equals(after[k], before[k]), `camera ${k}`);
  handle.exit();
  assert.equal(tiles(), false, 'left the sky');
  // a map that already had its globe off and no tilesets: nothing to credit
  env.viewer.scene.globe.show = false;
  await handle.enterAt(HOUSTON);
  assert.equal(tiles(), false, 'globe off before entering');
  handle.destroy();
  assert.equal(tiles(), false);
});

test('clear view CSS: the attribution stays complete while tiles are drawn: wraps (never clipped or ellipsised), tap-through, bottom-left, safe-area aware, under the eye, placed by the app credit rules; the NAIP slider is not in the sky ()', () => {
  const css = readFileSync(new URL('./skyView.css', import.meta.url), 'utf8');
  const flat = css.replace(/\s+/g, ' ');
  assert.match(
    flat,
    /body\.gev-sky-active\.gev-sky-clear\.gev-sky-tiles :is\(#cesium-credits, #cesium-credits \*\) \{ visibility: visible !important; \}/,
    'shown only with body.gev-sky-tiles',
  );
  const rule = flat.match(
    /body\.gev-sky-active\.gev-sky-clear #cesium-credits \{([^}]*)\}/,
  );
  assert.ok(rule, 'Clear view credit placement');
  const body = rule[1];
  assert.match(body, /pointer-events: none !important/, 'tap-through');
  assert.match(body, /left: max\(0\.75rem, calc\(env\(safe-area-inset-left/);
  // vertical placement stays with the app's credit rules (bottom-left,
  // above the dock / compass strip): the attribution pin models every
  // position/top/bottom rule on #cesium-credits and fails closed on new ones
  assert.doesNotMatch(
    body,
    /(^|;)\s*(position|top|bottom|height|transform)\s*:/,
  );
  assert.doesNotMatch(body, /opacity/, 'not faded (attribution pin)');
  // the line itself is Cesium's .cesium-widget-credits (absolutely placed
  // in the 0x0 #cesium-credits box): never clip the container
  assert.doesNotMatch(body, /overflow/, 'container not clipped (0x0 box)');
  const line = flat.match(
    /body\.gev-sky-active\.gev-sky-clear #cesium-credits \.cesium-widget-credits \{([^}]*)\}/,
  );
  assert.ok(line, 'the credit line in Clear view');
  // complete attribution (review R1): every credit stays readable in full,
  // so the line wraps inside the corner instead of being cut off
  assert.match(line[1], /white-space: normal !important/, 'wraps');
  assert.match(line[1], /overflow: visible !important/, 'never clipped');
  assert.match(line[1], /overflow-wrap: anywhere !important/);
  assert.match(line[1], /text-overflow: clip !important/);
  // the 0x0 #cesium-credits box would shrink it to one word per row
  assert.match(line[1], /width: max-content !important/);
  // room for the eye (44 px at 12 px from the right edge) on the same row
  assert.match(line[1], /max-width: calc\( 100vw - 80px/);
  const inner = flat.match(
    /body\.gev-sky-active\.gev-sky-clear #cesium-credits \.cesium-widget-credits \* \{([^}]*)\}/,
  );
  assert.ok(inner, 'every credit inside the line wraps too');
  assert.match(inner[1], /white-space: normal !important/);
  // nothing in this file truncates, clips or ellipsises a credit
  const creditRules = [
    ...flat.matchAll(
      /([^{}]*(?:#cesium-credits|cesium-credit)[^{}]*)\{([^}]*)\}/g,
    ),
  ];
  assert.ok(creditRules.length >= 5);
  for (const [, sel, decls] of creditRules) {
    assert.doesNotMatch(decls, /nowrap/, `${sel}: no single-line cap`);
    assert.doesNotMatch(decls, /ellipsis/, `${sel}: no ellipsis`);
    assert.doesNotMatch(
      decls,
      /(^|[ ;])overflow(-x|-y)?: (hidden|clip|scroll|auto)/,
      `${sel}: not clipped`,
    );
    assert.doesNotMatch(
      decls,
      /(display: none|visibility: hidden)/,
      `${sel}: not hidden`,
    );
  }
  // the credits Cesium lists only behind "Data attribution" stay reachable:
  // the link keeps working (only while the credits are shown) and its list
  // is shown over the clear sky
  assert.match(
    flat,
    /body\.gev-sky-active\.gev-sky-clear\.gev-sky-tiles #cesium-credits \.cesium-credit-expand-link \{ pointer-events: auto !important;/,
  );
  assert.match(
    flat,
    /body\.gev-sky-active\.gev-sky-clear :is\(\.cesium-credit-lightbox-overlay, \.cesium-credit-lightbox-overlay \*\) \{ visibility: visible !important; \}/,
  );
  const z = Number(body.match(/z-index: (\d+)/)[1]);
  assert.ok(z > 96 && z < 99, 'over the sky (96), under the eye (99)');
  assert.match(
    flat,
    /body\.gev-sky-active\.gev-sky-clear #cesium-credits \* \{ pointer-events: none !important; \}/,
  );
  assert.match(
    flat,
    /body\.gev-sky-active :is\(#gev-naip-slider, #gev-naip-split-line\) \{ display: none !important; \}/,
  );
});

test('clear view CSS: everything hidden by visibility (no reflow), only the sky canvases, centre circle, eye and message shown; safe-area insets', () => {
  const css = readFileSync(new URL('./skyView.css', import.meta.url), 'utf8');
  const flat = css.replace(/\s+/g, ' ');
  assert.match(
    flat,
    /body\.gev-sky-active\.gev-sky-clear, body\.gev-sky-active\.gev-sky-clear \* \{ visibility: hidden !important;[^}]*transition-property: none !important; \}/,
    'everything hidden at once (no visibility fade)',
  );
  const shown = flat.match(
    /body\.gev-sky-active\.gev-sky-clear :is\(([^)]*)\) \{ visibility: visible !important; \}/,
  );
  assert.ok(shown, 'the visible list');
  const list = shown[1].split(',').map((s) => s.trim());
  assert.deepEqual(list, [
    '.cesium-widget > canvas',
    '.gev-sky-canvas',
    '.gev-sky-crosshair',
    '.gev-sky-clear-btn',
    '.gev-sky-clear-btn *',
    '.gev-sky-clear-note',
    '.gev-sky-clear-note *',
  ]);
  assert.match(flat, /\.gev-sky-clear-btn \{[^}]*env\(safe-area-inset-right/);
  assert.match(flat, /\.gev-sky-clear-btn \{[^}]*env\(safe-area-inset-bottom/);
  assert.match(flat, /\.gev-sky-clear-note \{[^}]*env\(safe-area-inset-top/);
  assert.match(
    flat,
    /\.gev-sky-clear-btn\[data-dim='true'\] \{ opacity: 0\.2; \}/,
  );
  assert.match(
    flat,
    /\.gev-sky-clear-btn \{[^}]*width: 44px; height: 44px;/,
    '44 px target',
  );
});

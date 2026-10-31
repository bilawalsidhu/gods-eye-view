import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { readFileSync } from 'node:fs';
import { mountSkyView } from './skyView.js';
import { parseBoundaries, parseSkyData } from './starData.js';

const read = (name) =>
  JSON.parse(readFileSync(new URL(`./data/${name}`, import.meta.url)));
const DATA = parseSkyData(read('stars.json'), read('constellations.json'));
const EDGES = parseBoundaries(read('boundaries.json'));

// ── a very small DOM (same fakes as skyView.test.mjs) ───────────────────────────────────────────────────────
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
    this.checked = false;
    this.disabled = false;
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

// ── harness: controllable wall clock, frames and intervals ──────────────
FakeElement.prototype.replaceChildren = function replaceChildren() {
  for (const child of this.children) child.parentNode = null;
  this.children.length = 0;
};
import { Refraction } from 'astronomy-engine';
import { createSatWorkerHandler } from './satWorker.js';
import { bodyPosition } from './ephemeris.js';
import { toLocalInputValue } from './skyTimeControl.js';

const NOW = Date.parse('2026-10-12T03:30:00Z');
const HOUSTON = { latDeg: 29.7604, lonDeg: -95.3698 };
const SAT_FIXTURE = readFileSync(
  new URL('./reference/satFixture200.tle', import.meta.url),
  'utf8',
);

class InlineSatWorker extends EventTarget {
  constructor() {
    super();
    this.outbox = [];
    this.terminated = false;
    this.ticks = 0;
    this.handle = createSatWorkerHandler((m) => this.outbox.push(m));
  }
  postMessage(message) {
    if (message.type === 'tick') this.ticks += 1;
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

function frameQueue() {
  let id = 1;
  const queue = new Map();
  return {
    request: (fn) => {
      queue.set(id, fn);
      return id++;
    },
    cancel: (handle) => queue.delete(handle),
    run() {
      const due = [...queue];
      queue.clear();
      for (const [, fn] of due) fn();
    },
    get size() {
      return queue.size;
    },
  };
}

function runIntervals(timers) {
  for (const timer of [...timers.pending.values()]) if (timer.every) timer.fn();
}

function setup(options = {}) {
  const doc = fakeDocument();
  const viewer = fakeViewer(options.viewer);
  const timers = fakeTimers();
  const location = {
    href: options.href || 'https://gev.test/#v=2&lat=30&lon=-97',
  };
  const history = fakeHistory(location);
  const wall = { t: NOW };
  const frames = frameQueue();
  const worker = options.worker ?? null;
  const fetched = [];
  const handle = mountSkyView({
    viewer,
    document: doc,
    timers,
    location,
    history,
    CesiumApi: SkyCesium,
    now: () => wall.t,
    requestFrame: frames.request,
    cancelFrame: frames.cancel,
    reducedMotion: () => true,
    createSatWorker: worker ? () => worker : () => null,
    fetchCelestrak: async (path) => {
      fetched.push(path);
      if (options.fetchFails) throw new Error('HTTP 503');
      return path === 'active' || path === 'stations' ? SAT_FIXTURE : '';
    },
    skyContentOptions: {
      loadData: () => DATA,
      loadBoundaryData: () => EDGES,
      createCanvas: () => null,
      reducedMotion: () => true,
    },
  });
  return {
    doc,
    viewer,
    timers,
    location,
    history,
    handle,
    wall,
    frames,
    worker,
    fetched,
  };
}

const click = (node, props = {}) =>
  node.dispatchEvent(Object.assign(new Event('click'), props));
const key = (node, k, props = {}) =>
  node.dispatchEvent(Object.assign(new Event('keydown'), { key: k, ...props }));
const settle = () => new Promise((resolve) => setImmediate(resolve));
const viewerMs = (viewer) =>
  Cesium.JulianDate.toDate(viewer.clock.currentTime).getTime();
async function pump(worker) {
  for (let i = 0; i < 6; i++) {
    await settle();
    worker?.deliver();
  }
}
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

test('time control: fixed time set through the handle shows in the picker and Live is released', async () => {
  const { doc, handle, viewer } = setup();
  await handle.enterAt({
    ...HOUSTON,
    heightM: 15,
    heightKnown: true,
    source: 'manual',
  });
  assert.equal(doc.body.find('live').getAttribute('aria-pressed'), 'true');
  const T = Date.parse('2026-12-01T03:00:00Z');
  handle.clock.setFixed(T);
  assert.equal(doc.body.find('time').value, toLocalInputValue(T));
  assert.equal(doc.body.find('live').getAttribute('aria-pressed'), 'false');
  assert.equal(viewerMs(viewer), T);
  assert.equal(handle.content.ephemeris.ms, T, 'ephemeris reads the same time');
  click(doc.body.find('live'));
  assert.equal(handle.clock.mode, 'live');
  assert.equal(viewerMs(viewer), NOW);
});

test('play/pause, speed, reverse, step buttons and sky keys drive the single clock; viewer.clock, ephemeris and worker ticks follow it', async () => {
  const worker = new InlineSatWorker();
  const env = setup({ worker });
  const { doc, handle, viewer, wall, frames, timers } = env;
  await handle.enterAt({
    ...HOUSTON,
    heightM: 15,
    heightKnown: true,
    source: 'manual',
  });
  await pump(worker);
  const T = Date.parse('2026-10-11T18:00:00Z');
  handle.clock.setFixed(T);
  const rate = doc.body.find('rate');
  rate.value = '3600';
  rate.dispatchEvent(new Event('change'));
  assert.equal(handle.clock.rate, 3600);
  click(doc.body.find('play'));
  assert.equal(handle.clock.mode, 'play');
  assert.equal(doc.body.find('play').getAttribute('aria-pressed'), 'true');
  assert.equal(doc.body.find('play').textContent, '❚❚ Pause');
  assert.equal(handle.satellites.tickMs, 250, 'fast ticks while playing fast');
  wall.t += 1000;
  frames.run();
  assert.equal(viewerMs(viewer), T + 3600_000);
  assert.equal(handle.content.ephemeris.ms, T + 3600_000);
  runIntervals(timers); // satellite timer tick at the same Sky time
  await pump(worker);
  assert.equal(handle.satellites.stats.timeMs, T + 3600_000);
  // reverse keeps the time continuous and runs backwards
  click(doc.body.find('reverse'));
  assert.equal(handle.clock.rate, -3600);
  assert.equal(doc.body.find('reverse').getAttribute('aria-pressed'), 'true');
  wall.t += 500;
  frames.run();
  assert.equal(viewerMs(viewer), T + 1800_000);
  // Space pauses, ] steps a minute, Shift+[ steps back an hour
  const canvas = doc.body.find('canvas') ?? env.viewer.container.find('canvas');
  key(canvas, ' ');
  assert.equal(handle.clock.mode, 'fixed');
  assert.equal(handle.satellites.tickMs, 1000);
  key(canvas, ']');
  assert.equal(handle.clock.getTime(), T + 1800_000 + 60_000);
  key(canvas, '[', { shiftKey: true });
  assert.equal(handle.clock.getTime(), T + 1800_000 + 60_000 - 3600_000);
  click(doc.body.find('step-fwd'), { shiftKey: true });
  click(doc.body.find('step-back'));
  assert.equal(handle.clock.getTime(), T + 1800_000);
  assert.equal(viewerMs(viewer), T + 1800_000);
  assert.equal(frames.size, 0, 'no frame loop while paused');
});

test('ACCEPT: the Sunset preset puts the Sun (apparent, refraction-aware) at 0 +/- 0.3 deg in the drawn ephemeris', async () => {
  const { doc, handle, viewer } = setup();
  await handle.enterAt({
    ...HOUSTON,
    heightM: 15,
    heightKnown: true,
    source: 'manual',
  });
  handle.clock.setFixed(NOW);
  click(doc.body.find('preset-sunset'));
  await settle();
  const t = viewerMs(viewer);
  assert.ok(t > NOW && t - NOW < 26 * 3600_000);
  assert.equal(handle.clock.mode, 'fixed');
  const sun = handle.content.ephemeris.sun;
  assert.equal(handle.content.ephemeris.ms, t);
  assert.ok(Math.abs(sun.elDeg) <= 0.3, `Sun ${sun.elDeg}`);
  assert.match(doc.body.find('time-status').textContent, /^Sunset: /);
  // Midnight then Moonrise walk forward from the new time
  click(doc.body.find('preset-midnight'));
  await settle();
  assert.ok(viewerMs(viewer) > t);
  assert.ok(handle.content.ephemeris.sun.elDeg < -30);
});

// JPL Horizons rows of the Horizons reference (ephemeris.test.mjs): topocentric
// apparent az/el, AIRLESS; the Sky view draws with refraction, so the
// expected elevation adds astronomy-engine's own refraction to the row.
const P3A_SITES = {
  Houston: { latDeg: 29.7604, lonDeg: -95.3698, heightM: 15 },
  Sydney: { latDeg: -33.8688, lonDeg: 151.2093, heightM: 50 },
  Reykjavik: { latDeg: 64.1466, lonDeg: -21.9426, heightM: 30 },
};
const P3A_ROWS = [
  [
    'Houston',
    '2026-12-01T03:00:00Z',
    {
      Sun: [269.055450733, -46.713589944],
      Moon: [53.16049639, -36.334575128],
      Venus: [340.788809102, -68.6364988],
      Jupiter: [55.820776346, -25.135745759],
      Saturn: [202.319453565, 59.131868509],
    },
  ],
  [
    'Sydney',
    '2031-06-15T12:00:00Z',
    {
      Sun: [254.937583267, -62.625737538],
      Moon: [126.700774627, -62.540833472],
      Venus: [280.22286046, -21.43981839],
      Jupiter: [73.947787163, 62.480100322],
      Saturn: [235.711024474, -69.533193864],
    },
  ],
  [
    'Reykjavik',
    '2036-03-20T22:00:00Z',
    {
      Sun: [303.57094872, -14.632102051],
      Moon: [30.01224227, -43.174180046],
      Venus: [273.137854519, 20.527566338],
      Jupiter: [268.686382141, 19.297303018],
      Saturn: [168.815475883, 43.484628152],
    },
  ],
];

test('ACCEPT: playing the clock moves the Sun, Moon and planets per the Horizons references (0.05 deg)', async () => {
  for (const [site, iso, bodies] of P3A_ROWS) {
    const { handle, wall, frames, viewer } = setup();
    const s = P3A_SITES[site];
    await handle.enterAt({
      latDeg: s.latDeg,
      lonDeg: s.lonDeg,
      heightM: s.heightM - 1.7,
      heightKnown: true,
      source: 'manual',
    });
    const ref = Date.parse(iso);
    // two simulated hours of play at x3600 end exactly on the reference time
    handle.clock.play({ rate: 3600, fromMs: ref - 2 * 3600_000 });
    wall.t += 2000;
    frames.run();
    assert.equal(viewerMs(viewer), ref);
    const eph = handle.content.ephemeris;
    assert.equal(eph.ms, ref);
    const drawn = {
      Sun: eph.sun,
      Moon: eph.moon,
      ...Object.fromEntries(eph.planets.map((p) => [p.name, p])),
    };
    for (const [name, [az, el]] of Object.entries(bodies)) {
      const expectedEl = el + Refraction('normal', el);
      assert.ok(angDiff(drawn[name].azDeg, az) < 0.05, `${site} ${name} az`);
      assert.ok(
        Math.abs(drawn[name].elDeg - expectedEl) < 0.05,
        `${site} ${name} el ${drawn[name].elDeg} vs ${expectedEl}`,
      );
    }
    handle.destroy();
  }
});

test('URL round trip: sv (view + fixed or playing time) and every svf switch reopen the same sky', async () => {
  const first = setup();
  await first.handle.enterAt({ ...HOUSTON, source: 'manual' });
  const flags = {
    flatHorizon: true,
    grid: true,
    stars: false,
    lines: false,
    names: true,
    boundaries: true,
    planets: false,
    starNames: false,
    telescopic: true,
  };
  first.handle.content.setFlags(flags, { notify: true });
  first.handle.setView({ azDeg: 123.45, elDeg: 33.3, fovDeg: 55 });
  first.handle.clock.play({
    rate: 600,
    fromMs: Date.parse('2027-03-01T00:00:00Z'),
  });
  first.wall.t += 1000; // the link carries the time at the moment it is written
  first.timers.flush();
  const href = first.location.href;
  assert.match(
    href,
    /sv=29\.7604,-95\.3698,123\.45,33\.3,55,2027-03-01T00:10:00Z/,
  );
  const second = setup({ href });
  second.timers.flush();
  await settle();
  await settle();
  const h = second.handle;
  assert.equal(h.active, true);
  assert.deepEqual(
    { az: h.view.azDeg, el: h.view.elDeg, fov: h.view.fovDeg },
    { az: 123.45, el: 33.3, fov: 55 },
  );
  assert.equal(h.clock.getTime(), Date.parse('2027-03-01T00:10:00Z'));
  for (const [name, value] of Object.entries(flags))
    assert.equal(h.flags[name], value, name);
  // live writes no time
  h.clock.setLive();
  second.timers.flush();
  assert.equal(
    new URL(second.location.href).searchParams.get('sv').split(',').length,
    5,
  );
});

test('ACCEPT (unit level): x3600 for one simulated day with the real worker code: every tick answered, backlog never above 1, no errors', async () => {
  const worker = new InlineSatWorker();
  const { handle, wall, frames, timers } = setup({ worker });
  await handle.enterAt({
    ...HOUSTON,
    heightM: 15,
    heightKnown: true,
    source: 'manual',
  });
  await pump(worker);
  const start = Date.parse('2026-10-11T00:00:00Z');
  handle.clock.play({ rate: 3600, fromMs: start });
  let maxBacklog = 0;
  const ticksBefore = handle.satellites.stats.ticks;
  for (let i = 0; i < 24 * 4; i++) {
    wall.t += 250;
    frames.run();
    runIntervals(timers);
    maxBacklog = Math.max(maxBacklog, handle.satellites.stats.maxBacklog);
    await pump(worker);
  }
  assert.ok(handle.clock.getTime() >= start + 86_400_000 - 1);
  const stats = handle.satellites.stats;
  assert.ok(maxBacklog <= 1);
  // a timer tick that meets the forced tick of play() still in flight is
  // skipped (the backlog rule), never queued
  assert.ok(stats.skipped <= 1, `skipped ${stats.skipped}`);
  assert.ok(
    stats.ticks - ticksBefore >= 90,
    `ticks ${stats.ticks - ticksBefore}`,
  );
  assert.equal(handle.satellites.lastError, null);
});

test('validity banners: far-future Sky time warns about star/planet accuracy; old elements raise the satellite banner', async () => {
  const worker = new InlineSatWorker();
  const { doc, handle } = setup({ worker });
  await handle.enterAt({
    ...HOUSTON,
    heightM: 15,
    heightKnown: true,
    source: 'manual',
  });
  await pump(worker);
  handle.clock.setFixed(Date.UTC(2090, 0, 1));
  await pump(worker);
  const ids = () =>
    doc.body.find('banners').children.map((b) => b.getAttribute('data-banner'));
  assert.deepEqual(ids(), ['satellites', 'ephemeris']);
  assert.match(doc.body.find('banners').children[0].className, /error/);
  handle.clock.setLive();
  await pump(worker);
  assert.equal(ids().includes('ephemeris'), false);
});

test('empty/error states: preset before choosing a place, empty picker, ISS without satellite data', async () => {
  const { doc, handle } = setup({ fetchFails: true });
  click(doc.body.find('preset-sunset'));
  await settle();
  assert.match(doc.body.find('time-status').textContent, /where you stand/);
  await handle.enterAt({
    ...HOUSTON,
    heightM: 15,
    heightKnown: true,
    source: 'manual',
  });
  const time = doc.body.find('time');
  time.value = '';
  time.dispatchEvent(new Event('change'));
  assert.match(doc.body.find('time-status').textContent, /Pick a date/);
  click(doc.body.find('preset-iss'));
  await settle();
  await settle();
  assert.match(
    doc.body.find('time-status').textContent,
    /ISS elements could not be loaded/,
  );
});

test('ISS preset with the fixture elements jumps to a pass start', async () => {
  const { doc, handle } = setup();
  await handle.enterAt({
    ...HOUSTON,
    heightM: 15,
    heightKnown: true,
    source: 'manual',
  });
  // fixture elements are from 2026-10-11; search from there
  handle.clock.setFixed(Date.parse('2026-10-11T12:00:00Z'));
  const result = await handle.applyPreset('iss');
  assert.equal(result.ok, true);
  assert.equal(handle.clock.getTime(), result.timeMs);
  assert.match(doc.body.find('time-status').textContent, /^ISS pass: /);
});

test('accessibility CSS: 44 px touch targets on coarse pointers, visible keyboard focus, reduced motion', () => {
  const css = readFileSync(new URL('./skyView.css', import.meta.url), 'utf8');
  const coarse = css.match(/@media \(pointer: coarse\)\s*{([\s\S]*?)\n}/);
  assert.ok(coarse, 'coarse-pointer block');
  assert.match(coarse[1], /\.gev-sky-bar button/);
  assert.match(coarse[1], /\.gev-sky-bar select/);
  assert.match(coarse[1], /min-height: 44px/);
  assert.match(coarse[1], /min-width: 44px/);
  assert.match(css, /\.gev-sky-bar :focus-visible[\s\S]*?outline: 2px solid/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('one label collision space: satellite labels avoid sky labels and cardinals; only the selected one may overlap', async () => {
  const { placeLabels } = await import('./satOverlay.js');
  const { takenBoxes } = await import('./skyView.js');
  const sky = [{ box: { x0: 100, y0: 90, x1: 220, y1: 110 } }];
  const cardinals = [{ x0: 300, y0: 280, x1: 330, y1: 300 }];
  const reserved = takenBoxes(cardinals, sky);
  assert.deepEqual(reserved, [
    { x: 300, y: 280, w: 30, h: 20 },
    { x: 100, y: 90, w: 120, h: 20 },
  ]);
  // a dot whose four label spots all hit the sky label box is dropped...
  const blocked = {
    index: 1,
    x: 160,
    y: 100,
    r: 2,
    text: 'SAT-A 40°',
    color: '#fff',
  };
  assert.equal(placeLabels([blocked], 800, 600, reserved).length, 0);
  assert.equal(
    placeLabels([blocked], 800, 600).length,
    1,
    'without reserved it fits',
  );
  // ...unless it is the selected object
  assert.equal(
    placeLabels([{ ...blocked, selected: true }], 800, 600, reserved).length,
    1,
  );
});

test('mounted sky: no satellite label box overlaps a star/planet/constellation label box', async () => {
  const worker = new InlineSatWorker();
  const { handle } = setup({ worker });
  await handle.enterAt({
    ...HOUSTON,
    heightM: 15,
    heightKnown: true,
    source: 'manual',
  });
  await pump(worker);
  handle.clock.setFixed(Date.parse('2026-10-12T03:30:00Z'));
  await pump(worker);
  handle.setView({ azDeg: 180, elDeg: 60, fovDeg: 100 });
  handle.redraw();
  const skyLabels = handle.content.lastStats.labels;
  const satLabels = handle.satelliteModel.labels;
  assert.ok(
    skyLabels.length > 5 && satLabels.length > 0,
    `${skyLabels.length} sky, ${satLabels.length} sat`,
  );
  for (const s of satLabels)
    for (const { box: b } of skyLabels)
      assert.ok(
        !(
          s.box.x < b.x1 &&
          b.x0 < s.box.x + s.box.w &&
          s.box.y < b.y1 &&
          b.y0 < s.box.y + s.box.h
        ),
        `${s.text} overlaps a sky label`,
      );
});

test('narrow screens: the time rows fold behind a summary button (Live / Paused / speed)', async () => {
  const { doc, handle } = setup();
  await handle.enterAt({
    ...HOUSTON,
    heightM: 15,
    heightKnown: true,
    source: 'manual',
  });
  const fold = doc.body.find('time-fold');
  assert.match(fold.textContent, /^Time \d\d-\d\d \d\d:\d\d · Live$/);
  click(fold);
  assert.equal(fold.getAttribute('aria-expanded'), 'true');
  assert.equal(doc.body.find('time-control').getAttribute('data-open'), 'true');
  handle.clock.play({ rate: -600 });
  assert.match(fold.textContent, /· ◀ x600$/);
  handle.clock.pause();
  assert.match(fold.textContent, /· Paused$/);
  click(fold);
  assert.equal(fold.getAttribute('aria-expanded'), 'false');
});

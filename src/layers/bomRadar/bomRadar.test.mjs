import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  BOM_FRAME_MS,
  BOM_HOLD_MS,
  createBomRadarLayer,
  formatLocalTime,
} from './index.js';
import { createBomRendering } from './rendering.js';
import { BOM_RADAR_OFF_MESSAGE, BomRadarDisabledError } from './source.js';
import { BOM_RADAR_CREDIT } from '../../data/dataCredits.js';
import {
  createShellCesium,
  createShellScene,
  renderShells,
} from '../weather/shellFixture.mjs';

const ADELAIDE = { lat: -34.617, lon: 138.469 };
const SELLICKS = { lat: -35.33, lon: 138.5 };
const RADARS = [
  {
    id: '64',
    products: ['IDR641', 'IDR643', 'IDR644'],
    center: ADELAIDE,
    name: 'Adelaide',
  },
  { id: '46', products: ['IDR463'], center: SELLICKS, name: 'Sellicks Hill' },
];
const BOUNDS = { west: 137.05, south: -35.75, east: 139.89, north: -33.45 };
const stamp = (index) => Date.UTC(2026, 9, 12, 16, 0) + index * 5 * 60_000;
const fileFor = (product, index) => {
  const d = new Date(stamp(index));
  const p = (n) => String(n).padStart(2, '0');
  return `${product}.T.${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}.png`;
};
const framesFor = (product, from, count) =>
  Array.from({ length: count }, (_, i) => ({
    file: fileFor(product, from + i),
    timeMs: stamp(from + i),
    url: `/api/bom-radar/frame/${fileFor(product, from + i)}`,
  }));

const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
function event() {
  const listeners = new Set();
  return {
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(...args) {
      for (const fn of [...listeners]) fn(...args);
    },
    get size() {
      return listeners.size;
    },
  };
}
function target(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener(name, fn) {
      listeners.get(name)?.delete(fn);
    },
    emit(name) {
      for (const fn of [...(listeners.get(name) || [])]) fn();
    },
    get size() {
      return [...listeners.values()].reduce((n, set) => n + set.size, 0);
    },
  };
}
/** An imagery collection that records what is added and destroyed. */
function imageryCollection() {
  const layers = [];
  return {
    layers,
    addImageryProvider(provider) {
      const layer = {
        provider,
        alpha: 1,
        show: true,
        destroyed: false,
        isDestroyed() {
          return this.destroyed;
        },
        destroy() {
          this.destroyed = true;
        },
      };
      layers.push(layer);
      return layer;
    },
    add(layer) {
      layers.push(layer);
    },
    remove(layer, destroy) {
      const index = layers.indexOf(layer);
      if (index < 0) return false;
      layers.splice(index, 1);
      if (destroy) layer.destroy();
      return true;
    },
    contains: (layer) => layers.includes(layer),
    get length() {
      return layers.length;
    },
    get: (index) => layers[index],
  };
}

const mocked = new WeakSet();
function harness(t, options = {}) {
  if (!mocked.has(t)) {
    mocked.add(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
  }
  const clock = { ms: 0 };
  const scene = Object.assign(createShellScene(), {
    canvas: { clientWidth: 800, clientHeight: 600 },
    globe: { ellipsoid: Cesium.Ellipsoid.WGS84, show: true },
  });
  const camera = {
    positionCartographic: {
      latitude: Cesium.Math.toRadians(ADELAIDE.lat),
      longitude: Cesium.Math.toRadians(ADELAIDE.lon),
      height: 20_000,
    },
    moveEnd: event(),
    flights: [],
    flyTo(options) {
      this.flights.push(options);
    },
  };
  const collection = imageryCollection();
  const viewer = { scene, camera, imageryLayers: collection };
  const shellCesium = createShellCesium();
  const cesium = { ...Cesium, ...shellCesium };
  const canvases = [];
  const calls = { status: 0, products: 0, frames: [], images: [] };
  const state = {
    enabled: true,
    radars: RADARS,
    complete: true,
    frames: (product) => framesFor(product, 0, 12),
    failImage: () => false,
  };
  const source = {
    async getStatus() {
      calls.status++;
      return { enabled: state.enabled };
    },
    async getProducts() {
      calls.products++;
      return { radars: state.radars, complete: state.complete, stale: false };
    },
    async getFrames({ product }) {
      calls.frames.push(product);
      return {
        product,
        name: product.startsWith('IDR46') ? 'Sellicks Hill' : 'Adelaide',
        rangeKm: { 1: 512, 3: 128, 4: 64 }[product.at(-1)],
        center: ADELAIDE,
        bounds: BOUNDS,
        frames: state.frames(product),
        stale: false,
        listedAt: stamp(11),
      };
    },
    async getFrameImage({ file }) {
      calls.images.push(file);
      await state.imageGate;
      if (state.failImage(file)) throw new Error('frame fetch failed');
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    },
  };
  const credits = [];
  const win = target();
  const doc = target({ hidden: false });
  const media = {
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  };
  const host = { value: { collection, kind: 'globe' } };
  const layer = createBomRadarLayer({
    source,
    cesium,
    credits: {
      registerDynamicCredit: (_viewer, credit) => credits.push(credit),
      BOM_RADAR_CREDIT,
    },
    createRendering: (rendering) =>
      createBomRendering({ ...rendering, now: () => clock.ms }),
    decodeImage: async () => ({ width: 512, height: 512, close() {} }),
    createCanvas: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage() {},
          // A frame whose first pixel is the opaque grey title bar.
          getImageData: (_x, _y, w, h) => {
            const data = new Uint8ClampedArray(w * h * 4);
            data.set([193, 193, 193, 255]);
            return { data };
          },
          putImageData(pixels) {
            canvas.masked = pixels.data;
          },
        }),
      };
      canvases.push(canvas);
      return canvas;
    },
    now: () => stamp(11) + 90_000,
    timeZone: 'Australia/Adelaide',
    documentRef: doc,
    eventTarget: win,
    matchMedia: () =>
      options.reducedMotion ? { ...media, matches: true } : media,
  });
  layer.init(viewer);
  layer.attachShellServices({
    imageryHost: () => host.value,
    runNavigation: (navigate) => navigate(),
  });
  return {
    layer,
    viewer,
    scene,
    camera,
    collection,
    cesium: shellCesium,
    canvases,
    calls,
    state,
    credits,
    win,
    doc,
    clock,
    host,
    /** Resolve `promise` while rendering frames and letting the clock run. */
    async run(promise) {
      let done = false;
      let failure = null;
      promise.then(
        () => {
          done = true;
        },
        (error) => {
          done = true;
          failure = error;
        },
      );
      for (let i = 0; i < 80 && !done; i++) {
        await flush();
        clock.ms += 300;
        renderShells(shellCesium, scene, 4);
        scene.postRender.emit();
      }
      await flush();
      if (failure) throw failure;
      return promise;
    },
    async enable() {
      layer.enable();
      return this.run(layer.update(viewer));
    },
    shownLayers: () =>
      collection.layers.filter((entry) => entry.alpha > 0).length,
  };
}

test('enabling preloads the loop, shows one frame and credits the Bureau', async (t) => {
  const h = harness(t);
  assert.equal(await h.enable(), true);
  assert.deepEqual(h.calls.frames, ['IDR644']);
  assert.equal(h.calls.images.length, 12);
  assert.equal(h.collection.layers.length, 12, 'one resident layer per frame');
  assert.ok(
    h.canvases.every((canvas) =>
      canvas.masked.slice(0, 4).every((v) => v === 0),
    ),
    'the title bar is hidden before any host draws the frame',
  );
  assert.equal(h.shownLayers(), 1, 'every other frame sits at zero opacity');
  assert.ok(h.collection.layers.every((entry) => entry.show));
  const diag = h.layer.getDiagnostics();
  assert.equal(diag.host, 'globe');
  assert.equal(diag.product, 'IDR644');
  assert.equal(diag.residentImages, 12);
  assert.equal(h.credits.length, 1);
  assert.equal(h.credits[0], BOM_RADAR_CREDIT);
  const stats = h.layer.getStats();
  assert.equal(stats.count, 12);
  assert.equal(stats.lastUpdate, stamp(11));
  assert.equal(stats.error, null);
  assert.equal(stats.source, 'Bureau of Meteorology');
  assert.equal(stats.stale, false);
  h.layer.destroy();
});

test('the loop steps every 500 ms and holds the newest frame for 1.5 s', async (t) => {
  const h = harness(t);
  await h.enable();
  const shown = () => h.layer.getDiagnostics().shown;
  const files = framesFor('IDR644', 0, 12).map(({ file }) => file);
  assert.equal(BOM_FRAME_MS, 500);
  assert.equal(BOM_HOLD_MS, 1500);
  assert.equal(shown(), files[0]);
  t.mock.timers.tick(BOM_FRAME_MS - 1);
  assert.equal(shown(), files[0]);
  t.mock.timers.tick(1);
  assert.equal(shown(), files[1]);
  for (let i = 2; i <= 11; i++) t.mock.timers.tick(BOM_FRAME_MS);
  assert.equal(shown(), files[11]);
  t.mock.timers.tick(BOM_HOLD_MS - 1);
  assert.equal(shown(), files[11], 'the newest frame holds');
  t.mock.timers.tick(1);
  assert.equal(shown(), files[0], 'then the loop restarts');
  assert.equal(h.shownLayers(), 1, 'frame changes only move opacity');
  assert.equal(h.collection.layers.length, 12);
  h.layer.destroy();
});

test('pausing, a hidden tab and reduced motion stop the loop', async (t) => {
  const h = harness(t);
  await h.enable();
  const before = h.layer.getDiagnostics().shown;
  h.layer.setParams({ play: true });
  t.mock.timers.tick(5_000);
  assert.equal(h.layer.getDiagnostics().shown, before);
  assert.equal(h.layer.getDiagnostics().playing, false);
  h.layer.setParams({ play: true });
  t.mock.timers.tick(BOM_FRAME_MS);
  assert.notEqual(h.layer.getDiagnostics().shown, before);
  h.doc.hidden = true;
  h.doc.emit('visibilitychange');
  const hiddenAt = h.layer.getDiagnostics().shown;
  t.mock.timers.tick(5_000);
  assert.equal(h.layer.getDiagnostics().shown, hiddenAt);
  h.doc.hidden = false;
  h.doc.emit('visibilitychange');
  t.mock.timers.tick(BOM_FRAME_MS);
  assert.notEqual(h.layer.getDiagnostics().shown, hiddenAt);
  h.layer.destroy();

  const still = harness(t, { reducedMotion: true });
  await still.enable();
  assert.equal(
    still.layer.getDiagnostics().shown,
    framesFor('IDR644', 0, 12).at(-1).file,
    'reduced motion rests on the newest frame',
  );
  t.mock.timers.tick(10_000);
  assert.equal(still.layer.getDiagnostics().playing, false);
  still.layer.destroy();
});

test('disabling releases every layer, image and timer; destroying releases listeners', async (t) => {
  const h = harness(t);
  await h.enable();
  assert.equal(h.collection.layers.length, 12);
  const made = h.collection.layers.slice();
  assert.ok(h.camera.moveEnd.size >= 1);
  assert.ok(h.win.size >= 1 && h.doc.size >= 1);
  h.layer.disable();
  assert.equal(h.collection.layers.length, 0);
  assert.ok(
    made.every((entry) => entry.destroyed),
    'imagery layers destroyed',
  );
  assert.ok(
    h.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0),
    'decoded frames released',
  );
  const diag = h.layer.getDiagnostics();
  assert.equal(diag.residentImages, 0);
  assert.equal(diag.frames, 0);
  assert.equal(diag.imageryCount, 0);
  assert.equal(diag.playing, false);
  t.mock.timers.tick(60_000);
  assert.equal(h.layer.getDiagnostics().shown, null);
  assert.equal(h.layer.getStats().count, 0);
  assert.equal(
    await h.layer.update(h.viewer),
    false,
    'a disabled layer fetches nothing',
  );
  const calls = h.calls.status;
  assert.equal(h.calls.status, calls);

  // Re-enabling starts clean, then destroy removes the listeners it added.
  await h.enable();
  assert.equal(h.collection.layers.length, 12);
  h.layer.destroy();
  assert.equal(h.collection.layers.length, 0);
  assert.equal(h.camera.moveEnd.size, 0);
  assert.equal(h.win.size, 0);
  assert.equal(h.doc.size, 0);
});

test('a refresh keeps at most twelve frames: the oldest goes, the new one arrives', async (t) => {
  const h = harness(t);
  await h.enable();
  const dropped = h.collection.layers[0];
  h.state.frames = (product) => framesFor(product, 1, 12);
  await h.run(h.layer.update(h.viewer));
  assert.equal(h.collection.layers.length, 12);
  assert.equal(dropped.destroyed, true);
  assert.equal(h.calls.images.length, 13, 'only the new frame was fetched');
  assert.equal(h.layer.getDiagnostics().residentImages, 12);
  assert.equal(h.layer.getStats().lastUpdate, stamp(12));
  const live = h.canvases.filter((canvas) => canvas.width > 0);
  assert.equal(live.length, 12);
  h.layer.destroy();
});

test('when the operator has not enabled it, the layer says so and draws nothing', async (t) => {
  const h = harness(t);
  h.state.enabled = false;
  assert.equal(await h.enable(), true);
  assert.equal(h.layer.getStats().error, BOM_RADAR_OFF_MESSAGE);
  assert.match(BOM_RADAR_OFF_MESSAGE, /BOM_RADAR_ENABLED=1/);
  assert.match(BOM_RADAR_OFF_MESSAGE, /personal use only/);
  assert.equal(h.calls.products, 0);
  assert.deepEqual(h.calls.frames, []);
  assert.deepEqual(h.calls.images, []);
  assert.equal(h.collection.layers.length, 0);
  assert.match(h.layer.getRowControls().info, /personal use only/);
  // Switching it on is picked up at the next refresh.
  h.state.enabled = true;
  await h.run(h.layer.update(h.viewer));
  assert.equal(h.layer.getStats().error, null);
  assert.equal(h.collection.layers.length, 12);
  // A server that answers 503 mid-flight turns it back off and clears the picture.
  h.state.frames = () => {
    throw new BomRadarDisabledError();
  };
  await h.run(h.layer.update(h.viewer));
  assert.equal(h.layer.getStats().error, BOM_RADAR_OFF_MESSAGE);
  assert.equal(h.collection.layers.length, 0);
  h.layer.destroy();
});

test('the row shows the radar, range, local-time frame, age and the credit', async (t) => {
  const h = harness(t);
  await h.enable();
  const controls = h.layer.getRowControls();
  const lines = controls.info.split('\n');
  assert.equal(lines[0], 'Adelaide 64 km · 02:30 ACDT · 56 min ago');
  assert.equal(lines[1], 'Frame 1/12');
  assert.match(controls.info, /Bureau of Meteorology · personal use only/);
  assert.match(controls.infoTitle, /personal or in-organisation use only/);
  assert.match(controls.infoTitle, /your own time zone/);
  assert.equal(controls.legend.length, 5);
  assert.deepEqual(
    controls.chips.map(({ id }) => id),
    ['play', 'opacity-light', 'opacity-strong', 'coverage'],
  );
  t.mock.timers.tick(BOM_FRAME_MS);
  assert.match(h.layer.getRowControls().info, /Frame 2\/12/);
  assert.equal(h.layer.getStats().countLabel, '64 km');
  // The chips drive the layer through the usual parameters.
  h.layer.setParams({ opacity: 'light' });
  assert.equal(h.layer.getParams().opacity, 'light');
  const shown = h.collection.layers.find((entry) => entry.alpha > 0);
  assert.equal(shown.alpha, 0.45);
  h.layer.setParams({ focus: true });
  assert.equal(h.camera.flights.length, 1);
  h.layer.destroy();
});

test('frame times read in the requested or default zone with its abbreviation', () => {
  const adelaide = 'Australia/Adelaide';
  assert.equal(
    formatLocalTime(Date.UTC(2026, 9, 12, 16, 9), adelaide),
    '02:39 ACDT',
  );
  assert.equal(
    formatLocalTime(Date.UTC(2026, 6, 12, 16, 9), adelaide),
    '01:39 ACST',
  );
  assert.equal(
    formatLocalTime(Date.UTC(2026, 9, 12, 16, 9), 'Australia/Perth'),
    '00:09 AWST',
  );
  assert.ok(formatLocalTime(Date.UTC(2026, 9, 12, 16, 9)).length > 6);
  assert.equal(formatLocalTime(NaN), 'Unavailable');
});

test('moving the camera re-selects the product once, after the debounce', async (t) => {
  const h = harness(t);
  await h.enable();
  assert.deepEqual(h.calls.frames, ['IDR644']);
  const first = h.collection.layers.slice();
  // Climb to 400 km and nudge a few times: one reselection, not one per event.
  h.camera.positionCartographic.height = 400_000;
  for (let i = 0; i < 4; i++) {
    h.camera.moveEnd.emit();
    t.mock.timers.tick(300);
  }
  assert.deepEqual(h.calls.frames, ['IDR644']);
  await h.run((async () => t.mock.timers.tick(1_000))());
  await h.run(Promise.resolve());
  for (let i = 0; i < 20 && h.calls.frames.length < 2; i++)
    await h.run(Promise.resolve());
  assert.deepEqual(h.calls.frames, ['IDR644', 'IDR643']);
  // Let the new loop draw, then the old product's layers are gone.
  for (let i = 0; i < 20; i++) await h.run(Promise.resolve());
  assert.equal(h.layer.getDiagnostics().product, 'IDR643');
  assert.ok(
    first.every((entry) => entry.destroyed || !h.collection.contains(entry)),
  );
  assert.ok(h.collection.layers.length <= 12);
  assert.equal(
    h.layer.getRowControls().info.split('\n')[0],
    'Adelaide 128 km · 02:30 ACDT · 56 min ago',
  );
  // Moving without crossing a threshold keeps the product (no reload).
  h.camera.positionCartographic.height = 420_000;
  h.camera.moveEnd.emit();
  t.mock.timers.tick(1_000);
  await h.run(Promise.resolve());
  assert.deepEqual(h.calls.frames, ['IDR644', 'IDR643']);
  h.layer.destroy();
});

test('looking away from every radar shows nothing and no error', async (t) => {
  const h = harness(t);
  await h.enable();
  assert.equal(h.collection.layers.length, 12);
  h.camera.positionCartographic.latitude = Cesium.Math.toRadians(-23.7);
  h.camera.positionCartographic.longitude = Cesium.Math.toRadians(133.9);
  h.camera.moveEnd.emit();
  t.mock.timers.tick(1_000);
  for (let i = 0; i < 10; i++) await h.run(Promise.resolve());
  assert.equal(h.collection.layers.length, 0);
  assert.equal(h.layer.getStats().error, null);
  assert.match(
    h.layer.getRowControls().info,
    /No BoM radar reaches the view centre/,
  );
  assert.equal(h.layer.getDiagnostics().residentImages, 0);
  h.layer.destroy();
});

test('radar locations still arriving are polled again soon', async (t) => {
  const h = harness(t);
  h.state.complete = false;
  h.state.radars = [{ id: '64', products: ['IDR644'] }];
  await h.enable();
  assert.equal(h.collection.layers.length, 0);
  assert.match(h.layer.getRowControls().info, /Locating radars/);
  h.state.radars = RADARS;
  h.state.complete = true;
  t.mock.timers.tick(5_000);
  for (let i = 0; i < 10; i++) await h.run(Promise.resolve());
  assert.equal(h.calls.products, 2);
  assert.equal(h.collection.layers.length, 12);
  h.layer.destroy();
});

test('a retry that fires during a frame preload is deferred, not dropped', async (t) => {
  const h = harness(t);
  let release;
  h.state.imageGate = new Promise((resolve) => {
    release = resolve;
  });
  // Only a far radar is known at first; the nearer one is still being located.
  h.state.complete = false;
  h.state.radars = [
    {
      id: '14',
      products: ['IDR141'],
      center: { lat: -37.75, lon: 140.78 },
    },
  ];
  h.layer.enable();
  const first = h.layer.update(h.viewer);
  await flush();
  assert.deepEqual(h.calls.frames, ['IDR141']);
  assert.equal(h.calls.images.length > 0, true, 'the preload is pending');
  // The 5 s retry fires while that preload is still in flight.
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(h.calls.products, 1, 'nothing re-fetched mid-request');
  // Discovery finishes, then the preload settles.
  h.state.radars = RADARS;
  h.state.complete = true;
  release();
  await h.run(first);
  assert.equal(h.layer.getDiagnostics().product, 'IDR141');
  t.mock.timers.tick(5_000);
  for (let i = 0; i < 10; i++) await h.run(Promise.resolve());
  assert.equal(h.calls.products, 2, 'the deferred retry ran');
  assert.equal(h.layer.getDiagnostics().product, 'IDR644');
  assert.equal(h.layer.getDiagnostics().radar, '64');
  assert.doesNotMatch(h.layer.getRowControls().info, /Locating radars/);
  h.layer.destroy();
});

test('one failed frame shortens the loop; no frames at all is reported', async (t) => {
  const h = harness(t);
  const lost = fileFor('IDR644', 3);
  h.state.failImage = (file) => file === lost;
  await h.enable();
  assert.equal(h.collection.layers.length, 11);
  assert.equal(h.layer.getStats().count, 11);
  assert.equal(h.layer.getStats().error, null);
  h.layer.destroy();

  const none = harness(t);
  none.state.failImage = () => true;
  await none.enable();
  assert.equal(none.collection.layers.length, 0);
  assert.equal(none.layer.getStats().error, 'BoM radar frames unavailable');
  none.layer.destroy();
});

test('a failed refresh keeps the loop on screen and reports the error', async (t) => {
  const h = harness(t);
  await h.enable();
  h.state.frames = () => {
    throw new Error('BoM radar HTTP 502');
  };
  assert.equal(await h.run(h.layer.update(h.viewer)), true);
  assert.equal(h.collection.layers.length, 12);
  assert.equal(h.layer.getStats().error, 'BoM radar HTTP 502');
  h.layer.destroy();
});

test('3D Tiles hosts draw one raised shell and release it with the layer', async (t) => {
  const h = harness(t);
  h.host.value = { collection: null, kind: 'tileset' };
  await h.enable();
  assert.equal(h.collection.layers.length, 0, 'no draped imagery on 3D Tiles');
  const shells = h.cesium.created.primitives.filter((p) => !p.destroyed);
  assert.equal(shells.length, 1);
  assert.equal(h.layer.getDiagnostics().host, 'shell');
  assert.equal(h.layer.getStats().error, null);
  assert.equal(h.credits.length, 1);
  const material = shells[0].appearance.material;
  const first = material.uniforms.image;
  assert.ok(first && typeof first === 'object', 'a frame is bound');
  t.mock.timers.tick(BOM_FRAME_MS);
  assert.notEqual(material.uniforms.image, first, 'the loop swaps the texture');
  assert.equal(
    h.cesium.created.primitives.filter((p) => !p.destroyed).length,
    1,
    'still one surface',
  );
  assert.equal(
    shells[0].options.geometryInstances.geometry.options.rectangle.west > 0,
    true,
  );

  // Switching to a globe map moves the loop onto imagery layers.
  h.host.value = { collection: h.collection, kind: 'globe' };
  h.win.emit('gev:map-stack-changed');
  await h.run(Promise.resolve());
  for (let i = 0; i < 6; i++) await h.run(Promise.resolve());
  assert.equal(shells[0].destroyed, true, 'the shell is torn down');
  assert.equal(h.collection.layers.length, 12);
  assert.equal(h.layer.getDiagnostics().host, 'globe');

  // And back: imagery leaves the globe, a shell returns.
  h.host.value = { collection: null, kind: 'tileset' };
  h.win.emit('gev:map-stack-changed');
  for (let i = 0; i < 6; i++) await h.run(Promise.resolve());
  assert.equal(h.collection.layers.length, 0);
  assert.equal(
    h.cesium.created.primitives.filter((p) => !p.destroyed).length,
    1,
  );

  h.layer.disable();
  assert.equal(
    h.cesium.created.primitives.filter((p) => !p.destroyed).length,
    0,
  );
  assert.ok(h.cesium.created.materials.every((m) => m.destroyed));
  h.layer.destroy();
});

test('a map source with no imagery host hides the loop and says why', async (t) => {
  const h = harness(t);
  await h.enable();
  h.host.value = { collection: null, kind: 'none' };
  h.win.emit('gev:map-stack-changed');
  assert.match(h.layer.getRowControls().info, /choose a globe map/);
  assert.equal(h.layer.getDiagnostics().playing, false);
  h.host.value = { collection: h.collection, kind: 'globe' };
  h.win.emit('gev:map-stack-changed');
  assert.doesNotMatch(h.layer.getRowControls().info, /choose a globe map/);
  assert.ok(h.collection.layers.every((entry) => entry.show));
  h.layer.destroy();
});

test('the layer refuses a source that lacks the radar contract', () => {
  assert.throws(
    () => createBomRadarLayer({ source: { getStatus() {} } }),
    /requires a radar source/,
  );
});

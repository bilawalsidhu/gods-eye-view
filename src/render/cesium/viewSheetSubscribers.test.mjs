import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { createCesiumDraw } from './draw.js';
import { AIRCRAFT_VIEWS } from '../../data/aircraftViews.js';

function fakeScene() {
  const added = [];
  return {
    added,
    renders: 0,
    camera: { positionWC: new Cesium.Cartesian3(2e7, 0, 0) },
    frameState: { time: Cesium.JulianDate.now() },
    primitives: {
      add: (p) => (added.push(p), p),
      remove: (p) => {
        const at = added.indexOf(p);
        if (at >= 0) added.splice(at, 1);
        return at >= 0;
      },
      length: 0,
    },
    requestRender() {
      this.renders += 1;
    },
    isDestroyed: () => false,
  };
}
const AT = Cesium.Cartesian3.fromDegrees(4.1, 51.95, 2);
const viewIcon = (id) => ({
  id,
  pos: { x: AT.x, y: AT.y, z: AT.z },
  size: [32, 32],
  image: {
    views: AIRCRAFT_VIEWS.id,
    first: AIRCRAFT_VIEWS.subjects.widebody,
    fallback: 'glyph.png',
  },
  rotationMode: 'course',
  course: 30,
});

function hostOn(id) {
  const scene = fakeScene();
  const part = createCesiumDraw({ scene, report: (e) => assert.fail(e) });
  part.port.views(AIRCRAFT_VIEWS.id, {
    ...AIRCRAFT_VIEWS.sheet,
    image: '/sprites/view-sheet-subscribers.webp',
  });
  const set = part.port.icons({ id });
  set.set([viewIcon('a')]);
  return { scene, draw: part.port, host: part.sets.get(id).host };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('only live subscribers are notified when a shared view sheet settles', async (t) => {
  const urls = [];
  let fail;
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', (url) => {
    urls.push(url);
    return new Promise((_, reject) => {
      fail = reject;
    });
  });
  const saved = globalThis.createImageBitmap;
  globalThis.createImageBitmap = () => assert.fail('unexpected decode');
  try {
    const context = {};
    const a = hostOn('gpu:a');
    const b = hostOn('gpu:b');
    a.host._syncViews(context);
    b.host._syncViews(context);
    assert.deepEqual(urls, ['/sprites/view-sheet-subscribers.webp']);
    a.host.destroy();
    const before = b.scene.renders;
    fail(new Error('offline'));
    await tick();
    assert.equal(b.scene.renders - before, 1);
    assert.equal(b.host._viewEntry.listeners.size, 0);
    assert.equal(b.host.viewsState(), 'failed');
    b.host.destroy();
  } finally {
    if (saved === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = saved;
  }
});

test('a view sheet uses bitmap decoding and rejects an image of the wrong size', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response('blob'));
  const saved = globalThis.createImageBitmap;
  const close = t.mock.fn();
  const decode = t.mock.fn(async () => ({ width: 8, height: 8, close }));
  globalThis.createImageBitmap = decode;
  try {
    const { host, draw } = hostOn('gpu:size');
    const context = {};
    host._syncViews(context);
    await tick();
    assert.equal(decode.mock.callCount(), 1);
    const [blob, options] = decode.mock.calls[0].arguments;
    assert.ok(blob instanceof Blob);
    assert.equal(await blob.text(), 'blob');
    assert.deepEqual(options, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
    assert.equal(host.viewsState(), 'failed');
    assert.equal(close.mock.callCount(), 1);

    // A replacement layout at the same URL needs its own size check.
    draw.views(AIRCRAFT_VIEWS.id, {
      ...AIRCRAFT_VIEWS.sheet,
      image: host._views().image,
      rows: AIRCRAFT_VIEWS.sheet.rows + 1,
    });
    assert.equal(host.viewsState(), 'loading');
    host._syncViews(context);
    await tick();
    assert.equal(decode.mock.callCount(), 2);
    assert.equal(close.mock.callCount(), 2);
    assert.equal(host.viewsState(), 'failed');
    host.destroy();
  } finally {
    if (saved === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = saved;
  }
});

test('a failed sheet request skips bitmap decoding', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 404 }));
  const saved = globalThis.createImageBitmap;
  const decode = t.mock.fn();
  globalThis.createImageBitmap = decode;
  try {
    const { host } = hostOn('gpu:missing');
    host._syncViews({});
    await tick();
    assert.equal(host.viewsState(), 'failed');
    assert.equal(decode.mock.callCount(), 0);
    host.destroy();
  } finally {
    if (saved === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = saved;
  }
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

// A sheet whose body the test feeds; aborting the request errors it.
function slowSheet(t) {
  let feed;
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    const body = new ReadableStream({ start: (c) => (feed = c) });
    signal.addEventListener('abort', () =>
      feed.error(new DOMException('aborted', 'AbortError')),
    );
    return new Response(body);
  });
  return () => feed;
}

test('a view sheet still arriving after a minute is decoded', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const feed = slowSheet(t);
  const saved = globalThis.createImageBitmap;
  const decode = t.mock.fn(async () => ({ width: 8, height: 8, close() {} }));
  globalThis.createImageBitmap = decode;
  try {
    const { host } = hostOn('gpu:slow');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    host._syncViews({});
    await settle();
    for (let i = 0; i < 5; i++) {
      feed().enqueue(new Uint8Array(1));
      await settle();
      t.mock.timers.tick(20000);
      await settle();
    }
    feed().close();
    await settle();
    assert.equal(decode.mock.callCount(), 1);
    assert.equal(decode.mock.calls[0].arguments[0].size, 5);
    host.destroy();
  } finally {
    if (saved === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = saved;
  }
});

test('a view sheet that stops arriving fails after a minute without data', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const feed = slowSheet(t);
  const saved = globalThis.createImageBitmap;
  const decode = t.mock.fn();
  globalThis.createImageBitmap = decode;
  try {
    const { host } = hostOn('gpu:stall');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    host._syncViews({});
    await settle();
    feed().enqueue(new Uint8Array(1));
    await settle();
    t.mock.timers.tick(59000);
    await settle();
    assert.equal(host.viewsState(), 'loading');
    t.mock.timers.tick(1000);
    await settle();
    assert.equal(host.viewsState(), 'failed');
    assert.equal(decode.mock.callCount(), 0);
    assert.match(warn.mock.calls.at(-1).arguments[0], /no data for 60 s/);
    host.destroy();
  } finally {
    if (saved === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = saved;
  }
});

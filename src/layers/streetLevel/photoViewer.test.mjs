import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhotoViewer } from './photoViewer.js';
import { fakeHost, until } from '../../testSupport/kartaViewFakes.mjs';

const PHOTOS = {
  a: { id: 'a', sequenceId: 's', lon: 1, lat: 2, heading: 0, isPano: true },
  b: { id: 'b', sequenceId: 's', lon: 1, lat: 2, heading: 0, isPano: true },
  f: { id: 'f', sequenceId: 's', lon: 1, lat: 2, heading: 0, isPano: false },
  g: { id: 'g', sequenceId: 's', lon: 1, lat: 2, heading: 0, isPano: false },
};

/** Sources whose panoramas and sharper flat versions are named after the photo. */
const SOURCES = {
  hasPano: (photo) => photo.isPano,
  panoFirst: (photo) => ({ url: `${photo.id}-first`, width: 2048 }),
  panoSharp: (photo) => ({ url: `${photo.id}-sharp` }),
  flatFirst: (photo) => [`${photo.id}-first`],
  flatSharp: (photo, pixels) => (pixels > 1000 ? `${photo.id}-sharp` : null),
  describe: () => ({ externalUrl: 'https://example.org' }),
};

/** A viewer whose loads wait until `release(url)` (or fail with `fail(url)`). */
function setup() {
  const pending = new Map();
  const loads = [];
  const images = [];
  const viewer = createPhotoViewer({
    providerId: 'test',
    name: 'Test',
    sources: SOURCES,
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep() {},
    load: (url) =>
      new Promise((resolve, reject) => {
        loads.push(url);
        pending.set(url, { resolve, reject });
      }),
    createRenderer: () => ({
      setImage: (image) => images.push(image.src),
      setView() {},
      getView: () => ({ yaw: 0, pitch: 0, fov: 80 }),
      resize() {},
      clear() {},
      destroy() {},
    }),
  });
  const release = (url) => {
    const closed = { value: false };
    pending.get(url).resolve({ src: url, close: () => (closed.value = true) });
    pending.delete(url);
    return closed;
  };
  const fail = (url) => {
    pending.get(url).reject(new Error('gone'));
    pending.delete(url);
  };
  return { viewer, loads, images, release, fail, host: fakeHost() };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const parts = (host) => {
  const [picture, canvas] = host.children[0].children;
  return { picture, canvas };
};

test('a panorama that arrives after another photo opened is released, not shown', async () => {
  const env = setup();
  await env.viewer.mount(env.host);
  const first = env.viewer.open('a');
  await tick();
  const second = env.viewer.open('b');
  await tick();
  const stale = env.release('a-first');
  await first;
  assert.equal(stale.value, true, 'its bitmap is closed');
  env.release('b-first');
  await second;
  assert.deepEqual(env.images, ['b-first']);
});

test('one sharp panorama download per open, even across a quick switch and a burst of resizes', async (t) => {
  const env = setup();
  t.after(() => delete globalThis.devicePixelRatio);
  globalThis.devicePixelRatio = 1;
  await env.viewer.mount(env.host);
  const { canvas } = parts(env.host);
  canvas.clientWidth = 1800;
  const opening = env.viewer.open('a');
  await tick();
  env.release('a-first');
  await opening;
  await tick();
  assert.ok(env.loads.includes('a-sharp'), 'expanded: the sharp one is asked');
  // Photo b opens while a's sharp version is still on its way.
  const next = env.viewer.open('b');
  await tick();
  env.release('b-first');
  await next;
  await tick();
  assert.ok(env.loads.includes('b-sharp'));
  // a's download finishes late; resizes must not ask for b's again.
  env.release('a-sharp');
  await tick();
  env.viewer.resize();
  env.viewer.resize();
  await tick();
  assert.equal(env.loads.filter((url) => url === 'b-sharp').length, 1);
  env.release('b-sharp');
  await tick();
  assert.deepEqual(env.images, ['a-first', 'b-first', 'b-sharp']);
});

test('a sharper flat version that failed is tried again on the next resize', async (t) => {
  const env = setup();
  t.after(() => delete globalThis.devicePixelRatio);
  globalThis.devicePixelRatio = 1;
  await env.viewer.mount(env.host);
  const { picture } = parts(env.host);
  picture.clientWidth = 1200;
  const opening = env.viewer.open('f');
  await tick();
  env.release('f-first');
  await opening;
  await tick();
  env.fail('f-sharp');
  await tick();
  assert.equal(picture.src, 'f-first');
  env.viewer.resize();
  await tick();
  assert.equal(env.loads.filter((url) => url === 'f-sharp').length, 2);
  env.release('f-sharp');
  assert.ok(await until(() => picture.src === 'f-sharp'));
});

test('Esc: the docked viewer offers it to the provider first; expanded, it is the dialog’s', async () => {
  let asked = 0;
  const viewer = createPhotoViewer({
    providerId: 'test',
    name: 'Test',
    sources: SOURCES,
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep() {},
    onEscape: () => ++asked > 0,
    load: async (url) => ({ src: url }),
  });
  const host = fakeHost();
  await viewer.mount(host);
  const root = host.children[0];
  const press = () => {
    const event = { key: 'Escape', prevented: false, stopped: false };
    event.preventDefault = () => (event.prevented = true);
    event.stopPropagation = () => (event.stopped = true);
    root.fire('keydown', event);
    return event;
  };
  const docked = press();
  assert.equal(asked, 1);
  assert.equal(docked.prevented && docked.stopped, true);
  root.closest = (selector) =>
    selector.includes('sl-viewer-wrap:fullscreen') ? {} : null;
  const expanded = press();
  assert.equal(asked, 1, 'not asked while expanded');
  assert.equal(expanded.prevented, false);
});

test('a sharp panorama still downloading when another photo opens is aborted', async (t) => {
  const signals = [];
  const viewer = createPhotoViewer({
    providerId: 'test',
    name: 'Test',
    sources: SOURCES,
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep() {},
    load: (url, options) =>
      url.endsWith('-sharp')
        ? new Promise((_, reject) => {
            signals.push(options.signal);
            options.signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          })
        : Promise.resolve({ src: url }),
    createRenderer: () => ({
      setImage() {},
      setView() {},
      getView: () => ({ yaw: 0, pitch: 0, fov: 80 }),
      resize() {},
      clear() {},
      destroy() {},
    }),
  });
  t.after(() => delete globalThis.devicePixelRatio);
  globalThis.devicePixelRatio = 1;
  const host = fakeHost();
  await viewer.mount(host);
  parts(host).canvas.clientWidth = 1800;
  await viewer.open('a');
  await tick();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  await viewer.open('f');
  assert.equal(signals[0].aborted, true, 'not needed any more');
});

test('a lost WebGL context while the first panorama loads releases its bitmap', async () => {
  let closed = false;
  let built = 0;
  let land = null;
  const viewer = createPhotoViewer({
    providerId: 'test',
    name: 'Test',
    sources: SOURCES,
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep() {},
    load: (url) =>
      new Promise((resolve) => {
        land = () => resolve({ src: url, close: () => (closed = true) });
      }),
    // The first renderer is lost mid-load; a new one cannot be built.
    createRenderer: () => {
      built++;
      if (built > 1) throw new Error('context lost');
      return {
        setImage() {},
        setView() {},
        getView: () => ({ yaw: 0, pitch: 0, fov: 80 }),
        resize() {},
        clear() {},
        destroy() {},
      };
    },
  });
  const host = fakeHost();
  await viewer.mount(host);
  const opening = viewer.open('a');
  assert.ok(await until(() => land !== null), 'the panorama is loading');
  parts(host).canvas.fire('webglcontextlost', {});
  const first = land;
  first();
  // The panorama failed: the front view is loaded flat instead.
  assert.ok(await until(() => land !== first), 'the flat fallback loads');
  land();
  await opening;
  assert.equal(built, 2, 'a new renderer was tried');
  assert.equal(closed, true, 'the bitmap no renderer took is closed');
});

test('docked, Esc anywhere in the viewer’s box (toolbar, caption) is offered to the provider', async () => {
  let asked = 0;
  const viewer = createPhotoViewer({
    providerId: 'test',
    name: 'Test',
    sources: SOURCES,
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep() {},
    onEscape: () => ++asked > 0,
    load: async (url) => ({ src: url }),
  });
  const host = fakeHost();
  const wrap = fakeHost();
  host.closest = (selector) => (selector === '.sl-viewer-wrap' ? wrap : null);
  await viewer.mount(host);
  const flags = { stopped: false, prevented: false };
  // Focus back on EXPAND after a shrink: the key reaches the wrap, not the photo.
  wrap.fire('keydown', {
    key: 'Escape',
    stopPropagation: () => (flags.stopped = true),
    preventDefault: () => (flags.prevented = true),
  });
  assert.equal(asked, 1);
  assert.deepEqual(flags, { stopped: true, prevented: true });
  viewer.unmount();
  wrap.fire('keydown', { key: 'Escape' });
  assert.equal(asked, 1, 'unmounted: the listener is gone');
});

test('a picture file or bitmap past any real photo’s size is refused', async (t) => {
  const { loadImage, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE } =
    await import('./photoViewer.js');
  const saved = {
    fetch: globalThis.fetch,
    createImageBitmap: globalThis.createImageBitmap,
  };
  t.after(() => Object.assign(globalThis, saved));
  let closed = 0;
  const bitmap = (width, height) => ({ width, height, close: () => closed++ });
  globalThis.createImageBitmap = async (blob) => blob.bitmap;
  const respond = ({ length, size, width = 100, height = 50 }) =>
    (globalThis.fetch = async () => ({
      ok: true,
      headers: new Map([['content-length', String(length ?? '')]]),
      blob: async () => ({
        size: size ?? 10,
        bitmap: bitmap(width, height),
        slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
      }),
    }));
  const refusedForSize = (error) => {
    assert.match(error.message, /could not be loaded/);
    assert.equal(error.tooLarge, true, 'marked as a size refusal');
    return true;
  };
  respond({ length: MAX_IMAGE_BYTES + 1 });
  await assert.rejects(loadImage('https://x/a.jpg'), refusedForSize);
  respond({ size: MAX_IMAGE_BYTES + 1 });
  await assert.rejects(loadImage('https://x/a.jpg'), refusedForSize);
  respond({ width: MAX_IMAGE_SIDE + 1 });
  await assert.rejects(loadImage('https://x/a.jpg'), refusedForSize);
  assert.equal(closed, 1, 'the oversize bitmap is released');
  // No length given, a body that keeps coming: cut off while it streams.
  let pulled = 0;
  globalThis.fetch = async () => ({
    ok: true,
    headers: new Map(),
    body: new ReadableStream({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
      },
    }),
  });
  await assert.rejects(loadImage('https://x/a.jpg'), refusedForSize);
  assert.ok(pulled * 8 * 1024 * 1024 <= MAX_IMAGE_BYTES + 16 * 1024 * 1024);
  // Other failures are not size refusals.
  globalThis.fetch = async () => ({ ok: false, headers: new Map() });
  await assert.rejects(
    loadImage('https://x/a.jpg'),
    (error) => !error.tooLarge,
  );
  respond({});
  assert.equal((await loadImage('https://x/a.jpg')).width, 100);
});

/** A viewer whose loads are held, recording each load's signal by url. */
function heldViewer() {
  const pending = new Map();
  const signals = new Map();
  const loads = [];
  const viewer = createPhotoViewer({
    providerId: 'test',
    name: 'Test',
    sources: SOURCES,
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep() {},
    load: (url, options = {}) =>
      new Promise((resolve, reject) => {
        loads.push(url);
        signals.set(url, options.signal);
        options.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
        pending.set(url, { resolve, reject });
      }),
  });
  const release = (url) => {
    pending.get(url).resolve({ src: url });
    pending.delete(url);
  };
  return { viewer, pending, signals, loads, release, host: fakeHost() };
}

test('a new open, a close or an unmount stops the downloads of the open before it', async () => {
  const env = heldViewer();
  await env.viewer.mount(env.host);
  const first = env.viewer.open('f');
  assert.ok(await until(() => env.signals.has('f-first')));
  const second = env.viewer.open('g');
  assert.equal(env.signals.get('f-first').aborted, true, 'f is not wanted now');
  await first.catch(() => {});
  assert.ok(await until(() => env.signals.has('g-first')));
  env.viewer.close();
  assert.equal(env.signals.get('g-first').aborted, true, 'closed');
  await second.catch(() => {});
  const third = env.viewer.open('f');
  assert.ok(await until(() => env.pending.has('f-first')));
  env.viewer.unmount();
  assert.equal(env.signals.get('f-first').aborted, true, 'unmounted');
  await third.catch(() => {});
});

test('a sharper flat version on its way stops when another photo opens, and is asked again later', async (t) => {
  t.after(() => delete globalThis.devicePixelRatio);
  globalThis.devicePixelRatio = 1;
  const env = heldViewer();
  await env.viewer.mount(env.host);
  parts(env.host).picture.clientWidth = 1200;
  const opening = env.viewer.open('f');
  assert.ok(await until(() => env.pending.has('f-first')));
  env.release('f-first');
  await opening;
  assert.ok(
    await until(() => env.pending.has('f-sharp')),
    'the 1,200 px viewer asks for more',
  );
  // Resizes while it loads (the panel animating) do not ask again.
  env.viewer.resize();
  env.viewer.resize();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(env.loads.filter((url) => url === 'f-sharp').length, 1);
  // g opens (and fails): f's sharp download stops, f stays on screen.
  const failing = env.viewer.open('g');
  assert.equal(env.signals.get('f-sharp').aborted, true);
  assert.ok(await until(() => env.pending.has('g-first')));
  env.pending.get('g-first').reject(new Error('gone'));
  env.pending.delete('g-first');
  await failing.catch(() => {});
  // The discarded response does not block f's sharp version for good.
  env.signals.delete('f-sharp');
  env.viewer.resize();
  assert.ok(await until(() => env.signals.has('f-sharp')), 'asked again');
});

test('a resize while another photo opens does not upgrade the photo still shown', async (t) => {
  t.after(() => delete globalThis.devicePixelRatio);
  globalThis.devicePixelRatio = 1;
  const env = heldViewer();
  await env.viewer.mount(env.host);
  const opening = env.viewer.open('f');
  assert.ok(await until(() => env.pending.has('f-first')));
  env.release('f-first');
  await opening;
  // g is opening; EXPAND resizes the viewer meanwhile.
  const next = env.viewer.open('g');
  assert.ok(await until(() => env.pending.has('g-first')));
  parts(env.host).picture.clientWidth = 1200;
  env.viewer.resize();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(env.pending.has('f-sharp'), false, 'f is on its way out');
  env.release('g-first');
  await next;
  assert.ok(await until(() => env.pending.has('g-sharp')), 'g gets it');
});

test('a panorama is always decoded at a bounded size', async () => {
  const env = heldViewer();
  const options = [];
  const viewer = createPhotoViewer({
    providerId: 'test',
    name: 'Test',
    sources: SOURCES,
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep() {},
    load: async (url, opts) => {
      options.push(opts);
      return { src: url };
    },
    createRenderer: () => ({
      setImage() {},
      setView() {},
      getView: () => ({ yaw: 0, pitch: 0, fov: 80 }),
      resize() {},
      clear() {},
      destroy() {},
    }),
  });
  await viewer.mount(env.host);
  await viewer.open('a');
  // SOURCES' panoFirst names no size: the viewer still bounds it.
  assert.deepEqual(options[0].resize, [2048, 1024]);
});

test('a header that declares a huge image is refused before anything decodes it', async (t) => {
  const { loadImage } = await import('./photoViewer.js');
  const saved = {
    fetch: globalThis.fetch,
    createImageBitmap: globalThis.createImageBitmap,
  };
  t.after(() => Object.assign(globalThis, saved));
  let decoded = 0;
  globalThis.createImageBitmap = async () => {
    decoded++;
    return { width: 10, height: 10 };
  };
  // A 1 kB PNG that says it is 16,384 × 16,384.
  const png = new Uint8Array(1024);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  png.set(
    [...'IHDR'].map((c) => c.charCodeAt(0)),
    12,
  );
  png.set([0, 0, 0x40, 0, 0, 0, 0x40, 0], 16);
  globalThis.fetch = async () => new Response(png);
  await assert.rejects(
    loadImage('https://x/bomb.png'),
    (error) => error.tooLarge === true,
  );
  assert.equal(decoded, 0, 'never decoded');
});

test('an <img> that turns out too large is refused and let go', async (t) => {
  const { loadImage, MAX_IMAGE_SIDE } = await import('./photoViewer.js');
  const saved = globalThis.Image;
  t.after(() => (globalThis.Image = saved));
  let size = [MAX_IMAGE_SIDE + 1, 100];
  const images = [];
  globalThis.Image = class {
    constructor() {
      images.push(this);
    }
    set src(value) {
      this._src = value;
      if (value)
        queueMicrotask(() => {
          [this.naturalWidth, this.naturalHeight] = size;
          this.onload?.();
        });
    }
    get src() {
      return this._src;
    }
  };
  await assert.rejects(
    loadImage('https://x/a.jpg', { crossOrigin: false }),
    (error) => error.tooLarge === true,
  );
  assert.equal(images.at(-1).src, '', 'its pixels let go');
  size = [4000, 3000];
  const ok = await loadImage('https://x/b.jpg', { crossOrigin: false });
  assert.equal(ok.naturalWidth, 4000);
  // An aborted <img> load stops and rejects.
  size = [10, 10];
  const controller = new AbortController();
  const aborted = loadImage('https://x/c.jpg', {
    crossOrigin: false,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(aborted);
  assert.equal(images.at(-1).src, '', 'its download stops');
});

test('a browser without :fullscreen / :popover-open (Safari < 16.4) still opens a flat photo and hands Esc on', async () => {
  let asked = 0;
  const viewer = createPhotoViewer({
    providerId: 'test',
    name: 'Test',
    sources: SOURCES,
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep() {},
    onEscape: () => ++asked > 0,
    load: async (url) => ({ src: url }),
  });
  const host = fakeHost();
  await viewer.mount(host);
  const root = host.children[0];
  // Safari 16.0–16.3: neither pseudo-class parses, so closest() throws.
  root.closest = (selector) => {
    if (/:fullscreen|:popover-open/.test(selector))
      throw new SyntaxError(`'${selector}' is not a valid selector`);
    return null;
  };
  let failure = null;
  try {
    await viewer.open('f');
  } catch (error) {
    failure = error;
  }
  assert.equal(failure, null, 'opening a flat photo does not throw');
  const event = { key: 'Escape' };
  event.preventDefault = () => {};
  event.stopPropagation = () => {};
  assert.doesNotThrow(() => root.fire('keydown', event), 'Esc does not throw');
  assert.equal(asked, 1, 'Esc reaches the provider');
});

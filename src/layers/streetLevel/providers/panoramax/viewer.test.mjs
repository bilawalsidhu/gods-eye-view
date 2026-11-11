import assert from 'node:assert/strict';
import test from 'node:test';
import { PANORAMAX_SOURCES, createPanoramaxViewer } from './viewer.js';
import { normalizeItem } from './policy.js';
import { fakeHost, until } from '../../../../testSupport/kartaViewFakes.mjs';
import { stacItem } from '../../../../testSupport/panoramaxFixtures.mjs';

const photo = (options) =>
  normalizeItem(stacItem({ lon: 2.35, lat: 48.85, ...options }));

const PHOTOS = {
  flat: photo({ id: 'flat', prevId: 'p0', nextId: 'flat2', heading: 30 }),
  flat2: photo({ id: 'flat2', prevId: 'flat', heading: 40 }),
  pano: photo({ id: 'pano', pano: true, heading: 100, width: 5760 }),
  bigPano: photo({ id: 'bigPano', pano: true, width: 11_000 }),
  smallPano: photo({ id: 'smallPano', pano: true, width: 2048 }),
  email: photo({ id: 'email', producer: 'someone@city.example.fr' }),
};

function fakeRenderer() {
  const view = { yaw: 0, pitch: 0, fov: 80 };
  const images = [];
  return {
    images,
    setImage: (image) => images.push(image),
    setView(next) {
      Object.assign(view, next);
    },
    getView: () => ({ ...view }),
    resize() {},
    clear() {},
    destroy() {},
  };
}

function setup() {
  const loads = [];
  const renderers = [];
  const stepped = [];
  const viewer = createPanoramaxViewer({
    getPhoto: async (id) => {
      if (!PHOTOS[id]) throw new Error('no such picture');
      return PHOTOS[id];
    },
    step: async (from, delta) => (delta < 0 ? from.prevId : from.nextId),
    onStep: (id) => {
      stepped.push(id);
      viewer.open(id).catch(() => {});
    },
    load: async (url, options) => {
      loads.push({ url, ...options });
      return { src: url, width: 1, height: 1 };
    },
    createRenderer: () => {
      const renderer = fakeRenderer();
      renderers.push(renderer);
      return renderer;
    },
  });
  const poses = [];
  viewer.onPose((pose) => poses.push(pose));
  return { viewer, poses, loads, renderers, stepped, host: fakeHost() };
}

const parts = (host) => {
  const root = host.children[0];
  const [picture, canvas, prev, next] = root.children;
  return { root, picture, canvas, prev, next };
};

test('a flat picture shows its SD version with author, licence and a Panoramax link', async () => {
  const { viewer, poses, loads, host } = setup();
  await viewer.mount(host);
  const { root, picture, canvas } = parts(host);
  assert.equal(root.dataset.provider, 'panoramax', 'its colour in the CSS');
  assert.match(root.attributes['aria-label'], /^Panoramax photo/);
  await viewer.open('flat');
  assert.equal(picture.hidden, false);
  assert.equal(canvas.hidden, true);
  assert.equal(
    picture.src,
    'https://panoramax.example.org/pictures/flat/sd.jpg',
  );
  assert.deepEqual(
    loads.map((l) => l.url),
    [PHOTOS.flat.urls.sd],
  );
  const pose = poses.at(-1);
  assert.equal(pose.providerId, 'panoramax');
  assert.equal(pose.bearing, 30);
  assert.equal(pose.isPano, false);
  assert.equal(pose.creator, 'tester');
  assert.equal(pose.license, 'CC BY-SA 4.0');
  assert.equal(pose.sequenceId, 'seq-1');
  assert.equal(
    pose.externalUrl,
    'https://api.panoramax.xyz/#pic=flat&focus=pic',
  );
  assert.equal(viewer.supportsRenderModes(), true);
});

test('no creator in the caption for an account named by an email address', async () => {
  const { viewer, poses, host } = setup();
  await viewer.mount(host);
  await viewer.open('email');
  assert.equal(poses.at(-1).creator, null);
});

test('HD replaces SD only once the viewer is wide enough to use it', async (t) => {
  const { viewer, loads, host } = setup();
  await viewer.mount(host);
  const { picture, root } = parts(host);
  t.after(() => delete globalThis.devicePixelRatio);
  globalThis.devicePixelRatio = 1;
  picture.clientWidth = 400;
  await viewer.open('flat');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(loads.length, 1, 'docked: SD is sharp enough');
  // EXPAND on a wide screen.
  picture.clientWidth = root.clientWidth = 2600;
  viewer.resize();
  assert.ok(await until(() => picture.src === PHOTOS.flat.urls.hd));
  viewer.resize();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    loads.filter((l) => l.url === PHOTOS.flat.urls.hd).length,
    1,
    'asked once',
  );
});

test('a 360° picture shows its SD equirectangular image, then HD shrunk to 4,096 when expanded', async (t) => {
  const { viewer, poses, loads, renderers, host } = setup();
  await viewer.mount(host);
  const { canvas, picture } = parts(host);
  t.after(() => delete globalThis.devicePixelRatio);
  globalThis.devicePixelRatio = 1;
  canvas.clientWidth = 400;
  await viewer.open('pano');
  assert.equal(canvas.hidden, false);
  assert.equal(picture.hidden, true);
  assert.equal(viewer.supportsRenderModes(), false, 'no frame to fit');
  const { signal, ...first } = loads[0];
  assert.deepEqual(first, {
    url: PHOTOS.pano.urls.sd,
    crossOrigin: true,
    resize: [2048, 1024],
    failure: 'The Panoramax photo could not be loaded',
  });
  assert.equal(signal.aborted, false, 'the open can stop it');
  assert.equal(poses.at(-1).isPano, true);
  assert.equal(poses.at(-1).bearing, 100);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(loads.length, 1, 'docked: the 2,048 px SD is enough');
  // Docked on a dense screen the canvas wants more, but the original is
  // megabytes: not until the viewer is expanded.
  canvas.clientWidth = 1800;
  viewer.resize();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(loads.length, 1, 'docked: still SD only');
  const root = canvas.parentNode;
  root.closest = (selector) =>
    selector.includes('sl-viewer-wrap:fullscreen') ? {} : null;
  // EXPAND resizes more than once while the panel settles.
  viewer.resize();
  viewer.resize();
  viewer.resize();
  assert.ok(await until(() => renderers[0].images.length === 2));
  assert.equal(
    loads.filter((l) => l.url === PHOTOS.pano.urls.hd).length,
    1,
    'the original is fetched once',
  );
  const hd = loads.at(-1);
  assert.equal(hd.url, PHOTOS.pano.urls.hd);
  assert.deepEqual(hd.resize, [4096, 2048]);
  assert.equal(hd.timeoutMs, 30_000);
  assert.ok(hd.signal, 'abortable');
});

test('HD panoramas too big to decode, or no bigger than SD, are never fetched; nor while docked', () => {
  const size = [4096, 2048];
  const expanded = { expanded: true };
  assert.equal(
    PANORAMAX_SOURCES.panoSharp(PHOTOS.pano, size, { expanded: false }),
    null,
  );
  assert.equal(PANORAMAX_SOURCES.panoSharp(PHOTOS.pano, size), null);
  assert.equal(
    PANORAMAX_SOURCES.panoSharp(PHOTOS.bigPano, size, expanded),
    null,
  );
  assert.equal(
    PANORAMAX_SOURCES.panoSharp(PHOTOS.smallPano, size, expanded),
    null,
  );
  assert.deepEqual(
    PANORAMAX_SOURCES.panoSharp({ ...PHOTOS.pano, width: 3000 }, size, expanded)
      .resize,
    [3000, 1500],
    'never enlarged',
  );
  // Without an SD derivative the HD one is the first and only.
  const hdOnly = { ...PHOTOS.pano, urls: { ...PHOTOS.pano.urls, sd: null } };
  assert.deepEqual(PANORAMAX_SOURCES.panoFirst(hdOnly), {
    url: hdOnly.urls.hd,
    width: 4096,
    resize: [4096, 2048],
  });
  // …unless it is too big to decode: then no panorama, and the thumbnail.
  const hugeOnly = { ...hdOnly, width: 11_904 };
  assert.equal(PANORAMAX_SOURCES.panoFirst(hugeOnly), null);
  assert.equal(PANORAMAX_SOURCES.hasPano(hugeOnly), false);
  assert.deepEqual(PANORAMAX_SOURCES.flatFirst(hugeOnly).filter(Boolean), [
    hugeOnly.urls.thumb,
  ]);
  assert.equal(PANORAMAX_SOURCES.panoSharp(hdOnly, size, expanded), null);
  assert.equal(PANORAMAX_SOURCES.flatSharp(PHOTOS.flat, 2048), null);
  assert.equal(
    PANORAMAX_SOURCES.flatSharp(PHOTOS.flat, 2049),
    PHOTOS.flat.urls.hd,
  );
  assert.equal(
    PANORAMAX_SOURCES.hasPano({ isPano: true, urls: { sd: null, hd: null } }),
    false,
  );
});

test('› and ‹ follow the picture’s own links; the ends disable the buttons', async () => {
  const { viewer, poses, stepped, host } = setup();
  await viewer.mount(host);
  const { next, prev } = parts(host);
  await viewer.open('flat');
  next.fire('click');
  assert.ok(await until(() => poses.at(-1)?.imageId === 'flat2'));
  assert.deepEqual(stepped, ['flat2']);
  assert.ok(await until(() => next.disabled), 'flat2 is the last');
  assert.equal(prev.disabled, false);
});

test('without WebGL a 360° picture shows its whole equirectangular image flat', async () => {
  const loads = [];
  const viewer = createPanoramaxViewer({
    getPhoto: async () => PHOTOS.pano,
    step: async () => null,
    onStep() {},
    load: async (url) => {
      loads.push(url);
      return { src: url };
    },
    createRenderer: () => {
      throw new Error('no WebGL');
    },
  });
  const host = fakeHost();
  await viewer.mount(host);
  await viewer.open('pano');
  const { picture } = parts(host);
  assert.equal(picture.hidden, false);
  assert.equal(picture.src, PHOTOS.pano.urls.sd);
});

test('a picture whose SD fails falls back to the thumbnail; the original only for the expanded viewer', async () => {
  const tried = [];
  const viewer = createPanoramaxViewer({
    getPhoto: async () => PHOTOS.flat,
    step: async () => null,
    onStep() {},
    load: async (url) => {
      tried.push(url);
      if (!url.endsWith('thumb.jpg')) throw new Error('gone');
      return { src: url };
    },
  });
  const host = fakeHost();
  await viewer.mount(host);
  await viewer.open('flat');
  assert.deepEqual(tried, [PHOTOS.flat.urls.sd, PHOTOS.flat.urls.thumb]);
  assert.equal(parts(host).picture.src, PHOTOS.flat.urls.thumb);
  // Expanded, the original is worth its megabytes.
  tried.length = 0;
  parts(host).root.closest = (selector) =>
    selector.includes('sl-viewer-wrap:fullscreen') ? {} : null;
  await viewer.open('flat');
  assert.deepEqual(tried, [
    PHOTOS.flat.urls.sd,
    PHOTOS.flat.urls.hd,
    PHOTOS.flat.urls.thumb,
  ]);
});

test('a photo with no author to name is captioned with the instance holding it', () => {
  const photo = normalizeItem(
    stacItem({ id: 'x', lon: 1, lat: 2, producer: 'someone@city.example.fr' }),
  );
  photo.via = 'panoramax.ign.fr';
  assert.deepEqual(PANORAMAX_SOURCES.describe(photo), {
    title: 'via panoramax.ign.fr',
    creator: null,
    license: 'CC BY-SA 4.0',
    externalUrl: 'https://api.panoramax.xyz/#pic=x&focus=pic',
  });
  const named = { ...photo, creator: 'Robot8A' };
  assert.equal(PANORAMAX_SOURCES.describe(named).title, null);
});

test('an SD panorama refused for its size is not fetched again as a flat photo', async () => {
  const loads = [];
  const viewer = createPanoramaxViewer({
    getPhoto: async () => PHOTOS.pano,
    step: async () => null,
    onStep() {},
    load: async (url, options = {}) => {
      loads.push({ url, crossOrigin: options.crossOrigin });
      // The picture host's SD file is past the viewer's size limits.
      if (url === PHOTOS.pano.urls.sd)
        throw Object.assign(new Error('too big'), { tooLarge: true });
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
  const host = fakeHost();
  await viewer.mount(host);
  await viewer.open('pano');
  const sdLoads = loads.filter((l) => l.url === PHOTOS.pano.urls.sd);
  assert.equal(sdLoads.length, 1, 'tried once, as a bitmap, and refused');
  assert.equal(sdLoads[0].crossOrigin, true);
  const { picture } = parts(host);
  assert.equal(picture.hidden, false, 'the flat fallback shows');
  assert.notEqual(picture.src, PHOTOS.pano.urls.sd);
  // Opened again later: the refused file is still not asked for.
  await viewer.open('pano');
  assert.equal(loads.filter((l) => l.url === PHOTOS.pano.urls.sd).length, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createKartaViewViewer, loadImage, panoSizeFor } from './viewer.js';
import { fakeHost, until } from '../../../../testSupport/kartaViewFakes.mjs';

const PHOTOS = {
  flat1: {
    id: 'flat1',
    sequenceId: 's1',
    sequenceIndex: 1,
    lon: -83.04,
    lat: 42.33,
    heading: 90,
    isPano: false,
    capturedAt: Date.UTC(2016, 7, 23),
    urls: {
      view: 'https://storage2.openstreetcam.org/lth/a.jpg',
      full: 'https://storage2.openstreetcam.org/proc/a.jpg',
      pano: null,
    },
  },
  flat2: {
    id: 'flat2',
    sequenceId: 's1',
    sequenceIndex: 2,
    lon: -83.0401,
    lat: 42.33,
    heading: 92,
    isPano: false,
    capturedAt: Date.UTC(2016, 7, 23),
    urls: {
      view: 'https://storage2.openstreetcam.org/lth/b.jpg',
      full: 'https://storage2.openstreetcam.org/proc/b.jpg',
      pano: null,
    },
  },
  pano1: {
    id: 'pano1',
    sequenceId: 's2',
    sequenceIndex: 7,
    lon: 106.84,
    lat: -6.19,
    heading: 150,
    isPano: true,
    capturedAt: Date.UTC(2022, 2, 21),
    urls: {
      view: 'https://storage13.openstreetcam.org/lth/p.jpg',
      full: 'https://storage13.openstreetcam.org/wrapped_proc/p.jpg',
      pano: 'https://storage13.openstreetcam.org/wrapped_proc/p.jpg',
    },
  },
  pano2: {
    id: 'pano2',
    sequenceId: 's2',
    sequenceIndex: 8,
    lon: 106.8401,
    lat: -6.19,
    heading: 152,
    isPano: true,
    capturedAt: Date.UTC(2022, 2, 21),
    urls: {
      view: 'https://storage13.openstreetcam.org/lth/q.jpg',
      full: 'https://storage13.openstreetcam.org/wrapped_proc/q.jpg',
      pano: 'https://storage13.openstreetcam.org/wrapped_proc/q.jpg',
    },
  },
};

function fakeRenderer(canvas) {
  const view = { yaw: 0, pitch: 0, fov: 80 };
  return {
    canvas,
    images: [],
    hiddenAtSetImage: [],
    setImage(image) {
      this.images.push(image.src);
      // A hidden canvas measures 0×0: sizing it then gives a 1×1 buffer.
      this.hiddenAtSetImage.push(canvas?.hidden);
    },
    setView(next) {
      Object.assign(view, next);
    },
    getView: () => ({ ...view }),
    resize() {},
    clear() {},
    destroy() {
      this.destroyed = true;
    },
  };
}

PHOTOS.pano2 = {
  ...PHOTOS.pano1,
  id: 'pano2',
  sequenceIndex: 8,
  urls: {
    view: 'https://storage13.openstreetcam.org/lth/p2.jpg',
    full: 'https://storage13.openstreetcam.org/wrapped_proc/p2.jpg',
    pano: 'https://storage13.openstreetcam.org/wrapped_proc/p2.jpg',
  },
};

function setup({
  failLoads = [],
  rendererThrows = false,
  steps = {},
  failSteps = false,
  hold = () => false,
} = {}) {
  const loads = [];
  const held = [];
  const closed = [];
  const renderers = [];
  const stepped = [];
  const asked = [];
  const attempts = { renderer: 0 };
  const viewer = createKartaViewViewer({
    getPhoto: async (id) => {
      if (!PHOTOS[id]) throw new Error('no such photo');
      return PHOTOS[id];
    },
    step: async (photo, delta) => {
      asked.push(`${photo.id}:${delta}`);
      if (failSteps) throw new Error('KartaView did not answer in time');
      return steps[`${photo.id}:${delta}`] ?? null;
    },
    // The core opens what ‹ › chose; here the adapter is opened directly.
    onStep: (id) => {
      stepped.push(id);
      viewer.open(id).catch(() => {});
    },
    load: async (url, options) => {
      loads.push({ url, crossOrigin: options?.crossOrigin });
      if (failLoads.some((part) => url.includes(part)))
        throw new Error('The KartaView photo could not be loaded');
      // A decoded bitmap: close() frees it.
      const image = { src: url, close: () => closed.push(url) };
      if (!hold(url)) return image;
      return new Promise((resolve) => held.push(() => resolve(image)));
    },
    createRenderer: (canvas) => {
      attempts.renderer++;
      if (rendererThrows) throw new Error('WebGL is unavailable');
      const renderer = fakeRenderer(canvas);
      renderers.push(renderer);
      return renderer;
    },
  });
  const poses = [];
  viewer.onPose((pose) => poses.push(pose));
  const host = fakeHost();
  return {
    viewer,
    poses,
    host,
    loads,
    renderers,
    stepped,
    asked,
    attempts,
    held,
    closed,
  };
}

const parts = (host) => {
  const root = host.children[0];
  const [picture, canvas, prev, next] = root.children;
  return { root, picture, canvas, prev, next };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a flat photo shows its 1280 px version, then the sharp one, with a pose facing its heading', async () => {
  const { viewer, poses, host, loads } = setup({
    steps: { 'flat1:1': 'flat2', 'flat1:-1': 'flat0' },
  });
  await viewer.mount(host);
  const { picture, canvas, prev, next } = parts(host);
  picture.clientWidth = 1600; // expanded: the sharp version is wanted
  assert.equal(prev.disabled, true, 'nothing to step through yet');
  await viewer.open('flat1');
  assert.equal(picture.hidden, false);
  assert.equal(canvas.hidden, true);
  assert.equal(prev.disabled, false);
  assert.equal(next.disabled, false);
  const pose = poses.at(-1);
  assert.deepEqual(
    {
      providerId: pose.providerId,
      imageId: pose.imageId,
      position: pose.position,
      bearing: pose.bearing,
      tilt: pose.tilt,
      isPano: pose.isPano,
      sequenceId: pose.sequenceId,
      capturedAt: pose.capturedAt,
      title: pose.title,
    },
    {
      providerId: 'kartaview',
      imageId: 'flat1',
      position: { lon: -83.04, lat: 42.33 },
      bearing: 90,
      tilt: 0,
      isPano: false,
      sequenceId: 's1',
      capturedAt: Date.UTC(2016, 7, 23),
      title: null,
    },
  );
  assert.match(pose.externalUrl, /^https:\/\/cdn\.kartaview\.org\/pr:sharp\//);
  // The proxy's 1,280 px version first: KartaView's own can be 1.7 MB.
  assert.match(
    loads[0].url,
    /^https:\/\/cdn\.kartaview\.org\/.*rs:fit:1280:1280/,
  );
  assert.equal(loads[0].crossOrigin, false, 'an <img> needs no CORS');
  await settle();
  assert.match(
    loads[1].url,
    /^https:\/\/cdn\.kartaview\.org\/.*rs:fit:2560:2560/,
  );
  assert.equal(picture.src, loads[1].url, 'upgraded to the sharp version');
  assert.equal(viewer.supportsRenderModes(), true);
  viewer.setRenderMode('fill');
  assert.equal(picture.style.objectFit, 'cover');
});

test('a failing image proxy falls back to the photo on KartaView storage', async () => {
  const { viewer, host, loads } = setup({ failLoads: ['cdn.kartaview.org'] });
  await viewer.mount(host);
  await viewer.open('flat1');
  assert.equal(loads[1].url, PHOTOS.flat1.urls.view);
  assert.equal(parts(host).picture.hidden, false);
  assert.equal(parts(host).picture.src, PHOTOS.flat1.urls.view);
});

test('a 360° photo shows on the panorama, preview first; dragging turns the bearing', async () => {
  const { viewer, poses, host, loads, renderers } = setup();
  await viewer.mount(host);
  await viewer.open('pano1');
  const { picture, canvas } = parts(host);
  assert.equal(canvas.hidden, false);
  assert.equal(picture.hidden, true);
  assert.match(loads[0].url, /rs:fit:1024:512/);
  assert.equal(loads[0].crossOrigin, true, 'WebGL textures need CORS');
  assert.equal(poses.at(-1).isPano, true);
  assert.equal(poses.at(-1).bearing, 150);
  assert.equal(viewer.supportsRenderModes(), false, 'no frame to fit');
  await settle();
  // Docked (400 px at 80°), 2,048 px is all it can show.
  assert.match(renderers[0].images.at(-1), /rs:fit:2048:1024/);
  // Drag left by a quarter of the width: the view turns right.
  const frames = [];
  globalThis.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  try {
    canvas.fire('pointerdown', {
      button: 0,
      pointerId: 1,
      clientX: 200,
      clientY: 100,
    });
    canvas.fire('pointermove', { pointerId: 1, clientX: 100, clientY: 100 });
    canvas.fire('pointerup', { pointerId: 1 });
    frames.forEach((callback) => callback());
  } finally {
    delete globalThis.requestAnimationFrame;
  }
  const turned = poses.at(-1).bearing;
  assert.ok(turned > 150 && turned < 360, `bearing ${turned} turned right`);
});

test('without WebGL, or when the panorama fails, a 360° photo shows its front view', async () => {
  const noGl = setup({ rendererThrows: true });
  await noGl.viewer.mount(noGl.host);
  await noGl.viewer.open('pano1');
  assert.equal(parts(noGl.host).picture.hidden, false);
  assert.equal(noGl.loads[0].url, PHOTOS.pano1.urls.view);
  assert.equal(noGl.poses.at(-1).isPano, false);
  await settle();
  assert.equal(
    noGl.loads.length,
    1,
    'the equirectangular image never replaces it',
  );

  const broken = setup({ failLoads: ['cdn.kartaview.org'] });
  await broken.viewer.mount(broken.host);
  await broken.viewer.open('pano1');
  assert.equal(parts(broken.host).picture.hidden, false);
  assert.equal(broken.poses.at(-1).imageId, 'pano1');
});

test('‹ › and the arrow keys step along the sequence; ends disable at once', async () => {
  const { viewer, poses, host, stepped, asked } = setup({
    steps: { 'flat1:1': 'flat2', 'flat2:-1': 'flat1' },
  });
  await viewer.mount(host);
  await viewer.open('flat1');
  const { root, prev, next } = parts(host);
  assert.ok(
    await until(() => prev.disabled),
    'flat1 is the first photo: known up front',
  );
  assert.equal(next.disabled, false);
  next.fire('click');
  assert.ok(await until(() => poses.at(-1).imageId === 'flat2'));
  assert.deepEqual(stepped, ['flat2'], 'the core is asked to open it');
  assert.ok(await until(() => next.disabled), 'flat2 is the last photo');
  assert.equal(prev.disabled, false);
  // A modified arrow, then a plain → (at the end: it only asks). Presses run
  // in turn, so once → has asked, a stepping ⌘← would have asked first.
  const before = asked.length;
  root.fire('keydown', { key: 'ArrowLeft', metaKey: true });
  root.fire('keydown', { key: 'ArrowRight' });
  assert.ok(await until(() => asked.length > before));
  await settle();
  assert.deepEqual(
    asked.slice(before),
    ['flat2:1'],
    'modified arrows are not ours',
  );
  assert.equal(poses.at(-1).imageId, 'flat2');
  root.fire('keydown', { key: 'ArrowLeft' });
  assert.ok(await until(() => poses.at(-1).imageId === 'flat1'));
});

test('quick presses each step on from the photo the last one chose', async () => {
  const chain = { 'flat1:1': 'flat2', 'flat2:1': 'pano1' };
  const { viewer, host, stepped } = setup({
    steps: chain,
    rendererThrows: true,
  });
  await viewer.mount(host);
  await viewer.open('flat1');
  const { next } = parts(host);
  next.fire('click');
  next.fire('click');
  assert.ok(await until(() => stepped.length === 2), `stepped ${stepped}`);
  assert.deepEqual(stepped, ['flat2', 'pano1']);
});

test('a newer open wins; close hides the photo; unmount tears down the panorama', async () => {
  const { viewer, poses, host, renderers } = setup();
  await viewer.mount(host);
  const first = viewer.open('pano1');
  const second = viewer.open('flat1');
  await Promise.all([first, second]);
  assert.deepEqual(
    poses.map((pose) => pose.imageId),
    ['flat1'],
    'the overtaken panorama never posed',
  );
  assert.equal(renderers.length, 0, 'nor built a WebGL context');
  await viewer.open('pano1');
  viewer.close();
  const { picture, canvas, root } = parts(host);
  assert.equal(canvas.hidden, true);
  assert.equal(picture.hidden, true);
  assert.equal(root.dataset.kind, '');
  await assert.rejects(viewer.open('nope'), /no such photo/);
  viewer.unmount();
  assert.equal(host.children.length, 0);
  assert.equal(renderers[0].destroyed, true);
  await assert.rejects(viewer.open('flat1'), /not mounted/);
});

test('a panorama is put on screen before its image is sized into the canvas', async () => {
  const { viewer, host, renderers } = setup();
  await viewer.mount(host);
  await viewer.open('flat1');
  await viewer.open('pano1');
  await settle();
  assert.deepEqual(renderers[0].hiddenAtSetImage, [false, false]);
});

test('a step that gets no answer is not the end of the sequence', async () => {
  const { viewer, host, poses, asked } = setup({ failSteps: true });
  await viewer.mount(host);
  await viewer.open('flat1');
  const { next } = parts(host);
  next.disabled = false;
  // The ends check asked once already; the press asks again and fails.
  const asks = () => asked.filter((ask) => ask === 'flat1:1').length;
  next.fire('click');
  assert.ok(await until(() => asks() === 2), 'the press asked');
  await settle();
  assert.equal(next.disabled, false, 'still enabled: try again');
  assert.equal(poses.at(-1).imageId, 'flat1');
});

test('the keyboard looks around a panorama: Shift+arrows turn, ↑ ↓ tilt, + − zoom', async (t) => {
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  t.after(() => delete globalThis.requestAnimationFrame);
  const { viewer, host, renderers, stepped, asked } = setup({
    steps: { 'pano1:1': 'flat1' },
  });
  await viewer.mount(host);
  await viewer.open('pano1');
  const { root } = parts(host);
  const view = () => renderers[0].getView();
  const before = asked.length;
  root.fire('keydown', { key: 'ArrowRight', shiftKey: true });
  assert.ok(view().yaw > 0, 'turned right');
  root.fire('keydown', { key: 'ArrowUp' });
  assert.ok(view().pitch > 0, 'looked up');
  const fov = view().fov;
  root.fire('keydown', { key: '+' });
  assert.ok(view().fov < fov, 'zoomed in');
  root.fire('keydown', { key: '-' });
  root.fire('keydown', { key: '-' });
  assert.ok(view().fov > fov, 'zoomed out');
  root.fire('keydown', { key: 'ArrowRight' });
  assert.ok(await until(() => stepped.length === 1));
  assert.deepEqual(stepped, ['flat1'], 'a plain arrow still steps');
  // Only that press asked, then flat1's ends check: a Shift+→ that stepped
  // would have sent the plain → on from flat1.
  assert.ok(await until(() => asked.slice(before).length >= 3));
  await settle();
  assert.deepEqual(
    asked.slice(before).sort(),
    ['flat1:-1', 'flat1:1', 'pano1:1'],
    'none of the others stepped',
  );
});

test('two fingers pinch the panorama’s zoom', async () => {
  const { viewer, host, renderers } = setup();
  await viewer.mount(host);
  await viewer.open('pano1');
  const { canvas } = parts(host);
  const before = renderers[0].getView().fov;
  canvas.fire('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    clientX: 100,
    clientY: 100,
  });
  canvas.fire('pointerdown', {
    pointerId: 2,
    pointerType: 'touch',
    clientX: 140,
    clientY: 100,
  });
  canvas.fire('pointermove', {
    pointerId: 2,
    pointerType: 'touch',
    clientX: 180,
    clientY: 100,
  });
  assert.ok(renderers[0].getView().fov < before, 'spread zooms in');
  canvas.fire('pointerup', { pointerId: 1 });
  canvas.fire('pointerup', { pointerId: 2 });
});

test('a lost WebGL context drops the panorama and shows the photo again on a new one', async () => {
  const { viewer, host, renderers, poses, stepped } = setup();
  await viewer.mount(host);
  await viewer.open('pano1');
  const lost = parts(host).canvas;
  lost.fire('webglcontextlost');
  assert.equal(renderers[0].destroyed, true);
  // A lost canvas only ever gives back its lost context: a new element.
  assert.notEqual(parts(host).canvas, lost);
  assert.deepEqual(stepped, ['pano1'], 'reopened through the core');
  assert.ok(await until(() => renderers.length === 2), 'a new renderer');
  assert.equal(renderers[1].canvas, parts(host).canvas);
  assert.equal(poses.at(-1).imageId, 'pano1');
  assert.equal(parts(host).canvas.hidden, false);
});

test('a context lost while a newer photo opens leaves that open alone', async () => {
  const { viewer, host, stepped } = setup();
  await viewer.mount(host);
  await viewer.open('pano1');
  const opening = viewer.open('flat1');
  parts(host).canvas.fire('webglcontextlost');
  await opening;
  assert.deepEqual(stepped, [], 'no reopen of the old panorama');
  assert.equal(parts(host).picture.hidden, false);
});

test('a WebGL failure only lasts until the viewer is mounted again', async () => {
  let fail = true;
  const built = [];
  const viewer = createKartaViewViewer({
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep() {},
    load: async (url) => ({ src: url }),
    createRenderer: (canvas) => {
      if (fail) throw new Error('WebGL is unavailable');
      const renderer = fakeRenderer(canvas);
      built.push(renderer);
      return renderer;
    },
  });
  const host = fakeHost();
  await viewer.mount(host);
  await viewer.open('pano1');
  assert.equal(parts(host).picture.hidden, false, 'front view');
  viewer.unmount();
  fail = false;
  const again = fakeHost();
  await viewer.mount(again);
  await viewer.open('pano1');
  assert.equal(built.length, 1);
  assert.equal(parts(again).canvas.hidden, false);
});

/** Flat photos a → d of one drive, for the tests that hold loads back. */
const DRIVE = Object.fromEntries(
  ['a', 'b', 'c', 'd'].map((id, index) => [
    id,
    {
      id,
      sequenceId: 'drive',
      sequenceIndex: index,
      lon: 0.1 + index * 0.0001,
      lat: 0.1,
      heading: 0,
      isPano: false,
      capturedAt: 0,
      urls: {
        view: `https://storage2.openstreetcam.org/lth/${id}.jpg`,
        full: `https://storage2.openstreetcam.org/proc/${id}.jpg`,
        pano: null,
      },
    },
  ]),
);
const DRIVE_ORDER = Object.keys(DRIVE);

/** Which drive photo, at which size, an image address shows. */
function shows(src) {
  const proxied =
    /^https:\/\/cdn\.kartaview\.org\/pr:sharp\/rs:fit:(\d+):\d+\/([\w-]+)$/.exec(
      src || '',
    );
  const url = proxied ? Buffer.from(proxied[2], 'base64url').toString() : src;
  const id = /\/(\w+)\.jpg$/.exec(url || '')?.[1] ?? null;
  return proxied ? `${id}@${proxied[1]}` : id;
}

/**
 * A viewer whose photo loads (and, with `slowSteps`, step answers) wait for
 * the test. ‹ › open through a stand-in core that, like the real one, awaits
 * a tick (the viewer mount) before it opens the photo.
 */
function heldSetup({ slowSteps = false } = {}) {
  const loads = [];
  const asks = [];
  const stepped = [];
  const shown = [];
  const viewer = createKartaViewViewer({
    getPhoto: async (id) => {
      if (!DRIVE[id]) throw new Error('no such photo');
      return DRIVE[id];
    },
    step: (photo, delta) => {
      const answer = DRIVE_ORDER[DRIVE_ORDER.indexOf(photo.id) + delta] ?? null;
      if (!slowSteps) return Promise.resolve(answer);
      return new Promise((resolve) =>
        asks.push({ key: `${photo.id}:${delta}`, resolve }),
      );
    },
    onStep: async (id) => {
      stepped.push(id);
      await settle();
      viewer.open(id).catch(() => {});
    },
    onShown: (photo) => shown.push(photo.id),
    load: (url) =>
      new Promise((resolve, reject) =>
        loads.push({
          url,
          shows: shows(url),
          resolve: () => resolve({ src: url }),
          reject: () =>
            reject(new Error('The KartaView photo could not be loaded')),
        }),
      ),
    createRenderer: () => {
      throw new Error('no WebGL in Node');
    },
  });
  const poses = [];
  viewer.onPose((pose) => poses.push(pose.imageId));
  const host = fakeHost();
  /** Let the load showing `what` (e.g. 'a@1280') finish. */
  const release = async (what) => {
    assert.ok(
      await until(() => loads.some((load) => load.shows === what)),
      `${what} is loading: ${loads.map((load) => load.shows)}`,
    );
    const at = loads.findIndex((load) => load.shows === what);
    loads.splice(at, 1)[0].resolve();
    await settle();
  };
  /** Answer the oldest pending step ask for `key` (e.g. 'a:1'). */
  const answer = async (key, value) => {
    assert.ok(await until(() => asks.some((ask) => ask.key === key)));
    const at = asks.findIndex((ask) => ask.key === key);
    asks.splice(at, 1)[0].resolve(value);
    await settle();
  };
  return { viewer, host, loads, asks, stepped, shown, poses, release, answer };
}

test('quick presses while the next photo is still loading each step on from the last one chosen', async () => {
  const { viewer, host, stepped, release } = heldSetup();
  await viewer.mount(host);
  const opening = viewer.open('a');
  await release('a@1280');
  await opening;
  const { next } = parts(host);
  assert.ok(await until(() => !next.disabled));
  // b, c and d never load: each press steps on from the photo on its way.
  next.fire('click');
  next.fire('click');
  next.fire('click');
  assert.ok(await until(() => stepped.length >= 3), `stepped ${stepped}`);
  await settle();
  assert.deepEqual(stepped, ['b', 'c', 'd']);
});

test('a slow sharp version of an older photo never replaces the newer photo', async () => {
  const { viewer, host, shown, poses, release } = heldSetup();
  await viewer.mount(host);
  // An expanded viewer, so the sharp version is wanted.
  parts(host).picture.clientWidth = 1600;
  const first = viewer.open('a');
  await release('a@1280');
  await first;
  const second = viewer.open('b');
  await release('b@1280');
  await second;
  const { picture } = parts(host);
  assert.equal(shows(picture.src), 'b@1280');
  await release('a@2560'); // a's upgrade, overtaken
  assert.equal(shows(picture.src), 'b@1280', 'a never comes back');
  await release('b@2560');
  assert.equal(shows(picture.src), 'b@2560', 'b’s own upgrade lands');
  assert.deepEqual(shown, ['a', 'b']);
  assert.deepEqual(poses, ['a', 'b']);
});

test('an overtaken flat open never shows, nor tells the provider it did', async () => {
  const { viewer, host, shown, poses, loads, release } = heldSetup();
  await viewer.mount(host);
  const first = viewer.open('a');
  assert.ok(await until(() => loads.length === 1), 'a is loading');
  const second = viewer.open('b');
  await release('b@1280');
  await second;
  await release('a@1280');
  await first;
  const { picture } = parts(host);
  assert.equal(shows(picture.src), 'b@1280');
  assert.deepEqual(poses, ['b']);
  assert.deepEqual(shown, ['b'], 'onShown only for the photo on screen');
});

test('a photo still loading when the viewer closes stays closed', async () => {
  const { viewer, host, shown, poses, loads, release } = heldSetup();
  await viewer.mount(host);
  const opening = viewer.open('a');
  assert.ok(await until(() => loads.length === 1), 'a is loading');
  viewer.close();
  await release('a@1280');
  await opening;
  const { picture, root } = parts(host);
  assert.equal(picture.hidden, true);
  assert.equal(root.dataset.kind, '');
  assert.deepEqual(poses, []);
  assert.deepEqual(shown, []);
});

test('an ends check for an earlier photo does not disable › on the photo now showing', async () => {
  const { viewer, host, release, answer } = heldSetup({ slowSteps: true });
  await viewer.mount(host);
  const first = viewer.open('a');
  await release('a@1280');
  await first;
  const second = viewer.open('c');
  await release('c@1280');
  await second;
  const { prev, next } = parts(host);
  await answer('c:-1', 'b');
  await answer('c:1', 'd');
  // a's check answers last, saying nothing lies before or after it.
  await answer('a:-1', null);
  await answer('a:1', null);
  assert.equal(prev.disabled, false);
  assert.equal(next.disabled, false, 'c still has a next photo');
});

test('a press whose answer comes after another photo was opened is dropped', async () => {
  const { viewer, host, stepped, release, answer, asks } = heldSetup({
    slowSteps: true,
  });
  await viewer.mount(host);
  const first = viewer.open('a');
  await release('a@1280');
  await first;
  await answer('a:-1', null);
  await answer('a:1', 'b');
  const { next } = parts(host);
  next.disabled = false;
  next.fire('click');
  assert.ok(await until(() => asks.some((ask) => ask.key === 'a:1')));
  // The user picks another photo meanwhile.
  const other = viewer.open('d');
  await release('d@1280');
  await other;
  await answer('a:1', 'b');
  await settle();
  assert.deepEqual(stepped, [], 'the old press does not open b over d');
});

test('a failed open does not become the photo ‹ › step from', async () => {
  const { viewer, host, stepped } = setup({ steps: { 'flat1:1': 'flat2' } });
  await viewer.mount(host);
  await viewer.open('flat1');
  await assert.rejects(viewer.open('nope'), /no such photo/);
  parts(host).next.disabled = false;
  parts(host).next.fire('click');
  assert.ok(await until(() => stepped.length === 1));
  assert.deepEqual(stepped, ['flat2'], 'from the photo still showing');
});

test('WebGL is tried once per mount, not again for every 360° photo', async () => {
  const { viewer, host, attempts } = setup({ rendererThrows: true });
  await viewer.mount(host);
  await viewer.open('pano1');
  await viewer.open('pano2');
  assert.equal(attempts.renderer, 1);
  assert.equal(parts(host).picture.hidden, false, 'front views instead');
});

test('a step button that disables under the keyboard hands focus to the viewer', async () => {
  const { viewer, host } = setup();
  await viewer.mount(host);
  const { root, prev, next } = parts(host);
  let focused = 0;
  root.focus = () => focused++;
  next.ownerDocument = { activeElement: next };
  prev.ownerDocument = { activeElement: root };
  await viewer.open('flat1');
  assert.ok(await until(() => next.disabled && prev.disabled));
  assert.equal(focused, 1, 'only for the focused button');
});

test('› to another 360° photo keeps the look direction; opening one afresh faces its heading', async (t) => {
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  t.after(() => delete globalThis.requestAnimationFrame);
  const { viewer, host, renderers, poses } = setup({
    steps: { 'pano1:1': 'pano2' },
  });
  await viewer.mount(host);
  await viewer.open('pano1');
  const { root, next } = parts(host);
  root.fire('keydown', { key: 'ArrowRight', shiftKey: true });
  const yaw = renderers[0].getView().yaw;
  assert.ok(yaw > 0);
  next.fire('click');
  assert.ok(await until(() => poses.at(-1).imageId === 'pano2'));
  assert.equal(renderers[0].getView().yaw, yaw, 'still looking the same way');
  await viewer.open('pano1');
  assert.equal(renderers[0].getView().yaw, 0, 'a fresh open faces ahead');
});

/** A viewer whose loads for `held` URLs wait until `release()`. */
function heldPanoSetup(held) {
  const renderers = [];
  const stepped = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const viewer = createKartaViewViewer({
    getPhoto: async (id) => PHOTOS[id],
    step: async () => null,
    onStep: (id) => {
      stepped.push(id);
      viewer.open(id).catch(() => {});
    },
    load: async (url) => {
      if (held.some((part) => url.includes(part))) await gate;
      return { src: url };
    },
    createRenderer: (canvas) => {
      const renderer = fakeRenderer(canvas);
      renderers.push(renderer);
      return renderer;
    },
  });
  const poses = [];
  viewer.onPose((pose) => poses.push(pose));
  return { viewer, renderers, stepped, poses, host: fakeHost(), release };
}

const pano2Preview = Buffer.from(
  'https://storage13.openstreetcam.org/wrapped_proc/p2.jpg',
).toString('base64url');

test('a context lost while a newer panorama loads shows that one on a new canvas, not a black viewer', async () => {
  const { viewer, renderers, poses, host, release, stepped } = heldPanoSetup([
    pano2Preview,
  ]);
  await viewer.mount(host);
  await viewer.open('pano1');
  const opening = viewer.open('pano2');
  await new Promise((resolve) => setTimeout(resolve, 0));
  parts(host).canvas.fire('webglcontextlost');
  release();
  await opening;
  assert.equal(
    poses.at(-1).imageId,
    'pano2',
    'the newer panorama is on screen',
  );
  assert.equal(poses.at(-1).isPano, true);
  assert.deepEqual(stepped, [], 'its own open, not a reopen of the old one');
  assert.equal(renderers.length, 2, 'drawn by a new renderer');
  assert.equal(renderers[1].canvas, parts(host).canvas);
  assert.equal(parts(host).canvas.hidden, false);
});

test('a second context loss, on the new canvas, reopens again; the new canvas still drags', async (t) => {
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  t.after(() => delete globalThis.requestAnimationFrame);
  const { viewer, host, renderers, stepped, poses } = setup();
  await viewer.mount(host);
  await viewer.open('pano1');
  parts(host).canvas.fire('webglcontextlost');
  assert.ok(await until(() => renderers.length === 2));
  parts(host).canvas.fire('webglcontextlost');
  assert.ok(await until(() => renderers.length === 3), 'reopened twice');
  assert.deepEqual(stepped, ['pano1', 'pano1']);
  assert.equal(renderers[2].canvas, parts(host).canvas);
  const canvas = parts(host).canvas;
  const before = poses.at(-1).bearing;
  canvas.fire('pointerdown', {
    button: 0,
    pointerId: 7,
    pointerType: 'mouse',
    clientX: 200,
    clientY: 100,
  });
  canvas.fire('pointermove', { pointerId: 7, clientX: 100, clientY: 100 });
  canvas.fire('pointerup', { pointerId: 7 });
  assert.ok(await until(() => poses.at(-1).bearing !== before), 'dragged');
});

test('a context loss keeps where the user was looking', async () => {
  const { viewer, host, renderers } = setup();
  await viewer.mount(host);
  await viewer.open('pano1');
  renderers[0].setView({ yaw: 70, pitch: 12, fov: 60 });
  parts(host).canvas.fire('webglcontextlost');
  assert.ok(await until(() => renderers.length === 2));
  assert.deepEqual(renderers[1].getView(), { yaw: 70, pitch: 12, fov: 60 });
});

test('the panorama is as sharp as the viewer needs: 2,048 docked, 4,096 once expanded', async () => {
  assert.deepEqual(panoSizeFor(400, 80), [2048, 1024]);
  assert.deepEqual(panoSizeFor(1400, 80), [4096, 2048]);
  const { viewer, host, renderers } = setup();
  await viewer.mount(host);
  await viewer.open('pano1');
  assert.ok(await until(() => renderers[0].images.length === 2));
  assert.match(renderers[0].images[1], /rs:fit:2048:1024/);
  // Expanded: the panel tells the viewer it resized.
  parts(host).canvas.clientWidth = 1400;
  viewer.resize();
  assert.ok(await until(() => renderers[0].images.length === 3));
  assert.match(renderers[0].images[2], /rs:fit:4096:2048/);
  viewer.resize();
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(renderers[0].images.length, 3, 'not again once sharp');
});

test('a CORS image is decoded off the main thread into an ImageBitmap where the browser can', async (t) => {
  // A blob whose header names no size (the viewer then reads none).
  const fakeBlob = {
    size: 4,
    slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
  };
  const saved = {
    fetch: globalThis.fetch,
    bitmap: globalThis.createImageBitmap,
  };
  t.after(() => {
    globalThis.fetch = saved.fetch;
    globalThis.createImageBitmap = saved.bitmap;
  });
  const fetched = [];
  globalThis.fetch = async (url, init) => {
    fetched.push({ url, mode: init.mode });
    return url.includes('gone')
      ? { ok: false, status: 409 }
      : { ok: true, blob: async () => fakeBlob };
  };
  globalThis.createImageBitmap = async (blob) => ({
    blob,
    width: 4096,
    height: 2048,
  });
  const bitmap = await loadImage('https://cdn.kartaview.org/a', {
    crossOrigin: true,
  });
  assert.deepEqual(bitmap, { blob: fakeBlob, width: 4096, height: 2048 });
  assert.deepEqual(fetched, [
    { url: 'https://cdn.kartaview.org/a', mode: 'cors' },
  ]);
  await assert.rejects(
    loadImage('https://cdn.kartaview.org/gone', { crossOrigin: true }),
    /could not be loaded/,
  );
});

test('a docked viewer keeps the 1,280 px photo; expanding it brings the 2,560 px one', async () => {
  const { viewer, host, loads } = setup();
  await viewer.mount(host);
  await viewer.open('flat1');
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(loads.length, 1, 'no 2,560 px download for a 400 px frame');
  parts(host).picture.clientWidth = 1600;
  viewer.resize();
  assert.ok(await until(() => loads.length === 2));
  assert.match(loads[1].url, /rs:fit:2560:2560/);
  assert.equal(parts(host).picture.src, loads[1].url);
  viewer.resize();
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(loads.length, 2, 'once only');
});

test('resizes while a sharper panorama loads start no second load; the last size wins once it lands', async () => {
  let first = true;
  const { viewer, host, loads, renderers, held } = setup({
    hold: (url) => {
      const holdIt = first && url.includes('rs:fit:2048');
      if (holdIt) first = false;
      return holdIt;
    },
  });
  await viewer.mount(host);
  await viewer.open('pano1');
  assert.ok(await until(() => held.length === 1));
  // The panel animates open: a burst of resizes while 2,048 px loads.
  parts(host).canvas.clientWidth = 1400;
  for (let i = 0; i < 5; i++) viewer.resize();
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(loads.length, 2, 'the preview and the one 2,048 px load');
  held[0]();
  assert.ok(await until(() => renderers[0].images.length === 3));
  assert.match(renderers[0].images[1], /rs:fit:2048:1024/);
  assert.match(renderers[0].images[2], /rs:fit:4096:2048/);
  for (let i = 0; i < 4; i++) await settle();
  assert.equal(loads.length, 3, 'one more load, for the size asked last');
});

test('a preview or sharper version nobody will draw is freed, not left decoded', async () => {
  const { viewer, host, renderers, held, closed } = setup({
    hold: (url) => /rs:fit:(1024|2048):/.test(url),
  });
  await viewer.mount(host);
  // pano1's preview is still loading when flat1 opens over it.
  const overtaken = viewer.open('pano1');
  assert.ok(await until(() => held.length === 1));
  await viewer.open('flat1');
  held[0]();
  await overtaken;
  assert.deepEqual(closed.length, 1);
  assert.match(closed[0], /rs:fit:1024/, 'the overtaken preview');
  // pano1 shows; its sharp version lands after flat1 replaced it.
  const shown = viewer.open('pano1');
  assert.ok(await until(() => held.length === 2));
  held[1]();
  await shown;
  assert.ok(await until(() => held.length === 3));
  await viewer.open('flat1');
  held[2]();
  assert.ok(await until(() => closed.length === 2));
  assert.match(closed[1], /rs:fit:2048/, 'the overtaken sharp version');
  assert.equal(renderers[0].images.length, 1, 'only the preview was drawn');
});

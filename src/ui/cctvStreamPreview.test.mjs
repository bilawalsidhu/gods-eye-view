// src/ui/cctvStreamPreview.test.mjs — a stream camera's card plays the video
// the map's projection decodes: its top image shows that stream's frames,
// says it is acquiring until one is drawn (never LIVE · OK over an empty
// box), and falls back to the camera's frame when the stream cannot play.
// The dock paints the same decoder, and a pin keeps a drawn frame.
import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSameNode } from '../testSupport/domAssert.mjs';
import { createPinia } from 'pinia';
import { createApp, h, nextTick } from 'vue';
import { CctvControls } from './cctvControls.js';
import { useCctvStore } from './stores/cctv.js';
import { useEntityCardStore } from './stores/entityCard.js';
import { useDockedStore } from './stores/docked.js';
import { usePinnedStore } from './stores/pinned.js';
import { _setFrameStillCaptureForTest } from './frameStill.js';
import CctvTools from './views/panels/CctvTools.vue';
import CctvPreview from './views/panels/CctvPreview.vue';
import DockedView from './views/panels/DockedView.vue';

const frames = () => new Promise((resolve) => setTimeout(resolve, 60));

// The projection's decoder: nothing decoded until `decode()`.
function decoder() {
  const video = {
    readyState: 0,
    videoWidth: 0,
    videoHeight: 0,
    currentTime: 0,
  };
  return {
    video,
    decode() {
      Object.assign(video, {
        readyState: 4,
        videoWidth: 1280,
        videoHeight: 720,
      });
    },
    advance() {
      video.currentTime += 1;
    },
  };
}

// Canvases here draw into a recording context (the test DOM draws nothing).
function recordingContext(draws) {
  return { drawImage: (source) => draws.push(source), clearRect() {} };
}

const streamCamera = {
  id: 'deldot-1',
  name: 'US 113 @ US 9',
  city: 'Sussex County',
  headingDeg: 0,
  fovDeg: 50,
  rangeM: 120,
  feedType: 'hls',
  isVideo: true,
  sourceKind: 'live',
  sourceStatus: 'ok',
  frameUrl: '/api/cctv/frame/deldot-1',
};
const liveState = (camera = streamCamera) => ({
  enabled: true,
  count: 1,
  cameraIndex: [camera],
  activeCameraId: camera.id,
  activeCamera: camera,
});

function scene(t, { video }) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const tools = createApp(CctvTools).use(pinia);
  tools.mount(document.body.appendChild(document.createElement('div')));
  const byId = (id) => document.getElementById(id);
  const draws = [];
  byId('cctv-video').getContext = () => recordingContext(draws);
  const store = useCctvStore(pinia);
  const controls = new CctvControls({
    elements: {
      _cctvPanel: byId('cctv-tools'),
      _cctvFrame: byId('cctv-frame'),
      _cctvFrameWrap: byId('cctv-frame-wrap'),
      _cctvVideo: byId('cctv-video'),
      _cctvSummary: byId('cctv-summary'),
    },
    cctv: { getActiveVideoElement: () => video },
    actions: { isEnabled: () => true },
    store,
  });
  const mounted = [];
  const mountInto = (component, props = {}) => {
    const app = createApp({ render: () => h(component, props) }).use(pinia);
    const host = document.body.appendChild(document.createElement('div'));
    host.id = component === CctvPreview ? 'entity-card' : '';
    app.mount(host);
    mounted.push(app);
    return app;
  };
  t.after(() => {
    for (const app of mounted) app.unmount();
    controls.destroy();
    tools.unmount();
  });
  return { controls, store, byId, draws, pinia, mountInto };
}

const preview = () => document.querySelector('.cctv-preview');
const badge = () =>
  preview()?.querySelector('.cctv-preview__badge')?.textContent || '';
const waitText = () =>
  preview()?.querySelector('.cctv-preview__wait')?.textContent || '';

test("a card opened on a live stream camera plays the map's decoder in its top image", async (t) => {
  let snapshot;
  const priorImage = globalThis.Image;
  globalThis.Image = class {
    constructor() {
      snapshot = this;
    }
  };
  t.after(() => {
    globalThis.Image = priorImage;
  });
  const feed = decoder();
  const { controls, byId, draws, mountInto } = scene(t, { video: feed.video });
  // The camera goes live before its card renders (a pick on the map).
  controls._renderCctvState(
    liveState({ ...streamCamera, liveSnapshotUrl: '/camera/still.jpg' }),
  );
  const card = mountInto(CctvPreview, { cameraId: streamCamera.id });
  await nextTick();
  await frames();

  const host = preview().querySelector('.cctv-preview__video');
  assert.ok(host, 'a video surface, not a still');
  // Named for its camera, as the still it replaces is.
  assert.equal(host.getAttribute('role'), 'img');
  assert.equal(
    host.getAttribute('aria-label'),
    'Sussex County · US 113 @ US 9',
  );
  assert.equal(byId('cctv-video').getAttribute('role'), 'img');
  assert.equal(
    byId('cctv-video').getAttribute('aria-label'),
    'Sussex County · US 113 @ US 9',
  );
  assertSameNode(
    byId('cctv-video').parentElement,
    host,
    'the live canvas sits in the card',
  );
  // Connecting: said, and the source chip does not claim the feed is OK.
  assert.equal(waitText(), 'Acquiring frame…');
  assert.equal(badge(), 'FRAME · LOADING');
  assert.equal(draws.length, 0);

  feed.decode();
  await frames();
  await nextTick();
  assert.ok(draws.length > 0, 'the stream is drawn');
  assert.ok(
    draws.every((source) => source === feed.video),
    'from the one shared decoder',
  );
  assert.equal(waitText(), '');
  assert.equal(snapshot.src, '/camera/still.jpg');
  assert.equal(badge(), 'LIVE · OK', 'the optional snapshot is still loading');
  snapshot.onerror();
  await nextTick();
  assert.equal(badge(), 'LIVE · OK', 'the optional snapshot failed');

  // The card goes: the canvas goes home and stops drawing.
  card.unmount();
  await nextTick();
  assertSameNode(
    byId('cctv-video').parentElement,
    byId('cctv-frame-wrap'),
    'the canvas is home',
  );
  const drawn = draws.length;
  feed.advance();
  await frames();
  assert.equal(draws.length, drawn, 'no drawing once the card is gone');
});

test('a stream that cannot play shows the camera frame instead of a black box', async (t) => {
  const prior = globalThis.Image;
  const requests = [];
  globalThis.Image = class {
    constructor() {
      requests.push(this);
    }
  };
  t.after(() => {
    globalThis.Image = prior;
  });
  const { createApplicationCctv } = await import('../app/layers/cctv.js');
  const { defaultSurface } = await import('../data/surfaceServices.js');
  const { bindFakeDraw } = await import('../testSupport/fakeDrawPort.mjs');
  const viewer = {};
  const { unbind } = bindFakeDraw(viewer);
  t.after(unbind);
  let frameUrl = streamCamera.frameUrl;
  const layer = createApplicationCctv({
    surface: defaultSurface,
    source: {
      getCatalog: () => [],
      getHealth: () => null,
      getFrameUrl: () => frameUrl,
      getMediaUrl: () => '/fixture/camera.m3u8',
    },
  });
  // The test DOM can stand in for native HLS without opening a media connection.
  t.mock.method(
    globalThis.HTMLVideoElement.prototype,
    'canPlayType',
    () => 'probably',
  );
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 204 }),
  );
  const record = { camera: { ...streamCamera, lat: 30, lon: -97 } };
  layer._setCctvCoverageStateForTest({
    viewer,
    records: [record],
    activeCameraId: streamCamera.id,
    coverageMode: 'off',
    showProjection: true,
    healthById: new Map([
      [streamCamera.id, { sourceKind: 'live', status: 'ok' }],
    ]),
  });
  const { controls, mountInto, store } = scene(t, {});
  controls.cctv = layer;
  controls.connect();
  t.after(() => layer.disable());
  layer.setParams({ showProjection: true });
  mountInto(CctvPreview, { cameraId: streamCamera.id });
  await nextTick();
  await frames();
  assert.ok(preview().querySelector('.cctv-preview__video'));
  const video = layer.getActiveVideoElement();
  assert.ok(video);
  video.dispatchEvent(new Event('error'));
  await nextTick();
  assertSameNode(
    preview().querySelector('.cctv-preview__video'),
    null,
    'no video surface left behind',
  );
  const image = () =>
    preview().querySelector('img')?.getAttribute('src') ?? null;
  assert.equal(image(), null);
  assert.equal(waitText(), 'Acquiring frame…');
  assert.equal(badge(), 'FRAME · LOADING');
  requests.at(-1).onerror();
  await nextTick();
  assert.equal(image(), null);
  assert.equal(waitText(), 'FRAME · UNAVAILABLE');
  assert.ok(!preview().querySelector('.cctv-preview__expand'));

  const successful = streamCamera.frameUrl + '?frame=2';
  frameUrl = successful;
  layer.setParams({});
  requests.at(-1).onload();
  await nextTick();
  assert.equal(image(), successful);
  assert.equal(store.frame.cameraId, streamCamera.id);
  assert.equal(waitText(), '');
  assert.equal(badge(), 'FALLBACK · DEGRADED');

  frameUrl = streamCamera.frameUrl + '?frame=3';
  layer.setParams({});
  await nextTick();
  assert.equal(image(), successful);
  requests.at(-1).onerror();
  await nextTick();
  assert.equal(image(), successful, 'the last drawable frame is retained');
  assert.equal(waitText(), '');
});

test('a docked stream camera paints the same decoder and keeps a drawn frame for its pin', async (t) => {
  const feed = decoder();
  const { controls, pinia, mountInto } = scene(t, { video: feed.video });
  const frameRequests = [];
  const manager = {
    layers: new Map([
      [
        'cctv',
        {
          module: {
            getActiveVideoElement: () => feed.video,
            frameUrlForCamera: (id) => {
              frameRequests.push(id);
              return { url: `/api/cctv/frame/${id}`, refreshMs: 10_000 };
            },
            cameraDetails: () => ({ refreshMs: 10_000 }),
          },
        },
      ],
    ]),
    isEnabled: () => true,
  };
  useEntityCardStore(pinia).connect({
    dataManager: () => manager,
  });
  const kept = [];
  _setFrameStillCaptureForTest(async ({ shown }) => {
    kept.push(shown);
    return 'data:image/jpeg;base64,AAAA';
  });
  t.after(() => _setFrameStillCaptureForTest(null));
  const draws = [];
  const realGetContext = globalThis.HTMLCanvasElement.prototype.getContext;
  globalThis.HTMLCanvasElement.prototype.getContext = () =>
    recordingContext(draws);
  t.after(() => {
    globalThis.HTMLCanvasElement.prototype.getContext = realGetContext;
  });

  controls._renderCctvState(liveState());
  const key = `cctv:${streamCamera.id}`;
  useDockedStore(pinia).dock({
    key,
    kind: 'camera',
    title: streamCamera.name,
    identity: { layerId: 'cctv', id: streamCamera.id },
  });
  mountInto(DockedView);
  await nextTick();
  await frames();
  const dock = document.querySelector('.docked-view');
  const canvas = dock.querySelector('canvas.docked-view__stream');
  assert.ok(canvas, 'the dock plays the stream');
  assertSameNode(dock.querySelector('img'), null, 'no still');
  assert.equal(
    dock.querySelector('.docked-view__wait')?.textContent,
    'Acquiring frame…',
  );
  assert.deepEqual(frameRequests, [], 'no second request for its frame');
  assert.equal(kept.length, 0, 'no still kept from a blank canvas');

  feed.decode();
  await frames();
  await nextTick();
  assert.ok(draws.length > 0 && draws.every((source) => source === feed.video));
  assertSameNode(
    dock.querySelector('.docked-view__wait'),
    null,
    'no wait text',
  );
  assert.equal(
    dock.querySelector('.docked-view__tag')?.textContent,
    'Docked · live',
  );
  await frames();
  assert.equal(kept.length, 1, 'one still kept');
  assertSameNode(kept[0], canvas, 'the drawn frame is kept');
  assert.equal(
    useDockedStore(pinia).lastStillOf(key),
    'data:image/jpeg;base64,AAAA',
  );
});

test('the bigger view of a pinned camera’s kept frame credits its provider and partner', async (t) => {
  document.body.replaceChildren();
  const pinia = createPinia();
  const cards = useEntityCardStore(pinia);
  const manager = {
    layers: new Map([['cctv', { module: { cameraDetails: () => null } }]]),
    isEnabled: () => false,
  };
  cards.connect({
    dataManager: () => manager,
  });
  // The camera store last held another camera's frame.
  useCctvStore(pinia).setFrame({ cameraId: 'other', src: '/frame/other.jpg' });
  usePinnedStore(pinia).pin({
    key: 'cctv:cam-y',
    kind: 'camera',
    identity: { layerId: 'cctv', id: 'cam-y' },
    source: { provider: 'DelDOT', credit: 'Partner Roads' },
    still: 'data:image/jpeg;base64,KEPT',
  });
  cards.fromPin = true;
  const app = createApp({
    render: () => h(CctvPreview, { cameraId: 'cam-y' }),
  }).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => {
    app.unmount();
    cards.connect(null);
  });
  await nextTick();
  document.querySelector('.cctv-preview__expand').click();
  await nextTick();
  const caption = document.querySelector('.cctv-popup figcaption');
  assert.ok(caption, 'the bigger view has a credit line');
  assert.match(caption.textContent, /Source\s*DelDOT/);
  assert.match(caption.textContent, /Operator\s*Partner Roads/);
});

// A camera source may give each frame's time (`framesCarryTime`, the
// X-CCTV-Frame-Time header); the CCTV panel, the camera's card and its bigger
// view show it with the picture.
import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia } from 'pinia';
import { createApp, h, nextTick } from 'vue';
import { CctvControls } from './cctvControls.js';
import {
  CCTV_FRAME_TIME_HEADER,
  cctvFrameTimeLabel,
  cctvFrameTimeMs,
} from './cctvFrames.js';
import { createPresentation } from '../layers/cctv/presentation.js';
import { useCctvStore } from './stores/cctv.js';
import CctvPanel from './views/panels/CctvPanel.vue';
import CctvPreview from './views/panels/CctvPreview.vue';

const settle = () => new Promise((r) => setTimeout(r, 0));
const FRAME_MS = Date.UTC(2026, 10, 26, 18, 4, 31);
const LABEL = '2026-11-26 18:04:31Z';

const camera = { id: 'a', city: 'Austin', name: 'Congress Ave' };
const state = (frameUrl, { id = 'a', framesCarryTime = true } = {}) => ({
  enabled: true,
  count: 2,
  cameraIndex: [camera, { ...camera, id: 'b' }],
  activeCameraId: id,
  activeCamera: {
    ...camera,
    id,
    frameUrl,
    sourceKind: 'snapshot',
    framesCarryTime,
  },
});

function mockFrames(t) {
  const priorImage = globalThis.Image;
  const priorFetch = globalThis.fetch;
  const priorCreate = URL.createObjectURL;
  const priorRevoke = URL.revokeObjectURL;
  const images = [];
  const fetches = [];
  const revoked = [];
  let urls = 0;
  globalThis.Image = class {
    constructor() {
      images.push(this);
    }
  };
  globalThis.fetch = (url, init) =>
    new Promise((resolve, reject) => {
      const call = { url, init, resolve, reject };
      fetches.push(call);
      init?.signal?.addEventListener('abort', () => {
        call.aborted = true;
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  URL.createObjectURL = () => `blob:frame-${++urls}`;
  URL.revokeObjectURL = (url) => revoked.push(url);
  t.after(() => {
    globalThis.Image = priorImage;
    globalThis.fetch = priorFetch;
    URL.createObjectURL = priorCreate;
    URL.revokeObjectURL = priorRevoke;
  });
  const respond = (call, timeMs, status = 200) =>
    call.resolve(
      new Response(new Uint8Array([1, 2, 3]), {
        status,
        headers: {
          'Content-Type': 'image/jpeg',
          ...(timeMs == null ? {} : { [CCTV_FRAME_TIME_HEADER]: timeMs }),
        },
      }),
    );
  return { images, fetches, revoked, respond };
}

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const cardHost = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const panel = createApp(CctvPanel).use(pinia);
  panel.mount(host);
  const card = createApp(() => h(CctvPreview, { cameraId: 'a' })).use(pinia);
  card.mount(cardHost);
  const controls = new CctvControls({
    elements: {
      _cctvPanel: document.getElementById('cctv-panel'),
      _cctvFrame: document.getElementById('cctv-frame'),
      _cctvFrameWrap: document.getElementById('cctv-frame-wrap'),
    },
    cctv: {},
    actions: {
      isEnabled: () => true,
      setPanelCollapsed() {},
      syncViewport() {},
    },
    store: useCctvStore(pinia),
  });
  t.after(() => {
    controls.destroy();
    panel.unmount();
    card.unmount();
  });
  const panelEl = document.getElementById('cctv-panel');
  panelEl.classList.remove('collapsed');
  return { controls, panelEl, cardHost };
}

async function shown() {
  await settle();
  await nextTick();
}

test('a frame-time header reads as epoch ms, and anything else as none', () => {
  assert.equal(cctvFrameTimeMs(String(FRAME_MS)), FRAME_MS);
  assert.equal(cctvFrameTimeMs(` ${FRAME_MS} `), FRAME_MS);
  for (const value of [null, '', '0', '-5', '1.5', 'soon', '99999999999999999'])
    assert.equal(cctvFrameTimeMs(value), null, String(value));
  assert.equal(cctvFrameTimeLabel(FRAME_MS), LABEL);
  assert.equal(cctvFrameTimeLabel(null), '');
  assert.equal(cctvFrameTimeLabel(9e15), '');
});

test('the camera source flag reaches the camera state', () => {
  const record = { camera: { id: 'a', name: 'A' } };
  const parts = {
    selection: { getActiveRecord: () => record },
    model: { isVideoFeedCamera: () => false },
    frames: { frameUrlFor: () => '/frame/a', mediaUrlFor: () => '' },
    calibration: { normalizeCalibration: () => ({}), deriveCalBadge: () => '' },
  };
  const layerState = { _healthById: new Map() };
  const camera = (source) =>
    createPresentation({
      state: layerState,
      services: {},
      parts,
      source,
    }).getPublicCameraState(record);
  assert.equal(camera({ framesCarryTime: true }).framesCarryTime, true);
  assert.equal(camera({}).framesCarryTime, false);
  assert.equal(camera({ framesCarryTime: 'yes' }).framesCarryTime, false);
});

test('the panel, card and bigger view show the time the source gives the frame', async (t) => {
  const { images, fetches, respond } = mockFrames(t);
  const { controls, panelEl, cardHost } = fixture(t);
  controls._renderCctvState(state('/api/cctv/frame/a?label=Congress+Ave&ts=1'));
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, '/api/cctv/frame/a?label=Congress+Ave&ts=1');
  assert.equal(images.length, 0, 'the frame is read before it is decoded');
  respond(fetches[0], String(FRAME_MS));
  await settle();
  assert.equal(images.length, 1);
  assert.equal(images[0].src, 'blob:frame-1');
  images[0].onload();
  await shown();

  const panelTime = panelEl.querySelector('#cctv-frame-time');
  assert.equal(panelTime?.textContent, LABEL);
  assert.equal(
    panelTime.getAttribute('datetime'),
    new Date(FRAME_MS).toISOString(),
  );
  assert.equal(
    panelEl.querySelector('#cctv-frame').getAttribute('src'),
    'blob:frame-1',
  );
  assert.equal(
    panelEl.querySelector('#cctv-frame').dataset.currentSrc,
    '/api/cctv/frame/a?label=Congress+Ave&ts=1',
  );
  assert.equal(
    cardHost.querySelector('.cctv-preview__time')?.textContent,
    LABEL,
  );
  assert.equal(
    cardHost.querySelector('img').getAttribute('alt'),
    'Congress Ave',
  );

  cardHost.querySelector('.cctv-preview__expand').click();
  await nextTick();
  const popup = document.querySelector('.cctv-popup');
  assert.equal(popup.querySelector('figcaption time')?.textContent, LABEL);
  assert.match(popup.getAttribute('aria-label'), /Congress Ave/);
});

test('a source that gives no time shows none, and its frames load as images', async (t) => {
  const { images, fetches, respond } = mockFrames(t);
  const { controls, panelEl, cardHost } = fixture(t);
  controls._renderCctvState(state('a1.jpg', { framesCarryTime: false }));
  assert.equal(fetches.length, 0);
  assert.equal(images[0].src, 'a1.jpg');
  images[0].onload();
  await shown();
  assert.equal(
    panelEl.querySelector('#cctv-frame').getAttribute('src'),
    'a1.jpg',
  );
  assert.equal(panelEl.querySelector('#cctv-frame-time'), null);
  assert.equal(cardHost.querySelector('.cctv-preview__time'), null);

  // A frame without the header shows no time either.
  controls._renderCctvState(state('a2.jpg'));
  respond(fetches[0], null);
  await settle();
  images[1].onload();
  await shown();
  assert.equal(
    panelEl.querySelector('#cctv-frame').getAttribute('src'),
    'blob:frame-1',
  );
  assert.equal(panelEl.querySelector('#cctv-frame-time'), null);
});

test('a failed refresh keeps the shown time; a new camera clears it and frees old frames', async (t) => {
  const { images, fetches, revoked, respond } = mockFrames(t);
  const { controls, panelEl } = fixture(t);
  controls._renderCctvState(state('a1.jpg'));
  respond(fetches[0], String(FRAME_MS));
  await settle();
  images[0].onload();
  await shown();

  controls._renderCctvState(state('a2.jpg'));
  respond(fetches[1], String(FRAME_MS + 60_000), 503);
  await shown();
  assert.equal(controls._frame.error, true);
  assert.equal(panelEl.querySelector('#cctv-frame-time')?.textContent, LABEL);

  controls._renderCctvState(state('a3.jpg'));
  respond(fetches[2], String(FRAME_MS + 120_000));
  await settle();
  images[1].onload();
  await shown();
  assert.equal(
    panelEl.querySelector('#cctv-frame-time')?.textContent,
    '2026-11-26 18:06:31Z',
  );
  assert.deepEqual(revoked, ['blob:frame-1'], 'the replaced frame is freed');

  // Another camera: the old time goes at once, and the old camera's late
  // response is dropped.
  controls._renderCctvState(state('b1.jpg', { id: 'b' }));
  await nextTick();
  assert.equal(controls._frame.timeMs, null);
  assert.equal(panelEl.querySelector('#cctv-frame-time'), null);
  assert.deepEqual(revoked, ['blob:frame-1', 'blob:frame-2']);
  controls._renderCctvState(state('b2.jpg', { id: 'a' }));
  assert.equal(fetches[3].aborted, true, 'a superseded read is cancelled');
});

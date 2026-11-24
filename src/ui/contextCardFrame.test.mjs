import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia } from 'pinia';
import { createApp, h, nextTick, ref } from 'vue';
import { CctvControls } from './cctvControls.js';
import { useCctvStore } from './stores/cctv.js';
import CctvPanel from './views/panels/CctvPanel.vue';
import CctvPreview from './views/panels/CctvPreview.vue';

const settle = () => new Promise((r) => setTimeout(r, 0));
const camera = {
  id: 'a',
  city: 'Austin',
  name: 'Congress Ave',
  headingDeg: 91.6,
  fovDeg: 60,
  rangeM: 120.4,
  sourceLabel: 'Configured Source',
  calBadge: 'curated',
};
const stillState = (frameUrl, id = 'a') => ({
  enabled: true,
  count: 2,
  cameraIndex: [camera, { ...camera, id: 'b' }],
  activeCameraId: id,
  activeCamera: { ...camera, id, frameUrl, sourceKind: 'snapshot' },
});

function liveState(id = 'a') {
  const state = stillState(`/api/cctv/frame/${id}`, id);
  state.activeCamera = {
    ...state.activeCamera,
    feedType: 'hls',
    isVideo: true,
    sourceKind: 'live',
    sourceStatus: 'ok',
    liveSnapshotUrl: `/api/cctv/frame/${id}?snapshotOnly=1`,
  };
  return state;
}

function fixture(t, { card = true } = {}) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const cardHost = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(CctvPanel).use(pinia);
  app.mount(host);
  const previewId = ref('a');
  let preview;
  function mountCard() {
    preview = createApp(() =>
      h(CctvPreview, { cameraId: previewId.value }),
    ).use(pinia);
    preview.mount(cardHost);
  }
  function unmountCard() {
    preview?.unmount();
    preview = null;
  }
  if (card) mountCard();
  const store = useCctvStore(pinia);
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
    store,
  });
  t.after(() => {
    controls.destroy();
    app.unmount();
    preview?.unmount();
  });
  return {
    controls,
    cardHost,
    mountCard,
    unmountCard,
    previewId,
    store,
    panelEl: document.getElementById('cctv-panel'),
  };
}

function mockImages(t) {
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
  return requests;
}

test('desktop: the Context card keeps refreshing while the accordion folds CCTV', async (t) => {
  const requests = mockImages(t);
  const { controls, cardHost, panelEl } = fixture(t);
  panelEl.classList.remove('collapsed');
  controls._renderCctvState(stillState('a1.jpg'));
  assert.equal(requests.length, 1);
  requests[0].onload();
  await settle();
  await nextTick();
  assert.equal(cardHost.querySelector('img')?.getAttribute('src'), 'a1.jpg');
  // Context opens: the desktop accordion folds CCTV (class collapsed).
  panelEl.classList.add('collapsed');
  await settle();
  controls._renderCctvState(stillState('a2.jpg'));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].src, 'a2.jpg');
  requests[1].onload();
  controls._renderCctvState(stillState('a3.jpg'));
  assert.equal(requests.length, 3);
  assert.equal(requests[2].src, 'a3.jpg');
  requests[2].onload();
  await settle();
  await nextTick();
  assert.equal(cardHost.querySelector('img')?.getAttribute('src'), 'a3.jpg');
});

test('an HLS camera keeps live video in CCTV and shows its registered snapshot in Context', async (t) => {
  const requests = mockImages(t);
  const { controls, panelEl, cardHost, mountCard, unmountCard } = fixture(t, {
    card: false,
  });
  panelEl.classList.remove('collapsed');
  const state = liveState();
  controls._renderCctvState(state);
  await settle();
  assert.equal(requests.length, 0, 'the video panel alone needs no still');

  mountCard();
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].src, state.activeCamera.liveSnapshotUrl);
  assert.equal(panelEl.querySelector('#cctv-video').hidden, false);
  assert.equal(
    panelEl.querySelector('#cctv-frame-wrap').classList.contains('loading'),
    false,
  );
  assert.equal(
    panelEl.querySelector('#cctv-source-badge').textContent,
    'LIVE · OK',
  );
  requests[0].onload();
  await nextTick();
  assert.equal(
    cardHost.querySelector('img')?.getAttribute('src'),
    state.activeCamera.liveSnapshotUrl,
  );
  assert.match(
    cardHost.querySelector('.cctv-preview__badge').textContent,
    /SNAPSHOT/,
  );

  unmountCard();
  await settle();
  assert.equal(panelEl.querySelector('#cctv-video').hidden, false);
  controls._renderCctvState({
    ...state,
    activeCamera: { ...state.activeCamera, liveSnapshotUrl: '' },
  });
  mountCard();
  await settle();
  assert.equal(
    requests.length,
    1,
    'a video-only camera has no registered still',
  );
  assert.equal(cardHost.querySelector('img'), null);
  assert.match(cardHost.textContent, /FRAME · UNAVAILABLE/);
  assert.equal(panelEl.querySelector('#cctv-video').hidden, false);
});

test('a live still is requested only when the Context preview matches the active camera', async (t) => {
  const requests = mockImages(t);
  const { controls, cardHost, previewId } = fixture(t);
  const a = liveState('a');
  const b = liveState('b');

  controls._renderCctvState(a);
  assert.deepEqual(
    requests.map(({ src }) => src),
    [a.activeCamera.liveSnapshotUrl],
  );
  requests[0].onload();
  await nextTick();
  assert.equal(
    cardHost.querySelector('img')?.getAttribute('src'),
    a.activeCamera.liveSnapshotUrl,
  );
  cardHost.querySelector('.cctv-preview__expand').click();
  await nextTick();
  const popup = document.body.querySelector('.cctv-popup');
  assert.equal(
    popup.querySelector('img').getAttribute('src'),
    a.activeCamera.liveSnapshotUrl,
  );

  // CCTV's Next control changes the active feed without selecting a card.
  controls._renderCctvState(b);
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(cardHost.querySelector('img'), null);
  assert.equal(popup.querySelector('img'), null);

  // The same component can then receive the new card identity.
  previewId.value = 'b';
  await settle();
  assert.deepEqual(
    requests.map(({ src }) => src),
    [a.activeCamera.liveSnapshotUrl, b.activeCamera.liveSnapshotUrl],
  );
  requests[1].onload();
  await nextTick();
  assert.equal(
    cardHost.querySelector('img')?.getAttribute('src'),
    b.activeCamera.liveSnapshotUrl,
  );
});

test('a browser-only Québec video has no still in its Context card', async (t) => {
  const requests = mockImages(t);
  const { controls, cardHost, panelEl, previewId, store } = fixture(t);
  const id = 'qc-511-3735';
  const state = stillState(`/api/cctv/frame/${id}`, id);
  state.activeCamera = {
    ...state.activeCamera,
    feedType: 'image',
    isVideo: true,
    sourceKind: 'quebec-511-browser',
    browserMediaUrl: 'https://example.invalid/quebec-camera.mp4',
  };
  previewId.value = id;
  controls._renderCctvState(state);
  await nextTick();

  assert.equal(store.live, false, 'the CCTV panel does not play browser video');
  assert.equal(panelEl.querySelector('#cctv-frame-wrap').hidden, true);
  assert.equal(requests.length, 0);
  assert.equal(cardHost.querySelector('img'), null);
  assert.match(cardHost.textContent, /FRAME · UNAVAILABLE/);
});

test('a metadata-only Québec camera has no still in its Context card', async (t) => {
  const requests = mockImages(t);
  const { controls, cardHost, panelEl, previewId, store } = fixture(t);
  const id = 'qc-511-3735';
  const state = stillState(`/api/cctv/frame/${id}`, id);
  state.activeCamera.sourceKind = 'quebec-511-browser';
  previewId.value = id;
  controls._renderCctvState(state);
  await nextTick();

  assert.equal(store.live, false);
  assert.equal(panelEl.querySelector('#cctv-frame-wrap').hidden, true);
  assert.equal(requests.length, 0);
  assert.equal(cardHost.querySelector('img'), null);
  assert.match(cardHost.textContent, /FRAME · UNAVAILABLE/);
});

test('an inactive camera card hides another camera’s status and pose', async (t) => {
  const requests = mockImages(t);
  const { controls, cardHost, panelEl, store } = fixture(t);
  panelEl.classList.add('collapsed');
  controls._renderCctvState(stillState('a.jpg'));
  requests[0].onload();
  await nextTick();
  assert.equal(cardHost.querySelector('img')?.getAttribute('src'), 'a.jpg');
  assert.ok(cardHost.querySelector('.cctv-preview__facts'));
  assert.ok(cardHost.querySelector('.cctv-preview__badge'));

  const b = stillState('b.jpg', 'b');
  b.activeCamera.headingDeg = 204;
  b.activeCamera.sourceStatus = 'error';
  controls._renderCctvState(b);
  await nextTick();

  assert.equal(requests.length, 1);
  assert.ok(
    !cardHost.querySelector('.cctv-preview__badge'),
    'status is hidden',
  );
  assert.ok(!cardHost.querySelector('.cctv-preview__facts'), 'pose is hidden');
  assert.ok(!cardHost.querySelector('img'), 'the inactive card has no image');
  assert.equal(store.frame?.cameraId, '', 'the shared frame is cleared');
  assert.match(cardHost.textContent, /FRAME · UNAVAILABLE/);
});

test('phone: a camera picked with the Context sheet open gets its still', async (t) => {
  const requests = mockImages(t);
  t.after(() => {
    document.body.classList.remove('mobile-shell');
    document.body.removeAttribute('data-mobile-sheet');
  });
  const { controls, cardHost, panelEl } = fixture(t);
  document.body.classList.add('mobile-shell');
  document.body.setAttribute('data-mobile-sheet', 'context');
  panelEl.classList.remove('collapsed');
  controls._renderCctvState(stillState('a1.jpg'));
  controls._renderCctvState(stillState('a2.jpg'));
  await settle();
  await nextTick();
  assert.equal(
    requests.length,
    1,
    'the Context card on the Context sheet requests the still',
  );
  assert.equal(requests[0].src, 'a1.jpg');
  requests.at(-1).onload();
  await settle();
  await nextTick();
  assert.ok(
    cardHost.querySelector('.cctv-preview__expand'),
    'the card shows a frame, not Acquiring frame…',
  );
});

test('phone: the card on a closed Context sheet waits', async (t) => {
  const requests = mockImages(t);
  const { controls, panelEl } = fixture(t);
  panelEl.classList.add('collapsed');
  document.body.classList.add('mobile-shell');
  document.body.setAttribute('data-mobile-sheet', 'layers');
  t.after(() => {
    document.body.classList.remove('mobile-shell');
    document.body.removeAttribute('data-mobile-sheet');
  });
  controls._renderCctvState(stillState('a1.jpg'));
  assert.equal(requests.length, 0);
  document.body.setAttribute('data-mobile-sheet', 'context');
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].src, 'a1.jpg');
});

test('phone: the bigger view keeps refreshing after the layout turns phone, and stops once closed', async (t) => {
  const requests = mockImages(t);
  t.after(() => {
    document.body.classList.remove('mobile-shell');
    document.body.removeAttribute('data-mobile-sheet');
  });
  const { controls, cardHost, panelEl } = fixture(t);
  panelEl.classList.add('collapsed');
  controls._renderCctvState(stillState('a1.jpg'));
  assert.equal(requests.length, 1);
  requests[0].onload();
  await settle();
  await nextTick();
  cardHost.querySelector('.cctv-preview__expand').click();
  await settle();
  await nextTick();
  const popup = document.body.querySelector('.cctv-popup');
  assert.ok(popup);
  assert.equal(popup.querySelector('img').getAttribute('src'), 'a1.jpg');

  document.body.classList.add('mobile-shell');
  await settle();
  controls._renderCctvState(stillState('a2.jpg'));
  await settle();
  await nextTick();
  assert.ok(document.body.contains(popup));
  assert.equal(requests.length, 2);
  assert.equal(requests[1].src, 'a2.jpg');
  requests[1].onload();
  await settle();
  await nextTick();
  assert.equal(popup.querySelector('img').getAttribute('src'), 'a2.jpg');

  popup.querySelector('.cctv-popup__close').click();
  await settle();
  await nextTick();
  assert.equal(document.body.querySelector('.cctv-popup'), null);
  controls._renderCctvState(stillState('a3.jpg'));
  await settle();
  assert.equal(requests.length, 2);
});

test('desktop: a card that mounts asks for the still', async (t) => {
  const requests = mockImages(t);
  const { controls, panelEl, mountCard } = fixture(t, { card: false });
  panelEl.classList.add('collapsed');
  controls._renderCctvState(stillState('a1.jpg'));
  await settle();
  assert.equal(requests.length, 0);
  mountCard();
  await settle();
  await nextTick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].src, 'a1.jpg');
});

test('desktop: a card that unmounts stops the still, and a remount resumes it', async (t) => {
  const requests = mockImages(t);
  const { controls, panelEl, mountCard, unmountCard, store } = fixture(t);
  panelEl.classList.add('collapsed');
  controls._renderCctvState(stillState('a1.jpg'));
  assert.equal(requests.length, 1);
  requests[0].onload();
  await settle();
  await nextTick();

  unmountCard();
  await settle();
  await nextTick();
  assert.deepEqual(store.previewCards, []);
  controls._renderCctvState(stillState('a2.jpg'));
  await settle();
  assert.equal(requests.length, 1);

  mountCard();
  await settle();
  await nextTick();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].src, 'a2.jpg');
});

test('desktop: the bigger view is released when the card unmounts, also in the tick it closes', async (t) => {
  const requests = mockImages(t);
  const { controls, cardHost, panelEl, mountCard, unmountCard, store } =
    fixture(t);
  panelEl.classList.add('collapsed');
  controls._renderCctvState(stillState('a1.jpg'));
  requests[0].onload();
  await settle();
  await nextTick();
  const openPopup = async () => {
    cardHost.querySelector('.cctv-preview__expand').click();
    await nextTick();
    assert.deepEqual(store.previewPopups, ['a']);
  };

  await openPopup();
  unmountCard();
  await nextTick();
  assert.equal(document.body.querySelector('.cctv-popup'), null);
  assert.deepEqual(store.previewPopups, []);

  mountCard();
  await nextTick();
  await openPopup();
  // Closed and unmounted before the watcher runs, as when one Escape closes
  // the phone's Context sheet and the popup.
  document.body.querySelector('.cctv-popup__close').click();
  unmountCard();
  await settle();
  await nextTick();
  assert.deepEqual(store.previewPopups, []);
  assert.deepEqual(store.previewCards, []);
  const before = requests.length;
  controls._renderCctvState(stillState('a3.jpg'));
  await settle();
  assert.equal(requests.length, before);
});

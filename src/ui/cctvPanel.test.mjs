import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import { assertSameNode } from '../testSupport/domAssert.mjs';
import test from 'node:test';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { CctvControls } from './cctvControls.js';
import { CCTV_SELECTED_EVENT } from './cctvEvents.js';
import { presentCctvPanel } from './cctvPresentation.js';
import { useCctvStore } from './stores/cctv.js';
import CctvTools from './views/panels/CctvTools.vue';

const BUTTONS = {
  _cctvCoverageBtn: 'cctv-coverage-btn',
  _cctvAutoHopBtn: 'cctv-auto-hop-btn',
  _cctvProjectionBtn: 'cctv-projection-btn',
};

// Mount Camera settings before binding the controls that read its elements.
function panel(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(CctvTools).use(pinia);
  app.mount(host);
  const elements = Object.fromEntries(
    Object.entries(BUTTONS).map(([key, id]) => [
      key,
      document.getElementById(id),
    ]),
  );
  const store = useCctvStore(pinia);
  const controls = new CctvControls({
    elements: {
      ...elements,
      _cctvPanel: document.getElementById('cctv-tools'),
      _cctvFrame: document.getElementById('cctv-frame'),
      _cctvFrameWrap: document.getElementById('cctv-frame-wrap'),
      _cctvVideo: document.getElementById('cctv-video'),
      _cctvSummary: document.getElementById('cctv-summary'),
      _cctvCalReadout: document.getElementById('cctv-cal-readout'),
      _cctvAdjustBtn: document.getElementById('cctv-adjust-btn'),
      _cctvCalibSaveBtn: document.getElementById('cctv-calib-save-btn'),
      _cctvCalibResetBtn: document.getElementById('cctv-calib-reset-btn'),
    },
    cctv: {},
    actions: {
      isEnabled: () => true,
    },
    store,
  });
  t.after(() => {
    controls.destroy();
    app.unmount();
  });
  const byId = (id) => document.getElementById(id);
  return { controls, byId, store };
}

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

test('the camera tools keep their initial markup until the controls render', (t) => {
  const { byId } = panel(t);
  // A block of its own (Context's Camera settings tab), not a fold.
  assert.equal(byId('cctv-tools').tagName, 'DIV');
  // Toggles: a name, a switch and their state in aria-pressed.
  const toggle = (id) => [
    byId(id).textContent,
    byId(id).getAttribute('aria-pressed'),
  ];
  assert.deepEqual(toggle('cctv-coverage-btn'), ['CoverageOff', 'false']);
  assert.deepEqual(toggle('cctv-auto-hop-btn'), [
    'Hop between cameras',
    'false',
  ]);
  assert.deepEqual(toggle('cctv-projection-btn'), ['Projection', 'true']);
  assert.equal(byId('cctv-quality-chip').textContent, 'CAL · --');
  assert.equal(byId('cctv-quality-chip').hasAttribute('data-cal-badge'), false);
  for (const id of Object.values(BUTTONS))
    assert.equal(byId(id).disabled, false, id);
  // The retired panel's switch, navigation, picker and focus are gone.
  for (const gone of [
    'cctv-enable-btn',
    'cctv-nearest-btn',
    'cctv-prev-btn',
    'cctv-next-btn',
    'cctv-camera-select',
    'cctv-focus-btn',
    'cctv-panel',
  ])
    assert.equal(byId(gone), null, gone);
});

test('a disabled layer disables every tool', async (t) => {
  const { controls, byId, store } = panel(t);
  controls._renderCctvState({ enabled: false, count: 3, cameraIndex: [] });
  await nextTick();
  for (const id of Object.values(BUTTONS))
    assert.equal(byId(id).disabled, true, id);
  assert.equal(store.view.meta, '3 cameras loaded · enable CCTV to activate');
});

test('an active camera renders the toggles, CAL chip and meta line', async (t) => {
  const { controls, byId, store } = panel(t);
  controls._renderCctvState({
    enabled: true,
    count: 1,
    cameraIndex: [camera],
    activeCameraId: 'a',
    activeCamera: camera,
    coverageMode: 'viewshed',
    autoHop: true,
    showProjection: false,
  });
  await nextTick();
  for (const id of Object.values(BUTTONS))
    assert.equal(byId(id).disabled, false, id);
  assert.equal(
    byId('cctv-coverage-btn').querySelector('.gev-tool-toggle__state')
      .textContent,
    'Viewshed',
  );
  assert.equal(byId('cctv-coverage-btn').classList.contains('is-on'), true);
  assert.equal(byId('cctv-auto-hop-btn').textContent, 'Hop between cameras');
  assert.equal(byId('cctv-projection-btn').textContent, 'Projection');
  assert.equal(byId('cctv-projection-btn').classList.contains('is-on'), false);
  // The toggles say their state to assistive technology, not only by colour.
  const pressed = (id) => byId(id).getAttribute('aria-pressed');
  assert.equal(pressed('cctv-coverage-btn'), 'true');
  assert.equal(pressed('cctv-auto-hop-btn'), 'true');
  assert.equal(pressed('cctv-projection-btn'), 'false');
  assert.equal(pressed('cctv-adjust-btn'), 'false');
  // The calibration status reads as a sentence.
  assert.equal(
    byId('cctv-quality-chip').textContent,
    'Hand-checked calibration',
  );
  assert.equal(byId('cctv-quality-chip').dataset.calBadge, 'curated');
  assert.equal(store.view.activeCameraId, 'a');
  assert.equal(
    store.view.meta,
    'Austin · HDG 92° · FOV 60° · RANGE 120m · OFF · CURATED · Configured Source',
  );
});

test('the buttons stay the elements the controls listen on', async (t) => {
  const { controls, byId } = panel(t);
  const before = Object.values(BUTTONS).map(byId);
  controls._renderCctvState({ enabled: true, count: 0, cameraIndex: [] });
  await nextTick();
  controls._renderCctvState({ enabled: false, count: 0, cameraIndex: [] });
  await nextTick();
  const after = Object.values(BUTTONS).map(byId);
  assert.ok(
    before.every((node, index) => node === after[index]),
    'a button was replaced',
  );
});

test('the tools follow whether the layer is on', () => {
  const loaded = { enabled: true, count: 2, cameraIndex: [] };
  assert.equal(presentCctvPanel(loaded, true).toggleDisabled, false);
  assert.equal(presentCctvPanel(loaded, false).toggleDisabled, true);
});

test('coverage reads its mode, or the older on/off flag', () => {
  const text = (state) => presentCctvPanel(state, true).coverage;
  assert.deepEqual(text({ coverageMode: 'on' }), {
    active: true,
    mode: 'on',
    text: 'COVERAGE ON',
  });
  assert.deepEqual(text({ showCoverage: true }), {
    active: true,
    mode: 'on',
    text: 'COVERAGE ON',
  });
  assert.deepEqual(text({}), {
    active: false,
    mode: 'off',
    text: 'COVERAGE OFF',
  });
});

test('losing the active camera resets the CAL chip', async (t) => {
  const { controls, byId, store } = panel(t);
  controls._renderCctvState({
    enabled: true,
    count: 1,
    cameraIndex: [camera],
    activeCameraId: 'a',
    activeCamera: camera,
  });
  await nextTick();
  assert.equal(byId('cctv-quality-chip').dataset.calBadge, 'curated');
  controls._renderCctvState(null);
  await nextTick();
  assert.equal(byId('cctv-quality-chip').textContent, 'CAL · --');
  assert.equal(byId('cctv-quality-chip').getAttribute('data-cal-badge'), '');
  assert.equal(store.view.meta, 'Enable CCTV to load camera intersections');
});

/** A panel with an active camera, calibration patches recorded. */
async function calibrating(t) {
  const page = panel(t);
  const patches = [];
  page.controls.actions.setParams = (params) => patches.push(params);
  page.controls._renderCctvState({
    enabled: true,
    count: 1,
    cameraIndex: [camera],
    activeCameraId: 'a',
    activeCamera: { ...camera, headingDeg: 30, basePose: { headingDeg: 20 } },
  });
  await nextTick();
  const chip = document.querySelector('[data-cal-field="heading"]');
  const begin = async () => {
    chip.click();
    await nextTick();
    return chip.querySelector('input');
  };
  const key = (name) =>
    new KeyboardEvent('keydown', { key: name, cancelable: true });
  return { ...page, patches, chip, begin, key };
}

test('a pose chip types against the camera base captured when it opened', async (t) => {
  const { controls, patches, chip, begin, key } = await calibrating(t);
  assert.equal(chip.textContent, '30.0°');
  const input = await begin();
  assert.ok(input, 'the chip holds an input');
  assert.ok(document.activeElement === input, 'the input has focus');
  assert.equal(chip.textContent, 'HDG ');
  assert.equal(input.value, '30.0');
  assert.equal(input.step, '0.1');
  assert.equal(input.getAttribute('aria-label'), 'Heading in degrees');
  input.value = '100';
  // A refresh while typing keeps the draft and the base the edit opened with.
  controls._renderCctvState({
    ...controls._cctvState,
    activeCamera: {
      ...controls._cctvState.activeCamera,
      basePose: { headingDeg: 60 },
    },
  });
  await nextTick();
  assertSameNode(chip.querySelector('input'), input, 'the input survives');
  assert.equal(input.value, '100');
  input.dispatchEvent(key('Enter'));
  input.dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, [
    {
      selectedCameraId: 'a',
      calibration: { cameraId: 'a', patch: { headingDeg: 80 } },
    },
  ]);
  assert.equal(controls._calibrationEdit, null);
  await nextTick();
  assert.ok(!chip.querySelector('input'), 'the input is gone');
  assert.equal(chip.textContent, '30.0°');
});

test('each pose value is named by its field label, and its input by the label and unit', async (t) => {
  const { begin } = await calibrating(t);
  // The name aria-labelledby gives: the referenced elements' text, in order.
  const named = (node) =>
    (node.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent.trim())
      .join(' ')
      .replace(/[\u2066-\u2069]/g, '');
  const chip = (field) => document.querySelector(`[data-cal-field="${field}"]`);
  assert.equal(named(chip('heading')), 'Heading 30.0°');
  assert.equal(named(chip('range')), 'Range 120 m');
  assert.equal(named(chip('north')), 'North offset 0.0 m');
  const input = await begin();
  assert.equal(input.getAttribute('aria-label'), 'Heading in degrees');
});

test('estimated heading is qualified in the readout while the draft stays numeric', async (t) => {
  const { controls, chip, begin } = await calibrating(t);
  controls._renderCctvState({
    ...controls._cctvState,
    activeCamera: {
      ...controls._cctvState.activeCamera,
      headingEstimated: true,
    },
  });
  await nextTick();
  assert.match(chip.textContent, /~30.0°/);
  assert.match(chip.getAttribute('aria-label') || '', /30.0°.*estimated/i);
  assert.equal(chip.hasAttribute('aria-labelledby'), false);
  assert.equal((await begin()).value, '30.0');
});

test('camera settings hold off auto-hop and stale calibration controls cannot write to another camera', async (t) => {
  const { controls, patches, byId, chip, store } = await calibrating(t);
  const locks = [];
  controls.cctv.setPreviewedCamera = (id) => locks.push(id);
  store.settingsCameraId = 'a';
  store.settingsVisible = true;
  await nextTick();
  assert.equal(locks.at(-1), 'a');
  controls._renderCctvState({
    ...controls._cctvState,
    activeCameraId: 'b',
    activeCamera: { ...controls._cctvState.activeCamera, id: 'b' },
  });
  byId('cctv-calib-reset-btn').click();
  byId('cctv-calib-save-btn').click();
  byId('cctv-adjust-btn').click();
  chip.click();
  await nextTick();
  assert.deepEqual(patches, []);
  assert.equal(Boolean(chip.querySelector('input')), false);
  assert.equal(locks.at(-1), null);
});

test('a camera switch cancels calibration before old blur can change the new camera', async (t) => {
  const { controls, patches, chip, begin } = await calibrating(t);
  const input = await begin();
  input.value = '100';
  controls._renderCctvState({
    enabled: true,
    count: 1,
    cameraIndex: [camera],
    activeCameraId: 'b',
    activeCamera: {
      ...camera,
      id: 'b',
      headingDeg: 200,
      basePose: { headingDeg: 190 },
    },
  });
  input.dispatchEvent(new Event('blur'));
  await nextTick();
  assert.deepEqual(patches, []);
  assert.ok(!chip.querySelector('input'), 'the input is gone');
  assert.equal(chip.textContent, '200.0°');
});

test('Escape claims calibration cancellation and disposal prevents late commits', async (t) => {
  const { controls, patches, chip, begin, key } = await calibrating(t);
  let input = await begin();
  input.value = '100';
  const escape = key('Escape');
  input.dispatchEvent(escape);
  input.dispatchEvent(new Event('blur'));
  assert.equal(escape.defaultPrevented, true);
  await nextTick();
  assert.equal(chip.textContent, '30.0°');
  input = await begin();
  input.value = '120';
  controls.destroy();
  input.dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, []);
  await nextTick();
  assert.ok(!chip.querySelector('input'), 'disposal closes the editor');
});

test('ADJUST, SAVE and RESET follow whether a camera can be calibrated', async (t) => {
  const { controls, byId } = panel(t);
  controls._renderCctvState({ enabled: true, count: 1, cameraIndex: [] });
  await nextTick();
  for (const id of [
    'cctv-adjust-btn',
    'cctv-calib-save-btn',
    'cctv-calib-reset-btn',
  ])
    assert.equal(byId(id).disabled, true, id);
  const chip = document.querySelector('[data-cal-field="north"]');
  assert.equal(chip.textContent, '--');
  assert.equal(chip.disabled, true);
  controls._renderCctvState({
    enabled: true,
    count: 1,
    cameraIndex: [camera],
    activeCameraId: 'a',
    activeCamera: camera,
    calibrationMode: true,
  });
  await nextTick();
  assert.equal(byId('cctv-adjust-btn').textContent, 'Adjust');
  assert.equal(byId('cctv-adjust-btn').getAttribute('aria-pressed'), 'true');
  assert.equal(byId('cctv-adjust-btn').classList.contains('is-on'), true);
  assert.equal(byId('cctv-calib-save-btn').disabled, false);
  assert.equal(chip.textContent, '0.0 m');
  assert.equal(chip.disabled, false);
});

test('blur alone commits the draft; an empty draft changes nothing', async (t) => {
  const { patches, chip, begin } = await calibrating(t);
  let input = await begin();
  input.value = '';
  input.dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, []);
  await nextTick();
  assert.equal(chip.textContent, '30.0°');
  input = await begin();
  input.value = '25';
  input.dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, [
    {
      selectedCameraId: 'a',
      calibration: { cameraId: 'a', patch: { headingDeg: 5 } },
    },
  ]);
});

test('keys typed into a pose chip stay in it', async (t) => {
  const { begin } = await calibrating(t);
  const input = await begin();
  let reached = 0;
  document.body.addEventListener('keydown', () => reached++);
  for (const key of ['5', 'Escape'])
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  assert.equal(reached, 0);
});

test('a second edit of the same chip gets a fresh input', async (t) => {
  const { controls, chip, begin } = await calibrating(t);
  const first = await begin();
  first.value = '99';
  controls._beginCctvCalValueEdit(chip);
  controls._beginCctvCalValueEdit(chip);
  await nextTick();
  const second = chip.querySelector('input');
  assert.ok(second && second !== first, 'a new input');
  assert.equal(second.value, '30.0');
});

test('the frame preview renders each step of a camera frame request', async (t) => {
  const requests = mockImages(t);
  const { controls, byId, store } = panel(t);
  const frame = byId('cctv-frame');
  // The source chip shows on the card's image, from the store.
  const badge = {
    get textContent() {
      return store.sourceBadge?.label;
    },
    get dataset() {
      return { frameState: store.sourceBadge?.state };
    },
  };
  const state = {
    enabled: true,
    count: 1,
    cameraIndex: [camera],
    activeCameraId: 'a',
    activeCamera: {
      ...camera,
      frameUrl: 'a.jpg',
      sourceKind: 'snapshot',
      sourceStatus: 'ok',
    },
  };
  store.showPreviewCard('a', true);
  controls._renderCctvState(state);
  await nextTick();
  assert.equal(frame.dataset.cameraId, 'a');
  assert.equal(frame.dataset.loading, 'true');
  assert.equal(frame.hasAttribute('src'), false);
  assert.equal(badge.textContent, 'FRAME · LOADING');
  assert.equal(badge.dataset.frameState, 'loading');
  requests[0].onload();
  await nextTick();
  assert.equal(frame.getAttribute('src'), 'a.jpg');
  assert.equal(frame.dataset.loading, '');
  assert.equal(frame.classList.contains('active'), true);
  assert.equal(badge.textContent, 'SNAPSHOT · OK');
  // A failed refresh keeps the settled pixels.
  const refreshed = {
    ...state,
    activeCamera: { ...state.activeCamera, frameUrl: 'a2.jpg' },
  };
  controls._renderCctvState(refreshed);
  requests[1].onerror();
  await nextTick();
  assert.equal(frame.getAttribute('src'), 'a.jpg');
  assert.equal(frame.dataset.error, 'true');
  assert.equal(badge.textContent, 'SNAPSHOT · OK');
  // Another camera clears them while its frame loads.
  store.showPreviewCard('a', false);
  store.showPreviewCard('b', true);
  controls._renderCctvState({
    ...state,
    activeCameraId: 'b',
    activeCamera: { ...state.activeCamera, id: 'b', frameUrl: 'b.jpg' },
  });
  await nextTick();
  assert.equal(frame.hasAttribute('src'), false);
  assert.equal(frame.dataset.cameraId, 'b');
  assert.equal(badge.textContent, 'FRAME · LOADING');
  controls._renderCctvState({ ...state, enabled: false });
  await nextTick();
  assert.equal(frame.hasAttribute('src'), false);
  assert.equal(frame.dataset.cameraId, '');
  assert.equal(badge.textContent, 'SOURCE · UNKNOWN');
  assert.equal(badge.dataset.frameState, 'idle');
});

test('a live camera swaps the still frame for the video canvas', async (t) => {
  const { controls, byId } = panel(t);
  assert.equal(byId('cctv-video').hidden, true);
  controls._renderCctvState({
    enabled: true,
    count: 1,
    cameraIndex: [camera],
    activeCameraId: 'a',
    activeCamera: { ...camera, isVideo: true },
  });
  await nextTick();
  assert.equal(byId('cctv-video').hidden, false);
  assert.equal(byId('cctv-frame').hidden, true);
  controls._renderCctvState({
    enabled: true,
    count: 1,
    cameraIndex: [camera],
    activeCameraId: 'a',
    activeCamera: camera,
  });
  await nextTick();
  assert.equal(byId('cctv-video').hidden, true);
  assert.equal(byId('cctv-frame').hidden, false);
});

test('the scene summary types in, then holds the whole text', async (t) => {
  const { controls, byId } = panel(t);
  const text = 'Austin CCTV · 5th St / Congress Ave';
  controls._typeCctvSummary(text);
  await nextTick();
  assert.equal(byId('cctv-summary').textContent, '');
  await new Promise((resolve) => setTimeout(resolve, 30));
  await nextTick();
  const partial = byId('cctv-summary').textContent;
  assert.ok(partial.length > 0 && partial.length < text.length, partial);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await nextTick();
  assert.equal(byId('cctv-summary').textContent, text);
});

test('the panel meta line reads a bearing that rounds to north as HDG 0°', () => {
  const meta = (headingDeg) => {
    const camera = {
      id: 'a',
      city: 'Austin',
      headingDeg,
      fovDeg: 74,
      rangeM: 700,
    };
    return presentCctvPanel(
      {
        enabled: true,
        activeCameraId: camera.id,
        activeCamera: camera,
        cameras: [camera],
      },
      true,
    ).meta;
  };
  assert.match(meta(359.4), /· HDG 359° ·/);
  assert.match(meta(359.6), /· HDG 0° ·/);
});

const activeState = {
  enabled: true,
  count: 1,
  cameraIndex: [],
  activeCameraId: camera.id,
  activeCamera: camera,
};

test('a picked camera opens its card in Context', (t) => {
  const { controls } = panel(t);
  const picked = [];
  const onPicked = (event) => picked.push(event.detail.cameraId);
  document.addEventListener(CCTV_SELECTED_EVENT, onPicked);
  t.after(() => document.removeEventListener(CCTV_SELECTED_EVENT, onPicked));
  // The camera already active on the render that turns the layer on (the
  // one it chose for itself, or one restored) opens nothing. The fixtures
  // carry only the fields the layer's uiState() publishes.
  controls._renderCctvState(activeState);
  assert.deepEqual(picked, []);
  controls._renderCctvState({ ...activeState, enabled: false });
  controls._renderCctvState({ ...activeState, activeCameraId: 'restored' });
  assert.deepEqual(
    picked,
    [],
    'a camera restored from last time is not a pick',
  );
  // A camera someone picks is announced once.
  controls._renderCctvState({ ...activeState, activeCameraId: 'other' });
  controls._renderCctvState({ ...activeState, activeCameraId: 'other' });
  assert.deepEqual(picked, ['other']);
  // The layer's own opening camera, moved to the one nearest the view after
  // a settled pan, is not a pick either (uiState's `openingCamera`).
  controls._renderCctvState({
    ...activeState,
    activeCameraId: 'nearest-after-pan',
    openingCamera: true,
  });
  assert.deepEqual(picked, ['other']);
  // With Auto-hop on, timed hops open nothing: the layer marks its own
  // timed step as openingCamera while it activates, so the open card stays
  // and Context is not reopened on each step.
  for (const id of ['third', 'fourth', 'fifth'])
    controls._renderCctvState({
      ...activeState,
      activeCameraId: id,
      autoHop: true,
      openingCamera: true,
    });
  assert.deepEqual(picked, ['other']);
  // A person's step (Next or Previous, voice) with Auto-hop on is a pick.
  controls._renderCctvState({
    ...activeState,
    activeCameraId: 'manual-next',
    autoHop: true,
  });
  assert.deepEqual(picked, ['other', 'manual-next']);
});

test('a camera picked after a deselect left none active opens its card', (t) => {
  const { controls } = panel(t);
  const picked = [];
  const onPicked = (event) => picked.push(event.detail.cameraId);
  document.addEventListener(CCTV_SELECTED_EVENT, onPicked);
  t.after(() => document.removeEventListener(CCTV_SELECTED_EVENT, onPicked));
  const at = (id) => ({
    ...activeState,
    activeCameraId: id,
    activeCamera: id ? { ...camera, id } : null,
  });
  controls._renderCctvState(at('a'));
  controls._renderCctvState(at('b'));
  // An empty-ground click leaves no camera active.
  controls._renderCctvState(at(null));
  // Voice, next/previous or the Data Layers row then picks another.
  controls._renderCctvState(at('c'));
  assert.deepEqual(picked, ['b', 'c']);
});

test('the meta line of a disabled layer does not describe its last camera', () => {
  const off = { ...activeState, enabled: false, count: 3 };
  assert.equal(
    presentCctvPanel(off, false).meta,
    '3 cameras loaded · enable CCTV to activate',
  );
  assert.match(presentCctvPanel(activeState, true).meta, /^Austin · HDG /);
});

test('the tools group into View, Auto-hop, Calibration and Scene summary, in plain words', async (t) => {
  const { controls, byId, store } = panel(t);
  const sent = [];
  controls.actions.setParams = (params) => sent.push(params);
  // The interval select is read from the page like the other tools.
  controls._cctvAutoHopSec = byId('cctv-auto-hop-sec');
  controls._initCctvPanel();
  controls._renderCctvState({
    enabled: true,
    count: 1,
    cameraIndex: [camera],
    activeCameraId: 'a',
    activeCamera: { ...camera, pitchDeg: -18, heightM: 8 },
    autoHop: true,
    autoHopSec: 30,
    summaryLines: [
      { label: 'Coverage', value: '0.01 km²' },
      { label: 'Overlap', value: '15 cameras' },
      { label: 'Projection', value: 'On' },
    ],
  });
  await nextTick();
  const heads = [
    ...document.querySelectorAll('#cctv-tools .cctv-tools__head'),
  ].map((node) => node.textContent);
  assert.deepEqual(heads, ['View', 'Auto-hop', 'Calibration', 'Scene summary']);
  // Calibration is a fold, open in the tab; its values sit beside
  // readable labels.
  assert.equal(document.querySelector('.cctv-tools__calibration').open, true);
  const rows = [...document.querySelectorAll('.cctv-cal-grid__row')].map(
    (row) => row.textContent.replace(/\s+/g, ' ').trim(),
  );
  assert.equal(rows[0], 'Heading 91.6°');
  assert.match(rows[1], /^Pitch [−-]18\.0°$/);
  // The scene summary as short labelled lines, not one caps run-on.
  const lines = [
    ...byId('cctv-summary').querySelectorAll('.cctv-tools__line'),
  ].map((line) => line.textContent.replace(/\s+/g, ' ').trim());
  assert.deepEqual(lines, [
    'Coverage 0.01 km²',
    'Overlap 15 cameras',
    'Projection On',
  ]);
  assert.equal(store.view.autoHop.sec, 30);
  assert.equal(byId('cctv-auto-hop-sec').value, '30');
  byId('cctv-auto-hop-sec').value = '45';
  byId('cctv-auto-hop-sec').dispatchEvent(new Event('change'));
  assert.deepEqual(sent.at(-1), { autoHopSec: 45 });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
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

const stillState = (frameUrl, id = 'a') => ({
  enabled: true,
  count: 2,
  cameraIndex: [camera, { ...camera, id: 'b' }],
  activeCameraId: id,
  activeCamera: { ...camera, id, frameUrl, sourceKind: 'snapshot' },
});

test('Camera settings alone never requests a still; a visible card resumes reads', async (t) => {
  const requests = mockImages(t);
  const hidden = Object.getOwnPropertyDescriptor(document, 'hidden');
  let tabHidden = false;
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => tabHidden,
  });
  t.after(() => {
    if (hidden) Object.defineProperty(document, 'hidden', hidden);
    else delete document.hidden;
  });
  const { controls, byId } = panel(t);
  const panelElement = byId('cctv-tools');
  const state = stillState;

  // Collapsed tools: nothing is requested, however often the state arrives.
  panelElement.classList.add('collapsed');
  await settle();
  controls._renderCctvState(state('a1.jpg'));
  controls._renderCctvState(state('a2.jpg'));
  assert.equal(requests.length, 0, 'collapsed tools');

  // Settings has controls but no image. Even a new frame URL stays unread.
  panelElement.classList.remove('collapsed');
  await settle();
  controls._renderCctvState(state('a2.jpg'));
  assert.equal(requests.length, 0, 'expanded settings alone');
  controls.store.showPreviewCard('a', true);
  await settle();
  assert.equal(requests.length, 1, 'visible camera card');
  assert.equal(requests[0].src, 'a2.jpg');
  requests[0].onload();

  // A background tab: refreshed URLs are not requested.
  tabHidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  controls._renderCctvState(state('a3.jpg'));
  assert.equal(requests.length, 1, 'hidden tab');

  // Back in the tab: visibilitychange alone fetches the current URL.
  tabHidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(requests.length, 2, 'visible tab');
  assert.equal(requests[1].src, 'a3.jpg');
});

test('a camera card waits for the Context sheet on phones and an expanded preview can show over another sheet', async (t) => {
  const requests = mockImages(t);
  t.after(() => {
    document.body.classList.remove('mobile-shell');
    document.body.removeAttribute('data-mobile-sheet');
  });
  const { controls } = panel(t);
  document.body.classList.add('mobile-shell');
  document.body.setAttribute('data-mobile-sheet', 'layers');
  controls.store.showPreviewCard('a', true);
  controls._renderCctvState(stillState('a1.jpg'));
  assert.equal(requests.length, 0, 'another sheet is open');

  document.body.removeAttribute('data-mobile-sheet');
  controls._renderCctvState(stillState('a1.jpg'));
  assert.equal(requests.length, 0, 'no sheet is open');

  document.body.setAttribute('data-mobile-sheet', 'context');
  await settle();
  assert.equal(requests.length, 1, 'Context sheet opened');
  assert.equal(requests[0].src, 'a1.jpg');

  // Off a phone the sheet attribute means nothing.
  requests[0].onload();
  document.body.setAttribute('data-mobile-sheet', 'layers');
  controls.store.showPreviewPopup('a', true);
  controls._renderCctvState(stillState('popup.jpg'));
  assert.equal(requests[1].src, 'popup.jpg');
  requests[1].onload();
  controls.store.showPreviewPopup('a', false);
  document.body.classList.remove('mobile-shell');
  document.body.setAttribute('data-mobile-sheet', 'layers');
  controls._renderCctvState(stillState('a2.jpg'));
  assert.equal(requests.length, 3, 'desktop ignores the sheet');
});

test('a camera picked while the card is hidden shows its own still on reopening', async (t) => {
  const requests = mockImages(t);
  const { controls, byId } = panel(t);
  controls.store.showPreviewCard('a', true);
  controls._renderCctvState(stillState('a1.jpg'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].src, 'a1.jpg');
  const completeOldRequest = requests[0].onload;
  controls.store.showPreviewCard('a', false);
  await settle();
  controls._renderCctvState(stillState('b1.jpg', 'b'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].onload, null, 'the previous camera is released');
  completeOldRequest();
  assert.equal(
    controls.store.frame.cameraId,
    '',
    'queued completion is ignored',
  );
  controls.store.showPreviewCard('b', true);
  await settle();
  await nextTick();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].src, 'b1.jpg');
  assert.equal(byId('cctv-frame').dataset.cameraId, 'b');
  assert.notEqual(byId('cctv-frame').getAttribute('src'), 'a1.jpg');
});

test('leaving the Context sheet stops painting the camera canvas and returning starts it again', async (t) => {
  const { controls, byId } = panel(t);
  const { createApplicationCctv } = await import('../app/layers/cctv.js');
  const { defaultSurface } = await import('../data/surfaceServices.js');
  const { bindFakeDraw } = await import('../testSupport/fakeDrawPort.mjs');
  const viewer = {};
  const { unbind } = bindFakeDraw(viewer);
  t.after(unbind);
  const layer = createApplicationCctv({
    surface: defaultSurface,
    source: {
      getCatalog: () => [],
      getHealth: () => null,
      getFrameUrl: () => '',
      getMediaUrl: () => 'data:video/mp4;base64,AA==',
    },
  });
  const dispose = t.mock.fn();
  const video = document.createElement('video');
  layer._setCctvCoverageStateForTest({
    viewer,
    records: [
      {
        camera: { ...camera, lat: 30, lon: -97, feedType: 'mp4' },
        projection: { video, playback: { dispose } },
      },
    ],
    activeCameraId: camera.id,
    enabled: true,
    coverageMode: 'off',
    showProjection: false,
  });
  controls.cctv = layer;
  controls.store.showPreviewCard(camera.id, true);
  assert.equal(layer.getActiveVideoElement(), video);

  // The live video plays in a camera card's top image.
  const card = document.body.appendChild(document.createElement('div'));
  card.className = 'cctv-preview';
  card.appendChild(byId('cctv-video'));
  document.body.classList.add('mobile-shell');
  document.body.setAttribute('data-mobile-sheet', 'context');
  t.after(() => {
    document.body.classList.remove('mobile-shell');
    document.body.removeAttribute('data-mobile-sheet');
  });
  controls._renderCctvState({
    enabled: true,
    count: 1,
    cameraIndex: [camera],
    activeCameraId: 'a',
    activeCamera: { ...camera, isVideo: true },
  });
  const first = controls._cctvVideoSurface;
  assert.ok(first);
  const stop = t.mock.method(first, 'stop');
  document.body.setAttribute('data-mobile-sheet', 'layers');
  await settle();
  assert.equal(stop.mock.callCount(), 1);
  assert.equal(controls._cctvVideoSurface, null);
  assert.equal(
    dispose.mock.callCount(),
    1,
    'last visible consumer released its playback handle',
  );
  document.body.setAttribute('data-mobile-sheet', 'context');
  await settle();
  assert.ok(controls._cctvVideoSurface);
  assert.notEqual(controls._cctvVideoSurface, first);
  const resumed = layer.getActiveVideoElement();
  assert.ok(resumed, 'the returning card reconnects its decoder');
  assert.notEqual(resumed, video);
  layer.setVideoConsumer('dock', camera.id);
  document.body.setAttribute('data-mobile-sheet', 'layers');
  await settle();
  assertSameNode(
    layer.getActiveVideoElement(),
    resumed,
    'the visible dock keeps the shared decoder',
  );
  layer.setVideoConsumer('dock', null);
  assertSameNode(
    layer.getActiveVideoElement(),
    null,
    'closing the last consumer releases it',
  );
  layer.setParams({ showProjection: true });
  const projected = layer.getActiveVideoElement();
  assert.ok(projected, 'projection alone reconnects the decoder');
  layer.setVideoConsumer('card', camera.id);
  layer.setVideoConsumer('card', null);
  assertSameNode(
    layer.getActiveVideoElement(),
    projected,
    'the visible map projection still owns the decoder',
  );
  layer.setParams({ showProjection: false });
  assertSameNode(
    layer.getActiveVideoElement(),
    null,
    'projection was the last consumer',
  );
});

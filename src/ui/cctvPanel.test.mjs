import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import { assertSameNode } from '../testSupport/domAssert.mjs';
import test from 'node:test';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { CctvControls } from './cctvControls.js';
import { presentCctvPanel } from './cctvPresentation.js';
import { useCctvStore } from './stores/cctv.js';
import CctvPanel from './views/panels/CctvPanel.vue';

const BUTTONS = {
  _cctvEnableBtn: 'cctv-enable-btn',
  _cctvNearestBtn: 'cctv-nearest-btn',
  _cctvPrevBtn: 'cctv-prev-btn',
  _cctvNextBtn: 'cctv-next-btn',
  _cctvFocusBtn: 'cctv-focus-btn',
  _cctvCoverageBtn: 'cctv-coverage-btn',
  _cctvAutoHopBtn: 'cctv-auto-hop-btn',
  _cctvProjectionBtn: 'cctv-projection-btn',
};

function panel(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(CctvPanel).use(pinia);
  app.mount(host);
  const elements = Object.fromEntries(
    Object.entries(BUTTONS).map(([key, id]) => [
      key,
      document.getElementById(id),
    ]),
  );
  const controls = new CctvControls({
    elements: {
      ...elements,
      _cctvPanel: document.getElementById('cctv-panel'),
      _cctvSourceBadge: document.getElementById('cctv-source-badge'),
      _cctvFrame: document.getElementById('cctv-frame'),
      _cctvFrameWrap: document.getElementById('cctv-frame-wrap'),
      _cctvSummary: document.getElementById('cctv-summary'),
      _cctvCalReadout: document.getElementById('cctv-cal-readout'),
      _cctvAdjustBtn: document.getElementById('cctv-adjust-btn'),
      _cctvCalibSaveBtn: document.getElementById('cctv-calib-save-btn'),
      _cctvCalibResetBtn: document.getElementById('cctv-calib-reset-btn'),
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
    app.unmount();
  });
  const byId = (id) => document.getElementById(id);
  return { controls, byId };
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

test('the panel keeps its initial markup until the controls render', (t) => {
  const { byId } = panel(t);
  assert.equal(byId('cctv-enable-btn').textContent, 'CCTV OFF');
  assert.equal(byId('cctv-enable-btn').classList.contains('active'), false);
  assert.equal(byId('cctv-coverage-btn').textContent, 'COVERAGE OFF');
  assert.equal(byId('cctv-auto-hop-btn').textContent, 'AUTO HOP OFF');
  assert.equal(byId('cctv-projection-btn').textContent, 'PROJECTION ON');
  assert.equal(byId('cctv-quality-chip').textContent, 'CAL · --');
  assert.equal(byId('cctv-quality-chip').hasAttribute('data-cal-badge'), false);
  assert.equal(
    byId('cctv-meta').textContent,
    'Enable CCTV to load camera intersections',
  );
  for (const id of Object.values(BUTTONS))
    assert.equal(byId(id).disabled, false, id);
});

test('a disabled layer disables every button but the switch', async (t) => {
  const { controls, byId } = panel(t);
  controls._renderCctvState({ enabled: false, count: 3, cameraIndex: [] });
  await nextTick();
  assert.equal(byId('cctv-enable-btn').disabled, false);
  for (const [key, id] of Object.entries(BUTTONS)) {
    if (key === '_cctvEnableBtn') continue;
    assert.equal(byId(id).disabled, true, id);
  }
  assert.equal(
    byId('cctv-meta').textContent,
    '3 cameras loaded · enable CCTV to activate',
  );
});

test('an active camera renders the switch, toggles, CAL chip and meta line', async (t) => {
  const { controls, byId } = panel(t);
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
  assert.equal(byId('cctv-enable-btn').textContent, 'CCTV ON');
  assert.equal(byId('cctv-enable-btn').classList.contains('active'), true);
  for (const id of Object.values(BUTTONS))
    assert.equal(byId(id).disabled, false, id);
  assert.equal(byId('cctv-coverage-btn').textContent, 'VIEWSHED ON');
  assert.equal(byId('cctv-coverage-btn').classList.contains('active'), true);
  assert.equal(byId('cctv-auto-hop-btn').textContent, 'AUTO HOP ON');
  assert.equal(byId('cctv-projection-btn').textContent, 'PROJECTION OFF');
  assert.equal(byId('cctv-projection-btn').classList.contains('active'), false);
  // The toggles say their state to assistive technology, not only by colour.
  const pressed = (id) => byId(id).getAttribute('aria-pressed');
  assert.equal(pressed('cctv-enable-btn'), 'true');
  assert.equal(pressed('cctv-coverage-btn'), 'true');
  assert.equal(pressed('cctv-auto-hop-btn'), 'true');
  assert.equal(pressed('cctv-projection-btn'), 'false');
  assert.equal(pressed('cctv-adjust-btn'), 'false');
  assert.equal(byId('cctv-quality-chip').textContent, 'CAL · CURATED');
  assert.equal(byId('cctv-quality-chip').dataset.calBadge, 'curated');
  assert.equal(
    byId('cctv-meta').textContent,
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
  assert.equal(byId('cctv-nearest-btn').disabled, true);
});

test('FOCUS waits for an active camera while the other buttons work', () => {
  const loaded = { enabled: true, count: 2, cameraIndex: [] };
  const view = presentCctvPanel(loaded, true);
  assert.equal(view.navDisabled, false);
  assert.equal(view.focusDisabled, true);
  assert.equal(view.toggleDisabled, false);
  const active = presentCctvPanel(
    { ...loaded, activeCameraId: 'a', activeCamera: camera },
    true,
  );
  assert.equal(active.focusDisabled, false);
  assert.equal(presentCctvPanel(loaded, false).toggleDisabled, true);
});

test('coverage reads its mode, or the older on/off flag', () => {
  const text = (state) => presentCctvPanel(state, true).coverage;
  assert.deepEqual(text({ coverageMode: 'on' }), {
    active: true,
    text: 'COVERAGE ON',
  });
  assert.deepEqual(text({ showCoverage: true }), {
    active: true,
    text: 'COVERAGE ON',
  });
  assert.deepEqual(text({}), { active: false, text: 'COVERAGE OFF' });
});

test('losing the active camera resets the CAL chip', async (t) => {
  const { controls, byId } = panel(t);
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
  assert.equal(
    byId('cctv-meta').textContent,
    'Enable CCTV to load camera intersections',
  );
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
  assert.equal(chip.textContent, 'HDG 30.0°');
  const input = await begin();
  assert.ok(input, 'the chip holds an input');
  assert.ok(document.activeElement === input, 'the input has focus');
  assert.equal(chip.textContent, 'HDG ');
  assert.equal(input.value, '30.0');
  assert.equal(input.step, '0.1');
  assert.equal(input.getAttribute('aria-label'), 'HDG');
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
  assert.equal(chip.textContent, 'HDG 30.0°');
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
  assert.equal(chip.textContent, 'HDG 200.0°');
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
  assert.equal(chip.textContent, 'HDG 30.0°');
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
  assert.equal(chip.textContent, 'ΔN --');
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
  assert.equal(byId('cctv-adjust-btn').textContent, 'ADJUST ON');
  assert.equal(byId('cctv-adjust-btn').classList.contains('active'), true);
  assert.equal(byId('cctv-calib-save-btn').disabled, false);
  assert.equal(chip.textContent, 'ΔN 0.0m');
  assert.equal(chip.disabled, false);
});

test('blur alone commits the draft; an empty draft changes nothing', async (t) => {
  const { patches, chip, begin } = await calibrating(t);
  let input = await begin();
  input.value = '';
  input.dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, []);
  await nextTick();
  assert.equal(chip.textContent, 'HDG 30.0°');
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
  const { controls, byId } = panel(t);
  const frame = byId('cctv-frame');
  const wrap = byId('cctv-frame-wrap');
  const badge = byId('cctv-source-badge');
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
  controls._renderCctvState(state);
  await nextTick();
  assert.equal(frame.dataset.cameraId, 'a');
  assert.equal(frame.dataset.loading, 'true');
  assert.equal(frame.hasAttribute('src'), false);
  assert.equal(wrap.classList.contains('loading'), true);
  assert.equal(badge.textContent, 'FRAME · LOADING');
  assert.equal(badge.dataset.frameState, 'loading');
  requests[0].onload();
  await nextTick();
  assert.equal(frame.getAttribute('src'), 'a.jpg');
  assert.equal(frame.dataset.loading, '');
  assert.equal(frame.classList.contains('active'), true);
  assert.equal(wrap.classList.contains('has-frame'), true);
  assert.equal(wrap.classList.contains('loading'), false);
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
  assert.equal(wrap.classList.contains('has-frame'), true);
  assert.equal(badge.textContent, 'SNAPSHOT · OK');
  // Another camera clears them while its frame loads.
  controls._renderCctvState({
    ...state,
    activeCameraId: 'b',
    activeCamera: { ...state.activeCamera, id: 'b', frameUrl: 'b.jpg' },
  });
  await nextTick();
  assert.equal(frame.hasAttribute('src'), false);
  assert.equal(frame.dataset.cameraId, 'b');
  assert.equal(wrap.classList.contains('has-frame'), false);
  assert.equal(badge.textContent, 'FRAME · LOADING');
  controls._renderCctvState({ ...state, enabled: false });
  await nextTick();
  assert.equal(frame.hasAttribute('src'), false);
  assert.equal(frame.dataset.cameraId, '');
  assert.equal(wrap.classList.contains('has-frame'), false);
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

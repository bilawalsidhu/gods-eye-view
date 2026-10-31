import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
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

test('re-renders leave what the controls write alone', async (t) => {
  const { controls, byId } = panel(t);
  const select = byId('cctv-camera-select');
  const option = document.createElement('option');
  option.value = 'a';
  option.textContent = 'Austin · Congress Ave';
  select.append(option);
  byId('cctv-frame').setAttribute('src', 'https://example.test/a.jpg');
  byId('cctv-summary').textContent = 'Typed summary';
  const heading = document.querySelector('[data-cal-field="heading"]');
  heading.textContent = 'HDG 92°';
  for (const enabled of [true, false, true]) {
    controls._renderCctvState({ enabled, count: 1, cameraIndex: [] });
    await nextTick();
  }
  assert.equal(select.options.length, 1);
  assert.equal(select.options[0].value, 'a');
  assert.equal(
    byId('cctv-frame').getAttribute('src'),
    'https://example.test/a.jpg',
  );
  assert.equal(byId('cctv-summary').textContent, 'Typed summary');
  assert.equal(heading.textContent, 'HDG 92°');
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

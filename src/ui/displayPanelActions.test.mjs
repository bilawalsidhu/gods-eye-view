// src/ui/displayPanelActions.test.mjs — the Display panel's controls, the
// clean-view exit and the dock's style buttons call the Display controls'
// owner through the display store, and only while it is connected.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useDisplayStore } from './stores/display.js';
import { DisplayBindings } from './displayBindings.js';
import { VisualSettings } from './visualSettings.js';
import CommandDockView from './views/CommandDockView.vue';
import DisplayControlsView from './views/DisplayControlsView.vue';
import DrawControls from './views/panels/DrawControls.vue';

function mount(t) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = useDisplayStore(pinia);
  const app = createApp({
    // Draw sits in UTILITIES now; it answers through the same store.
    render: () => [h(DisplayControlsView), h(CommandDockView), h(DrawControls)],
  }).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  return store;
}
const $ = (id) => document.getElementById(id);
function recorder(store) {
  const calls = [];
  const actions = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args) =>
          calls.push([name, ...args]),
    },
  );
  return { calls, token: store.connect(actions) };
}
function input(el, value, type = 'input') {
  el.value = String(value);
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

test('buttons, sliders, the layout select and the Scope checkbox call their actions', async (t) => {
  const store = mount(t);
  const { calls } = recorder(store);
  for (const id of [
    'hud-toggle',
    'cyber-sonar-toggle',
    'detection-toggle',
    'models3d-toggle',
    'celestial-toggle',
    'clean-view-toggle',
    'bloom-toggle',
    'sharpen-toggle',
    'clean-view-exit',
  ])
    $(id).click();
  input($('hud-layout-select'), 'minimal', 'change');
  input($('cyber-sonar-rings'), 5);
  input($('cyber-sonar-range'), 90);
  input($('cyber-sonar-intensity'), 40);
  input($('cyber-sonar-opacity'), 60);
  input($('cyber-sonar-sector'), 30);
  input($('detection-density-slider'), 75);
  input($('detection-fade-slider'), 12);
  input($('detection-opacity-slider'), 3);
  input($('scope-feather-slider'), 150);
  input($('bloom-intensity-slider'), 24);
  input($('sharpen-intensity-slider'), 37);
  $('scope-toggle').checked = false;
  $('scope-toggle').dispatchEvent(new Event('change', { bubbles: true }));
  assert.deepEqual(calls, [
    ['toggleHud'],
    ['toggleSonar'],
    ['cycleDetection'],
    ['toggleModels'],
    ['toggleCelestial'],
    ['toggleCleanView'],
    ['toggleBloom'],
    ['toggleSharpen'],
    ['exitCleanView'],
    ['setHudLayout', 'minimal'],
    ['setSonarRings', 5],
    ['setSonarRange', 90],
    ['setSonarIntensity', 40],
    ['setSonarOpacity', 60],
    ['setSonarSector', 30],
    // Density passes the slider's own value, as it always has.
    ['setDensity', 75],
    ['setFade', 12],
    ['setOutsideOpacity', 3],
    ['setScopeFeather', 150],
    ['setBloomIntensity', 24],
    ['setSharpenIntensity', 37],
    ['setScopeEnabled', false],
  ]);
});

test('the Draw controls call the draw tool and show what it publishes', async (t) => {
  const store = mount(t);
  const { calls } = recorder(store);
  $('draw-toggle').click();
  document.querySelector('[data-shape="pin"]').click();
  document.querySelector('#draw-colors [data-color="red"]').click();
  $('draw-clear').click();
  assert.deepEqual(calls, [
    ['toggleDraw'],
    ['setDrawShape', 'pin'],
    ['setDrawColor', 'red'],
    ['clearDraw'],
  ]);
  store.publishDraw({
    active: true,
    shape: 'line',
    color: 'green',
    hint: 'Click to add points.',
    marks: [],
  });
  await nextTick();
  const line = document.querySelector('[data-shape="line"]');
  assert.equal(line.getAttribute('aria-checked'), 'true');
  assert.ok(line.classList.contains('active'));
  const green = document.querySelector('#draw-colors [data-color="green"]');
  assert.equal(green.getAttribute('aria-checked'), 'true');
  assert.ok(green.classList.contains('active'));
  assert.equal($('draw-hint').textContent, 'Click to add points.');
  assert.equal($('draw-toggle').getAttribute('aria-pressed'), 'true');
});

test('style, allocation and model choices keep their ids and data attributes', async (t) => {
  const store = mount(t);
  const { calls } = recorder(store);
  document.querySelector('.style-btn[data-style="thermal"]').click();
  $('detection-allocation-weighted').click();
  $('models3d-mode-all').click();
  $('models3d-mode-proximity').click();
  assert.deepEqual(calls, [
    ['setStyle', 'thermal'],
    ['setAllocation', 'WEIGHTED'],
    ['setModelsMode', 'all'],
    ['setModelsMode', 'proximity'],
  ]);
  assert.equal(
    $('detection-allocation-weighted').dataset.allocation,
    'WEIGHTED',
  );
  assert.equal($('models3d-mode-all').dataset.mode, 'all');
  // Their selection follows what the owners present.
  assert.equal(
    $('models3d-mode-proximity').getAttribute('aria-checked'),
    'true',
  );
  store.publishModels3d({ pressed: true, mode: 'all', rowVisible: true });
  await nextTick();
  assert.equal($('models3d-mode-all').getAttribute('aria-checked'), 'true');
  assert.ok($('models3d-mode-all').classList.contains('active'));
});

test('a detached or replaced owner hears nothing', (t) => {
  const store = mount(t);
  const first = recorder(store);
  $('bloom-toggle').click();
  store.detach(first.token);
  $('bloom-toggle').click();
  const second = recorder(store);
  store.detach(first.token);
  $('bloom-toggle').click();
  assert.deepEqual(first.calls, [['toggleBloom']]);
  assert.deepEqual(second.calls, [['toggleBloom']]);
});

test('DisplayBindings answers the controls from init until destroy', (t) => {
  const store = mount(t);
  const calls = [];
  const bindings = new DisplayBindings({
    viewer: null,
    services: { isScopeMaskEnabled: () => false, cycleDetectionMode: () => {} },
    elements: { _locationSearch: document.createElement('input') },
    operations: {
      _setScope: () => {},
      _setBloomEnabled: (enabled) => calls.push(['bloom', enabled]),
    },
    readState: () => ({ bloomEnabled: false }),
    claimDetection: () => {},
    displayStore: store,
  });
  bindings._initUI();
  // Initialising again replaces its own connection rather than stacking one.
  bindings._initUI();
  $('bloom-toggle').click();
  assert.deepEqual(calls, [['bloom', true]]);
  // A newer owner takes over; the old one's destroy leaves it connected.
  const next = recorder(store);
  bindings.destroy();
  $('bloom-toggle').click();
  assert.deepEqual(calls, [['bloom', true]]);
  assert.deepEqual(next.calls, [['toggleBloom']]);
  store.detach(next.token);
  bindings._initUI();
  bindings.destroy();
  $('bloom-toggle').click();
  assert.deepEqual(calls, [['bloom', true]]);
});

test('several owners answer their own actions, the newest first', (t) => {
  const store = mount(t);
  const calls = [];
  const owner = (tag, names) =>
    store.connect(
      Object.fromEntries(
        names.map((name) => [name, () => calls.push([tag, name])]),
      ),
    );
  const display = owner('display', ['toggleBloom', 'setStyle']);
  const draw = owner('draw', ['toggleDraw']);
  const newer = owner('newer', ['toggleBloom']);
  $('bloom-toggle').click();
  $('draw-toggle').click();
  store.detach(newer);
  $('bloom-toggle').click();
  store.detach(draw);
  $('draw-toggle').click();
  store.detach(display);
  $('bloom-toggle').click();
  assert.deepEqual(calls, [
    ['newer', 'toggleBloom'],
    ['draw', 'toggleDraw'],
    ['display', 'toggleBloom'],
  ]);
});

test('the Visual panel’s scope opacity, reset and presets call their actions', async (t) => {
  const store = mount(t);
  const { calls } = recorder(store);
  const selected = [];
  store.connectMapSource({ select: async (id) => selected.push(id) });
  store.publishMapSource({
    status: { text: 'OSM', warn: false },
    chips: [
      { id: 'photoreal', label: 'Google 3D', available: false },
      { id: 'osm', label: 'OSM', available: true, active: true },
    ],
  });
  await nextTick();
  input($('scope-opacity-slider'), 60);
  document.querySelector('#pp-toggles .pp-reset-btn').click();
  const presets = document.querySelector('#pp-toggles .visual-presets');
  presets.querySelector('[data-style="noir"]').click();
  const chips = presets.querySelectorAll('.visual-presets__chip');
  chips[0].click();
  chips[1].click();
  assert.deepEqual(calls, [
    ['setScopeOpacity', 60],
    ['resetVisual'],
    ['setStyle', 'noir'],
  ]);
  assert.deepEqual(selected, ['osm'], 'an unavailable source is not selected');
  // The presets follow the published style, as the dock's do.
  assert.equal(
    presets.querySelector('[data-style="normal"]').getAttribute('aria-pressed'),
    'true',
  );
  store.publishStyle({ name: 'noir', label: 'NOIR' });
  await nextTick();
  assert.equal(
    presets.querySelector('[data-style="noir"]').getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(
    presets.querySelector('[data-style="normal"]').getAttribute('aria-pressed'),
    'false',
  );
  // The dock keeps its own presets and map source beside them.
  assert.ok(
    document.querySelector('#control-panel .style-btn[data-style="noir"]'),
  );
  assert.ok($('map-stack-chips'));
});

test('DisplayBindings sets the scope opacity and resets Visual to its defaults', (t) => {
  const store = mount(t);
  const calls = [];
  const bindings = new DisplayBindings({
    viewer: null,
    services: { isScopeMaskEnabled: () => true, cycleDetectionMode: () => {} },
    elements: { _locationSearch: document.createElement('input') },
    operations: {
      setStyle: (style, options) => calls.push(['style', style, options]),
      _applyGlobalPostDefaults: (options) =>
        calls.push(['postDefaults', options]),
      _setDetectionAllocation: (value) => calls.push(['allocation', value]),
      _setScope: (scope) => calls.push(['scope', scope]),
      _setModels3dEnabled: (on) => calls.push(['models3d', on]),
      _setModels3dMode: (mode) => calls.push(['models3dMode', mode]),
      _syncModels3dModeRow: () => calls.push(['models3dRow']),
      _syncShareState: () => calls.push(['share']),
      _adoptDetectionAsRestore: () => calls.push(['adoptDetection']),
    },
    readState: () => ({
      shareLinkManager: {
        claimRestoreLane: (lane) => calls.push(['claim', lane]),
      },
    }),
    claimDetection: () => calls.push(['claimDetection']),
    displayStore: store,
  });
  bindings._initUI();
  t.after(() => bindings.destroy());
  calls.length = 0;
  input($('scope-opacity-slider'), 65);
  assert.deepEqual(calls, [
    ['claim', 'visual'],
    ['scope', { opacityPct: 65 }],
    ['share'],
  ]);
  calls.length = 0;
  document.querySelector('#pp-toggles .pp-reset-btn').click();
  assert.deepEqual(calls, [
    ['claim', 'visual'],
    ['style', 'normal', undefined],
    ['postDefaults', { keepHudVariant: true }],
    ['allocation', 'ELASTIC'],
    ['scope', { enabled: true, featherPct: 100, opacityPct: 100 }],
    ['models3d', true],
    ['models3dMode', 'proximity'],
    ['models3dRow'],
    ['claimDetection'],
    ['adoptDetection'],
    ['share'],
  ]);
});

test('a reset inside Contacts makes the shown detection what leaving puts back', () => {
  const adopt = VisualSettings.prototype.adoptDetectionAsRestore;
  const live = { detectionMode: 'DENSE', densityPct: 75 };
  const inContacts = {
    _contactsDetectionRestore: { mode: 'OFF', densityPct: 50 },
    getDetectionState: () => live,
  };
  adopt.call(inContacts);
  assert.deepEqual(inContacts._contactsDetectionRestore, {
    mode: 'DENSE',
    densityPct: 75,
  });
  // Outside Contacts there is no saved state to change.
  const outside = {
    _contactsDetectionRestore: null,
    getDetectionState: () => live,
  };
  adopt.call(outside);
  assert.equal(outside._contactsDetectionRestore, null);
});

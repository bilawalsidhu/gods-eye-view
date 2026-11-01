// src/ui/displayPanel.test.mjs — the Display panel renders bloom and sharpen
// from what VisualSettings publishes, and shows its initial markup before.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { useDisplayStore } from './stores/display.js';
import DisplayPanel from './views/panels/DisplayPanel.vue';
import { AircraftDisplay } from './aircraftDisplay.js';
import { VisualSettings } from './visualSettings.js';
import { initGeoFileImport } from './geoFileImport.js';
import { CockpitDisplayPortal } from './cockpitDisplayPortal.js';
// Core's classes on an element, without the kit's `ui-` classes.
const coreClasses = (el) =>
  [...el.classList].filter((name) => !name.startsWith('ui-')).join(' ');

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(DisplayPanel).use(pinia);
  app.mount(host);
  let mounted = true;
  const unmount = () => {
    if (mounted) app.unmount();
    mounted = false;
  };
  t.after(unmount);
  const $ = (id) => document.getElementById(id);
  return { store: useDisplayStore(pinia), $, unmount };
}

/** A VisualSettings over stand-in effects, publishing to `store`. */
function settings(store) {
  const owner = Object.create(VisualSettings.prototype);
  const effects = {
    bloomEnabled: false,
    sharpenEnabled: false,
    bloomIntensity: 0,
    sharpenIntensity: 0.49,
    applyBloomIntensity(value) {
      this.bloomIntensity = value;
    },
    applySharpenIntensity(value) {
      this.sharpenIntensity = value;
    },
    setBloomEnabled(on) {
      this.bloomEnabled = on;
    },
    setSharpenEnabled(on) {
      this.sharpenEnabled = on;
    },
    syncBloomEnabled() {},
  };
  const shares = [];
  Object.assign(owner, {
    store,
    _visualEffects: effects,
    _sharpenPct: 49,
    services: { governorRequestRender() {} },
    _syncShareState: () => shares.push(true),
    _layoutRightPanels() {},
  });
  return { owner, effects, shares };
}

test('before VisualSettings renders, the panel shows its initial markup', (t) => {
  const { $ } = fixture(t);
  assert.equal($('bloom-toggle').className, 'pp-toggle-btn');
  assert.equal($('bloom-slider-row').className, 'pp-slider-row');
  assert.equal($('bloom-intensity-slider').value, '0');
  assert.equal($('bloom-intensity-value').textContent, '0%');
  assert.equal($('sharpen-intensity-slider').value, '49');
  assert.equal($('sharpen-intensity-value').textContent, '49%');
});

test('bloom and sharpen render their state, slider and readout', async (t) => {
  const { store, $ } = fixture(t);
  const { owner, effects, shares } = settings(store);

  owner._setBloomEnabled(true);
  owner._setBloomIntensity(140.4);
  await nextTick();
  assert.equal($('bloom-toggle').classList.contains('active'), true);
  assert.equal($('bloom-slider-row').classList.contains('visible'), true);
  assert.equal($('bloom-intensity-slider').value, '140');
  assert.equal($('bloom-intensity-value').textContent, '140%');
  assert.equal(effects.bloomIntensity, 140);

  owner._setSharpenEnabled(true);
  owner._setSharpenIntensity(130);
  await nextTick();
  assert.equal($('sharpen-toggle').classList.contains('active'), true);
  assert.equal($('sharpen-slider-row').classList.contains('visible'), true);
  assert.equal($('sharpen-intensity-slider').value, '100', 'clamped to 100');
  assert.equal($('sharpen-intensity-value').textContent, '100%');
  assert.equal(effects.sharpenIntensity, 1);
  assert.equal(owner.sharpenIntensityPct, 100);
  assert.ok(shares.length > 0, 'changes reach the share state');

  owner._setBloomEnabled(false);
  await nextTick();
  assert.equal($('bloom-toggle').classList.contains('active'), false);
  assert.equal($('bloom-slider-row').classList.contains('visible'), false);
  assert.equal($('bloom-intensity-value').textContent, '140%', 'the amount stays');
});

test('a publish never rewrites a slider the user is dragging', async (t) => {
  const { store, $ } = fixture(t);
  const { owner } = settings(store);
  owner._setSharpenIntensity(30);
  await nextTick();
  const slider = $('sharpen-intensity-slider');
  let writes = 0;
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(slider),
    'value',
  );
  Object.defineProperty(slider, 'value', {
    get: () => descriptor.get.call(slider),
    set: (next) => {
      writes++;
      descriptor.set.call(slider, next);
    },
  });
  // The input handler applies the dragged value; the publish that follows
  // carries the same value, so the slider is left alone.
  owner._setSharpenIntensity(30);
  owner._setBloomEnabled(true);
  await nextTick();
  assert.equal(writes, 0);
  assert.equal(slider.value, '30');
});

/** VisualSettings with a stand-in detection engine. */
function detectionSettings(store) {
  const { owner } = settings(store);
  const engine = {
    mode: 'OFF',
    tuning: { densityPct: 50, allocationStrategy: 'ELASTIC' },
    fade: { fadeRatio: 0.07, outsideOpacity: 0.01 },
  };
  Object.assign(owner, {
    _detectionDensityPct: 50,
    _detectionFadePct: 7,
    _detectionOutsidePct: 1,
    _detectionModeLabel: null,
    _detectionAllocationShown: null,
    viewer: { scene: { requestRender() {} } },
  });
  owner.services = {
    ...owner.services,
    getDetectionMode: () => engine.mode,
    setDetectionModeByLabel: (label) => {
      engine.mode = label;
    },
    getDetectionTuning: () => ({ ...engine.tuning }),
    setDetectionTuning: (next) => Object.assign(engine.tuning, next),
    getKeyholeFadeTuning: () => ({ ...engine.fade }),
    setKeyholeFadeTuning: (next) => Object.assign(engine.fade, next),
  };
  return { owner, engine };
}

test('detection renders its mode, rows, sliders and allocation', async (t) => {
  const { store, $ } = fixture(t);
  const { owner, engine } = detectionSettings(store);
  const button = $('detection-toggle');
  assert.equal(button.querySelector('.pp-label').textContent, 'DETECT');
  assert.equal(button.getAttribute('aria-label'), 'Detection overlay');

  owner._setDetectionMode('DENSE');
  owner._setDetectionDensity(80);
  await nextTick();
  assert.equal(button.querySelector('.pp-label').textContent, 'DENSE');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.getAttribute('aria-label'), 'Detection overlay: dense');
  assert.equal(coreClasses(button), 'pp-toggle-btn active panoptic');
  for (const id of [
    'detection-slider-row',
    'detection-allocation-row',
    'detection-fade-row',
    'detection-opacity-row',
  ])
    assert.equal($(id).classList.contains('visible'), true, id);
  assert.equal($('detection-density-slider').value, '75', 'nearest stop');
  assert.equal($('detection-density-value').textContent, '75%');
  assert.equal(engine.tuning.densityPct, 75);

  owner._setDetectionFade({ fadePct: 55 });
  owner._setDetectionAllocation('weighted', { persist: false });
  await nextTick();
  assert.equal($('detection-fade-slider').value, '40', 'clamped to 40');
  assert.equal($('detection-fade-value').textContent, '40%');
  assert.equal($('detection-opacity-value').textContent, '1%', 'kept');
  assert.equal(engine.fade.fadeRatio, 0.4);
  const weighted = $('detection-allocation-weighted');
  const elastic = $('detection-allocation-elastic');
  assert.equal(weighted.classList.contains('active'), true);
  assert.equal(weighted.getAttribute('aria-checked'), 'true');
  assert.equal(elastic.classList.contains('active'), false);
  assert.equal(elastic.getAttribute('aria-checked'), 'false');
  assert.deepEqual(owner.getDetectionState(), {
    detectionMode: 'DENSE',
    densityPct: 75,
    allocationStrategy: 'WEIGHTED',
    fadePct: 40,
    outsideOpacityPct: 1,
  });

  owner._setDetectionMode('OFF');
  await nextTick();
  assert.equal(button.querySelector('.pp-label').textContent, 'DETECT');
  assert.equal(button.getAttribute('aria-label'), 'Detection overlay: off');
  assert.equal(coreClasses(button), 'pp-toggle-btn');
  assert.equal($('detection-slider-row').classList.contains('visible'), false);
});

test('the HUD and Sonar controls render what VisualSettings shows', async (t) => {
  const { store, $ } = fixture(t);
  const { owner } = settings(store);
  let visible = true;
  let variant = 'minimal';
  owner.readHud = () => ({
    get visible() {
      return visible;
    },
    getVariant: () => variant,
  });
  owner._scheduleAdaptivePanelLayout = () => {};
  assert.equal($('cyber-sonar-toggle').textContent, 'ON');
  assert.equal($('cyber-sonar-toggle').getAttribute('aria-pressed'), 'true');

  owner._syncHudControls();
  await nextTick();
  assert.equal($('hud-toggle').classList.contains('active'), true);
  assert.equal($('hud-layout-row').classList.contains('visible'), true);
  assert.equal($('hud-layout-select').value, 'minimal');

  visible = false;
  owner._updateHudButtonState();
  await nextTick();
  assert.equal($('hud-toggle').classList.contains('active'), false);
  assert.equal($('hud-layout-row').classList.contains('visible'), false);

  owner._sonarShown = {
    enabled: false,
    rings: 5,
    range: 90,
    intensity: 40,
    opacity: 60,
    sector: 30,
  };
  owner._publishDisplay();
  await nextTick();
  const toggle = $('cyber-sonar-toggle');
  assert.equal(toggle.textContent, 'OFF');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(toggle.classList.contains('active'), false);
  assert.equal($('cyber-sonar-rings').value, '5');
  assert.equal($('cyber-sonar-rings-value').textContent, '5');
  assert.equal($('cyber-sonar-range-value').textContent, '90%');
  assert.equal($('cyber-sonar-sector').value, '30');
  assert.equal($('cyber-sonar-sector-value').textContent, '30°');
});

test('Scope and Celestial render what VisualSettings shows', async (t) => {
  const { store, $ } = fixture(t);
  const { owner } = settings(store);
  const mask = { enabled: true, feather: 0.35 };
  owner.services = {
    ...owner.services,
    setScopeMaskEnabled: (on) => (mask.enabled = on),
    setScopeMaskFeather: (value) => (mask.feather = value),
  };
  assert.equal($('scope-toggle').checked, true);
  assert.equal($('scope-feather-value').textContent, '100%');
  assert.equal($('celestial-toggle').hasAttribute('aria-disabled'), false);

  owner._setScope({ enabled: false }, { apply: false });
  await nextTick();
  assert.equal($('scope-toggle').checked, false);
  assert.equal($('scope-feather-slider').disabled, true);
  assert.equal(mask.enabled, true, 'only shown');

  owner._setScope({ enabled: true, featherPct: 250 });
  await nextTick();
  assert.equal($('scope-toggle').checked, true);
  assert.equal($('scope-feather-slider').disabled, false);
  assert.equal($('scope-feather-slider').value, '200', 'clamped');
  assert.equal($('scope-feather-value').textContent, '200%');
  assert.deepEqual(mask, { enabled: true, feather: 2 });

  owner._celestialShown = { active: false, supported: false };
  owner._publishDisplay();
  await nextTick();
  const celestial = $('celestial-toggle');
  assert.equal(celestial.disabled, true);
  assert.equal(celestial.getAttribute('aria-disabled'), 'true');
  assert.equal(celestial.title, 'Celestial ring — available in Normal style');

  owner._celestialShown = { active: true, supported: true };
  owner._publishDisplay();
  await nextTick();
  assert.equal(celestial.disabled, false);
  assert.equal(celestial.getAttribute('aria-pressed'), 'true');
  assert.equal(celestial.classList.contains('active'), true);
  assert.equal(celestial.title, 'Celestial ring — reveal the full globe');
});

test('the 3D aircraft group renders what AircraftDisplay shows', async (t) => {
  const { store, $ } = fixture(t);
  const params = [];
  const owner = new AircraftDisplay({
    elements: { _models3dBtn: $('models3d-toggle') },
    readDataManager: () => ({
      setLayerParams: (id, next) => params.push([id, next]),
    }),
    layout() {},
    store,
  });
  const button = $('models3d-toggle');
  const row = $('models3d-mode-row');
  const all = $('models3d-mode-all');
  assert.equal(coreClasses(button), 'pp-toggle-btn active');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(row.classList.contains('visible'), true);
  assert.equal($('models3d-mode-proximity').getAttribute('aria-checked'), 'true');

  // The button leaves the row to its own sync.
  owner._setModels3dEnabled(false);
  await nextTick();
  assert.equal(coreClasses(button), 'pp-toggle-btn');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(row.classList.contains('visible'), true);
  owner._syncModels3dModeRow();
  await nextTick();
  assert.equal(row.classList.contains('visible'), false);

  owner._setModels3dMode('all');
  await nextTick();
  assert.equal(all.classList.contains('active'), true);
  assert.equal(all.getAttribute('aria-checked'), 'true');
  assert.equal($('models3d-mode-proximity').classList.contains('active'), false);
  assert.deepEqual(params.at(-1), ['military', { models3dMode: 'all' }]);

  owner._syncModels3dFromLayerState({
    options: { flights: { models3d: true, models3dMode: 'proximity' } },
  });
  await nextTick();
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(row.classList.contains('visible'), true);
  assert.equal(all.getAttribute('aria-checked'), 'false');
});

test('the Draw controls render what the draw tool publishes', async (t) => {
  const { store, $ } = fixture(t);
  const toggle = $('draw-toggle');
  const segment = (shape) =>
    document.querySelector(`#draw-mode-row [data-shape="${shape}"]`);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(segment('area').getAttribute('aria-checked'), 'true');
  assert.equal($('draw-hint').textContent, '');

  store.publishDraw({ active: true, shape: 'line', hint: 'Click to add points.' });
  await nextTick();
  assert.equal(coreClasses(toggle), 'pp-toggle-btn active');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal($('draw-mode-row').classList.contains('visible'), true);
  assert.equal($('draw-label-row').classList.contains('visible'), true);
  assert.equal(segment('line').getAttribute('aria-checked'), 'true');
  assert.equal(segment('line').classList.contains('active'), true);
  assert.equal(segment('area').classList.contains('active'), false);
  assert.equal($('draw-hint').textContent, 'Click to add points.');

  store.publishDraw({ active: false, shape: 'line', hint: '' });
  await nextTick();
  assert.equal(coreClasses(toggle), 'pp-toggle-btn');
  assert.equal($('draw-mode-row').classList.contains('visible'), false);
  assert.equal($('draw-label-row').classList.contains('visible'), false);
});

test('the imported files render what the file import publishes and keep focus', async (t) => {
  const { store, $ } = fixture(t);
  const list = $('geo-import-list');
  assert.equal(list.className, 'geo-import-list');
  assert.equal(list.children.length, 0);
  assert.equal($('geo-import-hint').textContent, '');

  const viewer = {
    container: document.createElement('div'),
    scene: { requestRender() {} },
    dataSources: { add: async (ds) => ds, remove: () => true },
  };
  const tool = initGeoFileImport({
    viewer,
    load: async (file) => ({
      dataSource: { show: true },
      name: file.name,
      format: file.name.endsWith('.kml') ? 'kml' : 'geojson',
      entityCount: 2,
      removed: 0,
      revoke() {},
    }),
    flyToSource() {},
    publish: (view) => store.publishGeoImport(view),
    connect: (actions) => {
      const token = store.connect(actions);
      return () => store.detach(token);
    },
  });
  t.after(() => tool.destroy());
  await tool.importFiles([{ name: '<b>a</b>.geojson' }, { name: 'b.kml' }]);
  await nextTick();
  assert.equal(list.className, 'geo-import-list visible');
  assert.equal($('geo-import-hint').textContent, 'Added 2 files.');
  const rowsNow = () => [...list.querySelectorAll('.geo-import-row')];
  const [first, second] = rowsNow();
  assert.equal(first.children.length, 5);
  assert.equal(
    [...first.childNodes].some((node) => node.nodeType === 3 && node.data),
    false,
    'no text between the parts',
  );
  const [swatch, name, toggle] = first.children;
  assert.equal(swatch.className, 'geo-import-swatch');
  assert.ok(swatch.style.background);
  assert.equal(name.textContent, '<b>a</b>.geojson');
  assert.equal(name.children.length, 0, 'the name is text');
  assert.match(name.title, /GEOJSON, 2 map objects$/);
  assert.equal(toggle.className, 'geo-import-action');
  assert.equal(toggle.getAttribute('type'), 'button');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Hide <b>a</b>.geojson');
  assert.equal(toggle.textContent, 'visibility');
  assert.equal(first.children[3].hasAttribute('aria-pressed'), false);
  assert.equal(second.children[0].className, 'geo-import-swatch own-styles');
  assert.equal(second.children[0].getAttribute('style'), null);

  const button = (row, action) =>
    row.querySelector(`button[data-action="${action}"]`);
  // The click lands on the icon inside the button, as in a browser.
  const press = async (el) => {
    el.focus();
    el.firstElementChild.click();
    await nextTick();
    await nextTick();
  };
  await press(button(first, 'toggle'));
  assert.equal(rowsNow()[0] === first, true, 'the row is kept');
  assert.equal(document.activeElement === button(first, 'toggle'), true);
  assert.equal(button(first, 'toggle').getAttribute('aria-pressed'), 'false');
  assert.equal(button(first, 'toggle').textContent, 'visibility_off');
  assert.equal(button(first, 'toggle').title, 'Show <b>a</b>.geojson');
  await press(button(first, 'toggle'));
  assert.equal(document.activeElement === button(first, 'toggle'), true);
  assert.equal(button(first, 'toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(button(first, 'fly').title, 'Fly to <b>a</b>.geojson');
  assert.equal(button(first, 'remove').getAttribute('aria-label'), 'Remove <b>a</b>.geojson');

  await press(button(first, 'remove'));
  assert.equal(rowsNow().length, 1);
  assert.equal(document.activeElement === button(second, 'remove'), true);
  await press(button(second, 'remove'));
  assert.equal(list.className, 'geo-import-list');
  assert.equal(document.activeElement === $('geo-import-button'), true);
});

test('the parameters panel shows the active style’s rows and hands each change to its owner', async (t) => {
  const { store, $ } = fixture(t);
  const panel = $('param-slider-panel');
  assert.equal(panel.classList.contains('active'), false);
  assert.equal($('param-sliders').children.length, 0);
  const changes = [];
  store.connect({
    setStyleParameter: (name, value) => changes.push([name, value]),
  });
  store.publishParameters({
    style: 'noir',
    rows: [
      {
        name: 'amount',
        label: 'Amount',
        min: 0,
        max: 1,
        step: '0.01',
        digits: 2,
        value: 0.25,
        text: '0.25',
      },
    ],
  });
  await nextTick();
  assert.equal(panel.classList.contains('active'), true);
  const row = $('param-sliders').querySelector('.param-slider-row');
  assert.equal(row.querySelector('.param-label').textContent, 'Amount');
  assert.equal(row.querySelector('.param-value').textContent, '0.25');
  const slider = row.querySelector('input.param-slider');
  assert.equal(slider.getAttribute('aria-label'), 'Amount');
  assert.equal(slider.step, '0.01');
  slider.value = '0.5';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  assert.deepEqual(changes, [['amount', 0.5]]);
  store.publishParameters(null);
  await nextTick();
  assert.equal(panel.classList.contains('active'), false);
  assert.equal($('param-sliders').children.length, 0);
});

test('VisualSettings publishes a style’s parameters and writes a moved slider’s uniform', async (t) => {
  const { store, $ } = fixture(t);
  const owner = Object.create(VisualSettings.prototype);
  const renders = [];
  let shared = 0;
  Object.assign(owner, {
    store,
    _visualEffects: {
      stages: {
        noir: {
          uniforms: { contrastAmt: 1.2, grainAmt: 0.5, vignetteAmt: 0.5 },
        },
      },
      stop() {},
    },
    services: { governorRequestRender: (reason) => renders.push(reason) },
    _parameters: null,
    readShareLinks: () => null,
    _scheduleRightPanelLayout() {},
    _syncShareState: () => (shared += 1),
  });
  owner._parametersToken = store.connect({
    setStyleParameter: (name, value) => owner.setStyleParameter(name, value),
  });
  owner._updateSliderPanel('noir');
  await nextTick();
  const labels = () =>
    [...$('param-sliders').querySelectorAll('.param-label')].map(
      (label) => label.textContent,
    );
  assert.deepEqual(labels(), ['Contrast', 'Grain', 'Vignette']);
  const grain = $('param-sliders').querySelectorAll('input.param-slider')[1];
  grain.value = '0.8';
  grain.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  assert.equal(owner.stages.noir.uniforms.grainAmt, 0.8);
  assert.equal(
    $('param-sliders').querySelectorAll('.param-value')[1].textContent,
    '0.80',
  );
  assert.deepEqual(renders, ['style-param-slider']);
  assert.equal(shared, 1);
  // A name that isn't one of the shown style's parameters writes nothing.
  owner.setStyleParameter('pixelation', 4);
  assert.equal(owner.stages.noir.uniforms.pixelation, undefined);
  assert.equal(shared, 1);
  owner._updateSliderPanel('normal');
  await nextTick();
  assert.deepEqual(labels(), []);
  assert.equal($('param-slider-panel').classList.contains('active'), false);
  // A preset that resets the shown style's uniforms republishes its rows.
  owner._updateSliderPanel('noir');
  owner.stages.noir.uniforms.grainAmt = 0.3;
  owner._refreshParameters();
  await nextTick();
  assert.equal(
    $('param-sliders').querySelectorAll('.param-value')[1].textContent,
    '0.30',
  );
  owner._lifetime = { destroy() {} };
  owner.stop();
  await nextTick();
  assert.equal(store.parameters, null, 'the sliders go with their owner');
  assert.equal($('param-slider-panel').classList.contains('active'), false);
  assert.equal(store.act('setStyleParameter', 'grainAmt', 0.2), undefined);
  assert.equal(owner.stages.noir.uniforms.grainAmt, 0.3, 'a stopped owner no longer answers');
  // An older owner's stop leaves a newer owner's rows.
  const newer = { style: 'noir', rows: [] };
  owner._parameters = { style: 'noir', rows: [] };
  store.publishParameters(newer);
  owner.stop();
  assert.equal(store.parameters, newer);
});

test('the four Cockpit groups teleport to the published slots and back to their places', async (t) => {
  const { store, $ } = fixture(t);
  const groupOf = (id) => $(id).closest('.pp-toggle-group') ?? $(id);
  const ids = ['hud-toggle', 'detection-toggle', 'param-slider-panel', 'models3d-toggle'];
  const body = $('pp-toggles').querySelector('.pp-panel-body');
  const order = () =>
    [...body.children].filter((el) => el.matches('.pp-toggle-group, #param-slider-panel'))
      .map((el) => el.id || el.querySelector('[id]')?.id);
  const home = order();
  const popover = document.body.appendChild(document.createElement('div'));
  const slots = {};
  for (const name of ['hud', 'detection', 'parameters', 'models3d']) {
    slots[name] = popover.appendChild(document.createElement('div'));
  }
  store.publishCockpitPortal(slots);
  await nextTick();
  assert.equal(slots.hud.contains($('hud-toggle')), true);
  assert.equal(slots.detection.contains($('detection-toggle')), true);
  assert.equal(slots.parameters.firstElementChild, $('param-slider-panel'));
  assert.equal(slots.models3d.contains($('models3d-toggle')), true);
  // The teleported controls still render from the store.
  store.publishParameters({ style: 'noir', rows: [] });
  await nextTick();
  assert.equal($('param-slider-panel').classList.contains('active'), true);
  store.publishCockpitPortal(null);
  await nextTick();
  for (const id of ids) assert.equal(body.contains(groupOf(id)), true, id);
  assert.deepEqual(order(), home);
  // A second trip uses the same slots.
  store.publishCockpitPortal(slots);
  await nextTick();
  assert.equal(slots.hud.contains($('hud-toggle')), true);
  store.publishCockpitPortal(null);
  await nextTick();
  assert.deepEqual(order(), home);
});

test('a group without a published slot stays home; a replaced slot and an unmount leave nothing behind', async (t) => {
  const { store, $, unmount } = fixture(t);
  const body = $('pp-toggles').querySelector('.pp-panel-body');
  const popover = document.body.appendChild(document.createElement('div'));
  const slot = () => popover.appendChild(document.createElement('div'));
  const first = { hud: slot(), detection: slot(), parameters: slot() };
  store.publishCockpitPortal(first);
  await nextTick();
  // No models3d slot: 3D stays in the Display panel, not in body.
  assert.equal(body.contains($('models3d-toggle')), true);
  assert.equal(first.hud.contains($('hud-toggle')), true);
  // A new popover replaces the slots while the groups are out.
  const second = { ...first, hud: slot() };
  store.publishCockpitPortal(second);
  await nextTick();
  assert.equal(second.hud.contains($('hud-toggle')), true);
  assert.equal(first.hud.childElementCount, 0);
  // Unmounting while teleported removes the groups from the slots too.
  unmount();
  for (const target of Object.values(second))
    assert.equal(target.childElementCount, 0);
});

test('the real portal lays out once the groups have moved and puts back the focus the move dropped', async (t) => {
  const { store, $ } = fixture(t);
  const popover = document.body.appendChild(document.createElement('div'));
  for (const name of ['hud', 'detection', 'parameters', 'models3d']) {
    const slot = popover.appendChild(document.createElement('div'));
    slot.dataset.cockpitDisplaySlot = name;
  }
  const frames = [];
  const priorFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  t.after(() => {
    globalThis.requestAnimationFrame = priorFrame;
  });
  const layouts = [];
  const portal = new CockpitDisplayPortal({
    standardPanel: $('pp-toggles'),
    cockpitPanel: popover,
    groups: [
      ['hud', $('hud-toggle').closest('.pp-toggle-group')],
      ['detection', $('detection-toggle').closest('.pp-toggle-group')],
      ['parameters', $('param-slider-panel')],
      ['models3d', $('models3d-toggle').closest('.pp-toggle-group')],
    ],
    layout: () => layouts.push(popover.contains($('hud-toggle'))),
    publish: (slots) => store.publishCockpitPortal(slots),
    afterRender: (callback) => {
      void nextTick(callback);
    },
  });
  t.after(() => portal.destroy());
  $('hud-toggle').focus();
  portal.setActive(true);
  // Superseded before the flush: one layout, for the last state.
  portal.setActive(false);
  portal.setActive(true);
  await nextTick();
  assert.deepEqual(layouts, [true]);
  while (frames.length) frames.shift()();
  assert.equal(document.activeElement, $('hud-toggle'));
  // A stopped portal lays out nothing.
  portal.stop();
  portal.setActive(false);
  await nextTick();
  assert.deepEqual(layouts, [true]);
});

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

function fixture(t) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(DisplayPanel).use(pinia);
  app.mount(host);
  t.after(() => app.unmount());
  const $ = (id) => document.getElementById(id);
  return { store: useDisplayStore(pinia), $ };
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
  assert.equal(button.className, 'pp-toggle-btn active panoptic');
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
  assert.equal(button.className, 'pp-toggle-btn');
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
  assert.equal(button.className, 'pp-toggle-btn active');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(row.classList.contains('visible'), true);
  assert.equal($('models3d-mode-proximity').getAttribute('aria-checked'), 'true');

  // The button leaves the row to its own sync.
  owner._setModels3dEnabled(false);
  await nextTick();
  assert.equal(button.className, 'pp-toggle-btn');
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

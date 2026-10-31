// src/ui/displayPanel.test.mjs — the Display panel renders bloom and sharpen
// from what VisualSettings publishes, and shows its initial markup before.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { useDisplayStore } from './stores/display.js';
import DisplayPanel from './views/panels/DisplayPanel.vue';
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

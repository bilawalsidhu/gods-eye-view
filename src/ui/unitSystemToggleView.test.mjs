// src/ui/unitSystemToggleView.test.mjs — the metric / imperial switch in the
// corner row: one press shows the other system and keeps it, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { computed, createApp, h, nextTick } from 'vue';
import { setLocale } from '../i18n/index.js';
import {
  UNIT_SYSTEM_STORAGE_KEY,
  getUnitSystem,
  setUnitSystem,
} from '../units.js';
import { applicationUnitSystem, chooseUnitSystem } from './unitSystem.js';
import { formatTemperature } from './unitLabels.js';
import UnitSystemToggle from './views/panels/UnitSystemToggle.vue';

function mount(t, extra = () => null) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp({ render: () => [h(UnitSystemToggle), extra()] });
  app.mount(host);
  t.after(() => {
    app.unmount();
    setUnitSystem('metric');
    globalThis.localStorage?.removeItem?.(UNIT_SYSTEM_STORAGE_KEY);
  });
  return () => document.getElementById('unit-system-toggle');
}

test('the switch shows the system in use and names the other one', async (t) => {
  setLocale('en');
  setUnitSystem('metric');
  const button = mount(t);
  assert.equal(button().textContent.trim(), '°C');
  assert.equal(button().getAttribute('aria-label'), 'Units: metric');
  assert.equal(button().title, 'Switch to imperial units (°F, mi, ft, mph)');
  assert.equal(button().dataset.unitSystem, 'metric');

  button().click();
  await nextTick();
  assert.equal(getUnitSystem(), 'imperial');
  assert.equal(button().textContent.trim(), '°F');
  assert.equal(button().getAttribute('aria-label'), 'Units: imperial');
  assert.equal(button().title, 'Switch to metric units (°C, km, m, km/h)');
});

test('a view that formats a quantity re-renders on a switch', async (t) => {
  setUnitSystem('metric');
  const reading = () =>
    h('output', { id: 'reading' }, formatTemperature(20));
  mount(t, reading);
  const text = () => document.getElementById('reading').textContent;
  assert.equal(text(), '20 °C');
  document.getElementById('unit-system-toggle').click();
  await nextTick();
  assert.equal(text(), '68 °F');
});

test('a choice is kept for the next visit', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    assert.equal(chooseUnitSystem('imperial', { storage }), 'imperial');
    assert.equal(values.get(UNIT_SYSTEM_STORAGE_KEY), 'imperial');
    assert.equal(applicationUnitSystem().value, 'imperial');
    const shown = computed(() => applicationUnitSystem().value);
    chooseUnitSystem('metric', { storage });
    assert.equal(shown.value, 'metric');
  } finally {
    setUnitSystem('metric');
  }
});

import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import VesselPanel from './views/panels/VesselPanel.vue';
import { useVesselPanelStore } from './stores/vesselPanel.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { normalizeVesselFilters } from '../data/vesselDisplayFilters.js';

test('Vessels panel renders independent filter toggles, vessel choices, speed inputs and the searchable list', async (t) => {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = useVesselPanelStore(pinia);
  const chrome = usePanelChromeStore(pinia);
  const chromeToken = chrome.connect({});
  chrome.publish(chromeToken, 'vessel-panel', { collapsed: false });
  store.enabled = true;
  store.available = true;
  store.list = {
    rows: [
      {
        id: 'abc123',
        label: '<b>TEST123</b>',
        speedKn: 10,
        type: 'TUG',
        visible: false,
      },
    ],
    total: 120,
    matching: 51,
    page: 0,
    pages: 2,
  };
  const calls = [];
  const token = store.connect({
    filter(patch) {
      calls.push(patch);
      store.filters = normalizeVesselFilters(patch, store.filters);
    },
    select: (id) => calls.push(id),
    search: (value) => calls.push(value),
  });
  const app = createApp(VesselPanel).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => {
    app.unmount();
    store.detach(token);
    chrome.detach(chromeToken);
  });
  assert.equal(store.visible, true);
  document.querySelector('#vessel-underway').click();
  document.querySelector('#vessel-type-enabled').click();
  await nextTick();
  assert.equal(
    document.querySelector('[data-vessel-type=TUG]').disabled,
    false,
  );
  document.querySelector('[data-vessel-type=TUG]').click();
  document.querySelector('#vessel-speed-enabled').click();
  await nextTick();
  const min = document.querySelector('#vessel-min-speed');
  assert.equal(min.disabled, false);
  min.value = '5';
  min.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('[data-vessel-id=abc123]').click();
  await nextTick();
  assert.ok(store.filters.underwayOnly);
  assert.ok(store.filters.types.includes('TUG'));
  assert.equal(store.filters.minSpeedKn, 5);
  assert.ok(calls.includes('abc123'));
  assert.equal(
    document.querySelector('.vessel-roster b'),
    null,
    'source names stay plain text',
  );
  assert.ok(document.body.textContent.includes('Hidden on map'));
  store.available = false;
  await nextTick();
  assert.equal(document.getElementById('vessel-panel').hidden, true);
  assert.equal(store.visible, false);
  store.available = true;
  await nextTick();
  assert.equal(document.getElementById('vessel-panel').hidden, false);
  assert.equal(store.visible, true);
  chrome.publish(chromeToken, 'vessel-panel', { collapsed: true });
  await nextTick();
  assert.equal(store.visible, false);
});

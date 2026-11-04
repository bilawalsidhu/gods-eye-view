import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick } from 'vue';
import { createPinia } from 'pinia';
import { createChesterCountyPanel } from './chesterCountyPanel.js';
import { useChesterCountyPanelStore } from './stores/chesterCountyPanel.js';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { createUiRuntime } from './vueRuntime.js';
import { PanelNavigation } from './panelNavigation.js';
import ChesterCountyPanel from './views/panels/ChesterCountyPanel.vue';

function fixture() {
  let categories = ['fire', 'ems', 'traffic'];
  let counties = ['chester-pa', 'montgomery-pa'];
  let enabled = false,
    count = 2,
    selected = null;
  const events = new Set(),
    listeners = new Set(),
    calls = [];
  const layer = {
    getIncidentPanelState: () => ({
      enabled,
      categories: [...categories],
      counties: ['chester-pa', 'montgomery-pa'].map((id) => ({
        id,
        label: id,
        active: counties.includes(id),
      })),
      info: `${count} reports`,
      chips: [
        {
          id: 'county',
          label: 'View Chester County',
          onClick: () => calls.push('county'),
        },
      ],
      list: {
        ariaLabel: 'Incidents',
        items: Array.from({ length: count }, (_, i) => ({
          id: String(i),
          lead: i ? 'SYNTHETIC UNRESOLVED' : '<b>SYNTHETIC EMS TEST</b>',
          text: 'EXAMPLE RD · Example Township',
          active: selected === String(i),
        })),
      },
    }),
    subscribeIncidentPanel(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const manager = {
    layers: new Map([['chester-county-ems', { module: layer }]]),
    isEnabled: () => enabled,
    subscribe(fn) {
      events.add(fn);
      return () => events.delete(fn);
    },
    setLayerParams(id, params, options) {
      calls.push({ id, params, options });
      if (params.categories) categories = params.categories;
      if (params.counties) counties = params.counties;
      if ('selectedIncident' in params) selected = params.selectedIncident;
      for (const fn of listeners) fn();
    },
  };
  return {
    manager,
    layer,
    calls,
    events,
    listeners,
    enable(value) {
      enabled = value;
      for (const fn of events)
        fn({ layerId: 'chester-county-ems', type: 'toggled' });
    },
    empty() {
      count = 0;
      for (const fn of listeners) fn();
    },
  };
}
test('the app follows the layer, dispatches selections and actions, and releases subscriptions', async () => {
  const state = fixture(),
    store = useChesterCountyPanelStore(createPinia());
  const panel = createChesterCountyPanel({ store });
  panel.connect(state.manager);
  assert.equal(store.view, null);
  assert.equal(state.listeners.size, 1);
  state.enable(true);
  assert.equal(store.view.list.items.length, 2);
  assert.equal(
    store.view.chips[0].onClick,
    undefined,
    'store holds presentation, not callbacks',
  );
  await store.act('select', '1');
  assert.equal(store.view.list.items[1].active, true);
  assert.deepEqual(state.calls[0], {
    id: 'chester-county-ems',
    params: { selectedIncident: '1' },
    options: { origin: 'user' },
  });
  await store.act('chip', 'county');
  assert.equal(state.calls[1], 'county');
  state.empty();
  assert.equal(store.view.list.items.length, 0);
  state.enable(false);
  assert.equal(store.view, null);
  await store.act('select', '0');
  assert.equal(state.calls.length, 2);
  panel.connect(null);
  assert.equal(state.listeners.size, 0);
  assert.equal(state.events.size, 0);
  panel.destroy();
  panel.destroy();
});
test('a replaced panel owner cannot hide or republish over the newest one', () => {
  const store = useChesterCountyPanelStore(createPinia()),
    state = fixture();
  const old = createChesterCountyPanel({ store });
  old.connect(state.manager);
  state.enable(true);
  const current = createChesterCountyPanel({ store });
  current.connect(state.manager);
  old.destroy();
  assert.equal(store.view.enabled, true);
  current.destroy();
  assert.equal(store.view, null);
});
test('the right-side launcher exists only when enabled and the real list selects through its owner', async (t) => {
  document.body.replaceChildren();
  const left = document.body.appendChild(document.createElement('aside'));
  const right = document.body.appendChild(document.createElement('aside'));
  right.id = 'right-context-rail';
  const ui = createUiRuntime();
  const store = useChesterCountyPanelStore(ui.pinia);
  const state = fixture();
  const owner = createChesterCountyPanel({ store });
  owner.connect(state.manager);
  // Render as a direct child of the same rail host used by ContextView.
  const host = document.createElement('div');
  right.append(host);
  const unmount = ui.mount(ChesterCountyPanel, host);
  // Vue's root mount host represents the ContextView rail in the app.
  const rail = host;
  const chrome = usePanelChromeStore(ui.pinia),
    chromeToken = chrome.connect({});
  chrome.publish(chromeToken, 'chester-county-panel', { collapsed: false });
  const navigation = new PanelNavigation({
    ui,
    stacks: { left, right: rail },
    setPanelCollapsed() {},
  });
  navigation.init();
  t.after(() => {
    navigation.destroy();
    owner.destroy();
    chrome.detach(chromeToken);
    unmount();
    ui.destroy();
  });
  await nextTick();
  navigation.sync();
  await nextTick();
  assert.equal(document.querySelector('#chester-county-panel').hidden, true);
  assert.equal(
    document.querySelector('[data-rail-item="chester-county-panel"]'),
    null,
  );
  state.enable(true);
  await nextTick();
  navigation.sync();
  await nextTick();
  assert.ok(document.querySelector('[data-rail-item="chester-county-panel"]'));
  const county = document.querySelector('[data-county-filter="montgomery-pa"]');
  county.click();
  await nextTick();
  assert.equal(county.checked, false);
  county.click();
  await nextTick();
  assert.equal(county.checked, true);
  const ems = document.querySelector('[data-county-category="ems"]');
  assert.equal(ems.getAttribute('aria-pressed'), 'true');
  ems.click();
  await nextTick();
  assert.equal(ems.getAttribute('aria-pressed'), 'false');
  ems.click();
  await nextTick();
  assert.equal(ems.getAttribute('aria-pressed'), 'true');
  const item = document.querySelector(
    '#chester-county-panel button[data-list-item-id="0"]',
  );
  assert.ok(item);
  assert.equal(item.querySelector('b'), null, 'report text remains plain text');
  item.click();
  await nextTick();
  assert.equal(item.getAttribute('aria-pressed'), 'true');
  state.enable(false);
  await nextTick();
  navigation.sync();
  await nextTick();
  assert.equal(
    document.querySelector('[data-rail-item="chester-county-panel"]'),
    null,
  );
  assert.equal(document.querySelector('#chester-county-panel').hidden, true);
  assert.equal(
    document.querySelector('#chester-county-panel button[data-list-item-id]'),
    null,
  );
});

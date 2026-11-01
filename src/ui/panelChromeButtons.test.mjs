// src/ui/panelChromeButtons.test.mjs — panel collapse, dock tray and pin
// buttons render each panel's state from the panel chrome store, and their
// clicks reach PanelChrome only while it presents the panels.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { PanelChrome } from './panelChrome.js';
import { bindPanelDisclosure } from './panelDisclosure.js';
import PanelCollapseButton from './rail/PanelCollapseButton.vue';
import { usePanelChromeStore } from './stores/panelChrome.js';
import CommandDockView from './views/CommandDockView.vue';

function mount(t, component) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = usePanelChromeStore(pinia);
  const app = createApp(component).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  return store;
}

test('the store republishes a panel only when its state changes', () => {
  const store = usePanelChromeStore(createPinia());
  const token = store.connect({});
  store.publish(token, 'data-panel', { collapsed: true });
  const first = store.panels;
  assert.deepEqual(store.panels['data-panel'], {
    collapsed: true,
    pinned: false,
  });
  store.publish(token, 'data-panel', { collapsed: true });
  assert.ok(store.panels === first, 'an unchanged state is not republished');
  store.publish({}, 'data-panel', { collapsed: false });
  assert.equal(
    store.panels['data-panel'].collapsed,
    true,
    'a stranger is ignored',
  );
  store.connect({});
  assert.equal(
    store.panels['data-panel'],
    undefined,
    'a new owner starts empty',
  );
  store.publish(token, 'data-panel', { collapsed: false });
  assert.equal(
    store.panels['data-panel'],
    undefined,
    'a replaced owner is ignored',
  );
});

test('a collapse button keeps its markup until presented, then follows the panel', async (t) => {
  const store = mount(t, {
    render: () => [
      h(PanelCollapseButton, {
        target: 'data-panel',
        name: 'DATA LAYERS',
        initial: '+',
      }),
      h(PanelCollapseButton, {
        target: 'cctv-panel',
        name: 'CCTV',
        sideways: true,
        initial: '+',
      }),
    ],
  });
  const [data, cctv] = document.querySelectorAll('.panel-collapse-btn');
  assert.equal(data.textContent, '+');
  assert.equal(data.title, 'Collapse panel');
  assert.equal(data.hasAttribute('aria-expanded'), false);
  assert.equal(data.hasAttribute('aria-label'), false);
  assert.equal(data.dataset.collapseTarget, 'data-panel');

  const toggled = [];
  const token = store.connect({ toggle: (id) => toggled.push(id) });
  store.publish(token, 'data-panel', { collapsed: true });
  store.publish(token, 'cctv-panel', { collapsed: false });
  await nextTick();
  assert.equal(data.textContent, '+');
  assert.equal(data.getAttribute('aria-expanded'), 'false');
  assert.equal(data.getAttribute('aria-label'), 'Expand DATA LAYERS');
  assert.equal(data.title, 'Expand DATA LAYERS');
  assert.equal(cctv.textContent, '▶');
  assert.equal(cctv.getAttribute('aria-expanded'), 'true');
  assert.equal(cctv.title, 'Collapse CCTV');

  store.publish(token, 'data-panel', { collapsed: false });
  await nextTick();
  assert.equal(data.textContent, '−');
  assert.equal(data.getAttribute('aria-label'), 'Collapse DATA LAYERS');
  data.click();
  assert.deepEqual(toggled, ['data-panel']);
});

test("Radio's collapse button keeps its own wording", async (t) => {
  const words = {
    initialLabel: 'Expand Radio section',
    expandLabel: 'Expand Radio section',
    collapseLabel: 'Collapse Radio section',
    expandTitle: 'Expand Radio',
    collapseTitle: 'Collapse Radio',
  };
  const store = mount(t, {
    render: () =>
      h(PanelCollapseButton, {
        target: 'radio-panel',
        initial: '+',
        initialTitle: 'Expand Radio',
        words,
      }),
  });
  const button = document.querySelector('.panel-collapse-btn');
  assert.equal(button.title, 'Expand Radio');
  assert.equal(button.getAttribute('aria-label'), 'Expand Radio section');
  store.publish(store.connect({}), 'radio-panel', { collapsed: false });
  await nextTick();
  assert.equal(button.textContent, '−');
  assert.equal(button.title, 'Collapse Radio');
  assert.equal(button.getAttribute('aria-label'), 'Collapse Radio section');
});

test('dock trays name their state and pins press without opening the tray', async (t) => {
  const store = mount(t, CommandDockView);
  const toggle = document.getElementById('location-bar-toggle');
  const pin = document.querySelector(
    '.dock-pin-btn[data-pin-target="location-bar"]',
  );
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), 'Expand LOCATION');
  assert.equal(pin.getAttribute('aria-pressed'), 'false');
  assert.equal(pin.getAttribute('aria-label'), 'Pin location tray');
  assert.equal(pin.title, 'Keep location tray open');

  const pinned = [];
  const token = store.connect({ pin: (id) => pinned.push(id) });
  store.publish(token, 'location-bar', { collapsed: false, pinned: true });
  await nextTick();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Collapse LOCATION');
  assert.equal(toggle.title, 'Collapse LOCATION');
  assert.equal(pin.getAttribute('aria-pressed'), 'true');

  let reachedTray = false;
  document
    .getElementById('location-bar')
    .addEventListener('click', () => (reachedTray = true));
  pin.click();
  assert.deepEqual(pinned, ['location-bar']);
  assert.equal(reachedTray, false, 'the pin click stops at the pin');
});

function panelChrome(store) {
  return new PanelChrome({
    elements: {},
    operations: { _showToast() {}, _syncCctvPanelViewport() {} },
    readHud: () => ({ visible: false, getVariant: () => null }),
    readCockpit: () => null,
    readShareLinks: () => null,
    readInitialShare: () => null,
    readScrollRestoreOwner: () => null,
    readDisplayScrollTop: () => 0,
    store,
  });
}

test('PanelChrome takes clicks only once initialized, pins only dock trays, and detaches on destroy', () => {
  document.body.innerHTML = `
    <div id="data-panel" class="collapsed"><button class="panel-collapse-btn" data-collapse-target="data-panel"></button></div>
    <div id="cctv-panel"></div>
    <div id="control-panel" class="collapsed"></div>`;
  const store = usePanelChromeStore(createPinia());
  const chrome = panelChrome(store);
  const calls = [];
  const setPanelCollapsed = chrome.setPanelCollapsed.bind(chrome);
  chrome.setPanelCollapsed = (id, collapsed, options) => {
    calls.push([id, collapsed, options]);
    setPanelCollapsed(id, collapsed, options);
  };

  store.act('toggle', 'data-panel');
  store.act('pin', 'control-panel');
  assert.deepEqual(calls, [], 'no clicks before the chrome is initialized');
  chrome._disclosurePanelIds = new Set(['data-panel']);
  store.act('toggle', 'data-panel');
  store.act('toggle', 'cctv-panel');
  assert.deepEqual(calls, [['data-panel', false, { explicit: true }]]);
  assert.equal(store.panels['data-panel'].collapsed, false);

  assert.equal(chrome._setCommandDockPanelPinState('data-panel'), undefined);
  store.act('pin', 'control-panel');
  assert.deepEqual(store.panels['control-panel'], {
    collapsed: false,
    pinned: true,
  });
  assert.equal(
    document.getElementById('control-panel').classList.contains('dock-pinned'),
    true,
  );

  chrome.destroy();
  const before = calls.length;
  store.act('toggle', 'data-panel');
  assert.equal(calls.length, before, 'a destroyed owner gets no clicks');
  chrome._syncPanelCollapseButton(document.getElementById('cctv-panel'));
  assert.equal(store.panels['cctv-panel'], undefined, 'nor publishes');
});

test('a remounted chrome starts from its own states, not a pin left behind', () => {
  document.body.innerHTML = '<div id="location-bar" class="collapsed"></div>';
  const store = usePanelChromeStore(createPinia());
  const first = panelChrome(store);
  first._disclosurePanelIds = new Set();
  store.act('pin', 'location-bar');
  assert.equal(store.panels['location-bar'].pinned, true);
  first.destroy();
  document.body.innerHTML = '<div id="location-bar" class="collapsed"></div>';
  const second = panelChrome(store);
  assert.equal(store.panels['location-bar'], undefined);
  second._syncPanelCollapseButton(document.getElementById('location-bar'));
  assert.deepEqual(store.panels['location-bar'], {
    collapsed: true,
    pinned: false,
  });
  second.destroy();
});

test('bindPanelDisclosure refuses the retired button wiring', () => {
  const panel = new EventTarget();
  for (const retired of [{ buttons: [] }, { onChange() {} }]) {
    assert.throws(
      () => bindPanelDisclosure({ panel, onEscape() {}, ...retired }),
      TypeError,
    );
  }
});

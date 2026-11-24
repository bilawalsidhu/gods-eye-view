// src/ui/panelChromeButtons.test.mjs — panel collapse, dock tray and pin
// buttons render each panel's state from the panel chrome store, and their
// clicks reach PanelChrome only while it presents the panels.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h, nextTick, withDirectives } from 'vue';
import { createPinia } from 'pinia';
import { settleSideAccordion } from './panelAccordion.js';
import { PanelChrome } from './panelChrome.js';
import { followPanelState, vPanelState } from './rail/panelState.js';
import { bindPanelDisclosure } from './panelDisclosure.js';
import PanelCollapseButton from './rail/PanelCollapseButton.vue';
import RailPanel from './rail/RailPanel.vue';
import UiPanel from './kit/UiPanel.vue';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { useDisplayStore } from './stores/display.js';
import { DisplayBindings } from './displayBindings.js';
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
    pinnedTop: false,
    auto: null,
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

test('a collapse button follows its markup until presented, then the panel', async (t) => {
  const store = mount(t, {
    render: () => [
      h(PanelCollapseButton, {
        target: 'data-panel',
        name: 'DATA LAYERS',
        startCollapsed: true,
      }),
      h(PanelCollapseButton, {
        target: 'cctv-panel',
        name: 'CCTV',
        sideways: true,
        startCollapsed: true,
      }),
    ],
  });
  const [data, cctv] = document.querySelectorAll('.panel-collapse-btn');
  assert.equal(data.textContent, '+');
  assert.equal(data.getAttribute('aria-expanded'), 'false');
  assert.equal(data.getAttribute('aria-label'), 'Expand DATA LAYERS');
  assert.equal(data.dataset.collapseTarget, 'data-panel');
  assert.equal(cctv.textContent, '◀');

  const toggled = [];
  const token = store.connect({ toggle: (id) => toggled.push(id) });
  store.publish(token, 'cctv-panel', { collapsed: false });
  await nextTick();
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

test("UiPanel draws Core's panel markup and asks for the other state", async (t) => {
  const asked = [];
  let collapsed = true;
  mount(t, {
    render: () =>
      h(
        UiPanel,
        {
          id: 'demo-panel',
          title: 'DEMO',
          hint: 'A demo',
          collapsible: true,
          collapsed,
          scroll: true,
          railScroller: true,
          'onUpdate:collapsed': (next) => asked.push(next),
        },
        {
          badge: () => h('span', { id: 'demo-badge' }),
          actions: () => h('button', { id: 'demo-action' }),
          default: () => h('div', { id: 'demo-body' }),
        },
      ),
  });
  const panel = document.getElementById('demo-panel');
  assert.equal(
    panel.className,
    'ui-panel panel-collapsible ui-panel--collapsed',
  );
  assert.equal(panel.children[0].className, 'panel-glow');
  const inner = panel.children[1];
  assert.equal(inner.className, 'demo-panel-inner ui-scroll');
  assert.equal(inner.hasAttribute('data-rail-scroller'), true);
  const [head, body] = inner.children;
  assert.deepEqual(
    [...head.children].map(
      (el) => el.id || el.classList[el.classList.length - 1],
    ),
    [
      'panel-title',
      'demo-badge',
      'panel-divider',
      'demo-action',
      'panel-edge-btn',
      'panel-collapse-btn',
    ],
  );
  assert.equal(head.querySelector('.panel-title').title, 'A demo');
  assert.equal(body.id, 'demo-body');
  const toggle = head.querySelector('.panel-collapse-btn');
  assert.equal(toggle.getAttribute('aria-label'), 'Expand DEMO');
  assert.equal(toggle.dataset.collapseTarget, 'demo-panel');
  toggle.click();
  assert.deepEqual(asked, [false]);
});

test('UiPanel without collapsible has no button, and glow is optional', (t) => {
  mount(t, {
    render: () =>
      h(UiPanel, {
        id: 'plain-panel',
        title: 'PLAIN',
        tag: 'section',
        glow: false,
      }),
  });
  const panel = document.getElementById('plain-panel');
  assert.equal(panel.tagName, 'SECTION');
  assert.equal(panel.querySelector('.panel-glow') === null, true);
  assert.equal(panel.querySelector('.panel-collapse-btn') === null, true);
});

test('RailPanel follows the store, forwards clicks, and never restores a class its owner removed', async (t) => {
  const store = mount(t, {
    render: () =>
      h(
        RailPanel,
        {
          id: 'radio-panel',
          startCollapsed: true,
          title: 'RADIO',
          class: 'extra',
          hidden: '',
        },
        { default: () => h('p', { id: 'radio-body' }) },
      ),
  });
  const panel = document.getElementById('radio-panel');
  assert.equal(
    panel.className,
    'ui-panel panel-collapsible extra collapsed ui-panel--collapsed',
  );
  assert.equal(panel.dataset.panelId, 'radio-panel');
  assert.equal(panel.hidden, true);
  assert.ok(document.getElementById('radio-body'));
  const toggle = panel.querySelector('.panel-collapse-btn');
  assert.equal(toggle.textContent, '+');

  const toggled = [];
  const token = store.connect({ toggle: (id) => toggled.push(id) });
  store.publish(token, 'radio-panel', { collapsed: false });
  assert.equal(panel.classList.contains('collapsed'), false, 'written at once');
  await nextTick();
  assert.equal(toggle.textContent, '−');
  // The re-render above left the class as written; pinning keeps it too.
  store.publish(token, 'radio-panel', { pinned: true });
  await nextTick();
  assert.equal(panel.classList.contains('collapsed'), false);
  assert.equal(panel.classList.contains('dock-pinned'), true);
  toggle.click();
  assert.deepEqual(toggled, ['radio-panel']);
});

test('a panel whose class binding changes keeps the presented state', async (t) => {
  const { ref } = await import('vue');
  const extra = ref('one');
  const store = mount(t, {
    render: () =>
      h(RailPanel, {
        id: 'cctv-panel',
        startCollapsed: true,
        title: 'CCTV',
        class: extra.value,
      }),
  });
  const panel = document.getElementById('cctv-panel');
  store.publish(store.connect({}), 'cctv-panel', {
    collapsed: false,
    pinned: true,
  });
  extra.value = 'two';
  await nextTick();
  assert.equal(panel.classList.contains('two'), true);
  assert.equal(panel.classList.contains('collapsed'), false);
  assert.equal(panel.classList.contains('dock-pinned'), true);
});

test("Radio's collapse button keeps its own wording", async (t) => {
  const words = {
    expandLabel: 'Expand Radio section',
    collapseLabel: 'Collapse Radio section',
    expandTitle: 'Expand Radio',
    collapseTitle: 'Collapse Radio',
  };
  const store = mount(t, {
    render: () =>
      h(RailPanel, {
        id: 'radio-panel',
        startCollapsed: true,
        title: 'RADIO',
        toggleWords: words,
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
  for (const id of ['data-panel', 'cctv-panel', 'control-panel'])
    followPanelState(store, id, document.getElementById(id));
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
    pinnedTop: true,
    auto: null,
  });
  assert.equal(
    document.getElementById('control-panel').classList.contains('dock-pinned'),
    true,
  );

  chrome.destroy();
  const before = calls.length;
  store.act('toggle', 'data-panel');
  assert.equal(calls.length, before, 'a destroyed owner gets no clicks');
  chrome._presentPanel('cctv-panel', { collapsed: true });
  assert.equal(store.panels['cctv-panel'], undefined, 'nor publishes');
  assert.equal(
    document.getElementById('cctv-panel').classList.contains('collapsed'),
    false,
  );
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
  second._presentPanel('location-bar');
  assert.deepEqual(store.panels['location-bar'], {
    collapsed: true,
    pinned: false,
    pinnedTop: false,
    auto: null,
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

test('a panel root draws its state at once, keeping classes others own', async (t) => {
  const store = mount(t, {
    render: () =>
      withDirectives(
        h('div', { id: 'scene-panel', class: 'panel-collapsible collapsed' }),
        [[vPanelState, 'scene-panel']],
      ),
  });
  const panel = document.getElementById('scene-panel');
  panel.classList.add('running');
  assert.equal(panel.classList.contains('collapsed'), true, 'markup stands');
  const token = store.connect({});
  store.publish(token, 'scene-panel', { collapsed: true, auto: 'accordion' });
  // No tick: a layout measures in the same task.
  assert.equal(panel.classList.contains('accordion-collapsed'), true);
  store.publish(token, 'scene-panel', { collapsed: false, auto: null });
  assert.equal(panel.classList.contains('collapsed'), false);
  assert.equal(panel.classList.contains('accordion-collapsed'), false);
  assert.equal(panel.classList.contains('running'), true);
  assert.equal(panel.classList.contains('panel-collapsible'), true);
  store.publish(token, 'scene-panel', { pinned: true, pinnedTop: true });
  assert.ok(panel.classList.contains('dock-pinned'));
  assert.ok(panel.classList.contains('dock-pinned-top'));
});

test('destroying the chrome inside Cockpit puts back the panels its entry closed', () => {
  document.body.innerHTML = `
    <div id="data-panel"></div>
    <div id="cctv-panel" class="collapsed"></div>`;
  const store = usePanelChromeStore(createPinia());
  const chrome = panelChrome(store);
  const data = document.getElementById('data-panel');
  followPanelState(store, 'data-panel', data);
  chrome.enterCockpit();
  assert.equal(data.classList.contains('collapsed'), true);
  chrome.destroy();
  assert.equal(data.classList.contains('collapsed'), false);
  chrome.exitCockpit();
  assert.equal(data.classList.contains('collapsed'), false);
});

test('Cockpit entry folds the Space Missions panel away and exit brings it back', () => {
  document.body.innerHTML = `<div id="space-missions-panel"></div>`;
  const store = usePanelChromeStore(createPinia());
  const chrome = panelChrome(store);
  const missions = document.getElementById('space-missions-panel');
  followPanelState(store, 'space-missions-panel', missions);
  chrome.enterCockpit();
  assert.equal(missions.classList.contains('collapsed'), true);
  chrome.exitCockpit();
  assert.equal(missions.classList.contains('collapsed'), false);
  chrome.destroy();
});

test('a share link records whether the Space Missions panel is open', () => {
  document.body.innerHTML = `<div id="space-missions-panel"></div>`;
  const store = usePanelChromeStore(createPinia());
  const chrome = panelChrome(store);
  const state = chrome._buildSharePanelState();
  assert.deepEqual(
    state.specs.filter((spec) => spec.id === 'space-missions-panel'),
    [{ id: 'space-missions-panel', collapsed: false }],
  );
  chrome.destroy();
});

test('the accordion closes peers through the real store, and opens them again', () => {
  document.body.innerHTML = `
    <div id="data-panel" data-panel-id="data-panel"></div>
    <div id="scene-panel" data-panel-id="scene-panel"></div>`;
  const store = usePanelChromeStore(createPinia());
  const chrome = panelChrome(store);
  const panels = ['data-panel', 'scene-panel'].map((id) => {
    const panel = document.getElementById(id);
    followPanelState(store, id, panel);
    return panel;
  });
  const onCollapse = (panel, patch) => chrome._presentPanel(panel, patch);
  settleSideAccordion({
    panels,
    enabled: true,
    preferredPanelId: 'scene-panel',
    documentRef: document,
    onCollapse,
  });
  assert.deepEqual(store.panels['data-panel'], {
    collapsed: true,
    pinned: false,
    pinnedTop: false,
    auto: 'accordion',
  });
  assert.equal(panels[0].className, 'collapsed accordion-collapsed');
  assert.equal(
    store.panels['scene-panel'],
    undefined,
    'the owner is untouched',
  );
  settleSideAccordion({ panels, enabled: false, onCollapse });
  assert.equal(panels[0].className, '');
  chrome.destroy();
});

test('F collapses Data Layers like its button and keeps its rail entry', (t) => {
  document.body.innerHTML = `
    <nav class="ui-rail"><button data-rail-item="data-panel" style="visibility: visible"></button></nav>
    <div id="data-panel" class="active"><button class="panel-collapse-btn" data-collapse-target="data-panel"></button></div>`;
  const panel = document.getElementById('data-panel');
  const item = document.querySelector('[data-rail-item="data-panel"]');
  panel.getClientRects = () =>
    panel.classList.contains('collapsed') ? [] : [{}];
  item.getClientRects = () => [{}];
  const store = usePanelChromeStore(createPinia());
  const chrome = panelChrome(store);
  followPanelState(store, 'data-panel', panel);
  chrome._disclosurePanelIds = new Set(['data-panel']);
  const bindings = new DisplayBindings({
    viewer: null,
    services: { isScopeMaskEnabled: () => false, cycleDetectionMode() {} },
    elements: { _locationSearch: document.createElement('input') },
    operations: {
      _setScope() {},
      _togglePanel: (panelId) => chrome._togglePanel(panelId),
    },
    readState: () => ({}),
    claimDetection() {},
    displayStore: useDisplayStore(createPinia()),
  });
  bindings._initUI();
  t.after(() => {
    bindings.destroy();
    chrome.destroy();
  });
  const press = (init = {}) =>
    document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', bubbles: true, ...init }),
    );

  panel.querySelector('button').focus();
  press();
  assert.equal(store.panels['data-panel']?.collapsed, true);
  assert.ok(document.activeElement === item, 'focus moves to the rail');
  assert.ok(panel.classList.contains('collapsed'));
  // `active` is what shows Data Layers at all (layers.css).
  assert.ok(panel.classList.contains('active'));
  press({ metaKey: true });
  assert.equal(store.panels['data-panel'].collapsed, true, 'Cmd+F is not ours');
  press();
  assert.equal(store.panels['data-panel'].collapsed, false);
  assert.ok(!panel.classList.contains('collapsed'));
  assert.ok(panel.classList.contains('active'));
});

test('F that folds a focused peer hands the focus to a rail entry', (t) => {
  document.body.innerHTML = `
    <nav class="ui-rail">
      <button data-rail-item="data-panel" style="visibility: visible"></button>
      <button data-rail-item="pp-toggles" style="visibility: visible"></button>
    </nav>
    <div id="left-panel-stack">
      <div id="data-panel" data-panel-id="data-panel" class="active collapsed"><button class="panel-collapse-btn" data-collapse-target="data-panel"></button></div>
      <div id="pp-toggles" data-panel-id="pp-toggles"><button class="panel-collapse-btn" data-collapse-target="pp-toggles"></button><button id="crt2">CRT 2</button></div>
    </div>`;
  const stack = document.getElementById('left-panel-stack');
  const store = usePanelChromeStore(createPinia());
  const chrome = new PanelChrome({
    elements: { _leftPanelStack: stack },
    operations: { _showToast() {}, _syncCctvPanelViewport() {} },
    readHud: () => ({ visible: false, getVariant: () => null }),
    readCockpit: () => null,
    readShareLinks: () => null,
    readInitialShare: () => null,
    readScrollRestoreOwner: () => null,
    readDisplayScrollTop: () => 0,
    store,
  });
  for (const id of ['data-panel', 'pp-toggles']) {
    const panel = document.getElementById(id);
    panel.getClientRects = () =>
      panel.classList.contains('collapsed') ? [] : [{}];
    followPanelState(store, id, panel);
  }
  for (const item of document.querySelectorAll('[data-rail-item]'))
    item.getClientRects = () => [{}];
  chrome._disclosurePanelIds = new Set(['data-panel', 'pp-toggles']);
  const bindings = new DisplayBindings({
    viewer: null,
    services: { isScopeMaskEnabled: () => false, cycleDetectionMode() {} },
    elements: { _locationSearch: document.createElement('input') },
    operations: {
      _setScope() {},
      _togglePanel: (panelId) => chrome._togglePanel(panelId),
    },
    readState: () => ({}),
    claimDetection() {},
    displayStore: useDisplayStore(createPinia()),
  });
  bindings._initUI();
  t.after(() => {
    bindings.destroy();
    chrome.destroy();
  });

  const crt2 = document.getElementById('crt2');
  crt2.focus();
  assert.equal(document.activeElement, crt2);
  crt2.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
  assert.equal(
    store.panels['data-panel']?.collapsed,
    false,
    'Data Layers opens',
  );
  const visual = document.getElementById('pp-toggles');
  assert.ok(
    visual.classList.contains('collapsed'),
    'the accordion folds Visual',
  );
  assert.ok(
    document.activeElement?.matches?.('.ui-rail [data-rail-item]'),
    `focus lands on a rail entry, not inside the hidden peer (got ${document.activeElement?.id || document.activeElement?.tagName})`,
  );
});

test('opening Data Layers in Cockpit hands the focus from the folded Contact card to its toggle', (t) => {
  document.body.innerHTML = `
    <div id="left-panel-stack">
      <div id="data-panel" data-panel-id="data-panel" class="active collapsed"><button class="panel-collapse-btn" data-collapse-target="data-panel"></button></div>
    </div>
    <aside id="cockpit-context"><button id="cockpit-context-toggle"></button><button id="cockpit-weather-toggle"></button></aside>`;
  const store = usePanelChromeStore(createPinia());
  const cockpit = {
    active: true,
    contextCollapsed: false,
    setContextCollapsed(collapsed) {
      this.contextCollapsed = collapsed;
    },
    setSignalCollapsed() {},
    scheduleContextLayout() {},
  };
  const chrome = new PanelChrome({
    elements: { _leftPanelStack: document.getElementById('left-panel-stack') },
    operations: { _showToast() {}, _syncCctvPanelViewport() {} },
    readHud: () => ({ visible: false, getVariant: () => null }),
    readCockpit: () => cockpit,
    readShareLinks: () => null,
    readInitialShare: () => null,
    readScrollRestoreOwner: () => null,
    readDisplayScrollTop: () => 0,
    store,
  });
  t.after(() => chrome.destroy());
  followPanelState(store, 'data-panel', document.getElementById('data-panel'));
  chrome._disclosurePanelIds = new Set(['data-panel']);
  document.getElementById('cockpit-weather-toggle').focus();
  chrome._togglePanel('data-panel');
  assert.equal(
    store.panels['data-panel']?.collapsed,
    false,
    'Data Layers opens',
  );
  assert.equal(cockpit.contextCollapsed, true, 'Contact folds for it');
  assert.equal(document.activeElement?.id, 'cockpit-context-toggle');
});

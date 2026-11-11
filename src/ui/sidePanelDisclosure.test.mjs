import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelChrome } from './panelChrome.js';
import { presentPanelLocally } from '../testSupport/panelState.mjs';
import { readPanelState } from './rail/panelState.js';

function fixture(theme = 'cyber') {
  const nodes = new Map();
  const node = (id, collapsed = true) => {
    const classes = new Set(collapsed ? ['collapsed'] : []);
    const value = { id, hidden: false, children: [],
      matches: () => true,
      contains(target) { return this === target || this.children.some((child) => child.contains(target)); },
      classList: {
        contains: (name) => classes.has(name),
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
      },
    };
    nodes.set(id, value);
    return value;
  };
  const left = node('left-stack');
  const layers = node('data-panel', false), scenes = node('scene-panel');
  left.children = [layers, scenes];
  for (const panel of left.children) panel.parentElement = left;
  const rail = node('rail');
  const display = node('pp-toggles'), context = node('global-context-panel'), cctv = node('cctv-panel'), radio = node('radio-panel');
  rail.children = [display, context, cctv];
  for (const panel of rail.children) panel.parentElement = rail;
  context.children = [radio];
  radio.parentElement = context;
  const saved = [], claimed = [];
  const owner = {
    _leftPanelStack: left,
    _rightPanelStack: rail,
    _panelLayout: {},
    _lifetime: { frame() {} },
    _presentPanel: presentPanelLocally, _shownPanel: readPanelState, _scheduleRightPanelLayout() {},
    _scheduleLeftPanelLayout() {}, _layoutRightPanels() {}, _syncCctvPanelViewport() {},
    _savePanelCollapsedState: (...args) => saved.push(args),
    shareLinkManager: { claimRestoreLane: (...args) => claimed.push(args), onPanelStateChange() {} },
  };
  owner.setPanelCollapsed = PanelChrome.prototype.setPanelCollapsed.bind(owner);
  return { layers, scenes, display, context, cctv, radio, owner, saved, claimed,
    doc: { documentElement: { dataset: { uiTheme: theme } }, getElementById: (id) => nodes.get(id) },
  };
}

test('explicit opening collapses side peers and claims their restoration lanes in every theme', () => {
  for (const theme of ['tactical', 'minimal', 'cyber']) {
    const f = fixture(theme), prior = globalThis.document;
    globalThis.document = f.doc;
    try {
      f.owner.setPanelCollapsed('global-context-panel', false, { explicit: true });
      f.owner.setPanelCollapsed('pp-toggles', false, { explicit: true });
      assert.equal(f.display.classList.contains('collapsed'), false);
      assert.equal(f.context.classList.contains('collapsed'), true);
      assert.ok(f.saved.some(([id, collapsed]) => id === 'global-context-panel' && collapsed));
      assert.ok(f.claimed.some(([, id]) => id === 'global-context-panel'));
      f.cctv.classList.add('accordion-collapsed');
      f.owner.setPanelCollapsed('cctv-panel', true, { explicit: true });
      assert.equal(f.cctv.classList.contains('accordion-collapsed'), false);
      // The left side has its own accordion; the right side is untouched.
      f.owner.setPanelCollapsed('scene-panel', false, { explicit: true });
      assert.equal(f.scenes.classList.contains('collapsed'), false);
      assert.equal(f.layers.classList.contains('collapsed'), true);
      assert.equal(f.display.classList.contains('collapsed'), false);
    } finally { globalThis.document = prior; }
  }
});

test('opening already-expanded Radio reveals Context and closes Display', () => {
  const f = fixture('tactical'), prior = globalThis.document;
  globalThis.document = f.doc;
  try {
    f.owner.setPanelCollapsed('radio-panel', false, { explicit: true });
    f.owner.setPanelCollapsed('pp-toggles', false, { explicit: true });
    assert.equal(f.radio.classList.contains('collapsed'), false);
    assert.equal(f.context.classList.contains('collapsed'), true);
    f.owner.setPanelCollapsed('radio-panel', false, { explicit: true });
    assert.equal(f.context.classList.contains('collapsed'), false);
    assert.equal(f.display.classList.contains('collapsed'), true);
  } finally { globalThis.document = prior; }
});

test('restored preferences keep every saved panel open for the layout to normalize', () => {
  for (const theme of ['tactical', 'minimal', 'cyber']) {
    const f = fixture(theme), prior = globalThis.document;
    globalThis.document = f.doc;
    try {
      const options = { restore: true, persist: false };
      f.owner.setPanelCollapsed('pp-toggles', false, options);
      f.owner.setPanelCollapsed('cctv-panel', false, options);
      assert.equal(f.display.classList.contains('collapsed'), false);
      assert.equal(f.cctv.classList.contains('collapsed'), false);
      assert.deepEqual(f.saved, []);
    } finally { globalThis.document = prior; }
  }
});

test('a feature revealing a side panel makes it the side owner', () => {
  const f = fixture('tactical'), prior = globalThis.document;
  globalThis.document = f.doc;
  try {
    f.owner.setPanelCollapsed('pp-toggles', false, { explicit: true });
    f.claimed.length = 0;
    // Street Level's viewer or a selected radio station opens its panel
    // without an explicit user disclosure.
    f.owner.setPanelCollapsed('radio-panel', false);
    assert.equal(f.context.classList.contains('collapsed'), false);
    assert.equal(f.display.classList.contains('collapsed'), true);
    assert.equal(f.owner._panelLayout._rightStackPreferredPanelId, 'global-context-panel');
    // Only a user's choice claims restoration lanes.
    assert.deepEqual(f.claimed, []);
  } finally { globalThis.document = prior; }
});

test('PanelChrome reads a panel’s state from its store, not classes written outside it', async () => {
  const { createPinia } = await import('pinia');
  const { usePanelChromeStore } = await import('./stores/panelChrome.js');
  const store = usePanelChromeStore(createPinia());
  const owner = {
    _chromeStore: store,
    _chromeToken: store.connect({}),
    readSharedCollapsed: () => undefined,
  };
  const classes = new Set(['collapsed']);
  const panel = {
    id: 'data-panel',
    classList: { contains: (name) => classes.has(name) },
  };
  // Before the first presentation the markup's classes stand.
  assert.deepEqual(PanelChrome.prototype._shownPanel.call(owner, panel), {
    collapsed: true, pinned: false, pinnedTop: false, auto: null,
  });
  // The accordion closed it; a class written outside the store doesn't count.
  store.publish(owner._chromeToken, 'data-panel', {
    collapsed: true, pinned: false, pinnedTop: false, auto: 'accordion',
  });
  classes.add('dock-pinned');
  const shown = PanelChrome.prototype._shownPanel.call(owner, panel);
  assert.equal(shown.auto, 'accordion');
  assert.equal(shown.pinned, false);
  // A share link records the accordion's collapse as the person's open panel.
  const prior = globalThis.document;
  globalThis.document = { getElementById: (id) => (id === 'data-panel' ? panel : null) };
  try {
    owner._shownPanel = PanelChrome.prototype._shownPanel;
    const state = PanelChrome.prototype._buildSharePanelState.call(owner);
    assert.deepEqual(state.specs, [{ id: 'data-panel', collapsed: false }]);
  } finally {
    globalThis.document = prior;
  }
});

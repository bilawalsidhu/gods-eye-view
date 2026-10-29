import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelChrome } from './panelChrome.js';

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
  const rail = node('rail');
  const display = node('pp-toggles'), context = node('global-context-panel'), cctv = node('cctv-panel'), radio = node('radio-panel');
  rail.children = [display, context, cctv];
  for (const panel of rail.children) panel.parentElement = rail;
  context.children = [radio];
  radio.parentElement = context;
  const saved = [], claimed = [];
  const owner = {
    _rightPanelStack: rail,
    _panelLayout: {},
    _lifetime: { frame() {} },
    _syncPanelCollapseButton() {}, _scheduleRightPanelLayout() {},
    _scheduleLeftPanelLayout() {}, _layoutRightPanels() {}, _syncCctvPanelViewport() {},
    _savePanelCollapsedState: (...args) => saved.push(args),
    shareLinkManager: { claimRestoreLane: (...args) => claimed.push(args), onPanelStateChange() {} },
  };
  owner.setPanelCollapsed = PanelChrome.prototype.setPanelCollapsed.bind(owner);
  return { display, context, cctv, radio, owner, saved, claimed,
    doc: { documentElement: { dataset: { uiTheme: theme } }, getElementById: (id) => nodes.get(id) },
  };
}

test('any live opening of a rail panel makes it the preferred owner; restores do not', () => {
  const f = fixture('tactical'), prior = globalThis.document;
  globalThis.document = f.doc;
  try {
    f.owner.setPanelCollapsed('cctv-panel', false, {});
    assert.equal(f.owner._panelLayout._rightStackPreferredPanelId, 'cctv-panel', 'a camera click opens CCTV without the explicit flag');
    assert.equal(f.display.classList.contains('collapsed'), true, 'peers are left to the rail pass, not persisted');
    f.owner.setPanelCollapsed('radio-panel', false, {});
    assert.equal(f.owner._panelLayout._rightStackPreferredPanelId, 'global-context-panel', 'a radio pick owns the rail through Context');
    f.owner.setPanelCollapsed('cctv-panel', true, { explicit: true });
    f.owner.setPanelCollapsed('cctv-panel', false, { restore: true, persist: false });
    assert.equal(f.owner._panelLayout._rightStackPreferredPanelId, 'global-context-panel', 'a restore never claims ownership');
  } finally { globalThis.document = prior; }
});

test('explicit Cyber opening collapses peers and claims their restoration lanes', () => {
  const f = fixture(), prior = globalThis.document;
  globalThis.document = f.doc;
  try {
    f.owner.setPanelCollapsed('global-context-panel', false, { explicit: true });
    f.owner.setPanelCollapsed('pp-toggles', false, { explicit: true });
    assert.equal(f.display.classList.contains('collapsed'), false);
    assert.equal(f.context.classList.contains('collapsed'), true);
    assert.ok(f.saved.some(([id, collapsed]) => id === 'global-context-panel' && collapsed));
    assert.ok(f.claimed.some(([, id]) => id === 'global-context-panel'));
    f.cctv.classList.add('rail-owner-collapsed');
    f.owner.setPanelCollapsed('cctv-panel', true, { explicit: true });
    assert.equal(f.cctv.classList.contains('rail-owner-collapsed'), false);
  } finally { globalThis.document = prior; }
});

test('opening already-expanded Radio reveals Context and closes Display', () => {
  const f = fixture(), prior = globalThis.document;
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

test('every theme collapses rail peers on an explicit open and keeps restored preferences', () => {
  for (const theme of ['tactical', 'operator', 'minimal', 'cyber']) {
    const prior = globalThis.document;
    const explicit = fixture(theme);
    globalThis.document = explicit.doc;
    try {
      explicit.owner.setPanelCollapsed('pp-toggles', false, { explicit: true });
      explicit.owner.setPanelCollapsed('cctv-panel', false, { explicit: true });
      assert.equal(explicit.display.classList.contains('collapsed'), true, theme);
      assert.equal(explicit.cctv.classList.contains('collapsed'), false, theme);
    } finally { globalThis.document = prior; }
    const restored = fixture(theme);
    globalThis.document = restored.doc;
    try {
      restored.owner.setPanelCollapsed('pp-toggles', false, { restore: true, persist: false });
      restored.owner.setPanelCollapsed('cctv-panel', false, { restore: true, persist: false });
      assert.equal(restored.display.classList.contains('collapsed'), false, theme);
      assert.equal(restored.cctv.classList.contains('collapsed'), false, theme);
      assert.deepEqual(restored.saved, [], theme);
    } finally { globalThis.document = prior; }
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { PanelChrome } from './panelChrome.js';

function classList(initial = []) {
  const values = new Set(initial);
  return {
    contains: (value) => values.has(value),
    add: (...items) => items.forEach((item) => values.add(item)),
    remove: (...items) => items.forEach((item) => values.delete(item)),
    toggle(value, force) {
      if (force === true) values.add(value);
      else if (force === false) values.delete(value);
      else if (values.has(value)) values.delete(value);
      else values.add(value);
      return values.has(value);
    },
  };
}

// The compact Radio player floats beside the strip and may stay open over an
// expanded Context: opening Context, by request or by the adaptive rail
// restore, leaves it alone.
test('a repeated Context-open request leaves an open compact Radio player alone', (t) => {
  const priorDocument = globalThis.document;
  const contextPanel = {
    id: 'global-context-panel',
    classList: classList(),
  };
  globalThis.document = {
    documentElement: { dataset: { uiTheme: 'tactical' } },
    getElementById(id) {
      return id === 'global-context-panel' ? contextPanel : null;
    },
  };
  t.after(() => {
    globalThis.document = priorDocument;
  });

  const radioDock = { classList: classList(['disclosure-open']) };
  const calls = [];
  const owner = {
    _contextRadioDock: radioDock,
    _setRadioDisclosure(open) {
      calls.push(open);
    },
    _leftPanelStack: null,
    _rightPanelStack: null,
    _panelLayout: {
      _leftStackPreferredPanelId: null,
      _rightStackPreferredPanelId: null,
    },
    _syncPanelCollapseButton() {},
    _scheduleLeftPanelLayout() {},
    _scheduleRightPanelLayout() {},
    shareLinkManager: null,
    cockpitView: null,
  };

  PanelChrome.prototype.setPanelCollapsed.call(
    owner,
    'global-context-panel',
    false,
  );

  assert.deepEqual(calls, []);
  assert.equal(radioDock.classList.contains('disclosure-open'), true);
});

test('adaptive rail restore reveals Context without touching the compact player', (t) => {
  const priorDocument = globalThis.document;
  const priorRaf = globalThis.requestAnimationFrame;
  let nextFrame;
  const contextPanel = {
    id: 'global-context-panel',
    classList: classList(['collapsed', 'layout-auto-collapsed']),
  };
  const rightRail = {
    querySelectorAll(selector) {
      return selector === '.layout-auto-collapsed' ? [contextPanel] : [];
    },
  };
  globalThis.document = {
    getElementById(id) {
      return id === 'right-context-rail' ? rightRail : null;
    },
  };
  globalThis.requestAnimationFrame = (callback) => {
    nextFrame = callback;
    return 1;
  };
  t.after(() => {
    globalThis.document = priorDocument;
    globalThis.requestAnimationFrame = priorRaf;
  });

  const dock = { classList: classList(['disclosure-open']) };
  const calls = [];
  const chrome = new PanelChrome({
    elements: { _contextRadioDock: dock },
    operations: {
      _setRadioDisclosure(open) {
        calls.push(`disclosure:${open}`);
      },
      _syncPanelCollapseButton(panel) {
        calls.push(`button:${panel.id}`);
      },
    },
    readHud: () => ({ visible: true, getVariant: () => 'tactical' }),
    readCockpit: () => null,
    readShareLinks: () => null,
    readInitialShare: () => null,
    readScrollRestoreOwner: () => null,
    readDisplayScrollTop: () => 0,
  });
  chrome._panelLayout._syncRightPanelAdaptiveLayout = () => {
    calls.push('layout');
  };

  chrome._panelLayout._scheduleRightPanelLayout({
    reconsiderAutoCollapse: true,
  });
  assert.equal(typeof nextFrame, 'function');
  nextFrame();

  assert.equal(contextPanel.classList.contains('collapsed'), false);
  assert.equal(contextPanel.classList.contains('layout-auto-collapsed'), false);
  assert.equal(dock.classList.contains('disclosure-open'), true);
  assert.deepEqual(calls, ['button:global-context-panel', 'layout']);
});

// A globe station pick opens Radio, which may already be expanded inside a
// closed Context.
for (const theme of ['tactical', 'cyber']) {
  test(`${theme}: a radio pick reopens the closed Context around an expanded Radio section`, (t) => {
    const priorDocument = globalThis.document;
    const contextPanel = {
      id: 'global-context-panel',
      classList: classList(['collapsed']),
    };
    const panels = {
      'global-context-panel': contextPanel,
      'radio-panel': { id: 'radio-panel', classList: classList() },
    };
    globalThis.document = {
      documentElement: { dataset: { uiTheme: theme } },
      body: { classList: classList() },
      getElementById: (id) => panels[id] || null,
    };
    t.after(() => {
      globalThis.document = priorDocument;
    });
    const owner = {
      _leftPanelStack: null,
      _rightPanelStack: { contains: (el) => el === contextPanel },
      _panelLayout: {
        _leftStackPreferredPanelId: null,
        _rightStackPreferredPanelId: 'pp-toggles',
      },
      _syncPanelCollapseButton() {},
      _scheduleLeftPanelLayout() {},
      _scheduleRightPanelLayout() {},
      _savePanelCollapsedState() {},
      _syncCctvPanelViewport() {},
      _updateCommandDockTrayStack() {},
      _lifetime: { frame() {} },
      shareLinkManager: null,
      cockpitView: null,
    };
    owner.setPanelCollapsed = PanelChrome.prototype.setPanelCollapsed;

    owner.setPanelCollapsed('radio-panel', false);

    assert.equal(contextPanel.classList.contains('collapsed'), false);
  });
}

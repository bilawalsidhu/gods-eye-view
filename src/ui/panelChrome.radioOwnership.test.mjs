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

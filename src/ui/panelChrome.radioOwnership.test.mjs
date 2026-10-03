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

test('opening an already-open Context still closes a stale compact Radio disclosure', (t) => {
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
      radioDock.classList.toggle('disclosure-open', open);
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

  assert.deepEqual(calls, [false]);
  assert.equal(radioDock.classList.contains('disclosure-open'), false);
});

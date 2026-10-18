import assert from 'node:assert/strict';
import test from 'node:test';
import { createPanel } from './panel.js';

test('rendering a selected mission resets the nearest theme-appropriate Context scroller', () => {
  for (const cyber of [true, false]) {
    const body = { scrollTop: 180 };
    const inner = { scrollTop: 90 };
    const output = { closest: () => null, removeAttribute() {} };
    const state = {
      _missionPanel: {
        querySelector: () => output,
        closest(selector) {
          assert.equal(selector, ":root[data-ui-theme='cyber'] .cyber-panel-body, .global-context-panel-inner");
          return cyber ? body : inner;
        },
      },
      _selectedLaunchId: 'mission-1',
      _launches: [{ id: 'mission-1', name: 'Example', payloads: [], recoveryStages: [] }],
      _replayTracks: new Map(),
    };
    const panel = createPanel({
      state,
      parts: {
        overlays: { shortMissionLabel: (name) => name },
        policyHelpers: { missionPathPresentation: () => ({}) },
        replay: { syncReplayButton() {} },
      },
    });
    panel.renderMissionPanel();
    assert.equal(body.scrollTop, cyber ? 0 : 180);
    assert.equal(inner.scrollTop, cyber ? 90 : 0);
  }
});

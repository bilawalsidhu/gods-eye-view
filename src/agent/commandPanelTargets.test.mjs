import test from 'node:test';
import assert from 'node:assert/strict';
import { createGevActionRunner } from '../voice/gevActions.js';

test('Display and Street Level aliases dispatch through the shared owner with explicit intent', async () => {
  const calls = [];
  const run = createGevActionRunner({
    viewer: {
      camera: { moveEnd: { addEventListener() {} } },
      scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
      clock: { onTick: { addEventListener: () => () => {} } },
    },
    styleManager: { setPanelCollapsed: (...args) => calls.push(args) },
    dataManager: { layers: new Map() },
  });
  for (const [name, id] of [
    ['Display', 'pp-toggles'],
    ['Street Level', 'street-level-panel'],
    ['street-level-panel', 'street-level-panel'],
  ]) {
    for (const open of [true, false]) {
      const result = await run('set_panel_open', { panelId: name, open });
      assert.equal(result.ok, true);
      assert.equal(result.panelId, id);
      assert.deepEqual(calls.at(-1), [id, !open, { explicit: true }]);
    }
  }
});

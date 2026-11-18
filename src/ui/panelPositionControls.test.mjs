import assert from 'node:assert/strict';
import test from 'node:test';
import { PanelPositionControls } from './panelPositionControls.js';

/** A localStorage stand-in whose keys enumerate like the real one. */
function fakeStorage(entries) {
  const storage = {};
  Object.defineProperties(storage, {
    getItem: { value: (key) => (key in storage ? storage[key] : null) },
    setItem: { value: (key, value) => (storage[key] = String(value)) },
    removeItem: { value: (key) => delete storage[key] },
  });
  Object.assign(storage, entries);
  return storage;
}

test('the floating panels’ stored positions and hint flag are dropped; collapse state stays', (t) => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = fakeStorage({
    'godsEyeView.v8.panelPos.cctv-panel': '{"x":1}',
    'godsEyeView.v8.panelFloatHintShown': '1',
    'godsEyeView.v6.panelCollapsed.cctv-panel': '1',
    'godsEyeView.v8.layoutResetNotified': '1',
  });
  t.after(() => {
    globalThis.localStorage = saved;
  });
  const controls = new PanelPositionControls({ showToast() {} });
  controls._maybeNotifyLayoutReset();
  assert.deepEqual(Object.keys(globalThis.localStorage).sort(), [
    'godsEyeView.v6.panelCollapsed.cctv-panel',
    'godsEyeView.v8.layoutResetNotified',
  ]);
});

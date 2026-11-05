import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPendingVisualChoices,
  pendingVisualSettings,
} from './pendingVisualSettings.js';

test('a style chosen between engines waits and then wins over the restored view', () => {
  const calls = [];
  const released = {
    activeStyle: 'nvg',
    setStyle(name) {
      calls.push(['released', name]);
    },
    _readShareState: () => ({ style: 'nvg' }),
  };
  const { settings, queue } = pendingVisualSettings(released);
  // Reads answer from the released settings; choices do not reach them.
  assert.equal(settings.activeStyle, 'nvg');
  assert.deepEqual(settings._readShareState(), { style: 'nvg' });
  assert.deepEqual(settings.setStyle('crt', { applyPreset: true }), {
    ok: true,
    pending: true,
  });
  settings._setBloomEnabled(true);
  assert.deepEqual(calls, []);
  // The next engine restored the link's 'normal'; the choices then apply.
  const next = {
    activeStyle: 'normal',
    setStyle(name) {
      calls.push(['next', name]);
      this.activeStyle = name;
    },
    _setBloomEnabled(on) {
      calls.push(['next bloom', on]);
    },
  };
  applyPendingVisualChoices(next, queue);
  assert.deepEqual(calls, [
    ['next', 'crt'],
    ['next bloom', true],
  ]);
  assert.equal(next.activeStyle, 'crt');
  assert.equal(queue.length, 0);
});

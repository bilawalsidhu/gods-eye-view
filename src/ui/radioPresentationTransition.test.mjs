import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderRadioState } from './radioPresentation.js';

function el() {
  const attrs = new Map();
  return {
    textContent: '',
    hidden: false,
    disabled: false,
    style: {},
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => attrs.get(k),
    attrs,
  };
}

for (const lifecycleState of ['enabling', 'disabling']) {
  test(`Radio render survives the ${lifecycleState} transition`, () => {
    const prior = globalThis.document;
    globalThis.document = { getElementById: () => null };
    try {
      const enable = el();
      const ctx = {
        destroyed: false,
        _radioPanel: el(),
        _radioEnableBtn: enable,
        _syncContextRadioLauncherState() {},
        actions: {
          getLifecycle: () => ({
            lifecycleState,
            enabled: lifecycleState === 'disabling',
            uncertain: false,
          }),
        },
      };
      const state = {
        enabled: false,
        categories: [],
        filteredCount: 0,
        stationCount: 0,
        audioState: 'idle',
      };
      try {
        renderRadioState.call(ctx, state);
      } catch (error) {
        // Anything thrown after the transitional label is a different
        // missing fixture field, not the bug under test.
        assert.ok(
          !(
            error instanceof ReferenceError &&
            /lifecycleLabel/.test(error.message)
          ),
          `render threw: ${error.message}`,
        );
      }
      assert.equal(enable.attrs.get('aria-busy'), 'true');
      assert.equal(enable.textContent, lifecycleState.toUpperCase());
    } finally {
      globalThis.document = prior;
    }
  });
}

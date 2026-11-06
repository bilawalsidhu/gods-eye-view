import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngineEvent } from '../../globe/contract.js';
import { createInteraction } from './interaction.js';
test('an external null follow clears satellite state; own release stays guarded', () => {
  const previous = globalThis.document;
  globalThis.document = new EventTarget();
  try {
    const changed = createEngineEvent();
    let current = null,
      releasing = false;
    const calls = [];
    const renderer = {
      follow: {
        onChanged: (fn) => changed.addEventListener(fn),
        current: () => current,
        releasing: () => releasing,
      },
      listenClick: () => ({ destroy() {} }),
    };
    const state = {
      _enabled: true,
      _trackedNorad: 25544,
      _trackedEntity: { id: 'own' },
    };
    const interaction = createInteraction({
      state,
      services: { picking: {} },
      parts: { tracking: { _clearTracking: (...args) => calls.push(args) } },
      getRenderer: () => renderer,
    });
    interaction._installClickHandler();
    releasing = true;
    changed.raiseEvent();
    assert.equal(calls.length, 0);
    releasing = false;
    changed.raiseEvent();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], true);
    current = state._trackedEntity;
    changed.raiseEvent();
    assert.equal(calls.length, 1);
    current = { id: 'foreign' };
    changed.raiseEvent();
    assert.equal(calls.length, 2);
    state._trackedEntityChangedRemove();
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

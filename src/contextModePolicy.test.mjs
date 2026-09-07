import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextAllowedLayerIds,
  contextRestoreLayerIds,
  isExplicitUserIntentOrigin,
  mergeContextTransitionErrors,
  contextSnapshotLayerIds,
  recordContextSessionUserChange,
  recordContextRestoreExplicitChange,
  runWithContextModeChanging,
  settleContextModeChange,
  settleContextIntentReplay,
  settleUserFacingContextAction,
  shouldCaptureContextSession,
  shouldExitContextForLayerChange,
} from './contextModePolicy.js';


test('user-facing Context actions surface rejection and semantic false without rethrowing', async () => {
  const surfaced = [];
  const rejection = new Error('restore rejected');
  assert.equal(await settleUserFacingContextAction({
    operation: async () => { throw rejection; },
    onFailure: (error) => surfaced.push(error),
  }), false);
  assert.equal(await settleUserFacingContextAction({
    operation: async () => false,
    onFailure: (error) => surfaced.push(error),
  }), false);
  assert.equal(surfaced[0], rejection);
  assert.match(surfaced[1].message, /did not complete/);

  assert.equal(await settleUserFacingContextAction({
    operation: async () => false,
    falseIsFailure: false,
    onFailure: () => assert.fail('handled false must not surface twice'),
  }), false);
  assert.equal(await settleUserFacingContextAction({
    operation: async () => { throw rejection; },
    onFailure: () => { throw new Error('broken toast'); },
  }), false);
});

const userEnable = (layerId) => ({
  type: 'visibility',
  layerId,
  enabled: true,
  origin: 'user',
});


test('the Global Context shell and layers selected while Context is off remain allowed', () => {
  assert.equal(shouldExitContextForLayerChange({
    contextMode: null,
    globalContextEnabled: true,
    change: userEnable('military-awareness'),
  }), false);
  assert.equal(shouldExitContextForLayerChange({
    contextMode: null,
    globalContextEnabled: false,
    change: userEnable('earthquakes'),
  }), false);
});


test('Context restoration keeps the pre-entry set and user-added layers', () => {
  assert.deepEqual(
    [...contextRestoreLayerIds({
      enabledLayerIds: new Set(['flights', 'traffic']),
      userAdded: new Set(['earthquakes', 'traffic']),
    })],
    ['flights', 'traffic', 'earthquakes'],
  );
});


test('explicit layer intent finishing during restore overrides the stale queued target', () => {
  for (const origin of ['user', 'voice']) {
    const restoreState = {
      enabledLayerIds: new Set(['flights']),
      explicitLayerStates: new Map(),
    };
    assert.equal(recordContextRestoreExplicitChange({
      restoreState,
      change: { type: 'visibility', origin, layerId: 'cctv', enabled: true },
    }), true);
    assert.equal(restoreState.enabledLayerIds.has('cctv'), true);
    assert.deepEqual([...restoreState.explicitLayerStates], [['cctv', true]]);

    assert.equal(recordContextRestoreExplicitChange({
      restoreState,
      change: { type: 'visibility', origin: 'context-restore', layerId: 'cctv', enabled: false },
    }), false);
    assert.deepEqual([...restoreState.explicitLayerStates], [['cctv', true]]);

    assert.equal(recordContextRestoreExplicitChange({
      restoreState,
      change: { type: 'visibility', origin, layerId: 'cctv', enabled: false },
    }), true);
    assert.equal(restoreState.enabledLayerIds.has('cctv'), false);
    assert.deepEqual([...restoreState.explicitLayerStates], [['cctv', false]]);
  }
});

test('context teardown guard restores coordination state after success and failure', async () => {
  const idleOwner = { _contextModeChanging: false };
  await runWithContextModeChanging(idleOwner, async () => {
    assert.equal(idleOwner._contextModeChanging, true);
  });
  assert.equal(idleOwner._contextModeChanging, false);

  const activeOwner = { _contextModeChanging: true };
  await assert.rejects(
    runWithContextModeChanging(activeOwner, async () => {
      assert.equal(activeOwner._contextModeChanging, true);
      throw new Error('restore failed');
    }),
    /restore failed/,
  );
  assert.equal(activeOwner._contextModeChanging, true);
});

test('leaving a Context transaction re-publishes the settled state to the funnel', () => {
  // Settle-gated consumers (the Contacts detection override) no-op while a
  // transaction is in flight, so dropping the flag without re-running the
  // funnel leaves them holding the pre-transaction state forever.
  const syncs = [];
  const owner = {
    _contextModeChanging: true,
    _syncContextModeButtons() { syncs.push(this._contextModeChanging); },
  };
  settleContextModeChange(owner);
  assert.equal(owner._contextModeChanging, false);
  assert.deepEqual(syncs, [false], 'the funnel runs AFTER the flag clears');

  // Already settled: nothing to re-publish.
  settleContextModeChange(owner);
  assert.deepEqual(syncs, [false]);

  // A nested scope handing back to a still-running outer transaction has
  // settled nothing.
  const nested = {
    _contextModeChanging: true,
    _syncContextModeButtons() { syncs.push('nested'); },
  };
  settleContextModeChange(nested, true);
  assert.equal(nested._contextModeChanging, true);
  assert.deepEqual(syncs, [false]);

  settleContextModeChange(null); // no owner, no throw
});

test('the teardown guard re-publishes on the way out, so a mid-flight exit is not stranded', async () => {
  // The field case: destroying a Contacts dependency layer exits the session
  // inside the guard — the sync it calls there is gated out — and only the
  // guard's own settle can let a settle-gated consumer see mode === null.
  const observed = [];
  const owner = {
    _contextModeChanging: false,
    _contextMode: 'flights',
    _syncContextModeButtons() {
      observed.push({ mode: this._contextMode, changing: this._contextModeChanging });
    },
  };
  await runWithContextModeChanging(owner, async () => {
    owner._contextMode = null;
    owner._syncContextModeButtons(); // gated: changing is still true
  });
  assert.deepEqual(observed, [
    { mode: null, changing: true },
    { mode: null, changing: false },
  ], 'the exit is re-published once the transaction settles');
});


test('a selected Context dependency becomes user-owned for exit restoration', () => {
  const snapshot = { enabledLayerIds: new Set(), userAdded: new Set() };
  assert.equal(recordContextSessionUserChange({
    snapshot,
    change: {
      type: 'visibility',
      layerId: 'flights',
      enabled: true,
      origin: 'user',
      adoptedFromSelection: true,
    },
    effectiveContextMode: 'flights',
  }), true);
  assert.equal(snapshot.userAdded.has('flights'), true);
  assert.equal(contextRestoreLayerIds(snapshot).has('flights'), true);
});

test('session bookkeeping ignores programmatic origins, non-visibility events, and a missing snapshot', () => {
  const snapshot = { enabledLayerIds: new Set(), userAdded: new Set() };
  assert.equal(recordContextSessionUserChange({
    snapshot,
    change: { type: 'visibility', layerId: 'cctv', enabled: true, origin: 'programmatic' },
    effectiveContextMode: null,
  }), false);
  assert.equal(recordContextSessionUserChange({
    snapshot,
    change: { type: 'visibility-will-change', layerId: 'cctv', enabled: true, origin: 'user' },
    effectiveContextMode: null,
  }), false);
  assert.equal(recordContextSessionUserChange({
    snapshot: null,
    change: { type: 'visibility', layerId: 'cctv', enabled: true, origin: 'user' },
    effectiveContextMode: null,
  }), false);
  assert.equal(snapshot.userAdded.size, 0);
});

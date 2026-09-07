import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadinessState } from '../dist/readiness.js';

test('tracks startup and draining transitions', () => {
  const state = new ReadinessState();
  assert.deepEqual(state.snapshot(), { ready: false, reason: 'starting' });
  state.markReady();
  assert.deepEqual(state.snapshot(), { ready: true, reason: 'ready' });
  state.markNotReady('draining');
  assert.deepEqual(state.snapshot(), { ready: false, reason: 'draining' });
});

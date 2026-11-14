// src/ui/placePacksLoading.test.mjs — the loading status names the place
// packs while they load, and a failed pack ends the batch as failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateLayerLoading,
  createLoadingFeedbackState,
  reduceLoadingFeedback,
} from '../loadingFeedback.js';
import { withPlacePacks } from './placePacksLoading.js';

const SATELLITES = Object.freeze({
  id: 'satellites',
  name: 'Satellites',
  enabled: true,
  stats: { count: 9000, lastUpdate: 1 },
});

function batch(states) {
  let state = createLoadingFeedbackState();
  let now = 0;
  for (const status of states) {
    now += 1000;
    state = reduceLoadingFeedback(
      state,
      aggregateLayerLoading(withPlacePacks([SATELLITES], status)),
      now,
    );
  }
  return state;
}

test('nothing extra while the packs are idle', () => {
  const layers = [SATELLITES];
  assert.equal(
    withPlacePacks(layers, { loading: false, failed: false }),
    layers,
  );
});

test('the packs are named while they load', () => {
  const summary = aggregateLayerLoading(
    withPlacePacks([SATELLITES], { loading: true, failed: false }),
  );
  assert.deepEqual(summary.activeIds, ['place-names']);
  assert.equal(summary.active[0].label, 'Place names');
});

test('a load that lands ends complete; one that fails ends failed', () => {
  const loading = { loading: true, failed: false };
  assert.equal(
    batch([loading, { loading: false, failed: false }]).terminal,
    'complete',
  );
  assert.equal(
    batch([loading, { loading: false, failed: true }]).terminal,
    'error',
  );
  // A retry after a failure that lands ends complete.
  assert.equal(
    batch([
      { loading: false, failed: true },
      loading,
      { loading: false, failed: false },
    ]).terminal,
    'complete',
  );
});

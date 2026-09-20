/**
 * Military-registry active-transition tests (pre-ship audit M2).
 *
 * Locks the setMilitaryLayerActive contract the flights layer's immediate
 * suppression/restore sweep depends on: listeners fire only on TRANSITIONS
 * (never on same-value sets), after the new state is committed, and a broken
 * listener can't break the toggle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMilitaryIcao,
  refreshMilitaryRegistryIfStale,
  setMilitaryLayerActive,
  isMilitaryLayerActive,
  onMilitaryLayerActiveChange,
} from './militaryRegistry.js';

test('active-change listener fires on transitions only, with committed state', () => {
  const seen = [];
  const unsub = onMilitaryLayerActiveChange((active) => {
    seen.push({ active, committed: isMilitaryLayerActive() });
  });
  try {
    setMilitaryLayerActive(false); // same value (initial false) → no fire
    assert.equal(seen.length, 0);

    setMilitaryLayerActive(true); // transition → fire, state already committed
    assert.deepEqual(seen, [{ active: true, committed: true }]);

    setMilitaryLayerActive(true); // same value → no fire
    assert.equal(seen.length, 1);

    setMilitaryLayerActive(false); // transition back → fire
    assert.deepEqual(seen[1], { active: false, committed: false });
    assert.equal(seen.length, 2);
  } finally {
    unsub();
    setMilitaryLayerActive(false);
  }
});

test('unsubscribe stops delivery; throwing listeners never break the toggle', () => {
  let calls = 0;
  const unsubBroken = onMilitaryLayerActiveChange(() => { throw new Error('boom'); });
  const unsubCounter = onMilitaryLayerActiveChange(() => { calls++; });
  try {
    setMilitaryLayerActive(true); // broken listener swallowed, counter still runs
    assert.equal(calls, 1);
    assert.equal(isMilitaryLayerActive(), true);

    unsubCounter();
    setMilitaryLayerActive(false);
    assert.equal(calls, 1); // unsubscribed → no more deliveries
  } finally {
    unsubBroken();
    unsubCounter();
    setMilitaryLayerActive(false);
  }
});

test('onMilitaryLayerActiveChange tolerates non-function listeners', () => {
  const unsub = onMilitaryLayerActiveChange(null);
  assert.equal(typeof unsub, 'function');
  unsub(); // no-op, must not throw
  setMilitaryLayerActive(true);
  assert.equal(isMilitaryLayerActive(), true);
  setMilitaryLayerActive(false);
});

test('a failed registry poll keeps the known set and never wedges the poll slot', async () => {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let calls = 0;
  try {
    setMilitaryLayerActive(false);
    // One good poll first: classification must survive what follows.
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ac: [{ hex: 'ADF001' }, { hex: ' RCH999 ' }, {}, { hex: '' }] }),
    });
    refreshMilitaryRegistryIfStale();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(isMilitaryIcao('adf001'), true);
    assert.equal(isMilitaryIcao('rch999'), true, 'hexes are trimmed and lower-cased');
    assert.equal(isMilitaryIcao(''), false, 'blank rows add nothing');

    // A later poll fails: the set is add-only, so nothing is declassified.
    const stampedAt = realNow();
    Date.now = () => stampedAt + 120_000; // the 60 s poll window has elapsed
    globalThis.fetch = () => { calls += 1; return Promise.reject(new Error('proxy offline')); };
    refreshMilitaryRegistryIfStale();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(isMilitaryIcao('adf001'), true, 'a transient outage does not declassify');
    assert.equal(isMilitaryIcao('civil123'), false);

    // The in-flight flag was released by the failure, so the next call polls.
    refreshMilitaryRegistryIfStale();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2, 'a failed poll is retried instead of being swallowed');
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
    setMilitaryLayerActive(false);
  }
});

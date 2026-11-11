import assert from 'node:assert/strict';
import test from 'node:test';
import { handoffTargetEnabled } from './layerStateCoordinator.js';

test('a pick keeps every handed-off layer as it runs', () => {
  // The incoming address is the outgoing one: it agrees everywhere.
  assert.equal(
    handoffTargetEnabled({ enabled: true, durable: true }, true),
    true,
  );
  // A Contacts session runs layers its address never lists.
  assert.equal(
    handoffTargetEnabled({ enabled: true, durable: false }, false),
    true,
  );
  assert.equal(
    handoffTargetEnabled({ enabled: false, durable: true }, true),
    false,
  );
});

test('a visited entry with another layer set wins where it differs', () => {
  assert.equal(
    handoffTargetEnabled({ enabled: false, durable: false }, true),
    true,
  );
  assert.equal(
    handoffTargetEnabled({ enabled: true, durable: true }, false),
    false,
  );
});

test('without a handoff record the address decides', () => {
  assert.equal(handoffTargetEnabled(undefined, true), true);
  assert.equal(handoffTargetEnabled({ entry: null }, false), false);
  // A record without the outgoing address keeps the running state.
  assert.equal(handoffTargetEnabled({ enabled: true }, false), true);
});

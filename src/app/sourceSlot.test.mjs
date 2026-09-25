import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceSlot } from './sourceSlot.js';

test('replacing a source rejects its late result and old cleanup cannot clear the new source', async () => {
  let finish;
  const slot = createSourceSlot({ read: async () => 'default' }, ['read']);
  const old = slot.configure({
    read: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = slot.source.read();
  const stop = slot.configure({
    read: async () => 'replacement',
    attribution: { name: 'Replacement' },
  });
  old();
  finish('stale');
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(await slot.source.read(), 'replacement');
  assert.equal(slot.source.attribution.name, 'Replacement');
  stop();
  assert.throws(() => slot.source.read(), /not configured/);
});

test('an invalid replacement leaves the working source intact', async () => {
  const slot = createSourceSlot({ read: async () => 42 }, ['read']);
  assert.throws(() => slot.configure({}), TypeError);
  assert.equal(await slot.source.read(), 42);
});

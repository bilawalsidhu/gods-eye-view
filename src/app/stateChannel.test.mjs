import test from 'node:test';
import assert from 'node:assert/strict';
import { createStateChannel } from './stateChannel.js';

test('snapshots and action data are immutable copies of live product state', () => {
  const live = { selected: { id: 'a' }, items: ['a'] };
  const channel = createStateChannel(() => live);
  const received = [];
  channel.subscribe((event) => received.push(event));
  const change = { type: 'selected', item: { id: 'b' } };
  live.selected.id = 'b';
  channel.publish(change);
  change.item.id = 'mutated';
  assert.equal(received[0].initial, true);
  assert.equal(received[0].state.selected.id, 'a');
  assert.equal(received[1].state.selected.id, 'b');
  assert.equal(received[1].change.item.id, 'b');
  assert.throws(() => received[1].state.items.push('c'), TypeError);
  assert.deepEqual(live.items, ['a']);
});

test('reentrant updates retain order and a new subscriber never regresses behind its initial snapshot', () => {
  let count = 0;
  const channel = createStateChannel(() => ({ count }));
  const first = [],
    second = [],
    joined = [];
  channel.subscribe(({ state, initial }) => {
    if (initial) return;
    first.push(state.count);
    if (state.count === 1) {
      count = 2;
      channel.publish({ type: 'next' });
      channel.subscribe(({ state }) => joined.push(state.count));
    }
  });
  channel.subscribe(({ state, initial }) => {
    if (!initial) second.push(state.count);
  });
  count = 1;
  channel.publish();
  assert.deepEqual(first, [1, 2]);
  assert.deepEqual(second, [1, 2]);
  assert.deepEqual(joined, [2]);
});

test('unsubscribe and destroy during delivery revoke pending callbacks and future reads', () => {
  let reads = 0;
  const channel = createStateChannel(() => ({ reads: ++reads }));
  let late = 0;
  let remove;
  channel.subscribe(
    () => {
      remove();
      channel.publish();
      channel.destroy();
    },
    { emitCurrent: false },
  );
  remove = channel.subscribe(() => late++, { emitCurrent: false });
  channel.publish();
  const stoppedReads = reads;
  channel.publish();
  channel.subscribe(() => late++);
  channel.destroy();
  remove();
  assert.equal(late, 0);
  assert.equal(reads, stoppedReads);
});

test('a failed subscriber cannot prevent other controls from receiving an update', () => {
  const channel = createStateChannel(() => ({ selected: 'a' }));
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(message);
  try {
    channel.subscribe(() => {
      throw new Error('consumer failure');
    });
    let received = 0;
    channel.subscribe(() => received++);
    channel.publish();
    assert.equal(received, 2);
    assert.equal(errors.length, 2);
  } finally {
    console.error = original;
    channel.destroy();
  }
});

test('an invalid initial snapshot cannot retain a subscriber without a cleanup handle', () => {
  let live = { action() {} };
  const channel = createStateChannel(() => live);
  let calls = 0;
  assert.throws(() => channel.subscribe(() => calls++), /plain data/);
  live = { selected: 'a' };
  channel.publish();
  assert.equal(calls, 0);
});

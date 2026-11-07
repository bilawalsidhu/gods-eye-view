import assert from 'node:assert/strict';
import test from 'node:test';
import { createPickDelivery } from './pickDelivery.js';

const entry = (seen, name, options = {}) => ({
  pick: false,
  drill: 0,
  ...options,
  listener: (event) => seen.push([name, event]),
});

test('plain listeners get the event; pick listeners the pick and their drill', () => {
  const seen = [];
  const picks = [];
  const delivery = createPickDelivery({
    pick: (at) => (picks.push(at), { id: 'x' }),
    drill: (at, limit) =>
      [{ id: 'x' }, { id: 'y' }, { id: 'z' }].slice(0, limit),
    schedule: () => assert.fail('clicks are not deferred'),
  });
  const event = { position: { x: 1, y: 2 } };
  delivery.deliver('click', event, [
    entry(seen, 'plain'),
    entry(seen, 'pick', { pick: true }),
    entry(seen, 'drill', { pick: true, drill: 2 }),
  ]);
  assert.deepEqual(picks, [{ x: 1, y: 2 }], 'one pick for every listener');
  assert.deepEqual(seen[0], ['plain', event]);
  assert.deepEqual(seen[1][1], { ...event, picked: { id: 'x' } });
  assert.deepEqual(seen[2][1].drilled, [{ id: 'x' }, { id: 'y' }]);
});

test('moves with picks are delivered once per frame, with the latest position', () => {
  const seen = [];
  let frame = null;
  const delivery = createPickDelivery({
    pick: (at) => ({ id: `at-${at.x}` }),
    drill: () => [],
    schedule: (run) => {
      frame = run;
    },
  });
  const listeners = [
    entry(seen, 'plain'),
    entry(seen, 'hover', { pick: true }),
  ];
  for (const x of [1, 2, 3])
    delivery.deliver(
      'move',
      { startPosition: { x: x - 1, y: 0 }, endPosition: { x, y: 0 } },
      listeners,
    );
  assert.equal(seen.filter(([name]) => name === 'plain').length, 3);
  assert.equal(seen.filter(([name]) => name === 'hover').length, 0);
  frame();
  const hovers = seen.filter(([name]) => name === 'hover');
  assert.equal(hovers.length, 1);
  assert.equal(hovers[0][1].picked.id, 'at-3');
});

test('asynchronous picks resolve before delivery; removed listeners get nothing', async () => {
  const seen = [];
  const delivery = createPickDelivery({
    pick: async () => ({ id: 'later' }),
    drill: async () => [{ id: 'later' }],
    schedule: (run) => run(),
  });
  const kept = entry(seen, 'kept', { pick: true, drill: 1 });
  const removed = entry(seen, 'removed', { pick: true });
  const live = new Set([kept, removed]);
  const done = delivery.deliver(
    'click',
    { position: { x: 0, y: 0 } },
    [...live],
    {
      isLive: (candidate) => live.has(candidate),
    },
  );
  live.delete(removed);
  await done;
  assert.deepEqual(
    seen.map(([name]) => name),
    ['kept'],
  );
  assert.deepEqual(seen[0][1].drilled, [{ id: 'later' }]);
});

test('pick windows partition sharing, preserve drill limits and copy the latest move', async () => {
  const picks = [],
    drills = [],
    seen = [];
  let frame;
  const delivery = createPickDelivery({
    pick: (at, type, window) => {
      picks.push([at.x, window]);
      return { id: window?.width };
    },
    drill: (at, limit, window) => {
      drills.push([limit, window]);
      return Array.from({ length: limit }, (_, id) => ({ id }));
    },
    schedule: (run) => {
      frame = run;
    },
  });
  const small = { width: 9, height: 3 },
    large = { width: 17, height: 11 };
  const listeners = [
    entry(seen, 'a', { pick: true, drill: 2, pickWindow: small }),
    entry(seen, 'b', { pick: true, drill: 4, pickWindow: { ...small } }),
    entry(seen, 'c', { pick: true, drill: 1, pickWindow: large }),
  ];
  await delivery.deliver('down', { position: { x: 1, y: 2 } }, listeners);
  assert.equal(picks.length, 2);
  assert.deepEqual(drills, [
    [4, small],
    [1, large],
  ]);
  assert.deepEqual(
    seen.map(([, event]) => event.drilled.length),
    [2, 4, 1],
  );
  picks.length = 0;
  delivery.deliver('move', { endPosition: { x: 3, y: 0 } }, listeners);
  delivery.deliver('move', { endPosition: { x: 4, y: 0 } }, listeners);
  frame();
  assert.deepEqual(
    picks.map(([x]) => x),
    [4, 4],
  );
});

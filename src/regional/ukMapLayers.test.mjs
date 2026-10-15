import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { createUkMapLayers, UK_MAP_STORAGE_KEY } from './ukMapLayers.js';
import { readUkFeed } from './ukFeedClient.js';

const feeds = ['a', 'b', 'c', 'places'].map((id) => ({
  id,
  name: id,
  interval: 3600000,
}));
const reading = (id = 'one', lat = 54.9) => ({ id, name: id, lat, lon: -1.6 });
const payload = (rows = [reading()]) => ({
  status: 'available',
  retrievedAt: '2026-10-15T10:00:00Z',
  rows,
});
function fixture(t, options = {}) {
  const drawn = new Map(),
    history = [],
    stored = new Map();
  const api = createUkMapLayers({
    feeds,
    storage: {
      getItem: (k) => stored.get(k),
      setItem: (k, v) => stored.set(k, v),
    },
    fetchFeed: async () => payload(),
    replace: (id, rows) => {
      drawn.set(id, rows);
      history.push(id);
    },
    remove: (id) => drawn.delete(id),
    ...options,
  });
  t.after(api.destroy);
  return { api, drawn, history, stored };
}

test('multiple map feeds stay independent; enabling all excludes the nearby query', async (t) => {
  const { api, drawn, stored, history } = fixture(t);
  api.enableAll();
  await tick();
  assert.deepEqual([...drawn.keys()], ['a', 'b', 'c']);
  assert.equal(api.isEnabled('places'), false);
  assert.deepEqual(JSON.parse(stored.get(UK_MAP_STORAGE_KEY)), ['a', 'b', 'c']);
  assert.deepEqual(
    history,
    ['a', 'b', 'c'],
    'a later feed does not rebuild unchanged collections',
  );
  api.setEnabled('b', false);
  assert.deepEqual([...drawn.keys()], ['a', 'c']);
});

test('disabled, destroyed and superseded requests cannot reinsert old points', async (t) => {
  const calls = [];
  const { api, drawn } = fixture(t, {
    fetchFeed: (id, signal) =>
      new Promise((resolve) => calls.push({ id, signal, resolve })),
  });
  api.setEnabled('a', true);
  api.setEnabled('a', false);
  api.setEnabled('a', true);
  assert.equal(calls[0].signal.aborted, true);
  calls[1].resolve(payload([reading('new')]));
  await tick();
  calls[0].resolve(payload([reading('old')]));
  await tick();
  assert.equal(drawn.get('a')[0].id, 'new');
  api.setEnabled('b', true);
  api.destroy();
  calls[2].resolve(payload());
  await tick();
  assert.equal(drawn.size, 0);
});

test('the request queue limits concurrency and a failed source keeps other points', async (t) => {
  const calls = [];
  const { api, drawn } = fixture(t, {
    maxConcurrent: 2,
    fetchFeed: (id) =>
      new Promise((resolve, reject) => calls.push({ id, resolve, reject })),
  });
  api.enableAll();
  assert.equal(calls.length, 2);
  calls[0].resolve(payload());
  await tick();
  assert.equal(calls.length, 3);
  calls[1].reject(new Error('offline'));
  calls[2].resolve(payload());
  await tick();
  assert.deepEqual([...drawn.keys()], ['a', 'c']);
  assert.equal(api.states().find((s) => s.id === 'b').status, 'unavailable');
});

test('invalid or absent coordinates are never invented; display caps are explicit', async (t) => {
  const { api, drawn } = fixture(t, {
    pointLimit: 2,
    fetchFeed: async () =>
      payload([
        reading('1'),
        reading('1'),
        reading('2'),
        reading('3'),
        { id: 'no coordinates' },
        reading('outside', 0),
      ]),
  });
  api.setEnabled('a', true);
  await tick();
  assert.deepEqual(
    drawn.get('a').map((r) => r.id),
    ['1', '2'],
  );
  assert.equal(api.states()[0].count, 6);
  assert.equal(api.states()[0].mappedCount, 2);
});

test('saved valid switches restore; malformed and inaccessible storage stay usable', async (t) => {
  const { api, drawn } = fixture(t, {
    storage: { getItem: () => '["a","unknown","a"]' },
  });
  await tick();
  assert.equal(api.isEnabled('a'), true);
  assert.equal(drawn.size, 1);
  const denied = fixture(t, {
    storage: {
      getItem() {
        throw new Error();
      },
      setItem() {
        throw new Error();
      },
    },
  });
  denied.api.setEnabled('a', true);
  await tick();
  assert.equal(denied.drawn.size, 1);
});

test('hidden-page cancellation pauses requests and reloading resumes them', async (t) => {
  const calls = [];
  const { api } = fixture(t, {
    fetchFeed: (id, signal) =>
      new Promise((resolve) => calls.push({ signal, resolve })),
  });
  api.setEnabled('a', true);
  api.setSuspended(true);
  assert.equal(calls[0].signal.aborted, true);
  api.setEnabled('b', true);
  assert.equal(calls.length, 1);
  calls[0].resolve(payload());
  await tick();
  api.setSuspended(false);
  assert.equal(calls.length, 3);
  for (const call of calls.slice(1)) call.resolve(payload());
  await tick();
});

test('camera normalization keeps UK locations and gives London its own official link', async () => {
  const result = await readUkFeed(
    'cameras',
    null,
    async () =>
      new Response(
        JSON.stringify({
          sources: [
            {
              id: 'tfl-1',
              cityId: 'london',
              name: 'London',
              lat: 51.5,
              lon: -0.1,
            },
            {
              id: 'utmc-1',
              cityId: 'utmc-northeast',
              name: 'Newcastle',
              lat: 55,
              lon: -1.6,
            },
            {
              id: 'foreign',
              cityId: 'austin',
              name: 'Austin',
              lat: 30,
              lon: -97,
            },
          ],
        }),
      ),
  );
  assert.equal(result.rows.length, 2);
  assert.match(result.rows[0].url, /tfl.gov.uk/);
  assert.match(result.rows[1].url, /netrafficcams.co.uk/);
});

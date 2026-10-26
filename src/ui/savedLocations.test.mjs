import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SAVED_LOCATIONS,
  SAVED_LOCATIONS_STORAGE_KEY,
  createSavedLocation,
  loadSavedLocations,
  normalizeSavedLocation,
  persistSavedLocations,
  removeSavedLocation,
  upsertSavedLocation,
} from './savedLocations.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    read: (key) => data.get(key) ?? null,
  };
}

const record = (id = 'a') => ({
  id,
  label: 'Austin',
  action: 'fly_to_location',
  args: {
    latitude: 30.2672,
    longitude: -97.7431,
    rangeM: 1200,
    viewMode: 'close',
  },
  createdAt: 1,
});

test('saved locations persist only typed fly_to_location arguments', () => {
  assert.deepEqual(normalizeSavedLocation(record()), record());
  assert.equal(
    normalizeSavedLocation({
      ...record(),
      action: 'set_panel_open',
    }),
    null,
  );
  assert.equal(
    normalizeSavedLocation({
      ...record(),
      args: { ...record().args, latitude: 91 },
    }),
    null,
  );
  assert.equal(
    normalizeSavedLocation({
      ...record(),
      args: { ...record().args, longitude: -181 },
    }),
    null,
  );
  assert.equal(
    normalizeSavedLocation({
      ...record(),
      args: { ...record().args, rangeM: 99 },
    }),
    null,
  );
  assert.equal(
    normalizeSavedLocation({
      ...record(),
      args: { ...record().args, viewMode: 'cinematic' },
    }),
    null,
  );
});

test('creation injects identity/time and still passes the persisted contract', () => {
  assert.deepEqual(
    createSavedLocation(
      {
        label: '  Austin  ',
        args: { latitude: 30, longitude: -97, rangeM: 1000 },
      },
      { idFactory: () => 'saved-austin', now: () => 1234 },
    ),
    {
      id: 'saved-austin',
      label: 'Austin',
      action: 'fly_to_location',
      args: { latitude: 30, longitude: -97, rangeM: 1000 },
      createdAt: 1234,
    },
  );
});

test('storage is bounded and malformed or blocked storage fails closed', () => {
  const store = memoryStorage();
  let items = [];
  for (let index = 0; index < MAX_SAVED_LOCATIONS + 3; index += 1)
    items = upsertSavedLocation(items, record(String(index)));
  assert.equal(items.length, MAX_SAVED_LOCATIONS);
  assert.equal(persistSavedLocations(items, store), true);
  assert.equal(loadSavedLocations(store).length, MAX_SAVED_LOCATIONS);
  assert.ok(store.read(SAVED_LOCATIONS_STORAGE_KEY));

  const malformed = memoryStorage({
    [SAVED_LOCATIONS_STORAGE_KEY]: '{broken',
  });
  assert.deepEqual(loadSavedLocations(malformed), []);

  const blocked = {
    getItem() {
      throw new DOMException('blocked', 'SecurityError');
    },
    setItem() {
      throw new DOMException('blocked', 'SecurityError');
    },
  };
  assert.deepEqual(loadSavedLocations(blocked), []);
  assert.equal(persistSavedLocations(items, blocked), false);
});

test('upsert and remove preserve stable ids and normalize persisted rows', () => {
  let items = [record('a'), record('b')];
  items = upsertSavedLocation(items, {
    ...record('a'),
    label: 'Austin Updated',
  });
  assert.deepEqual(
    items.map((item) => [item.id, item.label]),
    [
      ['a', 'Austin Updated'],
      ['b', 'Austin'],
    ],
  );
  assert.deepEqual(
    removeSavedLocation(items, 'b').map((item) => item.id),
    ['a'],
  );
});


test('persisted coordinates require actual finite numbers, not coercions', () => {
  const invalid = [null, '', '30', true, [], Infinity, NaN];
  for (const field of ['latitude', 'longitude']) {
    for (const value of invalid) {
      assert.equal(
        normalizeSavedLocation({
          ...record(),
          args: { ...record().args, [field]: value },
        }),
        null,
      );
    }
  }
  for (const value of ['', '1200', true, [], Infinity, NaN]) {
    assert.equal(
      normalizeSavedLocation({
        ...record(),
        args: { ...record().args, rangeM: value },
      }),
      null,
    );
  }
  assert.deepEqual(
    normalizeSavedLocation({
      ...record(),
      args: { latitude: 0, longitude: 0 },
    }).args,
    { latitude: 0, longitude: 0 },
  );
  assert.equal(
    normalizeSavedLocation({ ...record(), createdAt: '1234' }).createdAt,
    0,
  );
});

test('loading, persisting and editing collapse repeated ids deterministically', () => {
  const rows = [
    { ...record('a'), label: 'Latest A' },
    { ...record('a'), label: 'Stale A' },
    record('b'),
    record('b'),
  ];
  const store = memoryStorage({
    [SAVED_LOCATIONS_STORAGE_KEY]: JSON.stringify(rows),
  });
  assert.deepEqual(
    loadSavedLocations(store).map(({ id, label }) => [id, label]),
    [['a', 'Latest A'], ['b', 'Austin']],
  );
  assert.equal(persistSavedLocations(rows, store), true);
  assert.deepEqual(
    JSON.parse(store.read(SAVED_LOCATIONS_STORAGE_KEY)).map(({ id }) => id),
    ['a', 'b'],
  );
  assert.deepEqual(
    upsertSavedLocation(rows, { ...record('b'), label: 'New B' })
      .map(({ id, label }) => [id, label]),
    [['b', 'New B'], ['a', 'Latest A']],
  );
  assert.deepEqual(removeSavedLocation(rows, 'a').map(({ id }) => id), ['b']);

  const overfull = [record('first'), record('first')];
  for (let index = 0; index < MAX_SAVED_LOCATIONS; index += 1)
    overfull.push(record(`extra-${index}`));
  const overfullStore = memoryStorage({
    [SAVED_LOCATIONS_STORAGE_KEY]: JSON.stringify(overfull),
  });
  const loaded = loadSavedLocations(overfullStore);
  assert.equal(loaded.length, MAX_SAVED_LOCATIONS);
  assert.equal(new Set(loaded.map(({ id }) => id)).size, MAX_SAVED_LOCATIONS);
  assert.equal(loaded[0].id, 'first');
});

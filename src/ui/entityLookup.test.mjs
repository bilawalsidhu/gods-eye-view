// src/ui/entityLookup.test.mjs — what the search box keeps of a host's entity
// lookup, and how one picked is found in its layer.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findMatch,
  LOOKUP_RECHECK_MS,
  lookupMatches,
  loadedId,
} from './entityLookup.js';

test('a lookup answer keeps aircraft, ships, cameras and satellites with a position, once each', () => {
  const matches = lookupMatches([
    {
      kind: 'aircraft',
      id: '86d3f0',
      name: 'JAL58',
      detail: 'Boeing 787',
      lat: 50,
      lon: -120,
    },
    { kind: 'aircraft', id: '86d3f0', name: 'JAL58 again', lat: 50, lon: -120 },
    { kind: 'vessel', id: '353136000', name: 'EVER GIVEN', lat: 30, lon: 32 },
    {
      kind: 'vessel',
      id: 'uuid-1',
      mmsi: 311000999,
      name: 'GIVEN',
      lat: 3,
      lon: 4,
    },
    {
      kind: 'camera',
      id: 'tfl:1',
      name: 'London Rd / Staines Av',
      lat: 51.4,
      lon: -0.5,
    },
    {
      kind: 'satellite',
      id: '25544',
      name: 'ISS (ZARYA)',
      lat: 10,
      lon: 20,
      layerId: 'satellites',
    },
    { kind: 'place', id: 'x', lat: 1, lon: 1 },
    { kind: 'vessel', id: 'bad', lat: 91, lon: 0 },
    { kind: 'vessel', lat: 1, lon: 1 },
    null,
  ]);
  assert.deepEqual(
    matches.map((match) => [match.kind, match.id, match.layerId, match.mmsi]),
    [
      ['aircraft', '86d3f0', 'flights', null],
      ['vessel', '353136000', 'ais-live-vessels', '353136000'],
      ['vessel', 'uuid-1', 'ais-live-vessels', '311000999'],
      ['camera', 'tfl:1', 'cctv', null],
      ['satellite', '25544', 'satellites', null],
    ],
  );
  assert.equal(matches[0].detail, 'Boeing 787');
  assert.deepEqual(lookupMatches(null), []);
});

/** A layer manager with one layer whose records `findByQuery` reads. */
function layers({
  layerId = 'ais-live-vessels',
  enabled = false,
  records = [],
} = {}) {
  const listeners = new Set();
  const state = { enabled, records, picks: [], switched: [] };
  const module = {
    // Like the vessels layer: by id, then by MMSI, then by a name it holds.
    findByQuery(query) {
      const q = String(query);
      return (
        state.records.find((record) => record.id === q) ||
        state.records.find((record) => record.mmsi === q) ||
        state.records.find((record) =>
          record.name.toLowerCase().includes(q.toLowerCase()),
        ) ||
        null
      );
    },
    pickById(id, options) {
      state.picks.push([id, options]);
      return state.records.some((record) => record.id === id);
    },
  };
  const dataManager = {
    layers: new Map([[layerId, { module }]]),
    isEnabled: (id) => id === layerId && state.enabled,
    subscribeActivity(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const setLayer = (id, on) => {
    state.switched.push([id, on]);
    state.enabled = on;
    return true;
  };
  const load = (more) => {
    state.records.push(...more);
    for (const listener of [...listeners]) listener({ layerId });
  };
  return { state, dataManager, setLayer, load, listeners };
}

const ship = {
  kind: 'vessel',
  id: 'uuid-1',
  mmsi: '353136000',
  name: 'EVER GIVEN',
  lat: 30,
  lon: 32,
  layerId: 'ais-live-vessels',
};

test('one its layer holds is answered at once, for a Context row pick', async () => {
  const { state, dataManager, setLayer } = layers({
    enabled: true,
    records: [{ id: 'uuid-1', mmsi: '353136000', name: 'EVER GIVEN' }],
  });
  const centred = [];
  const found = await findMatch({
    match: ship,
    dataManager,
    setLayer,
    centre: (...at) => centred.push(at),
  });
  assert.equal(found.ok, true);
  assert.equal(found.picked, false);
  assert.deepEqual(found.identity, {
    layerId: 'ais-live-vessels',
    id: 'uuid-1',
    label: 'EVER GIVEN',
    lat: 30,
    lon: 32,
  });
  assert.deepEqual(centred, []);
  assert.deepEqual(state.picks, []);
});

test('its layer is switched on, the camera centred once, and it is picked when the next load has it', async () => {
  const { state, dataManager, setLayer, load } = layers();
  const centred = [];
  const finding = findMatch({
    match: ship,
    dataManager,
    setLayer,
    centre: (...at) => centred.push(at),
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(state.switched, [['ais-live-vessels', true]]);
  assert.deepEqual(centred, [[30, 32]]);
  // The layer keys it by MMSI this time.
  load([{ id: '353136000', mmsi: '353136000', name: 'EVER GIVEN' }]);
  const found = await finding;
  assert.equal(found.ok, true);
  assert.equal(found.picked, true);
  assert.equal(found.identity.id, '353136000');
  assert.deepEqual(state.picks, [
    ['353136000', { origin: 'user', center: false }],
  ]);
  assert.deepEqual(centred, [[30, 32]]);
});

test('one a layer loads without saying so is picked too', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { state, dataManager, setLayer } = layers();
  const finding = findMatch({
    match: ship,
    dataManager,
    setLayer,
    centre: () => {},
  });
  await Promise.resolve();
  await Promise.resolve();
  // Records land with no activity published, as a feed polled outside the
  // manager's refresh does.
  state.records.push({ id: 'uuid-1', mmsi: '353136000', name: 'EVER GIVEN' });
  t.mock.timers.tick(LOOKUP_RECHECK_MS);
  const found = await finding;
  assert.equal(found.ok, true);
  assert.equal(found.picked, true);
  assert.deepEqual(state.picks, [
    ['uuid-1', { origin: 'user', center: false }],
  ]);
});

test('a record that only shares its name is never taken for it', async () => {
  const { dataManager } = layers({
    enabled: true,
    records: [{ id: 'other', mmsi: '999000111', name: 'EVER GIVEN' }],
  });
  assert.equal(loadedId(dataManager, ship), null);
  const found = await findMatch({
    match: ship,
    dataManager,
    setLayer: () => true,
    centre: () => {},
    timeoutMs: 10,
  });
  assert.deepEqual(found, { ok: false, reason: 'not-loaded' });
});

test('an aborted find picks nothing', async () => {
  const { state, dataManager, setLayer, load, listeners } = layers();
  const controller = new AbortController();
  const finding = findMatch({
    match: ship,
    dataManager,
    setLayer,
    centre: () => {},
    signal: controller.signal,
  });
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  const found = await finding;
  assert.equal(found.reason, 'cancelled');
  load([{ id: 'uuid-1', mmsi: '353136000', name: 'EVER GIVEN' }]);
  assert.deepEqual(state.picks, []);
  assert.equal(listeners.size, 0);
});

test('a layer the app does not have, or that stays off, finds nothing', async () => {
  const { dataManager } = layers({ layerId: 'flights' });
  assert.equal(
    (
      await findMatch({
        match: ship,
        dataManager,
        setLayer: () => true,
        centre: () => {},
      })
    ).reason,
    'no-layer',
  );
  const off = layers();
  assert.equal(
    (
      await findMatch({
        match: ship,
        dataManager: off.dataManager,
        setLayer: () => false,
        centre: () => {},
      })
    ).reason,
    'layer-off',
  );
});

test('one with no position at the time asked is kept, with or without where it was last seen', () => {
  const matches = lookupMatches([
    {
      kind: 'vessel',
      id: 'uuid-qm2',
      name: 'QUEEN MARY 2',
      detail: 'Last seen 24 Nov, 01:10',
      lat: 21.4,
      lon: -64.7,
      placed: false,
    },
    {
      kind: 'aircraft',
      id: '3c4b23',
      name: 'DLH572',
      detail: 'No position at 14:00',
      placed: false,
    },
    // A placed one still needs a position.
    { kind: 'aircraft', id: 'abcdef', name: 'NOWHERE' },
  ]);
  assert.deepEqual(
    matches.map(({ id, lat, lon, placed }) => [id, lat, lon, placed]),
    [
      ['uuid-qm2', 21.4, -64.7, false],
      ['3c4b23', null, null, false],
    ],
  );
});

test('one with no position at the time asked is not waited for: the camera goes where it was last seen', async () => {
  const { state, dataManager, setLayer } = layers();
  const centred = [];
  const found = await findMatch({
    match: { ...ship, placed: false },
    dataManager,
    setLayer,
    centre: (...at) => centred.push(at),
  });
  assert.deepEqual(found, { ok: false, reason: 'unplaced' });
  assert.deepEqual(centred, [[30, 32]]);
  assert.deepEqual(state.switched, []);
  assert.deepEqual(state.picks, []);
  const nowhere = [];
  await findMatch({
    match: { ...ship, lat: null, lon: null, placed: false },
    dataManager,
    setLayer,
    centre: (...at) => nowhere.push(at),
  });
  assert.deepEqual(nowhere, []);
});

test('one placed at another time keeps that time, and only a real one', () => {
  const at = Date.UTC(2026, 10, 25, 21, 5);
  const [kept, none, unplaced] = lookupMatches([
    { ...ship, at },
    { ...ship, id: 'uuid-2', at: 'soon' },
    { ...ship, id: 'uuid-3', placed: false, at },
  ]);
  assert.equal(kept.at, at);
  assert.equal(none.at, null);
  // One with no position is never moved to.
  assert.equal(unplaced.at, null);
});

test('one placed at another time moves the world clock there, then is centred and picked by id', async () => {
  const at = Date.UTC(2026, 10, 25, 21, 5);
  // The layer holds the ship now, where it is now: that record is not where the lookup placed it.
  const { state, dataManager, setLayer } = layers({
    enabled: true,
    records: [{ id: 'uuid-1', mmsi: '353136000', name: 'EVER GIVEN' }],
  });
  const seeks = [];
  const centred = [];
  const found = await findMatch({
    match: { ...ship, at },
    dataManager,
    setLayer,
    centre: (...where) => centred.push(where),
    seek: (ms) => seeks.push(ms),
  });
  assert.deepEqual(seeks, [at]);
  assert.deepEqual(centred, [[30, 32]]);
  assert.equal(found.ok, true);
  assert.equal(found.picked, true);
  assert.deepEqual(state.picks, [
    ['uuid-1', { origin: 'user', center: false }],
  ]);
});

test('one placed at the time asked never moves the world clock', async () => {
  const { dataManager, setLayer } = layers({
    enabled: true,
    records: [{ id: 'uuid-1', mmsi: '353136000', name: 'EVER GIVEN' }],
  });
  const seeks = [];
  const found = await findMatch({
    match: ship,
    dataManager,
    setLayer,
    centre: () => {},
    seek: (ms) => seeks.push(ms),
  });
  assert.equal(found.picked, false);
  assert.deepEqual(seeks, []);
});

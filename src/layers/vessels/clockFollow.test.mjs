import test from 'node:test';
import assert from 'node:assert/strict';
import { VesselRecords } from './records.js';
import { createIngestion, createVesselFeed } from './ingestion.js';

// Vessels follow the world clock only while their source declares a
// timeline (src/time/snapshotTimeline.js); these cover the layer's side.

const row = (mmsi, fields = {}) => ({
  mmsi,
  lat: 51.93,
  lon: 4.05,
  name: mmsi,
  last_position_epoch: 1_000,
  ...fields,
});

function store() {
  const records = new VesselRecords({ now: () => 5_000_000 });
  const events = [];
  const effects = {
    add: (record) => events.push(['add', record.mmsi]),
    beforeUpdate: () => null,
    updated: (record) => events.push(['update', record.mmsi]),
    remove: (record, evicted) => events.push(['remove', record.mmsi, evicted]),
    removed: (mmsi) => events.push(['removed', mmsi]),
    staleSelected: (record) => events.push(['stale', record.mmsi]),
  };
  return {
    records,
    events,
    reconcile: (rows, options = {}) =>
      records.reconcile(rows, options, effects),
  };
}

test('rows at another time stand in for every vessel, selected or not', () => {
  const probe = store();
  probe.reconcile([row('111'), row('222')]);
  const selectedRecord = probe.records.byId.get('222');
  probe.reconcile([row('111', { last_position_epoch: 900 })], {
    complete: false,
    selectedRecord,
    replace: true,
  });
  assert.deepEqual([...probe.records.byId.keys()], ['111']);
  assert.deepEqual(probe.events.slice(-3), [
    ['update', '111'],
    ['remove', '222', true],
    ['removed', '222'],
  ]);
  assert.equal(probe.records.byId.get('111').motion, null);
});

test('following the clock, a vessel keeps where its fix moved from', () => {
  const probe = store();
  probe.reconcile([row('111')]);
  probe.reconcile([row('111', { lat: 52, last_position_epoch: 1_010 })], {
    follow: true,
  });
  const record = probe.records.byId.get('111');
  assert.deepEqual(record.motion, {
    fromLat: 51.93,
    fromLon: 4.05,
    fromMs: 1_000_000,
    toLat: 52,
    toLon: 4.05,
    toMs: 1_010_000,
  });
  probe.reconcile([row('111', { lat: 52, last_position_epoch: 1_010 })], {
    follow: true,
  });
  assert.equal(record.motion.toMs, 1_010_000, 'a repeated fix keeps its move');
  const live = store();
  live.reconcile([row('111')]);
  live.reconcile([row('111', { lat: 52, last_position_epoch: 1_010 })]);
  assert.equal(
    Object.hasOwn(live.records.byId.get('111'), 'motion'),
    false,
    'live records are as before',
  );
});

function ingestion(source) {
  const feed = createVesselFeed();
  feed.enabled = true;
  feed.sessionId = 1;
  const applied = [];
  const state = { follows: false, reloads: 0, radiusKm: 50 };
  const methods = createIngestion({
    feed,
    readSource: () => source,
    readViewer: () => ({}),
    readArea: () => ({ lat: 1, lon: 2, radiusKm: state.radiusKm }),
    getRowLimit: () => 500,
    readCount: () => applied.at(-1)?.rows.length ?? 0,
    now: () => 9999,
    setSourceLabel: () => {},
    applyRows: (_viewer, rows, options) => applied.push({ rows, options }),
    classifySnapshot: (payload) => ({
      acceptedRows: payload.rows,
      acceptedRowCount: payload.rows.length,
      rawRowCount: payload.rows.length,
      transportStatus: payload.status,
      lastMessageAt: payload.lastMessageAt,
      error: null,
    }),
    isDefinitiveTransportFailure: () => false,
    isGraceEligibleTransport: () => false,
    markUnavailable: () => {},
    settleFirstConnect: () => {},
    followsClock: () => state.follows,
    reloadAtClock: () => {
      state.reloads += 1;
    },
  });
  return { feed, applied, state, ...methods };
}

test('vessel polls carry no time; a snapshot at a time carries it and replaces', async () => {
  const queries = [];
  const probe = ingestion({
    async getSnapshot(query) {
      queries.push(query);
      return {
        records: [{ id: '111', latitude: 1, longitude: 2, observedAtMs: 5 }],
        observedAtMs: 5,
        freshness: 'current',
        complete: true,
        transportStatus: 'live',
      };
    },
  });
  await probe.methods.update();
  assert.equal(Object.hasOwn(queries[0], 'atMs'), false);
  assert.deepEqual(probe.applied[0].options, { complete: true });
  probe.state.follows = true;
  await probe.methods.update();
  assert.equal(queries.length, 1, 'no poll while following');
  assert.equal(await probe.loadAt(5_000, { replace: true }), true);
  assert.equal(queries[1].atMs, 5_000);
  assert.deepEqual(probe.applied[1].options, { complete: true, replace: true });
  assert.equal(probe.feed.lastUpdate, 5);
  // Following the clock, a moved view reloads the time shown.
  probe.state.radiusKm = 2_000;
  await probe.refreshIfMoved({});
  assert.equal(probe.state.reloads, 1);
  assert.equal(queries.length, 2);
});

test('an empty vessel snapshot at another time shows no vessels', async () => {
  const probe = ingestion({
    async getSnapshot() {
      return { records: [], observedAtMs: 5, freshness: 'current' };
    },
  });
  probe.state.follows = true;
  await probe.loadAt(5_000, { replace: true });
  assert.deepEqual(probe.applied, [
    { rows: [], options: { complete: true, replace: true } },
  ]);
});

test('a vessel snapshot at a time the source drops for a newer one is no failure', async () => {
  const probe = ingestion({
    async getSnapshot() {
      throw new DOMException('Superseded', 'AbortError');
    },
  });
  probe.state.follows = true;
  await assert.rejects(probe.loadAt(5_000, { replace: true }), {
    name: 'AbortError',
  });
  assert.equal(probe.feed.error, null);
  assert.equal(probe.feed.loading, false);
  assert.deepEqual(probe.applied, []);
});

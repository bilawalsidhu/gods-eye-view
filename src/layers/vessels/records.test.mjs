import test from 'node:test';
import assert from 'node:assert/strict';
import { VesselRecords, normalizeVessel } from './records.js';
const row = (mmsi, fields = {}) => ({
  mmsi,
  lat: 51.93,
  lon: 4.05,
  name: mmsi,
  speed: 8,
  ...fields,
});
function setup() {
  let now = 1000;
  const store = new VesselRecords({ now: () => now });
  const events = [];
  const effects = {
    add: (record) => events.push(['add', record]),
    beforeUpdate: (record) => record.type,
    updated: (record, before) => events.push(['update', record, before]),
    remove: (record, evicted) =>
      events.push(['remove', record, evicted, store.byMmsi.has(record.mmsi)]),
    removed: (id) => events.push(['removed', id, store.byMmsi.has(id)]),
    staleSelected: (record) => events.push(['stale', record]),
  };
  return {
    store,
    events,
    advance: (ms) => {
      now += ms;
    },
    reconcile: (rows, options = {}) => store.reconcile(rows, options, effects),
  };
}

test('vessel reconciliation preserves record identity and first duplicate while emitting plain metadata', () => {
  const probe = setup();
  probe.reconcile([
    row('111', { type: 'Cargo' }),
    row('222'),
    row('222', { name: 'duplicate' }),
    row('bad', { lat: NaN }),
  ]);
  assert.equal(probe.store.byMmsi.size, 2);
  assert.equal(probe.store.byMmsi.get('222').name, '222');
  const record = probe.store.byMmsi.get('111');
  probe.reconcile([row('111', { lat: 51.94, type: 'Tanker' })]);
  assert.equal(probe.store.byMmsi.get('111'), record);
  assert.equal(record.lat, 51.94);
  assert.equal(probe.events.find((event) => event[0] === 'update')[2], 'Cargo');
  assert.equal(probe.store.byMmsi.has('222'), false);
  for (const field of ['position', 'surfacePosition', 'normal', 'billboard'])
    assert.equal(Object.hasOwn(record, field), false);
  assert.deepEqual(structuredClone(record), record);
});

test('selected vessel remains pinned for three complete misses and teardown precedes removal', () => {
  const probe = setup();
  probe.reconcile([row('111'), row('222')]);
  const selectedRecord = probe.store.byMmsi.get('111');
  for (let i = 1; i <= 3; i++) {
    probe.reconcile([row('222')], { selectedRecord });
    assert.equal(probe.store.byMmsi.get('111'), selectedRecord);
    assert.equal(selectedRecord.missedRefreshes, i);
  }
  probe.reconcile([row('222')], { selectedRecord });
  assert.equal(probe.store.byMmsi.has('111'), false);
  const removal = probe.events.find(
    (event) => event[0] === 'remove' && event[1] === selectedRecord,
  );
  assert.deepEqual(removal.slice(2), [true, true]);
  assert.deepEqual(
    probe.events.find((event) => event[0] === 'removed' && event[1] === '111'),
    ['removed', '111', false],
  );
});

test('partial retention respects age and row cap while preserving the selected contact', () => {
  const probe = setup();
  probe.reconcile([row('111'), row('222')], { cap: 2 });
  const selectedRecord = probe.store.byMmsi.get('111');
  probe.reconcile([row('333')], { complete: false, selectedRecord, cap: 2 });
  assert.deepEqual([...probe.store.byMmsi.keys()], ['111', '333']);
  assert.equal(selectedRecord.missedRefreshes, 1);
  probe.advance(5 * 60 * 1000);
  probe.reconcile([row('333')], { complete: false, selectedRecord, cap: 2 });
  assert.equal(probe.store.byMmsi.has('111'), false);
  assert.equal(
    probe.events.find(
      (event) => event[0] === 'remove' && event[1] === selectedRecord,
    )[2],
    true,
  );
});

test('unkeyed records rebuild on each refresh and numeric coercion keeps unknown values null', () => {
  const probe = setup();
  probe.reconcile([row('', { speed: '', course: '12.5', heading: 'bad' })]);
  const original = probe.store.unkeyed[0];
  assert.equal(original.speed, null);
  assert.equal(original.course, 12.5);
  assert.equal(original.heading, null);
  probe.reconcile([row('')]);
  assert.notEqual(probe.store.unkeyed[0], original);
  assert.equal(
    probe.events.some(
      (event) => event[0] === 'remove' && event[1] === original,
    ),
    true,
  );
  assert.equal(probe.store.byMmsi.size, 0);
  assert.equal(probe.store.all.length, 1);
  assert.equal(normalizeVessel(row('bad', { lon: Infinity })), null);
});

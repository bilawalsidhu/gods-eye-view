import test from 'node:test';
import assert from 'node:assert/strict';
import { FlightRecords } from './records.js';

function records() {
  return new FlightRecords({
    geoidHeight: () => 40,
    cachedGroundFloor: () => null,
    floorAltitudeM: (altitude) => altitude,
    approxDistanceKm: () => 0,
  });
}
const view = () => ({
  viewerLatDeg: null,
  viewerLonDeg: null,
  trackedId: null,
  floorWarmPoints: [],
});
const observation = (fields = {}) => ({
  id: 'abc123',
  reference: 'abc123',
  longitude: -77,
  latitude: 39,
  callsign: 'TEST1',
  baroAltitudeM: 1000,
  ellipsoidAltitudeM: null,
  onGround: false,
  speedMps: 120,
  courseDeg: 90,
  positionTimeMs: 1700000000000,
  ...fields,
});

test('civil records keep aviation units separate from render height and survive missing fields', () => {
  const store = records();
  store.geoidReady = true;
  const first = store.receive(observation(), view());
  assert.equal(first.meta.altitude, 1000);
  assert.equal(first.meta.renderAltitudeM, 1040);
  assert.equal(first.fixEpochMs, 1700000000000);
  first.meta.typeCode = 'B738';
  first.meta.photo = { src: 'https://t.plnspttrs.net/1/2_280.jpg' };
  const second = store.receive(
    observation({
      callsign: '',
      baroAltitudeM: null,
      speedMps: null,
      courseDeg: null,
    }),
    view(),
  );
  assert.equal(second.prevMeta, first.meta);
  assert.equal(second.meta.callsign, 'TEST1');
  assert.equal(second.meta.altitude, 1000);
  assert.equal(second.meta.renderAltitudeM, 1040);
  assert.equal(second.meta.velocity, 120);
  assert.equal(second.meta.true_track, 90);
  assert.equal(second.meta.typeCode, 'B738');
  assert.equal(second.meta.photo, first.meta.photo, 'the photo survives polls');
  assert.equal(Object.hasOwn(second.meta, 'cullPosition'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(second.meta)), second.meta);
});

test('civil record owners isolate state and preserve partial, missing-poll and landed retention', () => {
  const store = records();
  const other = records();
  const { meta } = store.receive(observation(), view());
  assert.equal(other.data.size, 0);
  assert.equal(
    store.absence('abc123', { complete: false, likelyLanded: false }),
    'retain',
  );
  assert.equal(store.missingPolls.size, 0);
  meta.observedReceiptMs = Date.now() - 300001;
  assert.equal(
    store.absence('abc123', { complete: false, likelyLanded: false }),
    'stale',
  );
  assert.equal(
    store.absence('abc123', { complete: true, likelyLanded: false }),
    'stale',
  );
  assert.equal(
    store.absence('abc123', { complete: true, likelyLanded: false }),
    'remove',
  );
  // Admission decides removal; follow teardown can still read the record first.
  assert.equal(store.data.get('abc123'), meta);
  store.forget('abc123');
  assert.equal(store.data.size, 0);
  assert.equal(store.missingPolls.size, 0);
  assert.equal(store.geoidNCache.size, 0);
  store.receive(observation(), view());
  assert.equal(
    store.absence('abc123', { complete: true, likelyLanded: true }),
    'remove',
  );
});

test('ground transitions preserve last render height while a surface cell is cold', () => {
  const store = records();
  store.receive(observation({ ellipsoidAltitudeM: 1040 }), view());
  const next = store.receive(
    observation({ onGround: true, baroAltitudeM: null }),
    view(),
  );
  assert.equal(next.groundFlipped, true);
  assert.equal(next.meta.renderAltitudeM, 1040);
  assert.equal(next.meta.wasAirborne, true);
});

test('complete snapshots age out vanished aircraft and retain position-less ones unless landed', () => {
  const store = records();
  for (const id of ['abc123', 'def456', 'ghi789'])
    store.receive(observation({ id, reference: id }), view());
  // abc123 and ghi789 are still listed without a position; def456 vanished.
  const absent = (id, likelyLanded = false) =>
    store.absence(id, {
      complete: true,
      retainIds: new Set(['abc123', 'ghi789']),
      likelyLanded,
    });
  assert.deepEqual(
    [absent('def456'), absent('def456'), absent('def456')],
    ['stale', 'stale', 'remove'],
  );
  assert.equal(absent('abc123'), 'retain');
  assert.equal(store.missingPolls.has('abc123'), false);
  // A landed contact that lost its position takes the landed fast-cull.
  assert.equal(absent('ghi789', true), 'remove');
  // Position-less retention stays bounded like partial admission.
  store.data.get('abc123').observedReceiptMs = Date.now() - 300001;
  assert.equal(absent('abc123'), 'stale');
});

test('civil emergency status follows the latest poll instead of sticking', () => {
  const store = records();
  const first = store.receive(observation({ squawk: '7700' }), view());
  assert.equal(first.meta.squawk, '7700');
  assert.equal(first.meta.emergency.kind, 'general');
  const next = store.receive(observation({ squawk: '2000' }), view());
  assert.equal(next.meta.squawk, '2000');
  assert.equal(next.meta.emergency, null);
});

test('a route belongs to its callsign: a new callsign drops it, a blank one keeps it', () => {
  const store = records();
  store.geoidReady = true;
  const first = store.receive(observation({ callsign: 'UAL9' }), view());
  first.meta.route = { origin: { code: 'AUS' }, destination: { code: 'DEN' } };
  first.meta.airline = 'United';
  first.meta.routeCallsign = 'UAL9';
  const same = store.receive(observation({ callsign: 'UAL9 ' }), view());
  assert.equal(same.meta.route, first.meta.route);
  const blank = store.receive(observation({ callsign: '' }), view());
  assert.equal(
    blank.meta.route,
    first.meta.route,
    'a dropped callsign is sticky',
  );
  assert.equal(blank.meta.airline, 'United');
  const next = store.receive(observation({ callsign: 'UAL10' }), view());
  assert.equal(next.meta.route, null, 'the old route never shows under UAL10');
  assert.equal(next.meta.airline, null);
  assert.equal(next.meta.routeCallsign, null);
});

test('a contact with no altitude yet is marked as drawn at an invented height; a held one is not', () => {
  const store = records();
  const none = store.receive(
    observation({ baroAltitudeM: null, ellipsoidAltitudeM: null }),
    view(),
  );
  assert.equal(none.meta.renderAltitudeInvented, true);
  const known = store.receive(
    observation({ positionTimeMs: 1700000005000 }),
    view(),
  );
  assert.equal(known.meta.renderAltitudeInvented, false);
  const held = store.receive(
    observation({
      baroAltitudeM: null,
      ellipsoidAltitudeM: null,
      positionTimeMs: 1700000010000,
    }),
    view(),
  );
  assert.equal(held.meta.renderAltitudeInvented, false);
  const parked = records().receive(
    observation({ id: 'abc124', baroAltitudeM: null, onGround: true }),
    view(),
  );
  assert.equal(parked.meta.renderAltitudeInvented, false);
});

test('the tracked contact is stale from its first missed update and kept until ten minutes after its newest fix', () => {
  const realNow = Date.now;
  const fixMs = Date.UTC(2026, 10, 9, 20, 0);
  let clock = fixMs + 5_000;
  Date.now = () => clock;
  try {
    for (const snapshot of [
      { complete: true },
      { complete: true, retainIds: new Set(['abc123']) },
      { complete: false },
    ]) {
      const store = records();
      store.receive(observation({ positionTimeMs: fixMs }), view());
      const absent = (tracked) =>
        store.absence('abc123', { ...snapshot, likelyLanded: false, tracked });
      clock = fixMs + 15_000;
      assert.equal(absent(true), 'stale');
      assert.equal(store.missingPolls.get('abc123'), 1);
      // Kept long after the untracked limits, measured from the fix time.
      clock = fixMs + 9 * 60_000;
      assert.equal(absent(true), 'stale');
      clock = fixMs + 10 * 60_000 - 1;
      assert.equal(absent(true), 'stale');
      clock = fixMs + 10 * 60_000;
      assert.equal(absent(true), 'remove');
      assert.equal(store.missingPolls.has('abc123'), false);
    }
    // Untracked contacts keep their own limits.
    const store = records();
    store.receive(observation({ positionTimeMs: fixMs }), view());
    clock = fixMs + 15_000;
    const untracked = (snapshot) =>
      store.absence('abc123', { ...snapshot, likelyLanded: false });
    assert.equal(untracked({ complete: false }), 'retain');
    assert.deepEqual(
      [1, 2, 3].map(() => untracked({ complete: true })),
      ['stale', 'stale', 'remove'],
    );
  } finally {
    Date.now = realNow;
  }
});

test('a repeated fix time marks the contact as not updated; removal is unchanged', () => {
  const store = records();
  const fixMs = Date.UTC(2026, 10, 9, 20, 0);
  store.beginSnapshot(fixMs + 2_000);
  store.receive(observation({ positionTimeMs: fixMs }), view());
  assert.equal(store.fixRepeated.has('abc123'), false);
  // The next poll re-sends the same position.
  store.beginSnapshot(fixMs + 12_000);
  store.receive(observation({ positionTimeMs: fixMs }), view());
  assert.equal(store.fixRepeated.has('abc123'), true);
  assert.equal(store.missingPolls.has('abc123'), false);
  // The same snapshot read again is not a missed update.
  store.beginSnapshot(fixMs + 12_000);
  store.receive(observation({ positionTimeMs: fixMs }), view());
  assert.equal(store.fixRepeated.has('abc123'), true);
  // A newer fix clears it.
  store.beginSnapshot(fixMs + 22_000);
  store.receive(observation({ positionTimeMs: fixMs + 10_000 }), view());
  assert.equal(store.fixRepeated.has('abc123'), false);
  store.beginSnapshot(fixMs + 32_000);
  store.receive(observation({ positionTimeMs: fixMs + 10_000 }), view());
  store.forget('abc123');
  assert.equal(store.fixRepeated.has('abc123'), false);
});

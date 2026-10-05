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

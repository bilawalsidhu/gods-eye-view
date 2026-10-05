import test from 'node:test';
import assert from 'node:assert/strict';
import { MilitaryFlightRecords } from './records.js';
const observation = (fields = {}) => ({
  id: 'aaa001',
  reference: 'aaa001',
  longitude: -77,
  latitude: 39,
  baroAltitudeM: 1000,
  ellipsoidAltitudeM: null,
  onGround: false,
  callsign: 'MIL1',
  typeCode: 'C17',
  speedMps: 100,
  courseDeg: 90,
  verticalRateMps: 1,
  positionTimeMs: 1700000000000,
  ...fields,
});
const context = (fields = {}) => ({
  observedAtMs: 1700000001000,
  floorWarmPoints: [],
  modelOwnsVisual: false,
  ...fields,
});
const store = () =>
  new MilitaryFlightRecords({
    geoidHeight: () => 40,
    cachedGroundFloor: () => 200,
    floorAltitudeM: (height, floor) => Math.max(height, floor + 1.5),
  });

test('military records preserve feet for aviation, metres for rendering and source epochs', () => {
  const records = store();
  records.geoidReady = true;
  const first = records.receive(observation(), context());
  assert.equal(first.meta.altitudeFt, 1000 / 0.3048);
  assert.equal(first.meta.renderAltitudeM, 1040);
  assert.equal(first.fixEpochMs, 1700000000000);
  const next = records.receive(
    observation({ callsign: '', typeCode: '', positionTimeMs: null }),
    context(),
  );
  assert.equal(next.meta.callsign, 'MIL1');
  assert.equal(next.meta.type, 'C17');
  assert.equal(next.fixEpochMs, 1700000001000);
  assert.equal(Object.hasOwn(next.meta, 'cullPosition'), false);
});

test('military ground records leave model-owned placement alone and warm the same floor cell', () => {
  const records = store();
  const owned = context({ modelOwnsVisual: true });
  const first = records.receive(
    observation({ onGround: true, baroAltitudeM: null }),
    owned,
  );
  assert.equal(first.meta.renderAltitudeM, 0);
  assert.deepEqual(owned.floorWarmPoints, [{ lat: 39, lon: -77 }]);
  const unowned = context();
  const second = records.receive(
    observation({ onGround: true, baroAltitudeM: null }),
    unowned,
  );
  assert.equal(second.meta.renderAltitudeM, 201.5);
  assert.deepEqual(unowned.floorWarmPoints, owned.floorWarmPoints);
});

test('military records keep bounded partial retention and release metadata only after removal admission', () => {
  const first = store();
  const second = store();
  const { meta } = first.receive(observation(), context());
  assert.equal(second.data.size, 0);
  assert.equal(
    first.absence('aaa001', { complete: false, likelyLanded: true }),
    'retain',
  );
  meta.observedReceiptMs = Date.now() - 300001;
  assert.equal(
    first.absence('aaa001', { complete: false, likelyLanded: false }),
    'stale',
  );
  assert.equal(
    first.absence('aaa001', { complete: true, likelyLanded: false }),
    'stale',
  );
  assert.equal(
    first.absence('aaa001', { complete: true, likelyLanded: false }),
    'remove',
  );
  assert.equal(first.data.get('aaa001'), meta);
  first.forget('aaa001');
  assert.equal(first.data.size, 0);
  assert.equal(first.geoidNCache.size, 0);
  assert.equal(first.missingPolls.size, 0);
  first.receive(observation(), context());
  assert.equal(
    first.absence('aaa001', { complete: true, likelyLanded: true }),
    'remove',
  );
});

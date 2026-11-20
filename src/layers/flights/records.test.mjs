import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlightRecords } from './records.js';

const FLEET = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../public/models/fleet',
);
const fleetSet = {
  catalog: JSON.parse(
    fs.readFileSync(path.join(FLEET, 'catalog.json'), 'utf8'),
  ),
  types: JSON.parse(fs.readFileSync(path.join(FLEET, 'types.json'), 'utf8')),
};

function records(fleetModels = () => null) {
  return new FlightRecords({
    geoidHeight: () => 40,
    cachedGroundFloor: () => null,
    floorAltitudeM: (altitude) => altitude,
    approxDistanceKm: () => 0,
    fleetModels,
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

test('a ground vehicle or station with no altitude stands on the ground; an aircraft does not', () => {
  const store = records(() => fleetSet);
  const noAltitude = { baroAltitudeM: null, ellipsoidAltitudeM: null };
  const vehicle = store.receive(
    observation({
      id: 'v1',
      typeCode: 'ZVEH',
      speedMps: 8,
      callsign: 'FIRE 2',
      ...noAltitude,
    }),
    view(),
  ).meta;
  assert.equal(vehicle.onGround, true);
  assert.equal(vehicle.typeCode, 'ZVEH');
  assert.equal(vehicle.altitude, 0);
  const mast = store.receive(
    observation({ id: 'm1', typeCode: 'GRND', callsign: 'RX5', ...noAltitude }),
    view(),
  ).meta;
  assert.equal(mast.onGround, true);
  assert.equal(mast.typeCode, 'GRND');
  // An airliner with no altitude keeps the airborne default, and its feed
  // type from the first fix.
  const plane = store.receive(
    observation({ id: 'p1', typeCode: 'A320', ...noAltitude }),
    view(),
  ).meta;
  assert.equal(plane.onGround, false);
  assert.equal(plane.altitude, 10000);
  assert.equal(plane.typeCode, 'A320');
  // An "airport vehicle" reported airborne is no vehicle (a drone, a test
  // transponder): it is placed by its altitude and classed as an aircraft.
  const reported = store.receive(
    observation({ id: 'v2', typeCode: 'ZVEH', baroAltitudeM: 762 }),
    view(),
  ).meta;
  assert.equal(reported.onGround, false);
  assert.equal(reported.typeCode, null);
  assert.notEqual(reported.klass, 'vehicle');
  // Nor is one on the ground faster than a vehicle drives.
  const fast = store.receive(
    observation({
      id: 'v4',
      typeCode: 'ZVEH',
      onGround: true,
      speedMps: 77,
      ...noAltitude,
    }),
    view(),
  ).meta;
  assert.notEqual(fast.klass, 'vehicle');
  // A ground station stands on the ground whatever height it reports.
  const high = store.receive(
    observation({ id: 'm2', typeCode: 'GRND', baroAltitudeM: 11880 }),
    view(),
  ).meta;
  assert.equal(high.onGround, true);
  assert.equal(high.klass, 'station');
  assert.equal(high.altitude, 0);
  assert.ok(
    !(high.renderAltitudeM > 1000),
    `drawn at ${high.renderAltitudeM} m`,
  );
  // Before the model set loads, the feed's ground types already count: an
  // airport vehicle is never drawn as an aircraft first.
  const early = records();
  const unloaded = early.receive(
    observation({ id: 'v3', typeCode: 'ZVEH', speedMps: 8, ...noAltitude }),
    view(),
  ).meta;
  assert.equal(unloaded.onGround, true);
  assert.equal(unloaded.typeCode, 'ZVEH');
  const earlyPlane = early.receive(
    observation({ id: 'p2', typeCode: 'A320', ...noAltitude }),
    view(),
  ).meta;
  assert.equal(earlyPlane.onGround, false);
  assert.equal(earlyPlane.typeCode, 'A320');
});

test('airport vehicles and ground stations take their class from the first fix', () => {
  // Before the model set loads, and after.
  for (const store of [records(), records(() => fleetSet)]) {
    const klass = (fields) =>
      store.receive(observation({ callsign: '', ...fields }), view()).meta
        .klass;
    // An airport vehicle reports itself on the ground, at a vehicle's speed.
    const driving = { onGround: true, speedMps: 8 };
    assert.equal(klass({ id: 'v1', typeCode: 'ZVEH', ...driving }), 'vehicle');
    assert.equal(
      klass({ id: 'v2', typeCode: 'ZVEH', callsign: 'FIRE 2', ...driving }),
      'vehicle',
    );
    assert.equal(klass({ id: 'v3', category: 'C1' }), 'vehicle');
    assert.equal(klass({ id: 'v4', category: 'C2' }), 'vehicle');
    assert.equal(klass({ id: 'm1', typeCode: 'GRND' }), 'station');
    assert.equal(klass({ id: 'm2', category: 'C4' }), 'station');
    // An aircraft's feed type outranks its emitter category.
    assert.equal(
      klass({ id: 'p1', typeCode: 'A320', category: 'A7' }),
      'airliner',
    );
  }
});

test("an aircraft's feed type classes it from the first fix, until a lookup answers", () => {
  for (const store of [records(), records(() => fleetSet)]) {
    // A helicopter whose feed names its type, with an airliner-like category.
    const first = store.receive(
      observation({
        id: 'h1',
        callsign: 'NHC47',
        typeCode: 'ec45',
        category: 'A3',
      }),
      view(),
    ).meta;
    assert.equal(first.typeCode, 'EC45');
    assert.equal(first.klass, 'helicopter');
    assert.equal(first.typeLookedUp, false);
    // A later row without the type keeps it.
    const quiet = store.receive(
      observation({ id: 'h1', callsign: 'NHC47', category: 'A3' }),
      view(),
    ).meta;
    assert.equal(quiet.klass, 'helicopter');
    assert.equal(quiet.typeCode, 'EC45');
    // A looked-up type outranks the feed's on every later poll and reset.
    quiet.typeCode = 'EC35';
    quiet.typeLookedUp = true;
    quiet.typeName = 'Airbus Helicopters H135';
    const after = store.receive(
      observation({ id: 'h1', callsign: 'NHC47', typeCode: 'B738' }),
      view(),
    ).meta;
    assert.equal(after.typeCode, 'EC35');
    assert.equal(after.typeName, 'Airbus Helicopters H135');
    assert.equal(after.klass, 'helicopter');
    store.reset();
    const again = store.receive(
      observation({ id: 'h1', callsign: 'NHC47', typeCode: 'B738' }),
      view(),
    ).meta;
    assert.equal(again.typeCode, 'EC35');
    // No type anywhere: the emitter category classes it.
    const bare = store.receive(
      observation({ id: 'h2', category: 'A7' }),
      view(),
    ).meta;
    assert.equal(bare.typeCode, null);
    assert.equal(bare.klass, 'helicopter');
  }
});

test('a surface emitter category stands on the ground, before and after the model set loads', () => {
  const noAltitude = { baroAltitudeM: null, ellipsoidAltitudeM: null };
  for (const store of [records(), records(() => fleetSet)]) {
    for (const [id, category] of [
      ['c1', 'C1'],
      ['c2', 'C2'],
      ['c3', 'C3'],
      ['c5', 'C5'],
      ['o16', 16],
      ['o20', 20],
    ]) {
      const meta = store.receive(
        observation({ id, category, callsign: '', ...noAltitude }),
        view(),
      ).meta;
      assert.equal(meta.onGround, true, `${id} stands on the ground`);
      assert.equal(meta.altitude, 0, id);
    }
    // An aircraft category with no altitude keeps the airborne default.
    const plane = store.receive(
      observation({ id: 'a3', category: 'A3', ...noAltitude }),
      view(),
    ).meta;
    assert.equal(plane.onGround, false);
    // A feed's aircraft type on a surface category does not make it an aircraft.
    const odd = store.receive(
      observation({
        id: 'c9',
        category: 'C1',
        typeCode: 'A320',
        ...noAltitude,
      }),
      view(),
    ).meta;
    assert.equal(odd.klass, 'vehicle');
    assert.equal(odd.onGround, true);
  }
});

test('a contact reported with no course faces the way its newer fixes went', () => {
  const store = records();
  const T = 1700000000000;
  const taxi = (latitude, seconds, fields = {}) =>
    store.receive(
      observation({
        latitude,
        longitude: -97.6588,
        courseDeg: null,
        onGround: true,
        speedMps: 8,
        positionTimeMs: T + seconds * 1000,
        ...fields,
      }),
      view(),
    );
  const course = () => store.data.get('abc123').true_track;
  taxi(30.1908, 0);
  assert.equal(course(), 0, 'nothing known yet');
  // Fixes a second apart, 8 m each: they add up until 30 m are covered.
  taxi(30.19073, 1);
  taxi(30.19066, 2);
  assert.equal(course(), 0, 'under 30 m: still nothing');
  taxi(30.19059, 3);
  taxi(30.19052, 4);
  assert.ok(Math.abs(course() - 180) < 0.1, 'southbound');
  // An older fix from another feed, behind it: never turns it around.
  taxi(30.1912, 2);
  assert.ok(Math.abs(course() - 180) < 0.1, 'an older fix gives no course');
  taxi(30.1901, 8);
  assert.ok(Math.abs(course() - 180) < 0.1);
  // Standing (reported under 2 m/s) with 40 m of position noise: kept.
  taxi(30.18974, 12, { speedMps: 0.5, longitude: -97.6584 });
  assert.ok(
    Math.abs(course() - 180) < 0.1,
    'a standing contact keeps its course',
  );
  // A reported course always wins.
  taxi(30.189, 16, { courseDeg: 175 });
  assert.equal(course(), 175);
  // A reset forgets where it was: it starts again from north.
  store.reset();
  taxi(30.188, 20);
  assert.equal(course(), 0);
});

test('a low contact near the view carries the ground under it; others carry none', () => {
  const store = new FlightRecords({
    geoidHeight: () => 40,
    cachedGroundFloor: () => 1656,
    floorAltitudeM: (altitude, ground) =>
      Math.max(altitude, ground ?? -Infinity),
    fleetModels: () => null,
  });
  const denver = { latitude: 39.85, longitude: -104.67 };
  const near = { ...view(), viewerLatDeg: 39.8, viewerLonDeg: -104.7 };
  // Landing at Denver: 1,900 m above the ellipsoid over 1,656 m ground.
  const landing = store.receive(
    observation({ id: 'l1', ...denver, ellipsoidAltitudeM: 1900 }),
    near,
  ).meta;
  assert.equal(landing.groundM, 1656);
  // At cruise the ground is not read.
  const cruise = store.receive(
    observation({
      id: 'c1',
      ...denver,
      ellipsoidAltitudeM: 11000,
      baroAltitudeM: 11000,
    }),
    near,
  ).meta;
  assert.equal(cruise.groundM, null);
  // Nor without a view to be near.
  const away = store.receive(
    observation({ id: 'a1', ...denver, ellipsoidAltitudeM: 1900 }),
    view(),
  ).meta;
  assert.equal(away.groundM, null);
});

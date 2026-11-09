// src/layers/vessels/cockpitSubject.test.mjs — bridge eye heights by AIS
// type and the selected vessel as Cockpit subject info.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VESSEL_COCKPIT_LAYER_ID,
  vesselCockpitInfo,
  vesselEyeHeightM,
} from './cockpitSubject.js';

test('bridge eye height follows the AIS type family', () => {
  assert.equal(vesselEyeHeightM('71'), 30, 'cargo');
  assert.equal(vesselEyeHeightM('84'), 30, 'tanker');
  assert.equal(vesselEyeHeightM('60'), 25, 'passenger');
  assert.equal(vesselEyeHeightM('52'), 7, 'tug');
  assert.equal(vesselEyeHeightM('30'), 6, 'fishing');
  assert.equal(vesselEyeHeightM('37'), 3, 'pleasure');
  assert.equal(vesselEyeHeightM('36'), 3, 'sailing');
});

test('text vessel types resolve through the same families', () => {
  assert.equal(vesselEyeHeightM('Container Ship'), 30);
  assert.equal(vesselEyeHeightM('Cruise ship'), 25);
  assert.equal(vesselEyeHeightM('Ferry'), 4);
  assert.equal(vesselEyeHeightM(99), 4, 'AIS Other');
  assert.equal(vesselEyeHeightM('90'), 4, 'AIS Other');
  assert.equal(vesselEyeHeightM('Other'), 4, 'a feed text type Other');
  assert.equal(vesselEyeHeightM('Yacht'), 3);
});

test('codes filed under OTHER that are not AIS Other keep the default', () => {
  // Reserved (1-19), wing in ground (20-29), reserved (38-39), spare
  // (56-57) and local (59) codes name no family.
  for (const type of ['1', '19', '20', '29', '38', '39', '56', '57', '59'])
    assert.equal(vesselEyeHeightM(type), null, type);
});

test('an unknown or missing type has no eye height of its own', () => {
  for (const type of ['', '0', '255', 'Research vessel', null]) {
    assert.equal(vesselEyeHeightM(type), null, String(type));
  }
});

test('vessel info faces the true heading and moves along course over ground', () => {
  const info = vesselCockpitInfo({
    mmsi: '211000000',
    name: 'NORDIC STAR',
    type: '70',
    destination: ' KIEL ',
    lat: 54.5,
    lon: 10.2,
    speed: 12,
    course: 95,
    heading: 90,
    lastPositionEpoch: 1_700_000_000,
    missedRefreshes: 0,
  });
  assert.equal(info.kind, 'vessel');
  assert.equal(info.layerId, VESSEL_COCKPIT_LAYER_ID);
  assert.equal(info.id, '211000000');
  assert.equal(info.typeLabel, 'CARGO');
  assert.equal(info.track, 90);
  assert.equal(info.motionCourse, 95);
  assert.equal(info.destination, 'KIEL');
  assert.equal(info.eyeHeightM, 30);
  assert.equal(info.fixEpochMs, 1_700_000_000_000);
  assert.ok(Math.abs(info.velocityMps - 12 * 0.514444) < 1e-9);
  assert.equal(info.stale, false);
  assert.equal(info.onGround, false);
});

test('a missing heading or course falls back to the other', () => {
  const base = { mmsi: '1', lat: 1, lon: 1, speed: 3 };
  assert.equal(vesselCockpitInfo({ ...base, course: 40 }).track, 40);
  assert.equal(vesselCockpitInfo({ ...base, heading: 50 }).motionCourse, 50);
  const neither = vesselCockpitInfo(base);
  assert.equal(neither.track, null);
  assert.equal(neither.motionCourse, null);
});

test('the subject says whether its track is the heading or the course', () => {
  const base = { mmsi: '1', lat: 1, lon: 1, speed: 3 };
  assert.equal(
    vesselCockpitInfo({ ...base, heading: 50, course: 40 }).trackSource,
    'heading',
  );
  assert.equal(
    vesselCockpitInfo({ ...base, course: 40 }).trackSource,
    'course',
  );
  // A heading of 0 is due north, not a missing heading.
  assert.equal(
    vesselCockpitInfo({ ...base, heading: 0 }).trackSource,
    'heading',
  );
  assert.equal(vesselCockpitInfo(base).trackSource, null);
});

test('a vessel without identity or position is not a subject', () => {
  assert.equal(vesselCockpitInfo(null), null);
  assert.equal(vesselCockpitInfo({ lat: 1, lon: 1 }), null);
  assert.equal(vesselCockpitInfo({ mmsi: '1', lat: 'x', lon: 1 }), null);
});

test('a vessel missing from recent refreshes reads as stale', () => {
  const info = vesselCockpitInfo({
    mmsi: '1',
    lat: 1,
    lon: 1,
    missedRefreshes: 2,
  });
  assert.equal(info.stale, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMmsi,
  flagFromMmsi,
  isValidImo,
  normalizeVesselName,
  MMSI_KINDS,
} from './ais-identity.js';

test('ship MMSIs resolve to their flag state', () => {
  assert.deepEqual(flagFromMmsi('431449000'), { code: 'JP', name: 'Japan', kind: MMSI_KINDS.SHIP });
  assert.deepEqual(flagFromMmsi('503754000'), { code: 'AU', name: 'Australia', kind: MMSI_KINDS.SHIP });
  assert.equal(flagFromMmsi('636012345').name, 'Liberia');
  assert.equal(flagFromMmsi('232001234').code, 'GB');
});

test('prefixed MMSIs are classified before the MID is read', () => {
  // Reading digits 0-2 blindly would call this one "Andorra".
  assert.deepEqual(classifyMmsi('992501234'), { kind: MMSI_KINDS.AID_TO_NAVIGATION, mid: 250 });
  assert.deepEqual(classifyMmsi('002320001'), { kind: MMSI_KINDS.COAST_STATION, mid: 232 });
  assert.deepEqual(classifyMmsi('023200011'), { kind: MMSI_KINDS.GROUP, mid: 232 });
  assert.deepEqual(classifyMmsi('111232001'), { kind: MMSI_KINDS.SAR_AIRCRAFT, mid: 232 });
  assert.deepEqual(classifyMmsi('982320012'), { kind: MMSI_KINDS.AUXILIARY, mid: 232 });
  assert.equal(classifyMmsi('970123456').kind, MMSI_KINDS.FREE_FORM);
});

test('an aid to navigation still reports its administration', () => {
  const flag = flagFromMmsi('992501234');
  assert.equal(flag.name, 'Ireland'); // MID 250, not the 992 prefix
  assert.equal(flag.code, 'IE');
  assert.equal(flag.kind, MMSI_KINDS.AID_TO_NAVIGATION);
});

test('short, empty and unknown-MID MMSIs return no flag', () => {
  assert.equal(flagFromMmsi(''), null);
  assert.equal(flagFromMmsi('123'), null);
  assert.equal(flagFromMmsi('199999999'), null);
  assert.equal(classifyMmsi('12345').kind, MMSI_KINDS.UNKNOWN);
});

test('IMO check digit accepts real numbers and rejects corruptions', () => {
  assert.equal(isValidImo('9409065'), true); // CAPE BRITANNIA
  assert.equal(isValidImo('9074729'), true);
  assert.equal(isValidImo('9409066'), false); // wrong check digit
  assert.equal(isValidImo('9490065'), false); // transposed
  assert.equal(isValidImo('940906'), false); // too short
  assert.equal(isValidImo(''), false);
  assert.equal(isValidImo('IMO 9409065'), true); // punctuation tolerated
});

test('name normalization collapses punctuation and case', () => {
  assert.equal(normalizeVesselName('m/v  Ever-Given!'), 'M V EVER GIVEN');
  assert.equal(normalizeVesselName(''), '');
  assert.equal(normalizeVesselName(null), '');
});
